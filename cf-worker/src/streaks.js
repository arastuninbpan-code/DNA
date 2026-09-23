// Стрики по КАЖДОЙ привычке отдельно — в отличие от аггрегатного "стрика дня" в самом
// приложении (там день засчитывается, только если ВСЕ привычки дня выполнены, см. isPerfectDay
// в index.html), дайджесту в Telegram нужен стрик конкретной привычки ("Чтение — 9 дней
// подряд"), которого в клиенте нет вообще. Считаем его тут — из того же документа привычек
// (users/{uid}/appData/habits), не меняя и не трогая существующую клиентскую логику стриков.

import { habitsOn, dateKeyAddDays } from './reminders.js';

const HISTORY_DAYS = 400; // тот же порядок величины, что и bestStreak() в клиенте (730 дней)
export const STREAK_MILESTONES = [3, 7, 10, 14, 30, 50, 100];

// Имена всех привычек, встречавшихся за последние `days` дней (в порядке первого появления,
// от сегодня назад) — история может быть длиннее, но для дайджеста интересны только те
// привычки, что пользователь вёл недавно, а не любая когда-либо удалённая.
function recentHabitNames(habitsDoc, todayKey, days = 60) {
  const seen = new Set();
  const names = [];
  let cursor = todayKey;
  for (let i = 0; i < days; i++) {
    for (const h of habitsOn(habitsDoc, cursor)) {
      if (h && h.name && !seen.has(h.name)) {
        seen.add(h.name);
        names.push(h.name);
      }
    }
    cursor = dateKeyAddDays(cursor, -1);
  }
  return names;
}

// current — стрик с учётом сегодняшнего дня, если он уже выполнен; если сегодня привычка ещё
// не отмечена (или её вообще нет в расписании на сегодня), день просто не входит в current, но
// и не обрывает его — это "стрик под угрозой", а не уже потерянный (обрыв случится только если
// день закончится невыполненным — это проверяет digest.js вечером). Дни, где привычки не было
// в расписании вообще, пропускаются молча — так же снисходительно, как и клиентский стрик дня.
function streakFor(habitsDoc, name, todayKey) {
  const todayEntry = habitsOn(habitsDoc, todayKey).find((h) => h && h.name === name);
  const scheduledToday = !!todayEntry;
  const doneToday = scheduledToday && todayEntry.done === true;

  let priorStreak = 0;
  {
    let cursor = dateKeyAddDays(todayKey, -1);
    for (let i = 0; i < HISTORY_DAYS; i++) {
      const entry = habitsOn(habitsDoc, cursor).find((h) => h && h.name === name);
      if (entry) {
        if (entry.done === true) priorStreak++;
        else break;
      }
      cursor = dateKeyAddDays(cursor, -1);
    }
  }
  const current = doneToday ? priorStreak + 1 : priorStreak;

  // Лучший стрик БЕЗ учёта сегодняшнего дня — отдельный проход, не останавливается на первом
  // пропуске (в отличие от priorStreak выше), а ищет максимум по всей истории. Нужен, чтобы
  // отличить "просто длинный стрик" от "именно сегодня побит личный рекорд" (см. isNewRecord).
  let bestBeforeToday = 0;
  {
    let run = 0;
    let cursor = dateKeyAddDays(todayKey, -1);
    for (let i = 0; i < HISTORY_DAYS; i++) {
      const entry = habitsOn(habitsDoc, cursor).find((h) => h && h.name === name);
      if (entry) {
        if (entry.done === true) {
          run++;
          if (run > bestBeforeToday) bestBeforeToday = run;
        } else run = 0;
      }
      cursor = dateKeyAddDays(cursor, -1);
    }
  }

  return {
    current,
    best: Math.max(current, bestBeforeToday),
    doneToday,
    scheduledToday,
    isNewRecord: doneToday && current > bestBeforeToday && current > 1,
    reachedMilestoneToday: doneToday && STREAK_MILESTONES.includes(current),
  };
}

// {habitName: {current, best, doneToday, scheduledToday, isNewRecord, reachedMilestoneToday}}
// Принимает уже загруженный документ привычек (а не firestore/uid) — вызывающий код (digest.js)
// и так уже читает его для самого дайджеста, не нужно читать из Firestore дважды.
export function computeHabitStreaks(habitsDoc, todayKey) {
  const names = recentHabitNames(habitsDoc, todayKey);
  const streaks = {};
  for (const name of names) streaks[name] = streakFor(habitsDoc, name, todayKey);
  return streaks;
}
