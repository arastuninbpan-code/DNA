// Меню-интерфейс бота: ОДНО закреплённое сообщение "Главное меню" — оно же единственный
// "рабочий экран": любая навигация редактирует его на месте (см. renderToMainMenu), новых
// сообщений в чате при переходах между разделами не появляется. Отчёты/напоминания (дайджесты,
// "скоро начнётся") — принципиально другой канал, остаются отдельными сообщениями в общей
// ленте чата, не эта система (см. digest.js и handlePlannerReminders в index.js).
//
// Источник истины о том, что сейчас реально закреплено в чате — не наш сохранённый
// mainMenuMessageId, а ответ Telegram (getChat.pinned_message): пользователь мог открепить
// сообщение руками или очистить историю чата — тогда старый id мёртв, и renderToMainMenu
// создаёт и закрепляет меню заново, а не пытается вечно редактировать то, чего больше нет.
//
// Единый визуальный язык (см. spec п.16): ✅ выполнено, ⬜ осталось, 🔥 стрик, 💰 финансы,
// 📅 события, 📰 новости, 📊 "Сегодня", 🏠 главное меню. Для финансовых операций — 🟢/🔴
// (доход/расход), а не ✅/⬜ — у операции нет состояния "выполнено".

import {
  DEFAULT_TZ, todayKey, currentHourInTz, dateKeyAddDays, escapeHtml, pluralRu, formatRub,
  getHabitsDoc, habitsOn, getPlannerDoc, plannerOn,
  markPlannerDone, reschedulePlannerEvent, markHabitDoneByName,
} from './reminders.js';
import { computeHabitStreaks } from './streaks.js';
import { sendMessage, editMessageText, pinChatMessage, getChat, unpinAllChatMessages, deleteMessage } from './telegram.js';

const EVENT_LIST_CAP = 8;
const HABIT_LIST_CAP = 12;
// Стрик короче этого порога не выделяем отдельной строкой — 1-2 дня ещё не серия, о которой
// стоило бы напоминать (тот же порог, что и в digest.js, но своя копия — независимые модули).
const MEANINGFUL_STREAK = 3;
const CATEGORY_EMOJI = {
  'Продукты':'🛒','Транспорт':'🚕','Рестораны':'🍔','Здоровье':'💊','Развлечения':'🎬',
  'Образование':'📚','Одежда':'👕','Дом':'🏠','Подарки':'🎁','Переводы':'🔁',
  'Пополнение':'➕','Инвестиции':'📈','Связь':'📱','Другое':'💳',
};

// Разделы уже хранят реальный HEX-цвет (тот же PL_COLORS, что красит чипы и обводку событий
// в самом приложении — см. renderPlannerScreen), поэтому карточка раздела в боте — это ближайший
// по RGB цветной квадрат-эмодзи к ЭТОМУ цвету, а не смайлик, угаданный по названию: Telegram не
// умеет красить кнопки произвольным цветом, но 9 цветных квадратов — ближайшее доступное подобие.
const SECTION_COLOR_SWATCHES = [
  ['🟥', [229, 49, 44]],
  ['🟧', [244, 144, 12]],
  ['🟨', [253, 203, 88]],
  ['🟩', [120, 177, 89]],
  ['🟦', [85, 172, 238]],
  ['🟪', [170, 122, 192]],
  ['🟫', [150, 109, 74]],
  ['⬛', [30, 30, 30]],
  ['⬜', [240, 240, 240]],
];
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function sectionEmoji(section) {
  const rgb = hexToRgb(section?.color);
  if (!rgb) return '⬜';
  let best = SECTION_COLOR_SWATCHES[0][0];
  let bestDist = Infinity;
  for (const [emoji, ref] of SECTION_COLOR_SWATCHES) {
    const dist = (rgb[0] - ref[0]) ** 2 + (rgb[1] - ref[1]) ** 2 + (rgb[2] - ref[2]) ** 2;
    if (dist < bestDist) { bestDist = dist; best = emoji; }
  }
  return best;
}

