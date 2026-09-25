// Детерминированный локальный разбор ОЧЕВИДНЫХ команд Atlas — без единого обращения к LLM.
// Аудит AI-себестоимости (сентябрь 2026) показал, что каждое сообщение пользователя — даже
// «100 рублей шоколадка» — шло прямиком в YandexGPT Lite с полным контекстом дня. Основная
// масса сообщений Atlas — это как раз такие однозначные команды (см. п.1/7 аудита: сначала
// сократить КОЛИЧЕСТВО вызовов, а не выбор модели). Эта функция перехватывает их ДО обращения
// к провайдеру (см. planTurn в router.js) — реального AI-вызова для них не происходит вовсе,
// значит 0 input/output tokens и 0 ₽.
//
// Возвращает { actions, reply } в ТОМ ЖЕ формате, что и provider.route() (см. provider.js), если
// разбор уверенный, или null — тогда вызывающий код как раньше идёт в Lite. Намеренно НЕ пытается
// стать полноценным NLP (см. п.7 аудита: "не превращай local parser в NLP") — только частые,
// однозначные случаи; при малейшей неуверенности отдаёт текст модели, а не гадает сам.
//
// ВАЖНО про \b и кириллицу: обычный \b в JS regex не работает с русскими буквами (кириллица не
// входит в \w по умолчанию — "\bТренировку\b" не матчит "тренировку" вообще, ложно-отрицательный
// результат на 100% случаев). Везде ниже, где нужна граница слова, используются явные
// (?<![a-zа-яё0-9]) / (?![a-zа-яё0-9]) вместо \b — см. wholeWordEdge.
import { parseAmountAndNote } from '../reminders.js';

const INCOME_KEYWORDS = /(зарплат|аванс|премия|гонорар|стипенди|доход|возврат|вернул|верну\b|перевели\s+мне|поступил|пополнил|получил)/i;
// Слова, которые указывают на СОВСЕМ другое действие (событие/привычка/раздел) или на то, что
// число рядом с ними — вообще не сумма (время, дата, период) — если такое слово есть в тексте,
// это не однозначная "сумма+описание" команда, лучше отдать модели. Обнаружено бенчмарком (см.
// п.24 аудита): без "трениров"/"завтра" фраза "запиши тренировку завтра в 15" тихо становилась
// расходом "15 ₽ · Запиши тренировку завтра в" (15 — это время, а не сумма); без "анализ" фраза
// "проанализируй мои расходы за последние 3 месяца" тихо становилась расходом "3 ₽" — оба случая
// создали бы РЕАЛЬНУЮ ошибочную транзакцию, а не просто ушли не в тот AI-уровень, поэтому список
// специально с запасом, а не только под сегодняшние 10 сценариев теста.
const OTHER_ACTION_KEYWORDS = /(событ|встреч|напомни|привычк|трениров|раздел|удали|сотри|убери|отмет|выполнил[аи]?|заверш|завтра|послезавтра|следующ|анализ|закономерн|статистик|тенденц)/i;
const QUESTION_LIKE = /[?]|(?:^|\s)(сколько|что|какие|как(?:\s+ид|ие)|куда|когда|где)\s/i;

// "сколько я потратил сегодня?" / "что у меня сегодня?" и т.п. — не создают ничего, просто
// отвечают по уже загруженным данным дня (todayCtx уже посчитан для planTurn в любом случае,
// см. buildDayContext в context.js — доп. чтения из Firestore тут не требуется).
function tryFactualQuery(text, todayCtx) {
  const t = text.trim().toLowerCase();
  if (/сколько.*(потратил|потрачен|расход)/i.test(t) && /сегодня/i.test(t)) {
    return { actions: [], reply: `Сегодня потрачено: ${todayCtx.finance.spent.toLocaleString('ru-RU')} ₽.` };
  }
  if (/сколько.*(заработ|получил|доход|пополнени)/i.test(t) && /сегодня/i.test(t)) {
    return { actions: [], reply: `Сегодня получено: ${todayCtx.finance.earned.toLocaleString('ru-RU')} ₽.` };
  }
  if (/^что\s+(у\s+меня\s+)?(сегодня|на\s+сегодня)\s*[?.!]*$/i.test(t) || /^что\s+сегодня\s*[?.!]*$/i.test(t)) {
    const events = todayCtx.events.length
      ? todayCtx.events.map((e) => `${e.time ? e.time + ' ' : ''}${e.title}${e.done ? ' ✓' : ''}`).join('; ')
      : 'событий нет';
    const habits = todayCtx.habits.length
      ? todayCtx.habits.map((h) => `${h.name}${h.done ? ' ✓' : ''}`).join('; ')
      : 'привычек нет';
    return { actions: [], reply: `Сегодня: ${events}. Привычки: ${habits}.` };
  }
  // "Цели" (накопления в разделе Финансы) хранятся ТОЛЬКО в localStorage браузера (см.
  // state.finance.goals / saveJSON('goals', ...) в index.html) — этот backend вообще не видит
  // эти данные ни в каком виде, никогда, ни для одного пользователя (не "забыли прокинуть в
  // контекст", а физически нет синхронизации в Firestore). Раньше вопрос "как идут мои цели?"
  // всё равно уходил в Lite и получал платный, но заведомо пустой ответ (у модели тоже нет этих
  // данных) — теперь тот же самый по сути "нет данных" ответ даётся мгновенно и бесплатно, без
  // изменения того, что Атлас реально умеет.
  if (/цел[ьи]|накоплени/i.test(t) && QUESTION_LIKE.test(t)) {
    return { actions: [], reply: 'Пока не вижу цели — этот раздел Финансов ещё не подключён к Атласу. Посмотри вкладку «Цели» в приложении.' };
  }
  return null;
}

