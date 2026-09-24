// Cloudflare Worker — замена Firebase Cloud Functions (functions/index.js), перенесённая
// один в один по логике, только под другую платформу: пользователю с российской картой
// невозможно включить Blaze-план Firebase (нужна оплата), а у Cloudflare Workers щедрый
// бесплатный тариф без привязки карты вообще. База данных (Firestore) не переносится —
// остаётся той же, Worker обращается к ней напрямую через REST API (см. firestore.js).
import { createFirestoreClient } from './firestore.js';
import { createCustomToken } from './googleAuth.js';
import { verifyFirebaseIdToken } from './jwt.js';
import {
  sendMessage, sendMediaGroup, answerCallbackQuery,
  verifyLoginWidgetPayload, getUserProfilePhotoFilePath, fetchTelegramFile, getFilePath,
} from './telegram.js';
import {
  DEFAULT_TZ, todayKey, escapeHtml, uidForTelegramId, getUpcomingPlannerEvents,
  addFinanceTransaction, parseAmountAndNote,
} from './reminders.js';
import { runDailyDigests } from './digest.js';
import { renderScreen, runAction, renderHome, renderToMainMenu, renderAiPlanScreen } from './bot.js';
import { createYandexProvider } from './ai/provider.js';
import { planTurn, confirmActions } from './ai/router.js';

// Полчаса — достаточно, чтобы спокойно открыть одну и ту же ссылку и с телефона, и с
// компьютера, не отправляя /start заново под каждое устройство (ссылка теперь не
// одноразовая, см. handleTelegramLinkAuth).
const LOGIN_TOKEN_TTL_MS = 30 * 60 * 1000;

// Потолок длины голосового сообщения для AI — тот же лимит, что и в веб-клиенте
// (AI_VOICE_MAX_SECONDS в index.html): длинная запись — это и долгий SpeechKit, и большой
// вход в YandexGPT, а значит лишние деньги без видимой пользы для короткой команды/вопроса.
const AI_VOICE_MAX_SECONDS = 30;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Профиль (имя/юзернейм/фото) обновляем при каждом входе — он может поменяться в Telegram.
// Настройки напоминаний трогаем только при первой привязке, чтобы не затирать то, что
// пользователь мог уже изменить. Общая точка для входа через виджет и входа по ссылке от бота.
async function upsertTelegramUser(firestore, telegramId, profile) {
  const uid = uidForTelegramId(telegramId);
  const path = `users/${uid}`;
  const existing = await firestore.getDoc(path);
  await firestore.mergeDoc(path, {
    telegramId,
    telegramUsername: profile.username || null,
    telegramFirstName: profile.firstName || '',
    telegramLastName: profile.lastName || '',
    // Виджет входа отдаёт готовый публичный URL фото; вход по ссылке от бота — только
    // file_path (см. getUserProfilePhotoFilePath), который отдаётся клиенту не напрямую,
    // а через прокси /avatar/:uid (см. handleAvatar), чтобы не светить токен бота в URL.
    telegramPhotoUrl: profile.photoUrl || null,
    telegramPhotoFilePath: profile.photoFilePath || null,
    linkedAt: existing ? existing.linkedAt ?? Date.now() : Date.now(),
    reminderHourLocal: existing ? existing.reminderHourLocal ?? 20 : 20,
    // Вкл/выкл напоминаний целиком — настраивается в приложении (Настройки), пишется клиентом
    // напрямую в users/{uid} (правила Firestore это уже разрешают). Общий выключатель для всей
    // системы уведомлений — и дайджестов (см. digest.js), и напоминаний о скором событии
    // (handlePlannerReminders ниже).
    remindersEnabled: existing ? existing.remindersEnabled ?? true : true,
  });
  return uid;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

async function handleTelegramAuthVerify(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS_HEADERS);
  const payload = await req.json().catch(() => ({}));
  if (!(await verifyLoginWidgetPayload(env.TELEGRAM_BOT_TOKEN, payload))) {
    return json({ error: 'invalid telegram signature' }, 401, CORS_HEADERS);
  }
  const uid = await upsertTelegramUser(firestore, payload.id, {
    username: payload.username,
    firstName: payload.first_name,
    lastName: payload.last_name,
    photoUrl: payload.photo_url,
  });
  const customToken = await createCustomToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY, uid);
  // Меню появляется только после реально завершённой регистрации (не при /start — тогда
  // пользователь ещё даже не открыл приложение), см. renderToMainMenu ниже в handleTelegramLinkAuth.
  // Если у пользователя ни разу не было диалога с ботом (вход только через виджет на сайте),
  // отправка сообщения ожидаемо не удастся — это не должно ломать сам вход.
  await renderToMainMenu(env, firestore, env.TELEGRAM_BOT_TOKEN, uid, payload.id, renderHome())
    .catch((err) => console.error('renderToMainMenu (post-login, widget) failed', err));
  return json({ customToken }, 200, CORS_HEADERS);
}

