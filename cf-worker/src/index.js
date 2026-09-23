// Cloudflare Worker — замена Firebase Cloud Functions (functions/index.js), перенесённая
// один в один по логике, только под другую платформу: пользователю с российской картой
// невозможно включить Blaze-план Firebase (нужна оплата), а у Cloudflare Workers щедрый
// бесплатный тариф без привязки карты вообще. База данных (Firestore) не переносится —
// остаётся той же, Worker обращается к ней напрямую через REST API (см. firestore.js).
import { createFirestoreClient } from './firestore.js';
import { createCustomToken } from './googleAuth.js';
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup, verifyLoginWidgetPayload } from './telegram.js';
import { DEFAULT_TZ, todayKey, currentHourInTz, getHabitsToday, markHabitDone } from './reminders.js';

const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;

function uidForTelegramId(telegramId) {
  return `tg_${telegramId}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function habitsListMessage(list) {
  if (!list.length) return 'На сегодня привычек нет.';
  return list.map((h) => `${h.done ? '✅' : '▫️'} ${h.name}`).join('\n');
}

function undoneKeyboard(list) {
  const rows = list
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.done)
    .map(({ h, i }) => [{ text: `✅ ${h.name}`, callback_data: `done:${i}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
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
    telegramPhotoUrl: profile.photoUrl || null,
    linkedAt: existing ? existing.linkedAt ?? Date.now() : Date.now(),
    reminderHourLocal: existing ? existing.reminderHourLocal ?? 20 : 20,
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
    photoUrl: payload.photo_url,
  });
  const customToken = await createCustomToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY, uid);
  return json({ customToken }, 200, CORS_HEADERS);
}

// Вход по одноразовой ссылке из бота (проще виджета — не требует BotFather /setdomain). Бот
// при /start кладёт случайный токен в loginTokens/{token} и присылает ссылку вида
// APP_URL?telegram_login=<token>. Открыв её, клиент шлёт токен сюда; мы проверяем, что такой
// токен существует и не протух, сразу удаляем его (одноразовый — как magic-link в email), и
// выдаём тот же custom token, что и вход через виджет.
async function handleTelegramLinkAuth(req, env, firestore) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS_HEADERS);
  const body = await req.json().catch(() => ({}));
  const loginToken = body.token;
  if (!loginToken || typeof loginToken !== 'string') return json({ error: 'missing token' }, 400, CORS_HEADERS);

  const tokenPath = `loginTokens/${loginToken}`;
  const data = await firestore.getDoc(tokenPath);
  if (!data) return json({ error: 'invalid or already used token' }, 401, CORS_HEADERS);
  await firestore.deleteDoc(tokenPath);
  if (Date.now() > data.expiresAt) return json({ error: 'token expired' }, 401, CORS_HEADERS);

  const uid = await upsertTelegramUser(firestore, data.telegramId, {
    username: data.username,
    firstName: data.firstName,
    photoUrl: data.photoUrl,
  });
  const customToken = await createCustomToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY, uid);
  return json({ customToken }, 200, CORS_HEADERS);
}

async function handleTelegramWebhook(req, env, firestore) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const update = await req.json().catch(() => ({}));

  try {
    if (update.message && update.message.text === '/start') {
      const from = update.message.from;
      const loginToken = randomToken();
      await firestore.setDoc(`loginTokens/${loginToken}`, {
        telegramId: from.id,
        username: from.username || null,
        firstName: from.first_name || '',
        photoUrl: null,
        expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS,
      });
      await sendMessage(token, from.id, 'Открой приложение — сразу окажешься в своём аккаунте:', {
        reply_markup: {
          inline_keyboard: [[{ text: '📲 Открыть D.N.A.', url: `${env.APP_URL}/?telegram_login=${loginToken}` }]],
        },
      });
    } else if (update.message && update.message.text === '/today') {
      const telegramId = update.message.from.id;
      const uid = uidForTelegramId(telegramId);
      const { list } = await getHabitsToday(firestore, uid, DEFAULT_TZ);
      await sendMessage(token, telegramId, habitsListMessage(list), { reply_markup: undoneKeyboard(list) });
    } else if (update.callback_query && String(update.callback_query.data).startsWith('done:')) {
      const cq = update.callback_query;
      const telegramId = cq.from.id;
      const uid = uidForTelegramId(telegramId);
      const index = Number(cq.data.slice('done:'.length));
      const { dateKey, list } = await getHabitsToday(firestore, uid, DEFAULT_TZ);
      if (list[index]) {
        await markHabitDone(firestore, uid, dateKey, index, true);
        await answerCallbackQuery(token, cq.id, `Готово: ${list[index].name}`);
        const updated = [...list];
        updated[index] = { ...updated[index], done: true };
        await editMessageReplyMarkup(token, cq.message.chat.id, cq.message.message_id, undoneKeyboard(updated) || { inline_keyboard: [] });
      } else {
        await answerCallbackQuery(token, cq.id, 'Не нашёл эту привычку — возможно, список уже обновился.');
      }
    } else if (update.message && update.message.text) {
      await sendMessage(token, update.message.from.id, 'Пока я понимаю только /start и /today 🙂');
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

// ВРЕМЕННЫЙ диагностический эндпоинт — не раскрывает сам ключ, только его форму (длину,
// первые/последние символы — это всегда открытый текст BEGIN/END, не секрет), чтобы понять,
// что именно сломано во вставленном FIREBASE_PRIVATE_KEY. Убрать после починки.
function handleDebugKey(env) {
  const raw = env.FIREBASE_PRIVATE_KEY || '';
  const weird = [...new Set(raw.replace(/[A-Za-z0-9+/=\-\s]/g, '').split(''))];
  return json({
    checkedAt: new Date().toISOString(),
    length: raw.length,
    first30: raw.slice(0, 30),
    last30: raw.slice(-30),
    hasLiteralBackslashN: raw.includes('\\n'),
    hasRealNewline: /\n/.test(raw),
    unexpectedChars: weird.map((c) => ({ char: c, code: c.charCodeAt(0) })),
  });
}

export default {
  async fetch(req, env) {
    const firestore = createFirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/debugKey':
        return handleDebugKey(env);
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
    ctx.waitUntil(handleScheduledReminders(env, firestore));
  },
};
