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
export function eventCoversDate(e, dateKey) {
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

// Тот же id-формат, что клиент использует для событий/разделов/транзакций (Date.now в base36 +
// немного случайности, см. uid()/plannerId() в index.html) — не обязателен для их алгоритмов
// (там id проставляется лениво при загрузке, см. withIds), но при создании С СЕРВЕРА (голосовой
// AI, см. cf-worker/src/ai/) хотим сразу получить адресуемую запись, а не ждать следующей
// нормализации на клиенте.
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Создание нового события планера — используется голосовым/текстовым AI-ассистентом
// (см. cf-worker/src/ai/actions.js#execCreateEvent). Та же форма объекта, что и ручное
// сохранение в форме события (см. commitForm в index.html): минимальный набор полей,
// остальное (блоки, повтор, цвет раздела) можно донастроить потом в самом приложении.
export async function createPlannerEvent(firestore, uid, { title, date, time, duration, sectionId }) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const event = {
    id: generateId(),
    title,
    date,
    time: time || null,
    duration: duration || 60,
    sectionId: sectionId || null,
    // color остаётся null (не копируется цвет раздела на само событие) — так же, как при ручном
    // создании без выбора отдельного цвета: plannerEventColor() в index.html сама подставляет
    // цвет раздела через sectionId, если у события своего color нет (см. e.sectionId ниже).
    color: null,
    blocks: [],
    repeat: null,
    done: false,
    comments: [],
    createdAt: new Date().toISOString(),
  };
  events.push(event);
  await firestore.mergeDoc(path, { events });
  return event;
}

// Та же палитра и та же логика выбора цвета по умолчанию (по индексу нового раздела в общем
// списке), что PL_COLORS в index.html — раздел, созданный голосовым/текстовым AI, должен
// выглядеть так же, как созданный вручную в самом приложении, а не отдельным набором цветов.
const PL_COLORS = ['#c9a84c', '#7fb8e0', '#e08fa0', '#8fd19e', '#d6a8e8', '#e0b17f', '#a3d9d3'];

// Найти УЖЕ существующий раздел по названию (без учёта регистра/пробелов) — нужен голосовому/
// текстовому AI, когда просят "создай событие в разделе Х": раньше create_event вообще не умел
// принимать раздел, и модель в попытке выполнить просьбу дублировала его через create_section,
// хотя такой раздел уже был. Возвращает id или null, если раздела с таким именем нет (тогда
// событие создаётся без раздела, а не с придуманным новым — см. execCreateEvent в actions.js).
export async function findSectionIdByName(firestore, uid, name) {
  if (!name) return null;
  const data = (await firestore.getDoc(`users/${uid}/appData/planner`)) || {};
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const match = sections.find((s) => s && norm(s.name) === norm(name));
  return match ? match.id : null;
}

// Новый раздел планера — используется голосовым/текстовым AI-ассистентом (execCreateSection
// в actions.js). Та же форма {id, name, color}, что и sections, которые создаёт сам клиент.
export async function createSection(firestore, uid, { name, color }) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const sections = Array.isArray(data.sections) ? [...data.sections] : [];
  const section = { id: generateId(), name, color: color || PL_COLORS[sections.length % PL_COLORS.length] };
  sections.push(section);
  await firestore.mergeDoc(path, { sections });
  return section;
}

// Удалить раздел планера по НАЗВАНИЮ (без учёта регистра/пробелов — та же логика сопоставления,
// что и у findSectionIdByName выше) — используется голосовым/текстовым AI (execDeleteSection в
// actions.js). Сами события раздела не удаляются, только отвязываются (sectionId:null) — точно
// то же поведение, что и у ручного удаления раздела через форму в приложении (см. #pl-section-
// delete в index.html: "События останутся без раздела"). Возвращает удалённый раздел или null,
// если раздела с таким именем нет — тогда исполнитель отвечает отказом, а не тихо ничего не делает.
export async function deleteSectionByName(firestore, uid, name) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const sections = Array.isArray(data.sections) ? [...data.sections] : [];
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const idx = sections.findIndex((s) => s && norm(s.name) === norm(name));
  if (idx === -1) return null;
  const [removed] = sections.splice(idx, 1);
  const patchedEvents = events.map((e) => (e && e.sectionId === removed.id ? { ...e, sectionId: null } : e));
  await firestore.mergeDoc(path, { sections, events: patchedEvents });
  return removed;
}

// Ближайшее к hex-цвету раздела название цвета по-русски (грубый nearest-match по RGB-дистанции,
// та же идея, что у SECTION_COLOR_SWATCHES в bot.js для цветных квадратов-эмодзи, только тут
// текстовое имя, а не эмодзи) — нужно голосовому/текстовому AI, когда пользователь называет
// раздел по цвету ("удали зелёный раздел"), а не по имени: цвета в приложении свободные (палитра
// выбора цвета шире исходных семи), поэтому точного попадания в конкретный hex не будет — важно
// не точное совпадение, а разумное "к какому базовому цвету это ближе всего".
const NAMED_COLOR_SWATCHES = [
  ['красный', [229, 49, 44]],
  ['оранжевый', [244, 144, 12]],
  ['жёлтый', [253, 203, 88]],
  ['зелёный', [120, 177, 89]],
  ['синий', [85, 172, 238]],
  ['фиолетовый', [170, 122, 192]],
  ['розовый', [224, 143, 160]],
  ['коричневый', [150, 109, 74]],
  ['чёрный', [30, 30, 30]],
  ['белый', [240, 240, 240]],
];
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function nearestColorName(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [name, ref] of NAMED_COLOR_SWATCHES) {
    const dist = (rgb[0] - ref[0]) ** 2 + (rgb[1] - ref[1]) ** 2 + (rgb[2] - ref[2]) ** 2;
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return best;
}