// Вход по ссылке из бота (проще виджета — не требует BotFather /setdomain). Бот при /start
// кладёт токен в loginTokens/{token} и присылает ссылку вида APP_URL?telegram_login=<token>.
// Ссылка НЕ одноразовая — живёт LOGIN_TOKEN_TTL_MS (30 минут) и её можно открыть несколько
// раз за это окно (например, сначала с телефона, потом с компьютера); удаляем только когда
// она реально протухла, просто для уборки за собой.
async function handleTelegramLinkAuth(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS_HEADERS);
  const body = await req.json().catch(() => ({}));
  const loginToken = body.token;
  if (!loginToken || typeof loginToken !== 'string') return json({ error: 'missing token' }, 400, CORS_HEADERS);

  const tokenPath = `loginTokens/${loginToken}`;
  const data = await firestore.getDoc(tokenPath);
  if (!data) return json({ error: 'invalid or expired token' }, 401, CORS_HEADERS);
  if (Date.now() > data.expiresAt) {
    await firestore.deleteDoc(tokenPath);
    return json({ error: 'token expired' }, 401, CORS_HEADERS);
  }

  const uid = await upsertTelegramUser(firestore, data.telegramId, {
    username: data.username,
    firstName: data.firstName,
    lastName: data.lastName,
    photoFilePath: data.photoFilePath,
  });
  const customToken = await createCustomToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY, uid);
  // Главное меню создаётся и закрепляется здесь, а не в /start — по задумке оно должно
  // появляться только после того, как регистрация реально завершена (пользователь открыл
  // приложение по ссылке и вошёл), а не сразу при нажатии /start, когда аккаунта ещё нет.
  await renderToMainMenu(env, firestore, env.TELEGRAM_BOT_TOKEN, uid, data.telegramId, renderHome())
    .catch((err) => console.error('renderToMainMenu (post-login) failed', err));
  return json({ customToken }, 200, CORS_HEADERS);
}

// Три картинки-инструкции (обложка + установка на iPhone + установка на Android) — лежат
// в репозитории (assets/onboarding/) и раздаются тем же GitHub Pages, что и само приложение,
// поэтому Telegram спокойно подтягивает их по URL, без ручной загрузки файла через бота.
const ONBOARDING_IMAGE_PATHS = ['assets/onboarding/1-cover.jpg', 'assets/onboarding/2-iphone.jpg', 'assets/onboarding/3-android.jpg'];
const ONBOARDING_CAPTION = [
  '✨ <b>D.N.A. — как отдельное приложение</b>',
  '',
  '📲 Установи на телефон по инструкции на картинках выше — иконка на экране, открывается мгновенно, без адресной строки браузера.',
  '',
  '⚠️ <b>Никому не пересылай ссылку в следующем сообщении</b> — по ней открывается именно твой личный аккаунт, а не просто сайт.',
].join('\n');

