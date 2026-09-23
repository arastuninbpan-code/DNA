// Тонкие обёртки над Telegram Bot API через встроенный fetch (Node 20) — без сторонних
// библиотек, чтобы держать поверхность зависимостей минимальной для личного проекта.
'use strict';

const crypto = require('crypto');

const API_BASE = 'https://api.telegram.org/bot';

function apiUrl(token, method) {
  return `${API_BASE}${token}/${method}`;
}

async function callTelegram(token, method, payload) {
  const res = await fetch(apiUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram API ${method} failed: ${json.description || res.status}`);
  }
  return json.result;
}

function sendMessage(token, chatId, text, options = {}) {
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

function answerCallbackQuery(token, callbackQueryId, text) {
  return callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

function setWebhook(token, url) {
  return callTelegram(token, 'setWebhook', { url });
}

// Проверка подписи Telegram Login Widget — алгоритм из официальной документации:
// secret_key = SHA256(bot_token); hash должен совпасть с HMAC_SHA256(data_check_string, secret_key),
// где data_check_string — все поля кроме hash, отсортированные по ключу, "key=value" через \n.
function verifyLoginWidgetPayload(token, payload) {
  const { hash, ...fields } = payload;
  if (!hash) return false;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(token).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  if (computedHash.length !== hash.length) return false;
  const isValid = crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash));
  if (!isValid) return false;
  const authDate = Number(fields.auth_date);
  const ageSeconds = Date.now() / 1000 - authDate;
  // Защита от replay — payload старше суток не принимаем.
  return ageSeconds >= 0 && ageSeconds < 86400;
}

module.exports = {
  sendMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  setWebhook,
  verifyLoginWidgetPayload,
};
