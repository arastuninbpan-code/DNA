// Общая логика чтения/изменения "сегодняшних" привычек пользователя — используется и
// планировщиком напоминаний (scheduled-хендлер), и командой /today, и кнопкой "Готово" в
// вебхуке, чтобы дата и формат не разъезжались между тремя местами. Порт 1:1 с
// functions/reminders.js (Firebase-вариант) — только вместо Admin SDK берёт firestore-клиент.

export const DEFAULT_TZ = 'Europe/Moscow';

// sendMessage/editMessageText шлют с parse_mode 'HTML' — свободный текст (имена привычек,
// названия задач/событий) вводит сам пользователь и может содержать <, >, & — без экранирования
// Telegram либо сломает разметку, либо вовсе отклонит вызов API. Общая утилита — нужна и
// index.js, и digest.js, поэтому здесь, а не продублирована в обоих местах.
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 'YYYY-MM-DD' в заданной IANA-таймзоне — тот же формат ключа, что использует клиент
// (habitDateKey в index.html), но посчитанный на сервере независимо от таймзоны машины.
export function todayKey(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function currentHourInTz(tz = DEFAULT_TZ) {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr);
}

// Минуты с полуночи в заданной таймзоне — нужно для сравнения с e.time ('HH:MM') у событий
// планера при напоминаниях "скоро начнётся" (currentHourInTz даёт только целый час).
export function currentMinutesInTz(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return get('hour') * 60 + get('minute');
}

export function timeToMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// "tg_<telegramId>" — тот же детерминированный uid, что и everywhere в проекте (Firebase custom
// token, Firestore-документ пользователя); нужен и вебхуку, и дайджестам, и меню бота, поэтому
// общая функция, а не три копии.
export function uidForTelegramId(telegramId) {
  return `tg_${telegramId}`;
}

// Стандартное русское согласование числительного с существительным (1 день / 2 дня / 5 дней) —
// общая утилита для дайджестов и меню бота.
export function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatRub(n) {
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
  } catch (_) {
    return `${Math.round(n)} ₽`;
  }
}

// dateKey ('YYYY-MM-DD') ± N дней — простая календарная арифметика без библиотек, достаточно
// для "вчера"/"завтра" при обходе истории привычек и плана на следующий день.
export function dateKeyAddDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Весь документ привычек разом (не по одной дате) — нужен дайджесту (см. digest.js) для
// подсчёта стриков по каждой привычке отдельно: там придётся пройти историю за много дней,
// а один getDoc дешевле, чем дергать Firestore за каждый день истории по отдельности.
export async function getHabitsDoc(firestore, uid) {
  return (await firestore.getDoc(`users/${uid}/appData/habits`)) || {};
}

export function habitsOn(habitsDoc, dateKey) {
  return Array.isArray(habitsDoc[dateKey]) ? habitsDoc[dateKey] : [];
}

// Аналогично — весь планер разом, чтобы digest.js мог посмотреть и сегодня, и завтра одним
// чтением, не заводя отдельный вызов на каждый день (getPlannerToday ниже это делает и
// остаётся как есть — им уже пользуются /today и напоминания о скором событии).
export async function getPlannerDoc(firestore, uid) {
  return (await firestore.getDoc(`users/${uid}/appData/planner`)) || {};
}

// Разница в днях между двумя dateKey (b - a) — нужна ниже, чтобы понять, попадает ли dateKey
// внутрь многодневного события, не таская отдельную библиотеку дат.
function dateKeyDiffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Модель данных события — не date+endDate, а date+time+duration в минутах (форма редактирования
// сама переводит выбранную дату/время окончания в duration при сохранении, см. commitForm в
// index.html); duration может быть больше 1440 — тогда событие растягивается на несколько дней.
// dateKey входит в событие, если это его якорная дата (как раньше) ИЛИ dateKey попадает в
// открытый интервал [start, start+duration) относительно якорной даты. Для события без времени
// отсчитываем от начала суток (00:00) якорной даты — так же, как duration вычисляется в форме.
function eventCoversDate(e, dateKey) {
  if (e.date === dateKey) return true;
  if (!e.duration || e.duration <= 1440) return false;
  const dayDiff = dateKeyDiffDays(e.date, dateKey);
  if (dayDiff <= 0) return false;
  const startMin = timeToMinutes(e.time) ?? 0;
  const dayStart = dayDiff * 1440;
  return startMin + e.duration > dayStart;
}

export function plannerOn(plannerDoc, dateKey) {
  const events = Array.isArray(plannerDoc.events) ? plannerDoc.events : [];
  return events
    .filter((e) => e && eventCoversDate(e, dateKey))
    .sort((a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999));
}

// Планер хранится целиком одним документом (см. plannerSnapshot в index.html) — {events,
// sections, pollVotes}. Тут читаем только события на сегодня (e.date === сегодняшний ключ),
// отсортированные: сначала с временем (по времени), потом без времени (задачи на день).
export async function getPlannerToday(firestore, uid, tz = DEFAULT_TZ) {
  const dateKey = todayKey(tz);
  const data = (await firestore.getDoc(`users/${uid}/appData/planner`)) || {};
  const events = Array.isArray(data.events) ? data.events : [];
  const list = events
    .filter((e) => e && e.date === dateKey)
    .sort((a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999));
  return { dateKey, list };
}

// Тот же принцип read-modify-write, что и markHabitDone — пишем events обратно ПОЛНЫМ
// массивом через mergeDoc({events}), не трогая sections/pollVotes в том же документе.
export async function markPlannerDone(firestore, uid, eventId, done = true) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const idx = events.findIndex((e) => e && e.id === eventId);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], done };
  await firestore.mergeDoc(path, { events });
  return events[idx];
}

// "Перенести" из меню бота — просто переставляет якорную дату события (без времени эта дата и
// есть само событие, с временем время остаётся тем же на новой дате). Разово, не трогает repeat.
export async function reschedulePlannerEvent(firestore, uid, eventId, newDate) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const idx = events.findIndex((e) => e && e.id === eventId);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], date: newDate };
  await firestore.mergeDoc(path, { events });
  return events[idx];
}

// Меню бота адресует привычки по имени (тот же естественный ключ, что использует и сам клиент
// для переименования/сопоставления между днями — см. renameHabit в index.html), а не по индексу
// в дневном массиве: индекс сегодняшнего списка нестабилен и не подходит для callback_data,
// который переживает несколько независимых нажатий.
export async function markHabitDoneByName(firestore, uid, dateKey, name, done = true) {
  const path = `users/${uid}/appData/habits`;
  const data = (await firestore.getDoc(path)) || {};
  const list = Array.isArray(data[dateKey]) ? [...data[dateKey]] : [];
  const idx = list.findIndex((h) => h && h.name === name);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], done };
  await firestore.mergeDoc(path, { [dateKey]: list });
  return list[idx];
}

// Для крон-напоминаний "скоро начнётся": события сегодня, с временем, ещё не выполненные,
// чьё начало попадает в окно [сейчас, сейчас+windowMinutes) — т.е. каждое поймает ровно один
// 30-минутный тик крона (см. handlePlannerReminders в index.js), плюс защита от повтора там же.
export async function getUpcomingPlannerEvents(firestore, uid, tz = DEFAULT_TZ, windowMinutes = 30) {
  const { list } = await getPlannerToday(firestore, uid, tz);
  const now = currentMinutesInTz(tz);
  return list.filter((e) => {
    if (e.done || !e.time) return false;
    const start = timeToMinutes(e.time);
    return start !== null && start >= now && start < now + windowMinutes;
  });
}