// Русский язык склоняет слова по падежам ("Тренировка" в тексте почти всегда встречается как
// "тренировку"/"тренировкой" и т.п., а не в исходной форме) — обычный \b тоже тут не помог бы
// (см. шапку файла): нужен не точный, а "с запасом на окончание" матч. Отрезаем 1 букву у слов
// длиннее 6 (грубый стемминг) и разрешаем ещё до 2 букв окончания после стема — этого достаточно
// для типичных падежных окончаний (-у/-ой/-ом/-е и т.п.), но НЕ достаточно, чтобы случайно
// зацепить другое слово с тем же началом (например "Спорт" не должен матчить "спортзал" — там
// нужно было бы 3 лишних буквы "зал", а не 2).
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wordStem(word) {
  const w = word.toLowerCase();
  return w.length > 6 ? w.slice(0, w.length - 1) : w;
}
function matchesEntityName(name, text) {
  const firstWord = String(name || '').trim().split(/\s+/)[0];
  if (!firstWord) return false;
  const stem = wordStem(firstWord);
  const re = new RegExp(`(?<![a-zа-яё0-9])${escapeRegExp(stem)}[a-zа-яё]{0,2}(?![a-zа-яё0-9])`, 'i');
  return re.test(text);
}

const COMPLETION_VERBS = /(отметь|отмет|выполнил[аи]?|сделал[аи]?|готово|закончил[аи]?|завершил[аи]?|справил[аи]?сь)/i;
const DELETE_VERBS = /(удали|сотри|убери|стереть|отмени)/i;

// "отметь тренировку выполненной" / "закончил встречу" — закрытый, уже известный из todayCtx
// список имён привычек/событий на сегодня (см. п.1 просьбы: "простое CRUD-действие ≠ обязательно
// AI-задача", это ровно такой случай) — совпадение ищем ТОЛЬКО среди реальных сегодняшних имён,
// а не угадываем по общим словам, поэтому риск ложного срабатывания намного ниже, чем у
// tryExpenseIncome (там открытый домен "любое число"). Если совпало НЕСКОЛЬКО привычек сразу
// (или задача выглядит как удаление) — не гадаем, отдаём Lite.
function tryCompleteHabit(text, todayCtx) {
  if (!COMPLETION_VERBS.test(text)) return null;
  if (QUESTION_LIKE.test(text)) return null;
  if (DELETE_VERBS.test(text)) return null;
  const matches = (todayCtx.habits || []).filter((h) => h.name && matchesEntityName(h.name, text));
  if (matches.length !== 1) return null;
  const habit = matches[0];
  return { actions: [{ action: 'complete_habit', name: habit.name }], reply: `Вот что сделаю: ✅ ${habit.name}.` };
}

// Та же идея, что и tryCompleteHabit, но по сегодняшним/завтрашним событиям вместо привычек;
// уже выполненные события (done:true) не предлагаем отметить повторно — если единственное
// совпадение как раз такое, лучше промолчать и отдать Lite, чем создать бессмысленное действие.
function tryCompleteEvent(text, todayCtx) {
  if (!COMPLETION_VERBS.test(text)) return null;
  if (QUESTION_LIKE.test(text)) return null;
  if (DELETE_VERBS.test(text)) return null;
  const matches = (todayCtx.events || []).filter((e) => e.title && !e.done && matchesEntityName(e.title, text));
  if (matches.length !== 1) return null;
  const event = matches[0];
  return { actions: [{ action: 'complete_event', title: event.title }], reply: `Вот что сделаю: ✅ ${event.title}.` };
}

// "встреча завтра в 9" / "тренировка завтра в 15" — узкий, специально ОЧЕНЬ строгий разбор
// create_event: требует ОДНОВРЕМЕННО явное слово дня (сегодня/завтра/послезавтра — "через
// неделю"/"в пятницу" и т.п. НЕ поддерживаются, это уже не однозначно) И явное "в ЧЧ[:ММ]". Если
// в сообщении остались ЛЮБЫЕ другие цифры после того, как убрали найденные день и время — не
// уверены, что распознали верно (типичный случай — сообщение на самом деле про два действия
// сразу, как было в реальном баге "занеси... встречу а также трата 380р", см. provider.js),
// отдаём Lite. НЕ пытается понять относительное время ("через час") или день недели — это
// осознанно оставлено модели (см. п.7 аудита: "не превращай local parser в NLP").
const DAY_WORDS = [
  [/(?<![a-zа-яё0-9])послезавтра(?![a-zа-яё0-9])/i, 2],
  [/(?<![a-zа-яё0-9])завтра(?![a-zа-яё0-9])/i, 1],
  [/(?<![a-zа-яё0-9])сегодня(?![a-zа-яё0-9])/i, 0],
];
const TIME_PATTERN = /(?:^|[^a-zа-яё0-9])в\s+(\d{1,2})(?::(\d{2}))?(?!\d)/i;
const CREATION_HINT = /(запиши|добавь|создай|поставь|запланируй|назначь)/i;
const FINANCE_HINT = /(потрат|оплат|купил[аи]?|получил[аи]?|зарплат|доход|расход|пополнил[аи]?)/i;

