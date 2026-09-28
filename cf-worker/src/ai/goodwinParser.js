// Разбор пересланных уведомлений от бота "Гудвин" (назначение "игр" — выездных
// мероприятий/анимации) — по просьбе пользователя: формат ВСЕГДА одинаковый (см. живой пример),
// поэтому для него не нужен ни один AI-вызов (п.7 аудита: "простой parser -> сначала обычный
// код"). Сигнатура жёсткая ("Тебе назначили N игр") — случайно совпасть с обычным сообщением
// пользователя практически невозможно, поэтому этот разбор пробуется в router.js ПЕРВЫМ, ещё до
// tryLocalParse, а не гадает при малейшей неуверенности: если сигнатура есть, а дату или хотя бы
// одну игру распознать не удалось — отдаём null целиком (сообщение уйдёт в Lite как обычно), а не
// создаём часть событий наугад.
//
// Пример сообщения:
//   🎧 Тебе назначили 2 игры
//   📅 Суббота, 3 октября
//   15:30 · Дарья Лев
//   🥂 Лаундж / малая студия · 10 гостей · 🎉 Детский день рождения
//   📞 +7 910 888-72-27
//   📍 ул. Рождественская 13
//   ─────────────
//   19:30 · Илья
//   ...
//   Подтверди участие кнопкой ниже 👇
//   ✅ Подтверждено игр: 2. Они в «Моих играх» в приложении.
import { pluralRu } from '../reminders.js';

const SIGNATURE = /Тебе\s+назначили\s+\d+\s+игр/i;
const RU_MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};
const DATE_LINE = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i;
const TIME_NAME_LINE = /^(\d{1,2}):(\d{2})\s*[·•\-—]\s*(.+)$/;
// гост[а-яё]*, не гост\w* — \w не видит кириллицу (см. шапку localParser.js в этом же проекте:
// та же ошибка там уже документирована как известный баг), "\w*" после "гост" никогда не съел бы
// "ей"/"я" и регэксп ни разу не совпал бы — ровно это и произошло при первой проверке этого файла
// (см. goodwin-bench.mjs): адрес и место проведения перепутались местами.
const VENUE_LINE = /^(.+?)\s*[·•]\s*(\d+)\s*гост[а-яё]*\s*[·•]\s*(.+)$/i;
const SEPARATOR_LINE = /^[\s_\-─—]{3,}$/;
const TRAILER_LINE = /^(Подтверди\s+участие|✅?\s*Подтверждено)/i;

// Ведущий эмодзи-значок (📞/📍 и т.п.) — не входит ни в \w, ни в \p{L}\p{N}, поэтому просто срезаем
// всё, что не буква/цифра, с начала строки, а не держим список конкретных иконок (Гудвин может
// сменить их в любой момент, смысл строки от этого не изменится).
function stripLeadingIcon(line) {
  return line.replace(/^[^\p{L}\p{N}+]+/u, '').trim();
}

function extractPhone(line) {
  const m = line.match(/(\+?\d[\d\s\-()]{8,}\d)/);
  return m ? m[1].trim() : null;
}

// Год не указан в сообщении Гудвина вообще — Гудвин никогда не пришлёт уведомление про уже
// прошедшую игру, поэтому если дата с текущим годом уже в прошлом относительно сегодня, это
// значит "того же числа, но в следующем году" (актуально в основном для сообщений в конце
// декабря про начало января).
function resolveYear(day, month, todayKey) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = todayKey();
  const [ty] = today.split('-').map(Number);
  let dateKey = `${ty}-${pad(month)}-${pad(day)}`;
  if (dateKey < today) dateKey = `${ty + 1}-${pad(month)}-${pad(day)}`;
  return dateKey;
}

export function tryParseGoodwinMessage(text, todayKey) {
  const raw = String(text || '');
  if (!SIGNATURE.test(raw)) return null;

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const dateLine = lines.find((l) => DATE_LINE.test(l));
  const dm = dateLine && DATE_LINE.exec(dateLine);
  if (!dm) return null; // сигнатура есть, а дату не нашли — не уверены, лучше отдать Lite

  const day = Number(dm[1]);
  const month = RU_MONTHS[dm[2].toLowerCase()];
  const dateKey = resolveYear(day, month, todayKey);

  const dateIdx = lines.indexOf(dateLine);
  const body = lines.slice(dateIdx + 1).filter((l) => !TRAILER_LINE.test(l));

  const games = [];
  let current = null;
  for (const line of body) {
    if (SEPARATOR_LINE.test(line)) continue;
    const timeMatch = TIME_NAME_LINE.exec(line);
    if (timeMatch) {
      if (current) games.push(current);
      current = {
        time: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
        name: timeMatch[3].trim(),
        venue: null, guests: null, eventType: null, phone: null, address: null,
      };
      continue;
    }
    if (!current) continue; // строка до первой игры — заголовок/мусор, пропускаем
    const venueMatch = VENUE_LINE.exec(line);
    if (venueMatch) {
      current.venue = stripLeadingIcon(venueMatch[1]);
      current.guests = venueMatch[2];
      current.eventType = stripLeadingIcon(venueMatch[3]);
      continue;
    }
    const phone = extractPhone(line);
    if (phone) { current.phone = phone; continue; }
    if (!current.address) current.address = stripLeadingIcon(line);
  }
  if (current) games.push(current);
  if (!games.length) return null;

  const actions = games.map((g) => {
    const title = g.eventType ? `${g.name} — ${g.eventType}` : g.name;
    const noteParts = [];
    const venueLine = [g.venue, g.guests ? `${g.guests} ${pluralRu(Number(g.guests), 'гость', 'гостя', 'гостей')}` : null]
      .filter(Boolean).join(' · ');
    if (venueLine) noteParts.push(venueLine);
    if (g.phone) noteParts.push(`📞 ${g.phone}`);
    if (g.address) noteParts.push(`📍 ${g.address}`);
    const action = { action: 'create_event', title, date: dateKey, time: g.time };
    if (noteParts.length) action.note = noteParts.join('\n');
    return action;
  });

  const label = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}`;
  const list = actions.map((a) => `${a.title} — ${a.time}`).join('; ');
  const count = actions.length;
  return {
    actions,
    reply: `Вот что сделаю: добавлю ${count} ${pluralRu(count, 'игру', 'игры', 'игр')} от Гудвина в Планер на ${label}: ${list}.`,
  };
}
