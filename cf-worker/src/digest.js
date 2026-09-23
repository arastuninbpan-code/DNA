// Единая система дневных уведомлений — вместо отдельного сообщения от каждого раздела
// приложения (привычки написали, события написали, финансы написали — пользователь получает
// пачку из пяти сообщений подряд) бот собирает всё в 2-4 содержательных дайджеста за день:
// утро → (важные события — отдельно, см. handlePlannerReminders в index.js, это осознанное
// исключение) → вечер (объединяет оставшиеся дела/привычки/стрики под угрозой) → итог дня +
// план на завтра. Если дню нечего сообщить — дайджест просто не отправляется, тишина тоже
// осмысленный результат (см. каждую build*-функцию: она возвращает null, когда сказать нечего).
//
// Все дайджесты читают уже существующие приватные данные (users/{uid}/appData/{habits,planner,
// finance}), которые синхронизируются из приложения (см. index.html — queueCloudSync/
// CLOUD_DATA_TYPES) — здесь ничего не пишется в эти документы, только читается.

import {
  DEFAULT_TZ, todayKey, currentHourInTz, dateKeyAddDays, escapeHtml, pluralRu, formatRub,
  getHabitsDoc, habitsOn, getPlannerDoc, plannerOn,
} from './reminders.js';
import { computeHabitStreaks } from './streaks.js';
import { sendMessage } from './telegram.js';

// "Разумные настройки по умолчанию" (см. просьбу пользователя, п.19) — персональные часы начала/
// конца дня оставлены на потом; пока весь Worker уже считает время в DEFAULT_TZ (Europe/Moscow).
const MORNING_HOUR = 8;
const EOD_HOUR = 22;
// Стрик короче этого порога не стоит отдельного упоминания в дайджесте — 1-2 дня ещё не серия,
// её потеря не будет ощущаться как потеря, и напоминание о ней — просто лишний шум.
const MEANINGFUL_STREAK = 3;

