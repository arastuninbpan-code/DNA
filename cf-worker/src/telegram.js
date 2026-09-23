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

// Альбом фото по URL (без multipart-аплоада — картинки уже публично лежат на GitHub Pages
// рядом с самим приложением, см. handleTelegramWebhook#/start). Подпись показывается только
// под ПЕРВЫМ элементом альбома — так задумано Telegram API, не баг.
export function sendMediaGroup(token, chatId, photoUrls, caption) {
  const media = photoUrls.map((url, i) => ({
    type: 'photo',
    media: url,
    ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
  }));
  return callTelegram(token, 'sendMediaGroup', { chat_id: chatId, media });
}

export function editMessageText(token, chatId, messageId, text, options = {}) {
  return callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
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

// Удаление сообщения (не просто открепление) — нужно при пересоздании главного меню, чтобы
// старое действительно пропадало из чата, а не просто переставало значиться закреплённым
// (unpinAllChatMessages выше снимает статус "закреплено", но само сообщение остаётся в истории).
export function deleteMessage(token, chatId, messageId) {
  return callTelegram(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function setWebhook(token, url) {
  return callTelegram(token, 'setWebhook', { url });
}

// Закрепление главного меню (см. bot.js#renderToMainMenu) — disable_notification, чтобы пиннинг
// не присылал пользователю отдельное системное уведомление "закреплено сообщение".
export function pinChatMessage(token, chatId, messageId) {
  return callTelegram(token, 'pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
}

// Текущее состояние чата, в частности chat.pinned_message — источник истины о том, что сейчас
// реально закреплено (см. bot.js#renderToMainMenu): наша копия message_id в Firestore может
// устареть, если пользователь открепил сообщение сам или очистил историю чата. ВАЖНО: это поле
// отдаёт только САМЫЙ СВЕЖИЙ пин — Telegram допускает несколько закреплённых сообщений сразу
// (pinChatMessage не открепляет предыдущее автоматически), так что по одному getChat нельзя
// узнать, не накопились ли позади ещё старые — см. unpinAllChatMessages ниже.
export function getChat(token, chatId) {
  return callTelegram(token, 'getChat', { chat_id: chatId });
}

// Открепить ВСЕ закреплённые сообщения чата разом — вызываем перед каждым (пере)закреплением
// главного меню, чтобы гарантированно оставалось ровно одно закреплённое сообщение, а не
// накапливался стек из прошлых пересозданий (см. renderToMainMenu в bot.js).
export function unpinAllChatMessages(token, chatId) {
  return callTelegram(token, 'unpinAllChatMessages', { chat_id: chatId });
}

// Возвращает file_path (не URL!) самого маленького варианта фото профиля — этого достаточно
// для маленького круглого аватара в интерфейсе. file_path сам по себе не секрет, но получить
// по нему файл можно только вместе с токеном бота — поэтому отдаём его клиенту не напрямую,
// а через прокси-роут /avatar/:uid в index.js (см. handleAvatar), не раскрывая токен.
export async function getUserProfilePhotoFilePath(token, userId) {
  const res = await fetch(`${apiUrl(token, 'getUserProfilePhotos')}?user_id=${userId}&limit=1`);
  const json = await res.json();
  if (!json.ok || !json.result.photos.length) return null;
  const fileId = json.result.photos[0][0].file_id;
  const fileRes = await fetch(`${apiUrl(token, 'getFile')}?file_id=${fileId}`);
  const fileJson = await fileRes.json();
  return fileJson.ok ? fileJson.result.file_path : null;
}

// Скачивает файл с серверов Telegram (для прокси — токен остаётся на сервере, наружу уходит
// только сам файл). Возвращает { body, contentType } или null, если Telegram не отдал файл.
export async function fetchTelegramFile(token, filePath) {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) return null;
  return { body: res.body, contentType: res.headers.get('content-type') || 'image/jpeg' };
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
