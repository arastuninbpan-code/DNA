'use strict';

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

function uidForTelegramId(telegramId) {
  return `tg_${telegramId}`;
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
    const uid = uidForTelegramId(telegramId);
    const userRef = db.doc(`users/${uid}`);
    const snap = await userRef.get();
    if (!snap.exists) {
      await userRef.set({
        telegramId,
        telegramUsername: payload.username || null,
        telegramFirstName: payload.first_name || '',
        linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        reminderHourLocal: 20,
        lastReminderSentDate: null,
      });
    }
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken });
  }
);

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
    if (update.message && update.message.text === '/today') {
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
      await sendMessage(token, update.message.from.id, 'Пока я понимаю только /today 🙂');
    }
    res.status(200).send('ok');
  } catch (err) {
    logger.error('telegramWebhook failed', err);
    res.status(200).send('ok'); // Telegram ретраит на не-2xx — отвечаем 200 и в случае ошибки.
  }
});