const WEEKDAY_GENITIVE = ['воскресенья', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы'];
// День недели однозначно определяется календарной датой независимо от часового пояса —
// поэтому просто берём UTC-день недели у даты, собранной из частей dateKey.
function weekdayGenitive(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAY_GENITIVE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Стрик считается "под угрозой", только если он уже что-то значит (см. MEANINGFUL_STREAK) и
// сегодняшний день ещё не выполнен — тогда его правда можно потерять до конца дня.
function habitsAtRisk(remainingHabits, streaks) {
  return remainingHabits
    .map((h) => ({ h, s: streaks[h.name] }))
    .filter(({ s }) => s && s.current >= MEANINGFUL_STREAK)
    .sort((a, b) => b.s.current - a.s.current);
}

function pickStreakHighlight(streaks, todayHabits) {
  let best = null;
  for (const h of todayHabits) {
    const s = streaks[h.name];
    if (s && s.current >= MEANINGFUL_STREAK && (!best || s.current > best.current)) best = { name: h.name, current: s.current };
  }
  return best ? `🔥 Стрик «${escapeHtml(best.name)}»: ${best.current} ${pluralRu(best.current, 'день', 'дня', 'дней')}.` : null;
}

// Значимые вехи (п.8 просьбы) — сворачиваем в одну строку внутри итога дня, а не шлём отдельным
// сообщением: было бы ещё одним источником уведомлений, а именно этого просили избежать.
function pickMilestoneLine(streaks, habits) {
  let record = null;
  let milestone = null;
  for (const h of habits) {
    const s = streaks[h.name];
    if (!s) continue;
    if (s.isNewRecord && (!record || s.current > record.current)) record = { name: h.name, current: s.current };
    else if (s.reachedMilestoneToday && (!milestone || s.current > milestone.current)) milestone = { name: h.name, current: s.current };
  }
  if (record) return `🏆 Новый рекорд: «${escapeHtml(record.name)}» — ${record.current} ${pluralRu(record.current, 'день', 'дня', 'дней')} подряд.`;
  if (milestone) return `🔥 «${escapeHtml(milestone.name)}» — ${milestone.current} ${pluralRu(milestone.current, 'день', 'дня', 'дней')} подряд!`;
  return null;
}

const CLOSERS = {
  perfect: ['100% плана выполнено. День полностью закрыт.', 'Всё по плану — от начала и до конца.'],
  good: ['Почти весь план закрыт. Хороший темп.', 'Основное сделано — день прошёл продуктивно.'],
  medium: ['Главные задачи выполнены. Остальное можно спокойно перенести.', 'День вышел неровным, но важное не упущено.'],
  weak: ['Сегодня план оказался слишком большим. На завтра лучше оставить меньше задач, но самые важные.', 'Бывают и такие дни — завтра можно начать заново.'],
};
// Небольшой пул фраз на каждый случай (не одна на всё), чтобы не повторять слово в слово изо
// дня в день (п.13 просьбы) — без претензии на богатую генерацию текста, просто ротация.
function pickClosingPhrase(ratio, total) {
  if (total === 0) return 'Свободный день — иногда это тоже нормально.';
  const pool = ratio >= 0.999 ? CLOSERS.perfect : ratio >= 0.7 ? CLOSERS.good : ratio >= 0.4 ? CLOSERS.medium : CLOSERS.weak;
  return pool[Math.floor(Math.random() * pool.length)];
}

// "1 незавершённое дело" / "2 незавершённых дела" / "5 незавершённых дел" — числительное+
// существительное склоняются по-разному (пример был бы неверным при простой проверке "1 или не 1").
function unfinishedPhrase(n) {
  const noun = pluralRu(n, 'дело', 'дела', 'дел');
  const adj = n === 1 ? 'незавершённое' : 'незавершённых';
  return `${n} ${adj} ${noun}`;
}

function buildTomorrowSection(tomorrowPlanner, unfinishedTodayCount) {
  if (!tomorrowPlanner.length) {
    return unfinishedTodayCount
      ? `На завтра пока ничего не запланировано. Также остаётся ${unfinishedPhrase(unfinishedTodayCount)} с сегодня.`
      : 'На завтра пока ничего не запланировано. Можно оставить день свободным или подготовить план заранее.';
  }
  const timed = tomorrowPlanner.filter((e) => e.time);
  const untimed = tomorrowPlanner.filter((e) => !e.time);
  const lines = ['На завтра уже запланировано:'];
  for (const e of timed.slice(0, 3)) lines.push(`${e.time} — ${escapeHtml(e.title)}`);
  for (const e of untimed.slice(0, 3)) lines.push(`• ${escapeHtml(e.title)}`);
  const shown = Math.min(timed.length, 3) + Math.min(untimed.length, 3);
  if (tomorrowPlanner.length > shown) lines.push(`…и ещё ${tomorrowPlanner.length - shown}.`);
  if (unfinishedTodayCount) lines.push('', `Также осталось ${unfinishedPhrase(unfinishedTodayCount)} с сегодняшнего дня.`);
  return lines.join('\n');
}

// -------- Утро: "Что у меня сегодня?" --------
export async function buildMorningMessage(env, firestore, uid, dateKey) {
  const [habitsDoc, plannerDoc] = await Promise.all([getHabitsDoc(firestore, uid), getPlannerDoc(firestore, uid)]);
  const habits = habitsOn(habitsDoc, dateKey);
  const planner = plannerOn(plannerDoc, dateKey);

  if (!habits.length && !planner.length) {
    return {
      text: '☀️ Доброе утро!\n\nНа сегодня пока ничего не запланировано.\nХочешь выбрать несколько главных дел на день?',
      reply_markup: { inline_keyboard: [[{ text: '📲 Открыть D.N.A.', url: env.APP_URL }]] },
    };
  }

  const timed = planner.filter((e) => e.time);
  const untimed = planner.filter((e) => !e.time);
  const lines = ['☀️ Доброе утро 👋', '', 'Сегодня:'];
  if (untimed.length) lines.push(`• ${untimed.length} ${pluralRu(untimed.length, 'задача', 'задачи', 'задач')}`);
  if (habits.length) lines.push(`• ${habits.length} ${pluralRu(habits.length, 'привычка', 'привычки', 'привычек')}`);
  for (const e of timed.slice(0, 2)) lines.push(`• ${e.time} — ${escapeHtml(e.title)}`);
  if (timed.length > 2) lines.push(`• ещё ${timed.length - 2} по расписанию`);

  const mainItem = untimed[0] || timed[0];
  if (mainItem) lines.push('', `Главное дело дня — ${escapeHtml(mainItem.title)}.`);

  const highlight = pickStreakHighlight(computeHabitStreaks(habitsDoc, dateKey), habits);
  if (highlight) lines.push('', highlight);

  return { text: lines.join('\n') };
}

// -------- Вечер: "Есть ли что-то, о чём мне действительно нужно помнить сейчас?" --------
export async function buildEveningMessage(firestore, uid, dateKey) {
  const [habitsDoc, plannerDoc] = await Promise.all([getHabitsDoc(firestore, uid), getPlannerDoc(firestore, uid)]);
  const habits = habitsOn(habitsDoc, dateKey);
  const planner = plannerOn(plannerDoc, dateKey);
  if (!habits.length && !planner.length) return null; // пустой день — утро уже сказало об этом

  const doneHabits = habits.filter((h) => h.done).length;
  const donePlanner = planner.filter((e) => e.done).length;
  const remainingHabits = habits.filter((h) => !h.done);
  const remainingPlanner = planner.filter((e) => !e.done);

  if (!remainingHabits.length && !remainingPlanner.length) {
    return {
      text: [
        'На сегодня всё закрыто ✅',
        `${donePlanner}/${planner.length} ${pluralRu(planner.length, 'задача', 'задачи', 'задач')}`,
        `${doneHabits}/${habits.length} ${pluralRu(habits.length, 'привычка', 'привычки', 'привычек')}`,
        '',
        'Можно спокойно завершать день.',
      ].join('\n'),
    };
  }

  const streaks = computeHabitStreaks(habitsDoc, dateKey);
  const atRisk = habitsAtRisk(remainingHabits, streaks);
  const atRiskNames = new Set(atRisk.map(({ h }) => h.name));
  const otherHabits = remainingHabits.filter((h) => !atRiskNames.has(h.name));

  const lines = ['На сегодня осталось:'];
  const tooMany = remainingPlanner.length > 5;
  const plannerToShow = tooMany ? remainingPlanner.slice(0, 2) : remainingPlanner;
  if (tooMany) lines[0] = 'На сегодня осталось многовато дел. Похоже, закрыть всё сегодня будет сложно.\n\nСамые важные:';
  for (const e of plannerToShow) lines.push(`${e.time ? '🔴' : '▫️'} ${e.time ? e.time + ' ' : ''}${escapeHtml(e.title)}`);
  if (tooMany) lines.push(`\nОстальное (${remainingPlanner.length - plannerToShow.length}) можно спокойно перенести на завтра.`);

  for (const { h, s } of atRisk) lines.push(`🔥 ${escapeHtml(h.name)} — стрик ${s.current} ${pluralRu(s.current, 'день', 'дня', 'дней')}`);
  if (otherHabits.length) lines.push(`▫️ ${otherHabits.map((h) => escapeHtml(h.name)).join(', ')}`);
  if (atRisk.length) lines.push('', 'До конца дня ещё есть время сохранить серию.');

  return { text: lines.join('\n') };
}

// -------- Итог дня + план на завтра: "Как прошёл день и что будет завтра?" --------
export async function buildEndOfDayMessage(firestore, uid, dateKey) {
  const [habitsDoc, plannerDoc] = await Promise.all([getHabitsDoc(firestore, uid), getPlannerDoc(firestore, uid)]);
  const habits = habitsOn(habitsDoc, dateKey);
  const planner = plannerOn(plannerDoc, dateKey);
  if (!habits.length && !planner.length) return null; // нечего подводить

  const doneHabits = habits.filter((h) => h.done).length;
  const donePlanner = planner.filter((e) => e.done).length;
  const total = habits.length + planner.length;
  const ratio = total ? (doneHabits + donePlanner) / total : 1;
  const streaks = computeHabitStreaks(habitsDoc, dateKey);

  let spendLine = '';
  try {
    const financeDoc = (await firestore.getDoc(`users/${uid}/appData/finance`)) || {};
    const todaySpend = (Array.isArray(financeDoc.transactions) ? financeDoc.transactions : [])
      .filter((t) => t && t.date === dateKey && t.type === 'expense')
      .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
    if (todaySpend > 0) spendLine = `💰 Расходы: ${formatRub(todaySpend)}`;
  } catch (err) {
    console.error('EOD: finance read failed', err);
  }

  const lines = [`Итоги ${weekdayGenitive(dateKey)}`, ''];
  lines.push(`✅ Задачи: ${donePlanner}/${planner.length}`);
  lines.push(`🎯 Привычки: ${doneHabits}/${habits.length}`);
  if (spendLine) lines.push(spendLine);
  const milestoneLine = pickMilestoneLine(streaks, habits);
  if (milestoneLine) lines.push(milestoneLine);

  const unfinished = [...planner.filter((e) => !e.done).map((e) => e.title), ...habits.filter((h) => !h.done).map((h) => h.name)];
  if (unfinished.length) {
    lines.push('', 'Не завершены:');
    for (const title of unfinished.slice(0, 4)) lines.push(`• ${escapeHtml(title)}`);
    if (unfinished.length > 4) lines.push(`• ещё ${unfinished.length - 4}`);
  }

  lines.push('', pickClosingPhrase(ratio, total));
  lines.push('', buildTomorrowSection(plannerOn(plannerDoc, dateKeyAddDays(dateKey, 1)), unfinished.length));

  return { text: lines.join('\n') };
}

// -------- Оркестратор: решает, какие дайджесты уже пора слать, и не даёт повторяться --------
export async function runDailyDigests(env, firestore) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const users = await firestore.listCollection('users');
  const dateKey = todayKey(DEFAULT_TZ);
  const hour = currentHourInTz(DEFAULT_TZ);

  for (const { id: uid, data: user } of users) {
    if (user.remindersEnabled === false) continue;
    const eveningHour = user.reminderHourLocal ?? 20;
    try {
      const statePath = `users/${uid}/appData/digestState`;
      const state = (await firestore.getDoc(statePath)) || {};
      const sent = state.date === dateKey && state.sent ? state.sent : {};
      const patch = {};

      if (hour >= MORNING_HOUR && !sent.morning) {
        const msg = await buildMorningMessage(env, firestore, uid, dateKey);
        if (msg) {
          await sendMessage(token, user.telegramId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {});
          patch.morning = true;
        }
      }
      if (hour >= eveningHour && !sent.evening) {
        const msg = await buildEveningMessage(firestore, uid, dateKey);
        if (msg) {
          await sendMessage(token, user.telegramId, msg.text);
          patch.evening = true;
        }
      }
      if (hour >= EOD_HOUR && !sent.eod) {
        const msg = await buildEndOfDayMessage(firestore, uid, dateKey);
        if (msg) {
          await sendMessage(token, user.telegramId, msg.text);
          patch.eod = true;
        }
      }
      if (Object.keys(patch).length) {
        await firestore.setDoc(statePath, { date: dateKey, sent: { ...sent, ...patch } });
      }
    } catch (err) {
      console.error(`runDailyDigests failed for ${uid}`, err);
    }
  }
}