function dayLabel(dateKey, todayKeyStr) {
  if (dateKey === todayKeyStr) return 'Сегодня';
  if (dateKey === dateKeyAddDays(todayKeyStr, 1)) return 'Завтра';
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

// callback_data — байтовый лимит Telegram (64 байта), кириллица занимает по 2 байта на символ,
// поэтому длинное имя привычки режем: неполное совпадение — редкий случай для личного проекта
// одного пользователя, а не сотен привычек с общим длинным префиксом.
function habitCallbackName(name) {
  return String(name).slice(0, 24);
}

// dateKey — день, на который сейчас рисуется список; если он не совпадает с якорной датой
// события (e.date), значит это продолжение многодневного события (см. eventCoversDate в
// reminders.js) — помечаем отдельно, иначе время начала выглядело бы как время НА этот день.
function eventLine(e, dateKey) {
  const continuing = dateKey && e.date !== dateKey;
  return `${e.done ? '✅' : '⬜'} ${e.time && !continuing ? e.time + ' — ' : ''}${escapeHtml(e.title)}${continuing ? ' (продолжается)' : ''}`;
}
function eventButtonText(e, dateKey) {
  const continuing = dateKey && e.date !== dateKey;
  return `${e.done ? '✅' : '⬜'} ${e.time && !continuing ? e.time + ' ' : ''}${e.title}${continuing ? ' (продолжается)' : ''}`.slice(0, 64);
}

function pickBestActiveStreak(streaks, list, key) {
  let best = null;
  for (const item of list) {
    const s = streaks[key(item)];
    if (s && s.current >= MEANINGFUL_STREAK && (!best || s.current > best.current)) {
      best = { name: key(item), current: s.current };
    }
  }
  return best;
}

// -------- Главное меню (пинится один раз, содержимое всегда одно и то же) --------
export function renderHome() {
  return {
    text: '🏠 <b>Главное меню</b>\n\nЧто хочешь открыть?',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Финансы', callback_data: 's:finance' }, { text: '📅 События', callback_data: 's:events' }],
        [{ text: '🔥 Привычки', callback_data: 's:habits' }, { text: '📰 Новости', callback_data: 's:news' }],
        [{ text: '📊 Сегодня', callback_data: 's:today' }],
      ],
    },
  };
}

// -------- События --------
// Открыв "📅 События", сначала выбираешь раздел (как в самом приложении — те же
// plannerDoc.sections, что и чипы "Все/Работа/Учёба/..." над лентой), и только после выбора
// видишь сам список на день — а не всё вперемешку сразу.
function renderEventsSectionPicker(plannerDoc) {
  const sections = Array.isArray(plannerDoc.sections) ? plannerDoc.sections : [];
  const rows = [[{ text: '📋 Все', callback_data: 's:events:all' }]];
  for (const s of sections) {
    if (s && s.id) rows.push([{ text: `${sectionEmoji(s)} ${s.name || 'Без названия'}`.slice(0, 64), callback_data: `s:events:${s.id}` }]);
  }
  rows.push([{ text: '🏠 Главное', callback_data: 's:home' }]);
  return { text: '📅 <b>События</b>\n\nВыбери раздел:', reply_markup: { inline_keyboard: rows } };
}

