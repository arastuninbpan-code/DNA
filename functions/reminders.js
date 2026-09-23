// Общая логика чтения/изменения "сегодняшних" привычек пользователя — используется и
// планировщиком напоминаний, и командой /today, и кнопкой "Готово" в вебхуке, чтобы дата и
// формат не разъезжались между тремя местами.
'use strict';

const DEFAULT_TZ = 'Europe/Moscow';

// 'YYYY-MM-DD' в заданном IANA-таймзоне — тот же формат ключа, что использует клиент
// (habitDateKey в index.html), но посчитанный на сервере независимо от таймзоны машины.
function todayKey(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function currentHourInTz(tz = DEFAULT_TZ) {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr);
}

async function getHabitsToday(db, uid, tz = DEFAULT_TZ) {
  const dateKey = todayKey(tz);
  const snap = await db.doc(`users/${uid}/appData/habits`).get();
  const data = snap.exists ? snap.data() : {};
  const list = Array.isArray(data[dateKey]) ? data[dateKey] : [];
  return { dateKey, list };
}

async function markHabitDone(db, uid, dateKey, index, done = true) {
  const ref = db.doc(`users/${uid}/appData/habits`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const list = Array.isArray(data[dateKey]) ? [...data[dateKey]] : [];
    if (!list[index]) return;
    list[index] = { ...list[index], done };
    tx.set(ref, { [dateKey]: list }, { merge: true });
  });
}

module.exports = { DEFAULT_TZ, todayKey, currentHourInTz, getHabitsToday, markHabitDone };
