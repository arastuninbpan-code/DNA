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
import { confirmActions } from './ai/router.js';
import { getUsageOverview } from './ai/usage.js';
import {
  isUserAdmin, lockAdmin, listSupportMessages, listPromoCodes, createPromoCode,
  listDevRequests, getUserStatsOverview,
} from './admin.js';

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
// isAdmin — показывать ли пункт "Панель разработчика" (см. isUserAdmin в admin.js); "Поддержка"
// видна всем — пользователю не нужен особый статус, чтобы написать разработчику.
export function renderHome(isAdmin = false) {
  const rows = [
    [{ text: '💰 Финансы', callback_data: 's:finance' }, { text: '📅 События', callback_data: 's:events' }],
    [{ text: '🔥 Привычки', callback_data: 's:habits' }, { text: '📰 Новости', callback_data: 's:news' }],
    [{ text: '📊 Сегодня', callback_data: 's:today' }],
    [{ text: '✉️ Поддержка', callback_data: 'a:supportprompt' }],
  ];
  if (isAdmin) rows.push([{ text: '🛠 Панель разработчика', callback_data: 's:admin' }]);
  return {
    text: '🏠 <b>Главное меню</b>\n\nЧто хочешь открыть?',
    reply_markup: { inline_keyboard: rows },
  };
}

function renderSupportPromptScreen() {
  return {
    text: '✉️ <b>Поддержка</b>\n\nНапиши, что случилось — сообщение получит разработчик.',
    reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 's:home' }]] },
  };
}

// -------- Панель разработчика — см. просьбу пользователя: секретный пароль (/admin <пароль>,
// см. index.js) открывает эти экраны только тому, у кого isAdmin=true на users/{uid}. Минимальная
// версия: сколько AI стоит (см. usage.js — то, ради чего затевался аудит AI-расходов), обращения
// в поддержку (и с сайта, и из бота — оба пишут в supportMessages, см. admin.js), промокоды.
function rubText(n) {
  return `${(Math.round((n || 0) * 100) / 100).toLocaleString('ru-RU')} ₽`;
}

async function renderAdminScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const [usage, support, promoCodes, devRequests, userStats] = await Promise.all([
    getUsageOverview(firestore), listSupportMessages(firestore, 5), listPromoCodes(firestore),
    listDevRequests(firestore, 5), getUserStatsOverview(firestore),
  ]);
  const newSupport = support.filter((m) => m.status === 'new').length;
  const newDevRequests = devRequests.filter((r) => r.status === 'new').length;
  return {
    text: [
      '🛠 <b>Панель разработчика</b>', '',
      `👥 Пользователей: ${userStats.total} · активны сегодня: ${userStats.activeToday}`,
      `💸 AI сегодня: ${rubText(usage.today.gptCostRub + usage.today.sttCostRub)} · ${usage.today.requests} запрос(ов)`,
      `✉️ Обращения: ${support.length}${newSupport ? ` (новых: ${newSupport})` : ''}`,
      `📝 Заметки: ${devRequests.length}${newDevRequests ? ` (новых: ${newDevRequests})` : ''}`,
      `🎟 Промокодов: ${promoCodes.length}`,
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Пользователи', callback_data: 's:admin:stats' }],
        [{ text: '💸 AI-траты', callback_data: 's:admin:usage' }],
        [{ text: '✉️ Обращения', callback_data: 's:admin:support' }],
        [{ text: '📝 Заметки для разработки', callback_data: 's:admin:devrequests' }],
        [{ text: '🎟 Промокоды', callback_data: 's:admin:promo' }],
        [{ text: '🚪 Выйти из режима разработчика', callback_data: 'a:adminlogout' }],
        [{ text: '🏠 Главное меню', callback_data: 's:home' }],
      ],
    },
  };
}

async function renderAdminStatsScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const stats = await getUserStatsOverview(firestore);
  const top = stats.topActive.length
    ? stats.topActive.map((u, i) => `${i + 1}. ${escapeHtml(u.name)} — ${u.activeDaysCount} ${pluralRu(u.activeDaysCount, 'день', 'дня', 'дней')} активности`).join('\n')
    : 'Пока нет данных.';
  return {
    text: [
      '👥 <b>Пользователи</b>', '',
      `Всего: ${stats.total}`,
      `Новых сегодня: ${stats.newToday} · за 7 дней: ${stats.newWeek}`,
      `Активны сегодня: ${stats.activeToday} · за 7 дней: ${stats.activeWeek} · за 30 дней: ${stats.activeMonth}`,
      '', '<b>По частоте заходов:</b>', top,
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🛠 Назад', callback_data: 's:admin' }]] },
  };
}