// sectionKey — 'all' либо id раздела (см. renderEventsSectionPicker); kind — 'today'|'tomorrow'.
// Оба параметра зашиты в callback_data и строк переключения дня, и кнопок-тогглов ниже — чтобы
// после отметки события или смены дня пользователь оставался в том же разделе, а не улетал
// обратно к общему списку.
async function renderEventsScreen(env, firestore, uid, kind, sectionKey) {
  const base = todayKey(DEFAULT_TZ);
  const dateKey = kind === 'tomorrow' ? dateKeyAddDays(base, 1) : base;
  const plannerDoc = await getPlannerDoc(firestore, uid);
  const sections = Array.isArray(plannerDoc.sections) ? plannerDoc.sections : [];
  const section = sectionKey && sectionKey !== 'all' ? sections.find((s) => s && s.id === sectionKey) : null;
  const key = section ? section.id : 'all';
  let list = plannerOn(plannerDoc, dateKey);
  if (section) list = list.filter((e) => e && e.sectionId === section.id);
  const label = kind === 'tomorrow' ? 'завтра' : 'сегодня';
  const scr = (targetKind) => `s:events:${key}${targetKind === 'tomorrow' ? ':tomorrow' : ''}`;

  const lines = [`📅 <b>События на ${label}${section ? ` · ${sectionEmoji(section)} ${escapeHtml(section.name)}` : ''}</b>`, ''];
  const rows = [];
  if (!list.length) {
    lines.push('На этот день пока ничего не запланировано.');
  } else {
    const shown = list.slice(0, EVENT_LIST_CAP);
    lines.push(...shown.map((e) => eventLine(e, dateKey)));
    lines.push('', `Выполнено: ${list.filter((e) => e.done).length} из ${list.length}`);
    if (list.length > EVENT_LIST_CAP) lines.push(`…и ещё ${list.length - EVENT_LIST_CAP}`);
    // Тап по самой строке — мгновенный тоггл готово/не готово, значок слева от названия
    // (см. просьбу пользователя: один ряд — одна кнопка, без второй "детальной" сбоку).
    rows.push(...shown.map((e) => [{ text: eventButtonText(e, dateKey), callback_data: `a:eventtoggle:${e.id}:${key}:${kind}` }]));
  }
  rows.push(kind === 'tomorrow' ? [{ text: '📅 Сегодня', callback_data: scr('today') }] : [{ text: '📅 Завтра', callback_data: scr('tomorrow') }]);
  rows.push([{ text: '← Разделы', callback_data: 's:events' }, { text: '🏠 Главное', callback_data: 's:home' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function renderEventDetail(env, firestore, uid, eventId) {
  const plannerDoc = await getPlannerDoc(firestore, uid);
  const events = Array.isArray(plannerDoc.events) ? plannerDoc.events : [];
  const e = events.find((x) => x && x.id === eventId);
  if (!e) {
    return {
      text: '📅 Это событие не нашлось — возможно, его удалили или перенесли.',
      reply_markup: { inline_keyboard: [[{ text: '← События', callback_data: 's:events' }, { text: '🏠 Главное', callback_data: 's:home' }]] },
    };
  }
  const today = todayKey(DEFAULT_TZ);
  const lines = [
    `📅 <b>${escapeHtml(e.title)}</b>`,
    `${dayLabel(e.date, today)}${e.time ? ' · ' + e.time : ''}`,
    '',
    'Статус:',
    e.done ? '✅ Выполнено' : '⬜ Не выполнено',
  ];
  const rows = [];
  if (!e.done) {
    rows.push([{ text: '✅ Выполнить', callback_data: `a:eventdone:${e.id}` }]);
    rows.push([{ text: '⏰ Перенести на завтра', callback_data: `a:eventpostpone:${e.id}` }]);
  }
  rows.push([{ text: '← События', callback_data: 's:events' }, { text: '🏠 Главное', callback_data: 's:home' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// -------- Привычки --------
async function renderHabitsScreen(env, firestore, uid) {
  const dateKey = todayKey(DEFAULT_TZ);
  const habitsDoc = await getHabitsDoc(firestore, uid);
  const list = habitsOn(habitsDoc, dateKey);

  const lines = ['🔥 <b>Привычки сегодня</b>', ''];
  const rows = [];
  if (!list.length) {
    lines.push('На сегодня привычек нет.');
  } else {
    const shown = list.slice(0, HABIT_LIST_CAP);
    lines.push(...shown.map((h) => `${h.done ? '✅' : '⬜'} ${escapeHtml(h.name)}`));
    lines.push('', `Выполнено: ${list.filter((h) => h.done).length} из ${list.length}`);
    const streaks = computeHabitStreaks(habitsDoc, dateKey);
    const best = pickBestActiveStreak(streaks, list, (h) => h.name);
    if (best) lines.push('', '🔥 Лучший текущий стрик:', `${escapeHtml(best.name)} — ${best.current} ${pluralRu(best.current, 'день', 'дня', 'дней')}`);
    // Тап по строке — мгновенный тоггл, значок слева от названия (см. renderEventsScreen выше:
    // один ряд — одна кнопка, без второй "детальной" сбоку).
    rows.push(...shown.map((h) => [{
      text: `${h.done ? '✅' : '⬜'} ${h.name}`.slice(0, 64),
      callback_data: `a:habittoggle:${habitCallbackName(h.name)}`,
    }]));
    if (list.length > HABIT_LIST_CAP) lines.push(`…и ещё ${list.length - HABIT_LIST_CAP}`);
  }
  rows.push([{ text: '🏠 Главное', callback_data: 's:home' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function renderHabitDetail(env, firestore, uid, habitNamePrefix) {
  const dateKey = todayKey(DEFAULT_TZ);
  const habitsDoc = await getHabitsDoc(firestore, uid);
  const list = habitsOn(habitsDoc, dateKey);
  // callback_data мог прийти обрезанным (см. habitCallbackName) — ищем по совпадению префикса.
  const h = list.find((x) => x && habitCallbackName(x.name) === habitNamePrefix);
  if (!h) {
    return {
      text: '🔥 Эта привычка не нашлась на сегодня — возможно, её удалили или переименовали.',
      reply_markup: { inline_keyboard: [[{ text: '← Привычки', callback_data: 's:habits' }, { text: '🏠 Главное', callback_data: 's:home' }]] },
    };
  }
  const streaks = computeHabitStreaks(habitsDoc, dateKey);
  const s = streaks[h.name] || { current: 0, best: 0 };
  const lines = [
    `🔥 <b>${escapeHtml(h.name)}</b>`,
    h.done ? '✅ Сегодня выполнено' : '⬜ Сегодня не выполнено',
    '',
    `Текущий стрик: ${s.current} ${pluralRu(s.current, 'день', 'дня', 'дней')} 🔥`,
    `Личный рекорд: ${s.best} ${pluralRu(s.best, 'день', 'дня', 'дней')}`,
  ];
  const rows = [];
  if (!h.done) rows.push([{ text: '✅ Выполнить', callback_data: `a:habitdone:${habitCallbackName(h.name)}` }]);
  rows.push([{ text: '← Привычки', callback_data: 's:habits' }, { text: '🏠 Главное', callback_data: 's:home' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// -------- Финансы --------
// Не используем ✅/⬜ для операций — у операции нет состояния "выполнено", только знак суммы
// (🟢 доход / 🔴 расход), см. отдельную просьбу пользователя не путать эти два визуальных языка.
async function renderFinanceScreen(env, firestore, uid) {
  const dateKey = todayKey(DEFAULT_TZ);
  const financeDoc = (await firestore.getDoc(`users/${uid}/appData/finance`)) || {};
  const transactions = Array.isArray(financeDoc.transactions) ? financeDoc.transactions : [];
  const todayTx = transactions.filter((t) => t && t.date === dateKey);
  const spent = todayTx.filter((t) => t.type === 'expense').reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
  const earned = todayTx.filter((t) => t.type === 'income').reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
  const recent = [...transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 3);

  const lines = ['💰 <b>Финансы</b>', '', 'Сегодня:', `🟢 Доходы: ${formatRub(earned)}`, `🔴 Расходы: ${formatRub(spent)}`];
  if (recent.length) {
    lines.push('', 'Последние операции:');
    for (const t of recent) {
      const amount = Math.abs(Number(t.amount) || 0);
      const emoji = CATEGORY_EMOJI[t.category] || '💳';
      lines.push(`${t.type === 'income' ? '🟢 +' : '🔴 −'}${formatRub(amount)} · ${emoji} ${escapeHtml(t.category || t.note || 'Операция')}`);
    }
  } else {
    lines.push('', 'Пока нет ни одной операции.');
  }
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏠 Главное', callback_data: 's:home' }],
      ],
    },
  };
}

// -------- Новости --------
// В самом приложении раздел ещё в разработке (заглушка "Персональная лента ещё в разработке"),
// реальных данных для дайджеста по темам нет — честно показываем то же самое в боте, а не
// подставляем выдуманные цифры/темы, которых не существует.
function renderNewsScreen() {
  return {
    text: '📰 <b>Новости</b>\n\nЭтот раздел ещё в разработке — как и персональная лента в самом приложении.',
    reply_markup: { inline_keyboard: [[{ text: '🏠 Главное', callback_data: 's:home' }]] },
  };
}

// -------- "Сегодня" — живой статус дня, отличается от вечернего дайджеста (см. digest.js) тем,
// что это экран по запросу, а не push, и меняется в течение дня (утро/день/вечер) --------
async function renderTodayScreen(env, firestore, uid) {
  const dateKey = todayKey(DEFAULT_TZ);
  const hour = currentHourInTz(DEFAULT_TZ);
  const habitsDoc = await getHabitsDoc(firestore, uid);
  const plannerDoc = await getPlannerDoc(firestore, uid);
  const habits = habitsOn(habitsDoc, dateKey);
  const planner = plannerOn(plannerDoc, dateKey);
  const financeDoc = (await firestore.getDoc(`users/${uid}/appData/finance`)) || {};
  const spent = (Array.isArray(financeDoc.transactions) ? financeDoc.transactions : [])
    .filter((t) => t && t.date === dateKey && t.type === 'expense')
    .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
  const doneHabits = habits.filter((h) => h.done).length;
  const donePlanner = planner.filter((e) => e.done).length;

  const lines = ['📊 <b>Сегодня</b>', ''];
  if (hour < 12) {
    lines.push(`📅 ${planner.length} ${pluralRu(planner.length, 'дело', 'дела', 'дел')}`);
    lines.push(`🔥 ${habits.length} ${pluralRu(habits.length, 'привычка', 'привычки', 'привычек')}`);
    lines.push(spent > 0 ? `💰 Расходы: ${formatRub(spent)}` : '💰 Пока без расходов');
    lines.push('', 'Хорошего дня!');
  } else {
    lines.push(`📅 События: ${donePlanner}/${planner.length}`);
    lines.push(`🔥 Привычки: ${doneHabits}/${habits.length}`);
    lines.push(`💰 Расходы: ${formatRub(spent)}`);
    // 📅/🔥 — тот же значок раздела, что и в остальном боте (шапки экранов, кнопки главного
    // меню), чтобы в общем списке было видно, где событие, а где привычка — раньше оба типа
    // рисовались одинаковым "⬜" и не отличались друг от друга.
    const remainingPlanner = planner.filter((e) => !e.done);
    const remainingHabits = habits.filter((h) => !h.done);
    if (remainingPlanner.length || remainingHabits.length) {
      lines.push('', hour >= 19 ? 'Осталось выполнить:' : 'Осталось:');
      let shown = 0;
      for (const e of remainingPlanner) {
        if (shown >= 5) break;
        lines.push(`📅 ${e.time ? e.time + ' — ' : ''}${escapeHtml(e.title)}`);
        shown++;
      }
      for (const h of remainingHabits) {
        if (shown >= 5) break;
        lines.push(`🔥 ${escapeHtml(h.name)}`);
        shown++;
      }
    }
    const streaks = computeHabitStreaks(habitsDoc, dateKey);
    const best = pickBestActiveStreak(streaks, habits, (h) => h.name);
    if (best) lines.push('', `🔥 Стрик «${escapeHtml(best.name)}»: ${best.current} ${pluralRu(best.current, 'день', 'дня', 'дней')}`);
  }
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 События', callback_data: 's:events' }, { text: '🔥 Привычки', callback_data: 's:habits' }],
        [{ text: '💰 Финансы', callback_data: 's:finance' }, { text: '📰 Новости', callback_data: 's:news' }],
        [{ text: '🏠 Главное', callback_data: 's:home' }],
      ],
    },
  };
}

// -------- Маршрутизация --------
// screen — то, что приходит после "s:" в callback_data (см. index.js), например 'home', 'events'
// (пикер раздела), 'events:<sectionKey>' / 'events:<sectionKey>:tomorrow' (список дня, sectionKey —
// 'all' либо id раздела), 'event:<id>', 'habits', 'habit:<name>', 'finance', 'news', 'today'.
export async function renderScreen(env, firestore, uid, screen) {
  if (screen === 'events') return renderEventsSectionPicker(await getPlannerDoc(firestore, uid));
  if (screen.startsWith('events:')) {
    const [sectionKey, dayPart] = screen.slice('events:'.length).split(':');
    return renderEventsScreen(env, firestore, uid, dayPart === 'tomorrow' ? 'tomorrow' : 'today', sectionKey);
  }
  if (screen.startsWith('event:')) return renderEventDetail(env, firestore, uid, screen.slice('event:'.length));
  if (screen === 'habits') return renderHabitsScreen(env, firestore, uid);
  if (screen.startsWith('habit:')) return renderHabitDetail(env, firestore, uid, screen.slice('habit:'.length));
  if (screen === 'finance') return renderFinanceScreen(env, firestore, uid);
  if (screen === 'news') return renderNewsScreen();
  if (screen === 'today') return renderTodayScreen(env, firestore, uid);
  return renderHome();
}

// -------- Действия (что-то меняют, потом возвращают на какой экран отрисоваться) --------
export async function runAction(firestore, uid, action) {
  if (action.startsWith('eventtoggle:')) {
    // Тап по самой строке в списке событий (см. renderEventsScreen) — переключает готово/не
    // готово в обе стороны, а не только отмечает выполненным (в отличие от eventdone ниже,
    // которым по-прежнему пользуется кнопка "✅ Выполнить" в карточке события). sectionKey/kind
    // зашиты в саму callback_data строки (см. renderEventsScreen) — так после тоггла человек
    // возвращается в тот же раздел и день, а не в общий список.
    const [id, sectionKey, kind] = action.slice('eventtoggle:'.length).split(':');
    const plannerDoc = await getPlannerDoc(firestore, uid);
    const events = Array.isArray(plannerDoc.events) ? plannerDoc.events : [];
    const e = events.find((x) => x && x.id === id);
    const screen = `events:${sectionKey || 'all'}${kind === 'tomorrow' ? ':tomorrow' : ''}`;
    if (!e) return { toast: 'Не нашёл это событие', nextScreen: screen };
    const updated = await markPlannerDone(firestore, uid, id, !e.done);
    return { toast: updated.done ? `Готово: ${updated.title}` : `Отменено: ${updated.title}`, nextScreen: screen };
  }
  if (action.startsWith('eventdone:')) {
    const id = action.slice('eventdone:'.length);
    const updated = await markPlannerDone(firestore, uid, id, true);
    return updated ? { toast: `Готово: ${updated.title}`, nextScreen: `event:${id}` } : { toast: 'Не нашёл это событие', nextScreen: 'events' };
  }
  if (action.startsWith('eventpostpone:')) {
    const id = action.slice('eventpostpone:'.length);
    const updated = await reschedulePlannerEvent(firestore, uid, id, dateKeyAddDays(todayKey(DEFAULT_TZ), 1));
    return updated ? { toast: 'Перенесено на завтра', nextScreen: 'events' } : { toast: 'Не нашёл это событие', nextScreen: 'events' };
  }
  if (action.startsWith('habittoggle:')) {
    const namePrefix = action.slice('habittoggle:'.length);
    const dateKey = todayKey(DEFAULT_TZ);
    const habitsDoc = await getHabitsDoc(firestore, uid);
    const h = habitsOn(habitsDoc, dateKey).find((x) => x && habitCallbackName(x.name) === namePrefix);
    if (!h) return { toast: 'Не нашёл эту привычку', nextScreen: 'habits' };
    const newDone = !h.done;
    await markHabitDoneByName(firestore, uid, dateKey, h.name, newDone);
    return { toast: newDone ? `Готово: ${h.name}` : `Отменено: ${h.name}`, nextScreen: 'habits' };
  }
  if (action.startsWith('habitdone:')) {
    const namePrefix = action.slice('habitdone:'.length);
    const dateKey = todayKey(DEFAULT_TZ);
    const habitsDoc = await getHabitsDoc(firestore, uid);
    const h = habitsOn(habitsDoc, dateKey).find((x) => x && habitCallbackName(x.name) === namePrefix);
    if (!h) return { toast: 'Не нашёл эту привычку', nextScreen: 'habits' };
    await markHabitDoneByName(firestore, uid, dateKey, h.name, true);
    return { toast: `Готово: ${h.name}`, nextScreen: `habit:${namePrefix}` };
  }
  return { toast: null, nextScreen: 'home' };
}

// -------- Единственная точка входа в меню --------
// Показать любой экран — значит отредактировать закреплённое сообщение на месте. Перед этим
// сверяемся с Telegram (getChat), действительно ли оно всё ещё закреплено в чате: если
// пользователь открепил его руками или очистил историю (тогда и сам pinned_message пропадает),
// сохранённый в Firestore id мёртв — вместо бесполезной попытки его отредактировать создаём
// новое сообщение и закрепляем заново. Если getChat сам не ответил (сетевой сбой) — не считаем
// это признаком потери пина, а просто пробуем редактировать как обычно; если и редактирование
// не удалось — тоже пересоздаём. Так эта же функция закрывает и первый /start (сообщения ещё
// нет), и обычную навигацию, и восстановление после потери пина — везде один и тот же путь.
//
// Перед КАЖДЫМ новым pinChatMessage сначала открепляем всё через unpinAllChatMessages: Telegram
// не заменяет предыдущий пин новым сам по себе, а копит их один за другим, а chat.pinned_message
// в getChat ниже показывает только самый свежий — так что после нескольких пересозданий (сбой
// сети, очистка истории и т.п.) в чате незаметно копится несколько закреплённых "Главных меню"
// сразу. opts.repair форсирует эту же чистку и в "штатной" ветке (просто правки текста) — её
// включает команда /menu, которую пользователь и так использует как "почини мне меню".
//
// Открепить недостаточно: старое сообщение остаётся висеть в истории чата как мусор — поэтому
// при пересоздании ещё и удаляем его (deleteMessage), а не только снимаем статус "закреплено".
// Чистим и то, что мы сами помнили (storedId), и то, что Telegram ПРЯМО СЕЙЧАС считает
// закреплённым (chat.pinned_message) — на случай если это другое сообщение (например, пин
// прошёл, а запись id в Firestore после этого не удалась). Пины из ЕЩЁ более ранних циклов,
// чей id нигде не сохранился, штатно не найти: Bot API отдаёт только самый свежий пин чата,
// полного списка закреплённых сообщений в нём нет — такие приходится убирать вручную один раз.
export async function renderToMainMenu(env, firestore, token, uid, chatId, payload, opts = {}) {
  const userPath = `users/${uid}`;
  const user = await firestore.getDoc(userPath);
  const options = payload.reply_markup ? { reply_markup: payload.reply_markup } : {};
  const storedId = user && user.mainMenuMessageId;

  let chat = null;
  if (storedId) {
    try {
      chat = await getChat(token, chatId);
    } catch (err) {
      console.error('getChat failed, assuming pin is still valid', err);
    }
    const stillPinned = chat ? !!(chat.pinned_message && chat.pinned_message.message_id === storedId) : true;
    if (stillPinned) {
      try {
        await editMessageText(token, chatId, storedId, payload.text, options);
        if (opts.repair) {
          try {
            await unpinAllChatMessages(token, chatId);
            await pinChatMessage(token, chatId, storedId);
          } catch (err) {
            console.error('repair re-pin failed', err);
          }
        }
        return;
      } catch (err) {
        console.error('editMessageText on main menu failed, recreating it', err);
      }
    }
  }

  const sent = await sendMessage(token, chatId, payload.text, options);
  try {
    await unpinAllChatMessages(token, chatId);
    await pinChatMessage(token, chatId, sent.message_id);
  } catch (err) {
    console.error('pinChatMessage failed', err);
  }
  const staleIds = new Set();
  if (storedId && storedId !== sent.message_id) staleIds.add(storedId);
  if (chat && chat.pinned_message && chat.pinned_message.message_id !== sent.message_id) {
    staleIds.add(chat.pinned_message.message_id);
  }
  for (const staleId of staleIds) {
    try {
      await deleteMessage(token, chatId, staleId);
    } catch (err) {
      console.error(`deleting stale main menu message ${staleId} failed`, err);
    }
  }
  await firestore.mergeDoc(userPath, { mainMenuMessageId: sent.message_id });
}
