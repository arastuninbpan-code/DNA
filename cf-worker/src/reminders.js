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
