'use strict';

const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const {
  sendMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  verifyLoginWidgetPayload,
} = require('./telegram');
const { DEFAULT_TZ, todayKey, currentHourInTz, getHabitsToday, markHabitDone } = require('./reminders');

admin.initializeApp();
const db = admin.firestore();

const TELEGRAM_BOT_TOKEN = defineSecret('TELEGRAM_BOT_TOKEN');
// Домен, на котором лежит приложение — сюда бот шлёт ссылку для входа в одно касание.
const APP_URL = 'https://arastuninbpan-code.github.io/DNA';
const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;

function uidForTelegramId(telegramId) {
  return `tg_${telegramId}`;
}

// Профиль (имя/юзернейм/фото) обновляем при каждом входе — он может поменяться в Telegram.
// Настройки напоминаний трогаем только при первой привязке, чтобы не затирать то, что
// пользователь мог уже изменить. Используется и виджетом входа, и входом по ссылке от бота —
// оба в итоге создают/обновляют один и тот же users/{uid}.
async function upsertTelegramUser(telegramId, profile) {
  const uid = uidForTelegramId(telegramId);
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  await userRef.set(
    {
      telegramId,
      telegramUsername: profile.username || null,
      telegramFirstName: profile.firstName || '',
      telegramPhotoUrl: profile.photoUrl || null,
      linkedAt: snap.exists ? snap.data().linkedAt : admin.firestore.FieldValue.serverTimestamp(),
      reminderHourLocal: snap.exists ? snap.data().reminderHourLocal : 20,
      lastReminderSentDate: snap.exists ? snap.data().lastReminderSentDate : null,
    },
    { merge: true }
  );
  return uid;
}

function habitsListMessage(list) {
  if (!list.length) return 'На сегодня привычек нет.';
  return list
    .map((h, i) => `${h.done ? '✅' : '▫️'} ${h.name}`)
    .join('\n');
}