// Свободный текст пользователя вне команд/кнопок. Основной случай — сумма+описание после
// кнопок "➕ Пополнение"/"➖ Расход" в Финансах (см. renderFinancePromptScreen в bot.js):
// pendingFinanceInput на users/{uid} говорит, что следующее сообщение нужно разобрать именно
// так. Разбор — parseAmountAndNote (reminders.js), обычные регулярки, НЕ AI (по прямой просьбе
// пользователя — должно работать бесплатно и мгновенно, без внешнего API). Если разобрать не
// удалось, pendingFinanceInput нарочно НЕ снимается — пользователь может просто попробовать
// ещё раз тем же сообщением, не открывая Финансы заново.
async function handleTelegramFreeText(env, firestore, token, message) {
  const uid = uidForTelegramId(message.from.id);
  const user = await firestore.getDoc(`users/${uid}`);
  const pending = user && user.pendingFinanceInput;
  if (pending === 'income' || pending === 'expense') {
    const parsed = parseAmountAndNote(message.text);
    if (!parsed) {
      await sendMessage(token, message.chat.id, 'Не понял сумму — напиши, например: «100 на шоколадку». Или нажми «❌ Отмена» в Финансах.');
      return;
    }
    await firestore.mergeDoc(`users/${uid}`, { pendingFinanceInput: null });
    await addFinanceTransaction(firestore, uid, {
      amount: pending === 'income' ? Math.abs(parsed.amount) : -Math.abs(parsed.amount),
      type: pending,
      category: null,
      note: parsed.note,
      date: todayKey(DEFAULT_TZ),
    });
    // Сообщение пользователя с суммой НЕ удаляется — пользователь должен видеть, что именно
    // он написал (см. просьбу не убирать его запросы). forceNew — экран Финансов после этого
    // пересоздаётся заново внизу чата, а не редактируется в старой позиции: старое сообщение
    // могло уже уйти вверх под этим самым сообщением с суммой и стать не видно без прокрутки.
    const payload = await renderScreen(env, firestore, uid, 'finance');
    await renderToMainMenu(env, firestore, token, uid, message.chat.id, payload, { forceNew: true });
    return;
  }
  // Любой другой текст (не команда, не ожидаемая сумма) — тот же AI-ассистент, что и в
  // приложении (см. п.24 исходной просьбы: "та же схема AI работает и для Telegram, не
  // создавать отдельную AI-логику"). planTurn/confirmActions — общие с handleAiChat в этом же
  // файле, разница только в представлении результата (см. renderAiPlanScreen в bot.js).
  await handleAiTurn(env, firestore, token, uid, message.chat.id, message.text);
}

// Текстовый ход AI прямо в боте — планирует действия (planTurn), но ничего не применяет: если
// AI нашёл действия, они кладутся в users/{uid}.pendingAiActions и ждут подтверждения кнопками
// "✅ Добавить всё"/"❌ Отмена" (см. runAction#aiconfirm в bot.js) — тот же принцип "ничего не
// применяется без явного согласия", что и в приложении.
async function handleAiTurn(env, firestore, token, uid, chatId, text) {
  try {
    const provider = createYandexProvider(env);
    const plan = await planTurn(provider, firestore, uid, text);
    await firestore.mergeDoc(`users/${uid}`, { pendingAiActions: plan.actions.length ? plan.actions : null });
    // forceNew — ответ AI всегда заново отправляется внизу чата, у самого поля ввода, а не
    // редактирует старое сообщение на его прежнем месте (оно могло уже уйти вверх под новыми
    // сообщениями переписки и стать не видно без прокрутки — см. просьбу пользователя).
    await renderToMainMenu(env, firestore, token, uid, chatId, renderAiPlanScreen(plan), { forceNew: true });
  } catch (err) {
    console.error('handleAiTurn failed', err);
    await sendMessage(token, chatId, `🤖 AI сейчас недоступен: ${escapeHtml(String(err.message || err))}`);
  }
}

