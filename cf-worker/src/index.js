// Cloudflare Worker — замена Firebase Cloud Functions (functions/index.js), перенесённая
// один в один по логике, только под другую платформу: пользователю с российской картой
// невозможно включить Blaze-план Firebase (нужна оплата), а у Cloudflare Workers щедрый
// бесплатный тариф без привязки карты вообще. База данных (Firestore) не переносится —
// остаётся той же, Worker обращается к ней напрямую через REST API (см. firestore.js).
import { createFirestoreClient } from './firestore.js';
import { createCustomToken } from './googleAuth.js';
import {
  sendMessage, sendMediaGroup, editMessageText, answerCallbackQuery,
  verifyLoginWidgetPayload, getUserProfilePhotoFilePath, fetchTelegramFile,
} from './telegram.js';
import {
  DEFAULT_TZ, todayKey, currentHourInTz, getHabitsToday, markHabitDone,
  getPlannerToday, markPlannerDone, getUpcomingPlannerEvents,
} from './reminders.js';

// Полчаса — достаточно, чтобы спокойно открыть одну и ту же ссылку и с телефона, и с
// компьютера, не отправляя /start заново под каждое устройство (ссылка теперь не
// одноразовая, см. handleTelegramLinkAuth).
const LOGIN_TOKEN_TTL_MS = 30 * 60 * 1000;

