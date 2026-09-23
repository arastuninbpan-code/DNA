// Общая логика чтения/изменения "сегодняшних" привычек пользователя — используется и
// планировщиком напоминаний (scheduled-хендлер), и командой /today, и кнопкой "Готово" в
// вебхуке, чтобы дата и формат не разъезжались между тремя местами. Порт 1:1 с
// functions/reminders.js (Firebase-вариант) — только вместо Admin SDK берёт firestore-клиент.

export const DEFAULT_TZ = 'Europe/Moscow';

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

function timeToMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export async function getHabitsToday(firestore, uid, tz = DEFAULT_TZ) {
  const dateKey = todayKey(tz);
  const data = (await firestore.getDoc(`users/${uid}/appData/habits`)) || {};
  const list = Array.isArray(data[dateKey]) ? data[dateKey] : [];
  return { dateKey, list };
}

// Firestore REST не даёт настоящих транзакций одним вызовом так же просто, как Admin SDK —
// но у нас максимум два писателя (сам пользователь и бот от его лица), так что read-modify-write
// без блокировки достаточно: конфликтующая одновременная запись по одной и той же привычке
// практически исключена для личного проекта одного пользователя.
export async function markHabitDone(firestore, uid, dateKey, index, done = true) {
  const path = `users/${uid}/appData/habits`;
  const data = (await firestore.getDoc(path)) || {};
  const list = Array.isArray(data[dateKey]) ? [...data[dateKey]] : [];
  if (!list[index]) return;
  list[index] = { ...list[index], done };
  await firestore.mergeDoc(path, { [dateKey]: list });
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