// Голосовое сообщение в Telegram — тот же AI-пайплайн, что и текст (handleAiTurn), плюс
// распознавание речи в начале. В отличие от браузера (см. index.html#audioBlobToPcm16),
// Telegram присылает настоящий Ogg/Opus файл — конвертация не нужна, format:'oggopus' передаётся
// в SpeechKit как есть (см. provider.js#transcribe). Распознанный текст отправляется отдельным
// сообщением ДО ответа AI (п.5 исходной просьбы: пользователь должен видеть, что именно
// распознала система, прежде чем увидит реакцию на это).
async function handleTelegramVoice(env, firestore, token, message) {
  const uid = uidForTelegramId(message.from.id);
  // Telegram, в отличие от веб-клиента (см. AI_VOICE_MAX_SECONDS в index.html), сам запись не
  // ограничивает — без этой проверки пользователь может прислать голосовое на несколько минут,
  // что означает и длинный STT, и огромный вход в YandexGPT. duration Telegram присылает в самом
  // апдейте, поэтому лимит проверяется ДО скачивания файла и ДО любого платного вызова.
  if (Number(message.voice.duration) > AI_VOICE_MAX_SECONDS) {
    await sendMessage(token, message.chat.id, `🎤 Голосовое сообщение длиннее ${AI_VOICE_MAX_SECONDS} секунд — не обработано, запиши покороче.`);
    return;
  }
  try {
    const filePath = await getFilePath(token, message.voice.file_id);
    if (!filePath) throw new Error('Telegram не отдал файл голосового сообщения');
    const file = await fetchTelegramFile(token, filePath);
    if (!file) throw new Error('не удалось скачать голосовое сообщение');
    const audioBytes = await new Response(file.body).arrayBuffer();
    const provider = createYandexProvider(env);
    const transcript = await provider.transcribe(audioBytes, { format: 'oggopus' });
    if (!transcript.trim()) {
      await sendMessage(token, message.chat.id, 'Не удалось распознать речь — попробуй ещё раз или напиши текстом.');
      return;
    }
    await sendMessage(token, message.chat.id, `🎤 <i>${escapeHtml(transcript)}</i>`);
    await handleAiTurn(env, firestore, token, uid, message.chat.id, transcript);
  } catch (err) {
    console.error('handleTelegramVoice failed', err);
    await sendMessage(token, message.chat.id, `🤖 Не получилось распознать голос: ${escapeHtml(String(err.message || err))}`);
  }
}