function undoneKeyboard(list) {
  const rows = list
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.done)
    .map(({ h, i }) => [{ text: `✅ ${h.name}`, callback_data: `done:${i}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// --- Вход через Telegram Login Widget ---------------------------------------------------
exports.telegramAuthVerify = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN], cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    const token = TELEGRAM_BOT_TOKEN.value();
    const payload = req.body || {};
    if (!verifyLoginWidgetPayload(token, payload)) {
      res.status(401).json({ error: 'invalid telegram signature' });
      return;
    }
    const telegramId = payload.id;
    const uid = await upsertTelegramUser(telegramId, {
      username: payload.username,
      firstName: payload.first_name,
      photoUrl: payload.photo_url,
    });
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken });
  }
);

// --- Вход по одноразовой ссылке из бота (проще виджета — не требует BotFather /setdomain) ---
// Бот при /start кладёт случайный токен в loginTokens/{token} и присылает ссылку вида
// APP_URL?telegram_login=<token>. Открыв её, клиент шлёт токен сюда; мы проверяем, что такой
// токен существует и не протух, сразу удаляем его (одноразовый — как magic-link в email), и
// выдаём тот же custom token, что и вход через виджет.
exports.telegramLinkAuth = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const loginToken = (req.body || {}).token;
  if (!loginToken || typeof loginToken !== 'string') {
    res.status(400).json({ error: 'missing token' });
    return;
  }
  const tokenRef = db.doc(`loginTokens/${loginToken}`);
  const snap = await tokenRef.get();
  if (!snap.exists) {
    res.status(401).json({ error: 'invalid or already used token' });
    return;
  }
  const data = snap.data();
  await tokenRef.delete();
  if (Date.now() > data.expiresAt) {
    res.status(401).json({ error: 'token expired' });
    return;
  }
  const uid = await upsertTelegramUser(data.telegramId, {
    username: data.username,
    firstName: data.firstName,
    photoUrl: data.photoUrl,
  });
  const customToken = await admin.auth().createCustomToken(uid);
  res.json({ customToken });
});

// --- Напоминания по расписанию -----------------------------------------------------------
exports.sendHabitReminders = onSchedule(
  { schedule: 'every 30 minutes', secrets: [TELEGRAM_BOT_TOKEN] },
  async () => {
    const token = TELEGRAM_BOT_TOKEN.value();
    const usersSnap = await db.collection('users').get();
    const today = todayKey(DEFAULT_TZ);
    const hour = currentHourInTz(DEFAULT_TZ);
    for (const doc of usersSnap.docs) {
      const user = doc.data();
      const reminderHour = user.reminderHourLocal ?? 20;
      if (hour < reminderHour) continue;
      if (user.lastReminderSentDate === today) continue;
      const { list } = await getHabitsToday(db, doc.id, DEFAULT_TZ);
      const undone = list.filter((h) => !h.done);
      if (!undone.length) continue;
      try {
        await sendMessage(
          token,
          user.telegramId,
          `Ещё не отмечено сегодня:\n${habitsListMessage(list)}`,
          { reply_markup: undoneKeyboard(list) }
        );
        await doc.ref.update({ lastReminderSentDate: today });
      } catch (err) {
        logger.error(`sendHabitReminders failed for ${doc.id}`, err);
      }
    }
  }
);

// --- Webhook: команды и кнопки бота -------------------------------------------------------
exports.telegramWebhook = onRequest({ secrets: [TELEGRAM_BOT_TOKEN] }, async (req, res) => {
  const token = TELEGRAM_BOT_TOKEN.value();
  const update = req.body || {};

  try {
    if (update.message && update.message.text === '/start') {
      const from = update.message.from;
      const loginToken = crypto.randomBytes(32).toString('hex');
      await db.doc(`loginTokens/${loginToken}`).set({
        telegramId: from.id,
        username: from.username || null,
        firstName: from.first_name || '',
        photoUrl: null,
        expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS,
      });
      await sendMessage(token, from.id, 'Открой приложение — сразу окажешься в своём аккаунте:', {
        reply_markup: {
          inline_keyboard: [[{ text: '📲 Открыть D.N.A.', url: `${APP_URL}/?telegram_login=${loginToken}` }]],
        },
      });
    } else if (update.message && update.message.text === '/today') {
      const telegramId = update.message.from.id;
      const uid = uidForTelegramId(telegramId);
      const { list } = await getHabitsToday(db, uid, DEFAULT_TZ);
      await sendMessage(token, telegramId, habitsListMessage(list), {
        reply_markup: undoneKeyboard(list),
      });
    } else if (update.callback_query && String(update.callback_query.data).startsWith('done:')) {
      const cq = update.callback_query;
      const telegramId = cq.from.id;
      const uid = uidForTelegramId(telegramId);
      const index = Number(cq.data.slice('done:'.length));
      const { dateKey, list } = await getHabitsToday(db, uid, DEFAULT_TZ);
      if (list[index]) {
        await markHabitDone(db, uid, dateKey, index, true);
        await answerCallbackQuery(token, cq.id, `Готово: ${list[index].name}`);
        const updated = [...list];
        updated[index] = { ...updated[index], done: true };
        await editMessageReplyMarkup(
          token,
          cq.message.chat.id,
          cq.message.message_id,
          undoneKeyboard(updated) || { inline_keyboard: [] }
        );
      } else {
        await answerCallbackQuery(token, cq.id, 'Не нашёл эту привычку — возможно, список уже обновился.');
      }
    } else if (update.message && update.message.text) {
      await sendMessage(token, update.message.from.id, 'Пока я понимаю только /start и /today 🙂');
    }
    res.status(200).send('ok');
  } catch (err) {
    logger.error('telegramWebhook failed', err);
    res.status(200).send('ok'); // Telegram ретраит на не-2xx — отвечаем 200 и в случае ошибки.
  }
});