// Отметить событие выполненным по НАЗВАНИЮ (не по id — AI не знает внутренний id, только то, что
// видел в контексте дня, см. context.js), на заданную дату (по умолчанию сегодня). Сопоставление
// без учёта регистра/пробелов по краям; если событие уже выполнено или не найдено — вернёт null,
// а не тихо создаст новое (см. execCompleteEvent в actions.js — там же формируется отказ).
export async function completeEventByTitle(firestore, uid, { title, date }) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const dateKey = date || todayKey(DEFAULT_TZ);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const idx = events.findIndex((e) => e && !e.done && norm(e.title) === norm(title) && eventCoversDate(e, dateKey));
  if (idx === -1) return null;
  events[idx] = { ...events[idx], done: true };
  await firestore.mergeDoc(path, { events });
  return events[idx];
}

// Удалить событие по НАЗВАНИЮ (та же логика поиска, что и completeEventByTitle) — в отличие от
// completeEventByTitle не фильтрует по !e.done: пользователь может захотеть удалить и уже
// выполненное событие, done тут не признак "нельзя трогать". Возвращает удалённое событие или
// null, если не нашлось (см. execDeleteEvent в actions.js — там же формируется отказ).
export async function deleteEventByTitle(firestore, uid, { title, date }) {
  const path = `users/${uid}/appData/planner`;
  const data = (await firestore.getDoc(path)) || {};
  const events = Array.isArray(data.events) ? [...data.events] : [];
  const dateKey = date || todayKey(DEFAULT_TZ);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const idx = events.findIndex((e) => e && norm(e.title) === norm(title) && eventCoversDate(e, dateKey));
  if (idx === -1) return null;
  const [removed] = events.splice(idx, 1);
  await firestore.mergeDoc(path, { events });
  return removed;
}

// Финансовый документ целиком — как getHabitsDoc/getPlannerDoc, чтобы не дублировать
// firestore.getDoc(...finance) в каждом месте (bot.js/digest.js читали его инлайн).
export async function getFinanceDoc(firestore, uid) {
  return (await firestore.getDoc(`users/${uid}/appData/finance`)) || {};
}

// Новая финансовая операция — та же форма объекта, что тумблеры "Дата"/"Повторять" в приложении
// (см. finTransactionForm в index.html): amount со знаком (отрицательный у расхода), type,
// category, note, date, плюс новая модель planned/completed (см. ТЗ на переработку раздела
// "Финансы", п.24 "Главное правило финансового учёта"). Используется голосовым/текстовым
// AI-ассистентом — сейчас Atlas всегда создаёт СЕГОДНЯШНЮЮ completed-операцию (см. execCreateExpense/
// execCreateIncome в actions.js, там date/repeat пока не прокинуты из ACTION_SCHEMA), но сама
// функция уже принимает status/mandatory/repeat/goalId, чтобы расширение Atlas на "запланируй
// платёж"/повторяемость не потребовало снова трогать backend-запись.
export async function addFinanceTransaction(firestore, uid, { amount, type, category, note, date, status, mandatory, repeat, goalId }) {
  const path = `users/${uid}/appData/finance`;
  const data = (await firestore.getDoc(path)) || {};
  const transactions = Array.isArray(data.transactions) ? [...data.transactions] : [];
  const tx = {
    id: generateId(),
    amount,
    type,
    category: category || null,
    note: note || '',
    date,
    status: status || (date > todayKey(DEFAULT_TZ) ? 'planned' : 'completed'),
  };
  if (mandatory) tx.mandatory = true;
  if (repeat) tx.repeat = repeat;
  if (goalId) tx.goalId = goalId;
  transactions.push(tx);
  await firestore.mergeDoc(path, { transactions });
  return tx;
}

// Разбор текста вида "100 на шоколадку" / "500р такси" в {amount, note} — НЕ AI, обычный
// разбор строки регулярками (по прямой просьбе пользователя: кнопки "Пополнение"/"Расход" в
// боте (см. renderFinancePromptScreen в bot.js) должны работать бесплатно и мгновенно, без
// обращения к внешнему API — направление (доход/расход) уже известно из того, какую кнопку
// нажали, парсеру остаётся достать только сумму и описание). Возвращает null, если в тексте
// вообще нет числа — тогда пользователю нужно попробовать ещё раз.
export function parseAmountAndNote(text) {
  const raw = String(text || '').trim();
  // Порядок альтернатив важен: регулярка берёт первую подошедшую, а не самую длинную — "р\.?"
  // раньше стояло первым и "откусывало" только "р" от "руб", оставляя "уб" в начале описания.
  const m = /(\d[\d\s]*(?:[.,]\d+)?)\s*(?:рублей|руб\.?|р\.?|₽)?/i.exec(raw);
  if (!m) return null;
  const amount = Number(m[1].replace(/\s+/g, '').replace(',', '.'));
  if (!(amount > 0)) return null;
  let note = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
  // Частые вводные слова ("потратил 100 на кофе", "получил 5000 зарплата") — не несут смысла
  // как описание сами по себе, отдельно убираем сначала глагол, потом предлог, раз за разом
  // оставшийся текст мог начинаться с любого из них после первого вырезания.
  note = note.replace(/^(?:потратил(?:а)?|заплатил(?:а)?|купил(?:а)?|получил(?:а)?|пришло)\s+/i, '').trim();
  note = note.replace(/^(?:на|за|от|из|для|по)\s+/i, '').trim();
  note = note.replace(/\s{2,}/g, ' ');
  if (note) note = note.charAt(0).toUpperCase() + note.slice(1);
  return { amount, note };
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