async function handleTelegramWebhook(req, env, firestore) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const update = await req.json().catch(() => ({}));

  try {
    if (update.message && update.message.text === '/start') {
      const from = update.message.from;
      const loginToken = randomToken();
      const photoFilePath = await getUserProfilePhotoFilePath(token, from.id).catch(() => null);
      await firestore.setDoc(`loginTokens/${loginToken}`, {
        telegramId: from.id,
        username: from.username || null,
        firstName: from.first_name || '',
        lastName: from.last_name || '',
        photoFilePath,
        expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS,
      });
      // Сбой отправки картинок не должен срывать сам вход — это дополнение, поэтому свой
      // try/catch, отдельный от отправки ссылки ниже. Главное меню тут намеренно НЕ создаётся —
      // см. renderToMainMenu в handleTelegramLinkAuth: оно появляется только после того, как
      // пользователь реально откроет приложение по ссылке и войдёт, а не сразу по /start.
      await sendMediaGroup(token, from.id, ONBOARDING_IMAGE_PATHS.map((p) => `${env.APP_URL}/${p}`), ONBOARDING_CAPTION)
        .catch((err) => console.error('sendMediaGroup (onboarding) failed', err));
      await sendMessage(token, from.id, 'Открой приложение — сразу окажешься в своём аккаунте:', {
        reply_markup: {
          inline_keyboard: [[{ text: '📲 Открыть D.N.A.', url: `${env.APP_URL}/?telegram_login=${loginToken}` }]],
        },
      });
    } else if (update.message && update.message.text === '/menu') {
      const from = update.message.from;
      // /menu просто обновляет то же закреплённое сообщение до "Главного меню" — не шлёт
      // отдельную свежую копию (см. просьбу пользователя не плодить сообщения; закреплённое
      // всегда доступно через шапку чата Telegram, прокручивать вверх вручную не нужно).
      // repair:true — форсирует unpinAll+pin даже если правка текста прошла успешно: если из-за
      // прошлых сбоев/пересозданий в чате незаметно накопилось несколько пинов сразу (Telegram
      // их не заменяет автоматически), /menu как раз естественная команда "почини мне меню".
      await renderToMainMenu(env, firestore, token, uidForTelegramId(from.id), from.id, renderHome(), { repair: true });
    } else if (update.callback_query && String(update.callback_query.data).startsWith('s:')) {
      const cq = update.callback_query;
      const uid = uidForTelegramId(cq.from.id);
      const screen = cq.data.slice('s:'.length);
      // Любой обычный переход по меню (включая "❌ Отмена" на экране приглашения, см.
      // renderFinancePromptScreen, и уход с экрана подтверждения действий AI, см.
      // renderAiPlanScreen) снимает оба "жду чего-то" состояния — иначе залипли бы навсегда,
      // если пользователь передумал и ушёл в другой раздел, ничего не подтвердив/не написав.
      await firestore.mergeDoc(`users/${uid}`, { pendingFinanceInput: null, pendingAiActions: null });
      const payload = await renderScreen(env, firestore, uid, screen);
      await answerCallbackQuery(token, cq.id);
      await renderToMainMenu(env, firestore, token, uid, cq.message.chat.id, payload);
    } else if (update.callback_query && String(update.callback_query.data).startsWith('a:')) {
      const cq = update.callback_query;
      const uid = uidForTelegramId(cq.from.id);
      const action = cq.data.slice('a:'.length);
      const result = await runAction(firestore, uid, action);
      await answerCallbackQuery(token, cq.id, result.toast || undefined);
      const payload = await renderScreen(env, firestore, uid, result.nextScreen);
      await renderToMainMenu(env, firestore, token, uid, cq.message.chat.id, payload);
    } else if (update.message && update.message.voice) {
      await handleTelegramVoice(env, firestore, token, update.message);
    } else if (update.message && update.message.text) {
      await handleTelegramFreeText(env, firestore, token, update.message);
    }
  } catch (err) {
    console.error('telegramWebhook failed', err);
  }
  // Telegram ретраит на не-2xx — отвечаем 200 и в случае внутренней ошибки.
  return new Response('ok', { status: 200 });
}

// "Скоро начнётся" — отдельно от дайджестов (см. digest.js): это единственный тип уведомления,
// которому оправданно быть отдельным сообщением вне общего утро/вечер/итог-ритма — важные
// события должны долетать сразу, а не ждать вечернего дайджеста. Тикает каждые 30 минут (тот
// же крон) и ловит события планера, чьё начало попадает в ближайшие полчаса. sentIds на
// сегодня — защита от повторной отправки того же события на следующем тике крона.
async function handlePlannerReminders(env, firestore) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const users = await firestore.listCollection('users');
  const today = todayKey(DEFAULT_TZ);
  for (const { id: uid, data: user } of users) {
    if (user.remindersEnabled === false) continue;
    try {
      const upcoming = await getUpcomingPlannerEvents(firestore, uid, DEFAULT_TZ, 30);
      if (!upcoming.length) continue;
      const statePath = `users/${uid}/appData/plannerReminderState`;
      const state = (await firestore.getDoc(statePath)) || {};
      const alreadySent = state.date === today && Array.isArray(state.sentIds) ? state.sentIds : [];
      const sentSet = new Set(alreadySent);
      const fresh = upcoming.filter((e) => !sentSet.has(e.id));
      if (!fresh.length) continue;
      for (const e of fresh) {
        await sendMessage(token, user.telegramId, `⏰ Скоро: <b>${e.time} ${escapeHtml(e.title)}</b>`);
      }
      await firestore.setDoc(statePath, { date: today, sentIds: [...alreadySent, ...fresh.map((e) => e.id)] });
    } catch (err) {
      console.error(`sendPlannerReminders failed for ${uid}`, err);
    }
  }
}