function uidForTelegramId(telegramId) {
  return `tg_${telegramId}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// sendMessage/editMessageText шлют с parse_mode 'HTML' — имена привычек и названия событий
// вводит сам пользователь и могут содержать <, >, & — без экранирования Telegram либо
// сломает разметку, либо вовсе отклонит вызов API.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function habitsListMessage(list) {
  if (!list.length) return 'На сегодня привычек нет.';
  return list.map((h) => `${h.done ? '✅' : '▫️'} ${escapeHtml(h.name)}`).join('\n');
}

function habitsUndoneRows(list) {
  return list
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.done)
    .map(({ h, i }) => [{ text: `✅ ${h.name}`.slice(0, 64), callback_data: `done:${i}` }]);
}

function undoneKeyboard(list) {
  const rows = habitsUndoneRows(list);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function plannerListMessage(list) {
  if (!list.length) return 'На сегодня в планере пусто.';
  return list.map((e) => `${e.done ? '✅' : '▫️'} ${e.time ? e.time + ' ' : ''}${escapeHtml(e.title)}`).join('\n');
}

function plannerUndoneRows(list) {
  return list
    .filter((e) => !e.done)
    .map((e) => [{ text: `✅ ${e.time ? e.time + ' ' : ''}${e.title}`.slice(0, 64), callback_data: `plandone:${e.id}` }]);
}

// Единая "вкладочная" карточка /today — переключение между привычками и планом на день одной
// кнопкой снизу (редактируется то же сообщение, не шлём новое) — то самое "переключение между
// разделами" из бота, о котором просили: не отдельные несвязанные команды, а один экран.
function todayViewPayload(kind, habits, planner) {
  const switchButton = kind === 'planner'
    ? { text: '🎯 Привычки', callback_data: 'view:habits' }
    : { text: '📅 План на сегодня', callback_data: 'view:planner' };
  if (kind === 'planner') {
    return {
      text: `📅 <b>План на сегодня</b>\n\n${plannerListMessage(planner)}`,
      reply_markup: { inline_keyboard: [...plannerUndoneRows(planner), [switchButton]] },
    };
  }
  return {
    text: `🎯 <b>Привычки на сегодня</b>\n\n${habitsListMessage(habits)}`,
    reply_markup: { inline_keyboard: [...habitsUndoneRows(habits), [switchButton]] },
  };
}

async function loadTodayView(firestore, uid, kind) {
  const [{ list: habits }, { list: planner }] = await Promise.all([
    getHabitsToday(firestore, uid, DEFAULT_TZ),
    getPlannerToday(firestore, uid, DEFAULT_TZ),
  ]);
  return todayViewPayload(kind, habits, planner);
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
    // напрямую в users/{uid} (правила Firestore это уже разрешают). Затрагивает и привычки,
    // и напоминания о событиях планера (см. handleScheduledReminders/handlePlannerReminders).
    remindersEnabled: existing ? existing.remindersEnabled ?? true : true,
    lastReminderSentDate: existing ? existing.lastReminderSentDate ?? null : null,
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
      // Сбой отправки картинок не должен срывать сам вход — это просто приятное дополнение,
      // поэтому свой try/catch, отдельный от отправки ссылки ниже.
      await sendMediaGroup(token, from.id, ONBOARDING_IMAGE_PATHS.map((p) => `${env.APP_URL}/${p}`), ONBOARDING_CAPTION)
        .catch((err) => console.error('sendMediaGroup (onboarding) failed', err));
      await sendMessage(token, from.id, 'Открой приложение — сразу окажешься в своём аккаунте:', {
        reply_markup: {
          inline_keyboard: [[{ text: '📲 Открыть D.N.A.', url: `${env.APP_URL}/?telegram_login=${loginToken}` }]],
        },
      });
    } else if (update.message && (update.message.text === '/today' || update.message.text === '/plan')) {
      const telegramId = update.message.from.id;
      const uid = uidForTelegramId(telegramId);
      const kind = update.message.text === '/plan' ? 'planner' : 'habits';
      const view = await loadTodayView(firestore, uid, kind);
      await sendMessage(token, telegramId, view.text, { reply_markup: view.reply_markup });
    } else if (update.callback_query && (update.callback_query.data === 'view:habits' || update.callback_query.data === 'view:planner')) {
      const cq = update.callback_query;
      const uid = uidForTelegramId(cq.from.id);
      const kind = cq.data.slice('view:'.length);
      const view = await loadTodayView(firestore, uid, kind);
      await answerCallbackQuery(token, cq.id);
      await editMessageText(token, cq.message.chat.id, cq.message.message_id, view.text, { reply_markup: view.reply_markup });
    } else if (update.callback_query && String(update.callback_query.data).startsWith('plandone:')) {
      const cq = update.callback_query;
      const uid = uidForTelegramId(cq.from.id);
      const eventId = cq.data.slice('plandone:'.length);
      const updated = await markPlannerDone(firestore, uid, eventId, true);
      if (updated) {
        await answerCallbackQuery(token, cq.id, `Готово: ${updated.title}`);
        const view = await loadTodayView(firestore, uid, 'planner');
        await editMessageText(token, cq.message.chat.id, cq.message.message_id, view.text, { reply_markup: view.reply_markup });
      } else {
        await answerCallbackQuery(token, cq.id, 'Не нашёл это событие — возможно, список уже обновился.');
      }
    } else if (update.callback_query && String(update.callback_query.data).startsWith('done:')) {
      const cq = update.callback_query;
      const uid = uidForTelegramId(cq.from.id);
      const index = Number(cq.data.slice('done:'.length));
      const { dateKey, list } = await getHabitsToday(firestore, uid, DEFAULT_TZ);
      if (list[index]) {
        await markHabitDone(firestore, uid, dateKey, index, true);
        await answerCallbackQuery(token, cq.id, `Готово: ${list[index].name}`);
        const view = await loadTodayView(firestore, uid, 'habits');
        await editMessageText(token, cq.message.chat.id, cq.message.message_id, view.text, { reply_markup: view.reply_markup });
      } else {
        await answerCallbackQuery(token, cq.id, 'Не нашёл эту привычку — возможно, список уже обновился.');
      }
    } else if (update.message && update.message.text) {
      await sendMessage(token, update.message.from.id, 'Понимаю команды:\n/today — привычки и план на сегодня\n/plan — сразу план на сегодня');
    }
  } catch (err) {
    console.error('telegramWebhook failed', err);
  }
  // Telegram ретраит на не-2xx — отвечаем 200 и в случае внутренней ошибки.
  return new Response('ok', { status: 200 });
}

async function handleScheduledReminders(env, firestore) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const users = await firestore.listCollection('users');
  const today = todayKey(DEFAULT_TZ);
  const hour = currentHourInTz(DEFAULT_TZ);
  for (const { id: uid, data: user } of users) {
    if (user.remindersEnabled === false) continue;
    const reminderHour = user.reminderHourLocal ?? 20;
    if (hour < reminderHour) continue;
    if (user.lastReminderSentDate === today) continue;
    const { list } = await getHabitsToday(firestore, uid, DEFAULT_TZ);
    const undone = list.filter((h) => !h.done);
    if (!undone.length) continue;
    try {
      await sendMessage(token, user.telegramId, `Ещё не отмечено сегодня:\n${habitsListMessage(list)}`, {
        reply_markup: undoneKeyboard(list),
      });
      await firestore.mergeDoc(`users/${uid}`, { lastReminderSentDate: today });
    } catch (err) {
      console.error(`sendHabitReminders failed for ${uid}`, err);
    }
  }
}

// "Скоро начнётся" — отдельно от вечернего напоминания по привычкам: тикает каждые 30 минут
// (тот же крон) и ловит события планера, чьё начало попадает в ближайшие полчаса. sentIds
// на сегодня — защита от повторной отправки того же события на следующем тике крона.
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
      default:
        return new Response('not found', { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    const firestore = createFirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    ctx.waitUntil(Promise.all([
      handleScheduledReminders(env, firestore),
      handlePlannerReminders(env, firestore),
    ]));
  },
};