function tryCreateEventNarrow(text, dateKeyAddDays, todayKey) {
  if (QUESTION_LIKE.test(text)) return null;
  if (DELETE_VERBS.test(text)) return null;
  if (FINANCE_HINT.test(text)) return null; // похоже на финансовую операцию, не на событие

  const timeMatch = TIME_PATTERN.exec(text);
  if (!timeMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const timeStart = timeMatch.index + timeMatch[0].indexOf('в');
  let rest = text.slice(0, timeStart) + ' ' + text.slice(timeMatch.index + timeMatch[0].length);

  let dayOffset = null;
  for (const [re, offset] of DAY_WORDS) {
    const m = re.exec(rest);
    if (m) {
      dayOffset = offset;
      rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
      break;
    }
  }
  if (dayOffset === null) return null; // без явного дня — не гадаем "сегодня по умолчанию"
  if (/\d/.test(rest)) return null; // остались другие числа — похоже на составное сообщение

  const title = rest.replace(CREATION_HINT, ' ').replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 60) return null;

  const dateKey = dateKeyAddDays(todayKey(), dayOffset);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayLabel = dayOffset === 0 ? 'сегодня' : dayOffset === 1 ? 'завтра' : 'послезавтра';
  const titleCap = title[0].toUpperCase() + title.slice(1);
  return {
    actions: [{ action: 'create_event', title: titleCap, date: dateKey, time }],
    reply: `Вот что сделаю: 📅 ${titleCap} — ${dayLabel} · ${time}.`,
  };
}

// "100 рублей шоколадка" / "такси 500" / "зарплата 120000" — сумма+описание, направление
// (расход/доход) определяем по ключевым словам, а не спрашиваем; без явного income-слова
// по умолчанию расход (см. примеры в аудите — "такси 500"/"кофе 350" без слова "расход" всё
// равно расход, ровно то же допущение уже делает parseFinInput в index.html для формы).
function tryExpenseIncome(text) {
  const t = text.trim();
  if (t.length > 80) return null; // длинное сообщение — выше риск, что это не простая команда
  if (QUESTION_LIKE.test(t)) return null; // похоже на вопрос, не на команду создания
  if (OTHER_ACTION_KEYWORDS.test(t)) return null; // похоже на событие/привычку/раздел
  const numberMatches = t.match(/\d[\d\s.,]*/g) || [];
  if (numberMatches.length !== 1) return null; // больше одного числа — не уверены, какое сумма

  const parsed = parseAmountAndNote(t);
  if (!parsed || !(parsed.amount > 0) || parsed.amount > 1e9) return null;

  const isIncome = INCOME_KEYWORDS.test(t);
  const action = isIncome ? 'create_income' : 'create_expense';
  const label = isIncome ? 'Пополнение' : 'Расход';
  return {
    actions: [{ action, amount: parsed.amount, description: parsed.note || undefined }],
    reply: `Вот что сделаю: ${label} ${parsed.amount.toLocaleString('ru-RU')} ₽${parsed.note ? ' · ' + parsed.note : ''}.`,
  };
}

// Если СРАЗУ несколько разборщиков независимо решили, что уверены (например текст одновременно
// похож и на завершение привычки, и на завершение события с тем же началом слова) — это как раз
// повод не гадать, какой из них прав, а не выбирать по порядку вызова: отдаём null, вызывающий
// код идёт в Lite.
function tryExactlyOne(candidates) {
  const hits = candidates.filter(Boolean);
  return hits.length === 1 ? hits[0] : null;
}

// todayCtx — тот же объект, что planTurn уже получил от buildDayContext(today) для system prompt
// на случай, если распознать не удастся; передаём его сюда, чтобы factual-запросы и разбор
// привычек/событий не требовали повторного чтения Firestore. dateKeyAddDays/todayKey — те же
// функции из reminders.js, что использует router.js, передаются параметрами, а не импортируются
// здесь напрямую, чтобы не плодить второй способ узнать "какой сегодня день" в проекте.
export function tryLocalParse(text, todayCtx, dateKeyAddDays, todayKey) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const factual = tryFactualQuery(raw, todayCtx);
  if (factual) return factual;
  const actionMatch = tryExactlyOne([
    tryCompleteHabit(raw, todayCtx),
    tryCompleteEvent(raw, todayCtx),
    tryCreateEventNarrow(raw, dateKeyAddDays, todayKey),
  ]);
  return actionMatch || tryExpenseIncome(raw);
}