// Прокси-аватар: /avatar/tg_<telegramId>. Виджет входа даёт готовый публичный URL фото — для
// него достаточно redirect. Вход по ссылке от бота даёт только file_path, который скачивается
// с serverов Telegram лишь вместе с токеном бота — поэтому качаем сами и отдаём уже сами байты,
// токен наружу не уходит. uid не секрет (это просто "tg_<telegramId>", тот же формат, что и
// в Firestore, публично виден любому, кто напишет боту).
async function handleAvatar(env, firestore, uid) {
  const user = await firestore.getDoc(`users/${uid}`);
  if (!user) return new Response('not found', { status: 404 });
  if (user.telegramPhotoUrl) {
    return Response.redirect(user.telegramPhotoUrl, 302);
  }
  if (user.telegramPhotoFilePath) {
    const file = await fetchTelegramFile(env.TELEGRAM_BOT_TOKEN, user.telegramPhotoFilePath);
    if (file) {
      return new Response(file.body, {
        headers: { 'content-type': file.contentType, 'cache-control': 'public, max-age=3600' },
      });
    }
  }
  return new Response('no avatar', { status: 404 });
}

// Проверка личности звонящего для /ai/* — единственные эндпоинты, где клиент действует от
// имени уже вошедшего пользователя (а не просто предъявляет одноразовый токен входа, как
// /telegramLinkAuth). Без этой проверки любой мог бы прислать чужой uid и писать в чужие
// данные (см. п.36 просьбы: "проверить пользователя, проверить права доступа"). Клиент уже
// авторизован в Firebase (signInWithCustomToken после входа через Telegram), поэтому шлёт
// свой обычный Firebase ID-токен — тот же, которым Firestore Security Rules проверяют доступ
// на клиенте; здесь его проверяем сами, без Admin SDK (см. verifyFirebaseIdToken в jwt.js).
async function requireFirebaseUid(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) throw new Error('missing bearer token');
  return verifyFirebaseIdToken(m[1], env.FIREBASE_PROJECT_ID);
}

const AI_CORS_HEADERS = {
  ...CORS_HEADERS,
  'access-control-allow-headers': 'content-type, authorization',
};

// Текстовый ход диалога с AI-ассистентом: {text} -> {reply, actions, rejected}. actions —
// уже провалидированные (см. actions.js), но НЕ применённые действия — клиент показывает их
// пользователю как карточку подтверждения и, если он согласен, шлёт их же на /ai/confirm.
async function handleAiChat(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: AI_CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, AI_CORS_HEADERS);
  let uid;
  try {
    uid = await requireFirebaseUid(req, env);
  } catch (err) {
    return json({ error: 'unauthorized' }, 401, AI_CORS_HEADERS);
  }
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'missing text' }, 400, AI_CORS_HEADERS);
  try {
    const provider = createYandexProvider(env);
    const plan = await planTurn(provider, firestore, uid, text);
    return json(plan, 200, AI_CORS_HEADERS);
  } catch (err) {
    console.error('handleAiChat failed', err);
    return json({ error: 'ai_unavailable', message: String(err.message || err) }, 502, AI_CORS_HEADERS);
  }
}