function renderDevRequestPromptScreen() {
  return {
    text: '📝 <b>Заметка для разработки</b>\n\nНапиши, что поправить или добавить — увидишь в этом же списке в панели.',
    reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 's:admin:devrequests' }]] },
  };
}

async function renderAdminDevRequestsScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const requests = await listDevRequests(firestore, 10);
  const lines = requests.length
    ? requests.map((r) => `${r.status === 'new' ? '🆕' : '·'} ${escapeHtml(r.text)}`).join('\n\n')
    : 'Пока пусто.';
  return {
    text: `📝 <b>Заметки для разработки</b>\n\n${lines}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Добавить заметку', callback_data: 'a:devrequestprompt' }],
        [{ text: '🛠 Назад', callback_data: 's:admin' }],
      ],
    },
  };
}

async function renderAdminUsageScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const usage = await getUsageOverview(firestore);
  const line = (label, t) => `<b>${label}</b>: ${rubText(t.gptCostRub + t.sttCostRub)} · GPT ${rubText(t.gptCostRub)} · STT ${rubText(t.sttCostRub)} · ${t.requests} запрос(ов) · ${t.inputTokens + t.outputTokens} токенов`;
  // Себестоимость НА ПЛАТЯЩЕГО ПОЛЬЗОВАТЕЛЯ за месяц (см. economics.js: цель 30-40₽, средний
  // максимум по базе — 50₽) — то самое число, ради которого затевался весь аудит, а не просто
  // сумма трат по всем пользователям сразу.
  const cohort = usage.perUser.month.total;
  const cohortLine = cohort.users
    ? `👤 <b>На пользователя (30 дней)</b>: среднее ${rubText(cohort.avgRub)} · медиана ${rubText(cohort.medianRub)} · P90 ${rubText(cohort.p90Rub)} · P95 ${rubText(cohort.p95Rub)} (${cohort.users} польз.)`
    : '👤 На пользователя (30 дней): пока нет данных';
  const topOps = Object.entries(usage.byOperation.month)
    .sort((a, b) => b[1].avgCostRub * b[1].requests - a[1].avgCostRub * a[1].requests)
    .slice(0, 6)
    .map(([op, t]) => `· ${op}: ${t.requests} раз, ~${rubText(t.avgCostRub)}/раз, P95 ${rubText(t.p95CostRub)}`)
    .join('\n');
  return {
    text: [
      '💸 <b>AI-траты</b>', '',
      line('Сегодня', usage.today),
      line('7 дней', usage.week),
      line('30 дней', usage.month),
      '', cohortLine,
      '', topOps ? `📊 <b>По операциям (30 дней)</b>:\n${topOps}` : '📊 По операциям: пока нет данных',
      '', 'Тарифы приблизительные — см. cf-worker/src/ai/pricing.js',
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🛠 Назад', callback_data: 's:admin' }]] },
  };
}

async function renderAdminSupportScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const messages = await listSupportMessages(firestore, 10);
  const lines = messages.length
    ? messages.map((m) => `${m.status === 'new' ? '🆕' : '·'} <i>${escapeHtml(m.source)}</i> · <code>${escapeHtml(m.uid)}</code>\n${escapeHtml(m.text)}`).join('\n\n')
    : 'Пока пусто.';
  return {
    text: `✉️ <b>Обращения в поддержку</b>\n\n${lines}`,
    reply_markup: { inline_keyboard: [[{ text: '🛠 Назад', callback_data: 's:admin' }]] },
  };
}

async function renderAdminPromoScreen(firestore, uid) {
  if (!(await isUserAdmin(firestore, uid))) return renderHome(false);
  const codes = await listPromoCodes(firestore);
  const lines = codes.length
    ? codes.map((c) => `<code>${escapeHtml(c.code)}</code> — использован ${c.usedCount || 0}${c.maxUses != null ? `/${c.maxUses}` : ''} раз`).join('\n')
    : 'Пока нет ни одного кода.';
  return {
    text: `🎟 <b>Промокоды</b>\n\n${lines}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Создать код', callback_data: 'a:promocreate' }],
        [{ text: '🛠 Назад', callback_data: 's:admin' }],
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
        [{ text: '➖ Расход', callback_data: 'a:financeprompt:expense' }, { text: '➕ Пополнение', callback_data: 'a:financeprompt:income' }],
        [{ text: '🏠 Главное', callback_data: 's:home' }],
      ],
    },
  };
}

