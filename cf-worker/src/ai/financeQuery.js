// Локальный Finance Query Engine (см. ТЗ п.11-17) — отвечает на большинство вопросов пользователя
// о СВОИХ финансовых данных без единого обращения к LLM: разбор вопроса (intent + filters),
// подсчёт (обычным кодом по уже загруженным транзакциям) и формирование ответа — всё детерминиро-
// ванно. LLM сюда не передаётся НИ разу, ни сами транзакции, ни промежуточный результат — если
// движок не смог уверенно разобрать вопрос, он просто возвращает null и вызывающий код (router.js)
// идёт в Lite с обычным текстом вопроса (без сотен транзакций в контексте, см. ТЗ п.17).
import { findEntity } from './entities.js';
import { SUBCATEGORIES } from './classify.js';

// -------- Периоды (см. ТЗ п.14) --------
function parseDateKey(dk) {
  const [y, m, d] = String(dk).split('-').map(Number);
  return { y, m, d };
}
function toDateKey(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function addDaysDk(dk, days) {
  const { y, m, d } = parseDateKey(dk);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return toDateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function addMonthsDk(dk, months) {
  const { y, m, d } = parseDateKey(dk);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return toDateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function startOfMonthDk(dk) {
  const { y, m } = parseDateKey(dk);
  return toDateKey(y, m, 1);
}
function endOfMonthDk(dk) {
  const { y, m } = parseDateKey(dk);
  return toDateKey(y, m + 1, 0);
}
function startOfYearDk(dk) {
  const { y } = parseDateKey(dk);
  return toDateKey(y, 1, 1);
}

// Возвращает {start,end,label} в dateKey ("YYYY-MM-DD", обе границы включительно) или null, если
// в тексте вообще нет явной привязки к периоду — тогда filters.period остаётся null ("за всё
// время", см. runFinanceQuery).
export function parsePeriodPhrase(text, today) {
  const t = text.toLowerCase();
  // \b здесь намеренно НЕ используется — с кириллицей он не работает (см. комментарий в шапке
  // localParser.js и в classify.js): "сегодня"/"вчера" достаточно длинные и однозначные слова,
  // чтобы просто искать подстроку, без риска случайно зацепить другое слово.
  if (/сегодня/.test(t)) return { start: today, end: today, label: 'сегодня' };
  if (/вчера/.test(t)) return { start: addDaysDk(today, -1), end: addDaysDk(today, -1), label: 'вчера' };
  if (/прошл(?:ой|ую|ая)\s+недел/.test(t)) return { start: addDaysDk(today, -13), end: addDaysDk(today, -7), label: 'на прошлой неделе' };
  if (/эт(?:ой|у|а)\s+недел|за\s+недел/.test(t)) return { start: addDaysDk(today, -6), end: today, label: 'за последнюю неделю' };
  if (/прошл(?:ый|ом|ого)\s+месяц/.test(t)) {
    const prevMonthAnyDay = addMonthsDk(startOfMonthDk(today), -1);
    return { start: startOfMonthDk(prevMonthAnyDay), end: endOfMonthDk(prevMonthAnyDay), label: 'в прошлом месяце' };
  }
  if (/эт(?:ом|от|ого)\s+месяц|за\s+месяц/.test(t)) return { start: startOfMonthDk(today), end: today, label: 'в этом месяце' };
  if (/с\s+начала\s+года/.test(t)) return { start: startOfYearDk(today), end: today, label: 'с начала года' };
  if (/последн(?:ие|их)\s+3\s+месяц/.test(t)) return { start: addMonthsDk(today, -3), end: today, label: 'за последние 3 месяца' };
  if (/последн(?:ие|их)\s+6\s+месяц/.test(t)) return { start: addMonthsDk(today, -6), end: today, label: 'за последние 6 месяцев' };
  if (/последн(?:ие|их)\s+12\s+месяц|за\s+год|годов/.test(t)) return { start: addMonthsDk(today, -12), end: today, label: 'за последние 12 месяцев' };
  if (/эт(?:ом|от)\s+год/.test(t)) return { start: startOfYearDk(today), end: today, label: 'в этом году' };
  return null;
}

// -------- Разбор темы вопроса (item/merchant/counterparty/category/subcategory/purpose) --------
const TOPIC_ALIASES = { 'еда': ['Продукты', 'Рестораны'], 'еду': ['Продукты', 'Рестораны'] };
const CATEGORY_NAMES = Object.keys(SUBCATEGORIES);
const SUBCATEGORY_NAMES = Object.values(SUBCATEGORIES).flat();

function normWord(s) { return String(s || '').trim().toLowerCase().replace(/ё/g, 'е'); }
function stemWord(w) { const s = normWord(w); return s.length > 4 ? s.slice(0, s.length - 2) : s; }
function stemIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  const hs = normWord(haystack).split(/\s+/).map(stemWord);
  return hs.includes(stemWord(needle));
}

const TRANSFER_QUERY = /(?:перевод(?:ил|ила|ы)?|скинул[а]?|отправил[а]?)\s+(?:денег\s+)?([А-ЯЁ][а-яё]+)/;
// Предлоги "на/за/в/у" — однобуквенные-двухбуквенные, реально рискуют совпасть ВНУТРИ другого
// слова, поэтому им здесь нужна настоящая граница, а не \b (тот не работает с кириллицей — см.
// комментарий в classify.js): используется тот же lookaround-приём, что уже есть в localParser.js.
const TOPIC_PREPOSITIONS = /(?<![a-zа-яё0-9])(?:на|за|в|у)(?![a-zа-яё0-9])/gi;
// Голое временное слово БЕЗ дальнейшего уточнения ("...в месяц?", "...за раз?") — это не тема
// вопроса, а обрывок периода/кратности; полные периодные фразы ("в этом месяце") отсекает отдельно
// сам parsePeriodPhrase(phrase) ниже — двух проверок вместе достаточно, не пытаясь быть идеальной
// грамматикой.
const BARE_TIME_WORD = /^(месяц|год|недел|раз|дня|дней|период)/i;

function resolveTopicPhrase(phrase, entitiesDoc) {
  const aliasKey = normWord(phrase);
  if (TOPIC_ALIASES[aliasKey]) return { kind: 'category', value: TOPIC_ALIASES[aliasKey] };
  const merchant = findEntity(entitiesDoc.merchants || [], phrase);
  if (merchant) return { kind: 'merchant', value: phrase, resolvedId: merchant.id };
  const person = findEntity(entitiesDoc.people || [], phrase);
  if (person) return { kind: 'counterparty', value: phrase, resolvedId: person.id };
  const subMatch = SUBCATEGORY_NAMES.find((s) => stemIncludes(s, phrase) || stemIncludes(phrase, s));
  if (subMatch) return { kind: 'subcategory', value: subMatch };
  const catMatch = CATEGORY_NAMES.find((c) => stemIncludes(c, phrase));
  if (catMatch) return { kind: 'category', value: [catMatch] };
  // Ничего конкретного не нашли — свободный поиск по item/note/merchant/purpose/tags этой фразой.
  return { kind: 'free', value: phrase };
}

// entitiesDoc — уже загруженный {people,merchants} (см. entities.js), передаётся, а не читается
// здесь заново — движок сам не делает Firestore-запросов, только принимает готовые данные.
//
// Ищем предлог "на/за/в/у" — НЕ первый попавшийся, а идя от КОНЦА фразы к началу: "сколько за год
// я потратил на кофе?" содержит и "за" (в "за год"), и "на" (в "на кофе") — первый жадный вариант
// раньше захватывал "год я потратил на кофе" целиком (см. баг в изначальной версии, пойман
// бенчмарком). Перебираем предлоги с конца, у каждого берём хвост ДО следующего уже проверенного
// предлога (не до конца строки), пропускаем голые временные слова/периодные фразы — первый
// оставшийся кандидат и есть тема.
function extractTopic(rawText, entitiesDoc, today) {
  const transferMatch = TRANSFER_QUERY.exec(rawText);
  if (transferMatch) {
    const name = transferMatch[1];
    const person = findEntity(entitiesDoc.people || [], name);
    return { kind: 'counterparty', value: name, resolvedId: person?.id || null };
  }
  const matches = [...rawText.matchAll(TOPIC_PREPOSITIONS)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const phrase = rawText.slice(start, end).replace(/[?!.]+/g, '').trim();
    if (!phrase || BARE_TIME_WORD.test(phrase) || parsePeriodPhrase(phrase, today || '2000-01-01')) continue;
    return resolveTopicPhrase(phrase, entitiesDoc);
  }
  return null;
}

function matchesTopic(t, topic) {
  if (!topic) return true;
  switch (topic.kind) {
    case 'counterparty':
      return (topic.resolvedId && t.counterpartyId === topic.resolvedId) || stemIncludes(t.counterparty, topic.value);
    case 'merchant':
      return (topic.resolvedId && t.merchantId === topic.resolvedId) || stemIncludes(t.merchant, topic.value);
    case 'category':
      return topic.value.includes(t.category);
    case 'subcategory':
      return t.subcategory === topic.value;
    case 'free':
      return stemIncludes(t.item, topic.value) || stemIncludes(t.note, topic.value) || stemIncludes(t.merchant, topic.value)
        || stemIncludes(t.purpose, topic.value) || (t.tags || []).some((tag) => stemIncludes(tag, topic.value));
    default:
      return true;
  }
}

// -------- Intent (см. ТЗ п.12) --------
const QUESTIONY = /сколько|когда|как(?:ая|ой)|покажи|список|средн/i;
// Короткое продолжение без вопросительных слов ("а за год?", "а в Surf Coffee?") — см. ТЗ п.16:
// принимаем его как ФРАГМЕНТ вопроса (недостающее — intent/topic — восполнит mergeQueryContext из
// предыдущего контекста ниже по router.js), если в тексте всё же есть период/тема ИЛИ явное "а ".
function looksLikeQueryFragment(text, period, topic) {
  return QUESTIONY.test(text) || /^а\b/i.test(text) || !!period || !!topic;
}

export function parseQueryIntent(rawText, entitiesDoc, today) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const period = parsePeriodPhrase(text, today);
  const topic = extractTopic(text, entitiesDoc || { people: [], merchants: [] }, today);
  if (!looksLikeQueryFragment(text, period, topic)) return null;

  const type = /трат|расход|оплат|купил/i.test(text) ? 'expense'
    : /доход|заработ|получил|пополнил|поступил/i.test(text) ? 'income'
      : (topic && topic.kind === 'counterparty' ? 'expense' : null);

  // intent может остаться null (в тексте нет ни одного intent-слова, например голое "а за год?") —
  // тогда его достраивает mergeQueryContext из предыдущего вопроса; если и там нет — вызывающий
  // код (router.js) просто не станет отвечать локально.
  let intent = null;
  if (/когда.*последн|последн(?:ий|яя).*раз/i.test(text)) intent = 'last_transaction';
  else if (/средн/i.test(text)) intent = 'average_transactions';
  else if (/сколько\s+раз|как\s+часто/i.test(text)) intent = 'count_transactions';
  else if (/сам(?:ая|ый)\s+(?:больш|крупн)/i.test(text)) intent = 'max_transaction';
  else if (/сам(?:ая|ый)\s+(?:маленьк|мелк)/i.test(text)) intent = 'min_transaction';
  else if (/покажи|список|какие\s+(?:операции|траты|расходы)/i.test(text)) intent = 'list_transactions';
  else if (/сколько/i.test(text)) intent = 'sum_transactions';

  // "средний расход ... В МЕСЯЦ" — просит именно помесячную величину, а не среднее за одну
  // операцию (см. пример ТЗ). Без явного периода 12 месяцев назад — разумное окно по умолчанию
  // для помесячной статистики (см. ТЗ п.14: та же логика, что у period-фраз "за год").
  const perMonth = intent === 'average_transactions' && /в\s+месяц/i.test(text);
  const finalPeriod = period || (perMonth ? parsePeriodPhrase('за последние 12 месяцев', today) : null);

  return { intent, filters: { type, period: finalPeriod, topic, perMonth } };
}

// -------- Подсчёт (обычным кодом — см. ТЗ п.13/15: "сумму считает код") --------
function inPeriod(t, period) {
  if (!period) return true;
  return t.date >= period.start && t.date <= period.end;
}
function filterTx(transactions, filters) {
  return (transactions || []).filter((t) => {
    if (t.type !== 'expense' && t.type !== 'income') return false;
    if ((t.status || 'completed') !== 'completed') return false;
    if (filters.type && t.type !== filters.type) return false;
    if (!inPeriod(t, filters.period)) return false;
    if (!matchesTopic(t, filters.topic)) return false;
    return true;
  });
}

export function runFinanceQuery(transactions, intent, filters) {
  const rows = filterTx(transactions, filters);
  const amounts = rows.map((t) => Math.abs(Number(t.amount) || 0));
  const total = amounts.reduce((s, v) => s + v, 0);
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));
  const monthsSpan = filters.period
    ? Math.max(1, Math.round((new Date(filters.period.end) - new Date(filters.period.start)) / (30 * 86400000)))
    : 1;
  return {
    rows, count: rows.length, total,
    average: rows.length ? total / rows.length : 0,
    monthlyAverage: filters.period ? total / monthsSpan : total,
    last: sorted[0] || null,
    max: rows.length ? rows.reduce((a, b) => (Math.abs(a.amount) >= Math.abs(b.amount) ? a : b)) : null,
    min: rows.length ? rows.reduce((a, b) => (Math.abs(a.amount) <= Math.abs(b.amount) ? a : b)) : null,
  };
}

