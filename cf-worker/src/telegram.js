// Тонкие обёртки над Telegram Bot API через fetch — без сторонних библиотек, тот же подход,
// что был в функции functions/telegram.js (Firebase-вариант), только HMAC теперь через
// Web Crypto (Node'овского crypto.createHmac в Workers нет).

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

export function sendMessage(token, chatId, text, options = {}) {
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export function answerCallbackQuery(token, callbackQueryId, text) {
  return callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

export function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

export function setWebhook(token, url) {
  return callTelegram(token, 'setWebhook', { url });
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Проверка подписи Telegram Login Widget — алгоритм из официальной документации:
// secret_key = SHA256(bot_token); hash должен совпасть с HMAC_SHA256(data_check_string, secret_key),
// где data_check_string — все поля кроме hash, отсортированные по ключу, "key=value" через \n.
export async function verifyLoginWidgetPayload(token, payload) {
  const { hash, ...fields } = payload;
  if (!hash) return false;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKeyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(dataCheckString));
  const computedHash = bytesToHex(signature);

  if (!timingSafeEqualHex(computedHash, hash)) return false;
  const authDate = Number(fields.auth_date);
  const ageSeconds = Date.now() / 1000 - authDate;
  // Защита от replay — payload старше суток не принимаем.
  return ageSeconds >= 0 && ageSeconds < 86400;
}