// Экран-приглашение после нажатия "Пополнение"/"Расход" — следующее текстовое сообщение
// пользователя в чате разбирается parseAmountAndNote (см. reminders.js, НЕ AI) и сразу
// становится операцией; направление (доход/расход) уже известно из выбранной кнопки, парсер
// достаёт только сумму и описание. Отдельного подтверждения не требуется — по той же логике,
// что и "✅ Выполнить" у привычек/событий: одно действие, сразу видимый результат.
function renderFinancePromptScreen(type) {
  const label = type === 'income' ? 'Новое пополнение' : 'Новый расход';
  return {
    text: `${type === 'income' ? '➕' : '➖'} <b>${label}</b>\n\nНапиши сообщением сумму и на что/от кого — например:\n«100 на шоколадку» или «500 такси».`,
    reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 's:finance' }]] },
  };
}

// -------- AI-ассистент (текст и голос — общая точка с index.html, см. ai/router.js) --------
// То же самое planTurn/confirmActions, что использует веб-приложение (см. handleAiChat/
// handleAiVoice в index.js) — никакой отдельной AI-логики под Telegram, только своё
// представление результата под интерфейс бота (одно закреплённое сообщение вместо чата).

// "Сегодня"/"Завтра" с заглавной — так короче и читается как ярлык, а не часть предложения
// (по референсу пользователя: "Сегодня · 16:00" отдельной строкой под названием события).
function aiDayLabel(dateKey) {
  if (!dateKey) return '';
  const today = todayKey(DEFAULT_TZ);
  if (dateKey === today) return 'Сегодня';
  if (dateKey === dateKeyAddDays(today, 1)) return 'Завтра';
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

// Каждое действие — короткая "карточка" в две строки (иконка+название, затем деталь), а не одна
// строка списком — по референсу пользователя (📅 Название \n Сегодня · 16:00).
function aiActionCard(a) {
  switch (a.action) {
    case 'create_event': {
      const when = [aiDayLabel(a.date), a.time].filter(Boolean).join(' · ');
      return `📅 ${escapeHtml(a.title || '')}\n${when || 'Без даты'}`;
    }
    case 'complete_event':
      return `📅 ${escapeHtml(a.title || '')}\nОтметить выполненным`;
    case 'delete_event':
      return `🗑️ ${escapeHtml(a.title || '')}\nУдалить`;
    case 'create_expense':
      return `💰 ${escapeHtml(a.category || a.description || 'Расход')}\n−${formatRub(Math.abs(Number(a.amount) || 0))}`;
    case 'create_income':
      return `💰 ${escapeHtml(a.category || a.description || 'Доход')}\n+${formatRub(Math.abs(Number(a.amount) || 0))}`;
    case 'complete_habit':
      return `🔥 ${escapeHtml(a.name || '')}\nОтметить выполненной`;
    case 'create_section':
      return `📁 ${escapeHtml(a.name || '')}\nНовый раздел`;
    case 'delete_section':
      return `🗑️ ${escapeHtml(a.name || '')}\nУдалить раздел`;
    default:
      return escapeHtml(a.action || 'действие');
  }
}

// plan = {reply, actions, rejected} от planTurn — actions тут ещё НЕ применены (см. п.16/18
// исходной просьбы: несколько действий сразу требуют явного подтверждения), только показаны на
// подтверждение; сам список на этот момент уже сохранён в users/{uid}.pendingAiActions
// (см. handleAiTurn/handleTelegramVoice в index.js) — кнопки ниже лишь ссылаются на него.
// Когда actions есть, заголовок — фиксированная фраза "Хорошо, я понял так:" (не текст модели —
// он бы дублировал уже показанные ниже карточки); reply модели показывается только когда action'ов
// нет вовсе (обычный вопрос-ответ) — по референсу пользователя.
export function renderAiPlanScreen(plan) {
  const hasActions = plan.actions && plan.actions.length;
  const lines = [hasActions ? '🤖 Атлас понял так:' : '🤖 ' + escapeHtml(plan.reply || 'Готово.')];
  if (plan.rejected && plan.rejected.length) {
    lines.push('', `⚠️ Не понял: ${plan.rejected.map((r) => escapeHtml(r.error || 'действие')).join('; ')}`);
  }
  const rows = [];
  if (hasActions) {
    lines.push('', plan.actions.map((a) => aiActionCard(a)).join('\n\n'));
    rows.push([{ text: '✅ Подтвердить', callback_data: 'a:aiconfirm' }]);
    rows.push([{ text: '✕ Отмена', callback_data: 'a:aicancel' }]);
  }
  rows.push([{ text: '🏠 Главное меню', callback_data: 's:home' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
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
  if (screen.startsWith('finance:prompt:')) return renderFinancePromptScreen(screen.slice('finance:prompt:'.length));
  if (screen === 'news') return renderNewsScreen();
  if (screen === 'today') return renderTodayScreen(env, firestore, uid);
  if (screen === 'support') return renderSupportPromptScreen();
  if (screen === 'admin') return renderAdminScreen(firestore, uid);
  if (screen === 'admin:stats') return renderAdminStatsScreen(firestore, uid);
  if (screen === 'admin:usage') return renderAdminUsageScreen(firestore, uid);
  if (screen === 'admin:support') return renderAdminSupportScreen(firestore, uid);
  if (screen === 'admin:devrequests') return renderAdminDevRequestsScreen(firestore, uid);
  if (screen === 'admin:devrequest') return renderDevRequestPromptScreen();
  if (screen === 'admin:promo') return renderAdminPromoScreen(firestore, uid);
  return renderHome(await isUserAdmin(firestore, uid));
}

// -------- Действия (что-то меняют, потом возвращают на какой экран отрисоваться) --------
export async function runAction(firestore, uid, action) {
  if (action.startsWith('financeprompt:')) {
    // Запоминаем, что от этого пользователя ждём следующим сообщением сумму+описание (см.
    // pendingFinanceInput в index.js#handleTelegramWebhook) — поле снимается там же сразу после
    // разбора текста (успешного или нет), а также при любом обычном переходе по меню (см. `s:`
    // ветку в index.js), чтобы не "залипало" навсегда, если пользователь передумал и ушёл в
    // другой раздел, не написав ничего.
    const type = action.slice('financeprompt:'.length) === 'income' ? 'income' : 'expense';
    await firestore.mergeDoc(`users/${uid}`, { pendingFinanceInput: type });
    return { toast: null, nextScreen: `finance:prompt:${type}` };
  }
  if (action === 'supportprompt') {
    // Тот же паттерн, что financeprompt выше — следующее сообщение пользователя ловит
    // pendingSupportInput в index.js#handleTelegramFreeText, а не уходит в AI.
    await firestore.mergeDoc(`users/${uid}`, { pendingSupportInput: true });
    return { toast: null, nextScreen: 'support' };
  }
  if (action === 'promocreate') {
    if (!(await isUserAdmin(firestore, uid))) return { toast: 'Недоступно', nextScreen: 'home' };
    const code = await createPromoCode(firestore, {});
    return { toast: `Код создан: ${code}`, nextScreen: 'admin:promo' };
  }
  if (action === 'devrequestprompt') {
    if (!(await isUserAdmin(firestore, uid))) return { toast: 'Недоступно', nextScreen: 'home' };
    // Тот же паттерн, что supportprompt выше — следующее сообщение ловит pendingDevRequestInput
    // в index.js#handleTelegramFreeText, а не уходит в AI.
    await firestore.mergeDoc(`users/${uid}`, { pendingDevRequestInput: true });
    return { toast: null, nextScreen: 'admin:devrequest' };
  }
  if (action === 'adminlogout') {
    // Реальный выход, а не просто скрытие кнопки — снимает isAdmin на сервере (см. lockAdmin
    // в admin.js), поэтому без повторного ввода пароля панель больше не откроется.
    await lockAdmin(firestore, uid);
    return { toast: 'Вышел из режима разработчика', nextScreen: 'home' };
  }
  if (action === 'aiconfirm') {
    // Список действий на подтверждение не помещается в callback_data (лимит Telegram — 64
    // байта, а тут может быть несколько событий/операций сразу), поэтому лежит в Firestore
    // (см. handleAiTurn/handleTelegramVoice в index.js) — кнопка лишь ссылается на него.
    // confirmActions заново валидирует каждое действие, не доверяя слепо тому, что тут лежит
    // (тот же принцип, что и в /ai/confirm — см. router.js).
    const user = await firestore.getDoc(`users/${uid}`);
    const pending = Array.isArray(user?.pendingAiActions) ? user.pendingAiActions : [];
    await firestore.mergeDoc(`users/${uid}`, { pendingAiActions: null });
    if (!pending.length) return { toast: 'Нечего подтверждать', nextScreen: 'home' };
    const results = await confirmActions(firestore, uid, pending);
    const ok = results.filter((r) => r.ok).length;
    return { toast: `Готово: ${ok}/${results.length}`, nextScreen: 'home' };
  }
  if (action === 'aicancel') {
    await firestore.mergeDoc(`users/${uid}`, { pendingAiActions: null });
    return { toast: 'Отменено', nextScreen: 'home' };
  }
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
    // opts.forceNew — реплики AI-ассистента (см. handleAiTurn/handleTelegramVoice в index.js)
    // никогда не редактируют старое сообщение на месте: пока идёт переписка, оно уходит вверх
    // под новыми сообщениями пользователя и становится не видно без прокрутки. Каждый новый
    // ответ AI — заново отправленное сообщение внизу чата, у самого поля ввода; старое (и то,
    // что Telegram прямо сейчас считает закреплённым) удаляется ниже, как при обычном пересоздании.
    const stillPinned = !opts.forceNew && (chat ? !!(chat.pinned_message && chat.pinned_message.message_id === storedId) : true);
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