function money(v) { return `${Math.round(v).toLocaleString('ru-RU')} ₽`; }
function topicLabel(topic) {
  if (!topic) return '';
  if (topic.kind === 'category') return ` на «${Array.isArray(topic.value) ? topic.value.join('/') : topic.value}»`;
  if (topic.kind === 'subcategory') return ` на «${topic.value}»`;
  if (topic.kind === 'merchant') return ` в «${topic.value}»`;
  if (topic.kind === 'counterparty') return ` для «${topic.value}»`;
  return ` на «${topic.value}»`;
}

// -------- Ответ (см. ТЗ п.15 — формируется кодом, без LLM) --------
export function formatQueryAnswer(intent, filters, result) {
  const periodLabel = filters.period ? ` ${filters.period.label}` : '';
  const topic = topicLabel(filters.topic);
  const dir = filters.type === 'income' ? 'доход' : 'расход';
  if (!result.count) return `Не нашёл операций${topic}${periodLabel}.`;
  switch (intent) {
    case 'sum_transactions':
      return `${dir === 'доход' ? 'Доход' : 'Расход'}${topic}${periodLabel} — ${money(result.total)}${filters.period ? `. В среднем ${money(result.monthlyAverage)} в месяц.` : '.'}`;
    case 'average_transactions':
      return filters.perMonth
        ? `Средний ${dir}${topic} — ${money(result.monthlyAverage)} в месяц (по данным${periodLabel}).`
        : `Средний ${dir}${topic}${periodLabel} — ${money(result.average)} за операцию (${result.count} шт.).`;
    case 'count_transactions':
      return `${result.count} операци${result.count === 1 ? 'я' : result.count < 5 ? 'и' : 'й'}${topic}${periodLabel} на сумму ${money(result.total)}.`;
    case 'last_transaction': {
      const t = result.last;
      return `Последний раз${topic} — ${t.date.split('-').reverse().join('.')}, ${money(Math.abs(t.amount))}${t.note ? ` · ${t.note}` : ''}.`;
    }
    case 'max_transaction': {
      const t = result.max;
      return `Самая крупная операция${topic}${periodLabel} — ${money(Math.abs(t.amount))}${t.note ? ` · ${t.note}` : ''} (${t.date.split('-').reverse().join('.')}).`;
    }
    case 'min_transaction': {
      const t = result.min;
      return `Самая мелкая операция${topic}${periodLabel} — ${money(Math.abs(t.amount))}${t.note ? ` · ${t.note}` : ''} (${t.date.split('-').reverse().join('.')}).`;
    }
    case 'list_transactions': {
      const items = result.rows.slice(0, 8).map((t) => `${t.date.split('-').reverse().join('.')} — ${money(Math.abs(t.amount))}${t.note ? ` · ${t.note}` : ''}`);
      return `Операции${topic}${periodLabel} (${result.count}):\n${items.join('\n')}${result.count > 8 ? `\n…и ещё ${result.count - 8}` : ''}`;
    }
    default:
      return `${dir === 'доход' ? 'Доход' : 'Расход'}${topic}${periodLabel} — ${money(result.total)}.`;
  }
}