// Голосовой ход: тело запроса — сырые байты записи (Content-Type: реальный mime от
// MediaRecorder). Сначала распознаём в текст (SpeechKit), дальше — та же логика, что в
// handleAiChat, плюс transcript в ответе, чтобы клиент показал "ты сказал: ..." до ответа AI
// (см. п.5 просьбы: пользователь должен видеть, что именно распознала система).
async function handleAiVoice(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: AI_CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, AI_CORS_HEADERS);
  let uid;
  try {
    uid = await requireFirebaseUid(req, env);
  } catch (err) {
    return json({ error: 'unauthorized' }, 401, AI_CORS_HEADERS);
  }
  // Фронтенд (index.html) всегда шлёт сюда сырой PCM16 моно (декодированный из записи браузера
  // через Web Audio API — см. audioBlobToPcm16), а не оригинальный webm/ogg от MediaRecorder:
  // раньше это поле бралось из mime-типа MediaRecorder напрямую и лейблилось как "oggopus", хотя
  // Chrome/Firefox пишут WebM-контейнер, а не настоящий Ogg — SpeechKit не мог разобрать звук,
  // распознавание просто не работало. Частота дискретизации — из Content-Type (audio/l16;rate=N).
  const contentType = req.headers.get('content-type') || '';
  const rateMatch = /rate=(\d+)/.exec(contentType);
  const sampleRateHertz = rateMatch ? Number(rateMatch[1]) : 16000;
  const audioBytes = await req.arrayBuffer();
  if (!audioBytes.byteLength) return json({ error: 'empty audio' }, 400, AI_CORS_HEADERS);
  // Клиент уже сам не даёт записать больше AI_VOICE_MAX_SECONDS (см. index.html), но это только
  // UX-ограничение — сам эндпоинт публичный по HTTP, поэтому лимит нужно проверить и тут:
  // PCM16 моно — 2 байта на сэмпл, отсюда длительность в секундах без декодирования звука.
  const durationSeconds = audioBytes.byteLength / 2 / sampleRateHertz;
  if (durationSeconds > AI_VOICE_MAX_SECONDS) {
    return json({ error: 'voice_too_long', message: `Голосовое сообщение длиннее ${AI_VOICE_MAX_SECONDS} секунд — не обработано` }, 400, AI_CORS_HEADERS);
  }
  try {
    const provider = createYandexProvider(env);
    const transcript = await provider.transcribe(audioBytes, { format: 'lpcm', sampleRateHertz });
    if (!transcript.trim()) {
      return json({ transcript: '', error: 'empty_transcript' }, 200, AI_CORS_HEADERS);
    }
    const plan = await planTurn(provider, firestore, uid, transcript);
    return json({ transcript, ...plan }, 200, AI_CORS_HEADERS);
  } catch (err) {
    console.error('handleAiVoice failed', err);
    return json({ error: 'ai_unavailable', message: String(err.message || err) }, 502, AI_CORS_HEADERS);
  }
}

// Подтверждение: клиент присылает ровно те actions, что получил от /ai/chat или /ai/voice
// (после того, как пользователь нажал "Добавить всё" — см. п.16 просьбы, ничего не пишется
// без явного подтверждения нескольких изменений сразу). confirmActions заново валидирует
// каждое действие перед исполнением — не доверяет тому, что пришло от клиента, целиком.
async function handleAiConfirm(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: AI_CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, AI_CORS_HEADERS);
  let uid;
  try {
    uid = await requireFirebaseUid(req, env);
  } catch (err) {
    return json({ error: 'unauthorized' }, 401, AI_CORS_HEADERS);
  }
  const body = await req.json().catch(() => ({}));
  const results = await confirmActions(firestore, uid, body.actions);
  return json({ results }, 200, AI_CORS_HEADERS);
}

export default {
  async fetch(req, env) {
    const firestore = createFirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    const url = new URL(req.url);
    if (url.pathname.startsWith('/avatar/')) {
      return handleAvatar(env, firestore, url.pathname.slice('/avatar/'.length));
    }
    switch (url.pathname) {
      case '/telegramAuthVerify':
        return handleTelegramAuthVerify(req, env, firestore);
      case '/telegramLinkAuth':
        return handleTelegramLinkAuth(req, env, firestore);
      case '/telegramWebhook':
        return handleTelegramWebhook(req, env, firestore);
      case '/ai/chat':
        return handleAiChat(req, env, firestore);
      case '/ai/voice':
        return handleAiVoice(req, env, firestore);
      case '/ai/confirm':
        return handleAiConfirm(req, env, firestore);
      default:
        return new Response('not found', { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    const firestore = createFirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    ctx.waitUntil(Promise.all([
      handlePlannerReminders(env, firestore),
      runDailyDigests(env, firestore),
    ]));
  },
};