// -------- Связь с целями (см. ТЗ п.18 — без LLM, обычное деление) --------
// Только когда intent — сумма трат за период (не имеет смысла для count/last/list) и есть цели.
export function goalComparisonNote(result, goals) {
  if (!result.total || !goals || !goals.length) return '';
  const open = goals.filter((g) => Number(g.target) > Number(g.current || 0));
  if (!open.length) return '';
  const nearest = [...open].sort((a, b) => Math.abs(Number(a.target) - result.total) - Math.abs(Number(b.target) - result.total))[0];
  const ratio = result.total / Number(nearest.target);
  if (ratio < 0.05 || ratio > 3) return ''; // слишком далеко друг от друга — сравнение не информативно
  if (ratio > 0.85 && ratio < 1.15) return ` Это почти столько же, сколько составляет цель «${nearest.name}».`;
  return ` Это около ${Math.round(ratio * 100)}% стоимости цели «${nearest.name}».`;
}

// -------- Контекст продолжений (см. ТЗ п.16) --------
// Короткие "а за год?"/"а когда последний раз?" — новый разбор мог не найти topic/period сам по
// себе (в тексте буквально не сказано, ПРО ЧТО "за год") — тогда недостающие поля наследуются из
// предыдущего структурированного контекста, а НЕ вся история чата (см. ТЗ п.16/17: "не отправлять
// всю историю Atlas в модель" — этот контекст маленький JSON {intent,filters}, а не переписка).
export function mergeQueryContext(parsed, prevContext) {
  if (!parsed) return null;
  if (!prevContext) return parsed;
  const filters = { ...parsed.filters };
  if (!filters.topic && prevContext.filters?.topic) filters.topic = prevContext.filters.topic;
  if (!filters.period && prevContext.filters?.period) filters.period = prevContext.filters.period;
  if (!filters.type && prevContext.filters?.type) filters.type = prevContext.filters.type;
  return { intent: parsed.intent || prevContext.intent || null, filters };
}
