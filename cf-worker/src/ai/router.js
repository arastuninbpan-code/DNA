// Оркестратор одного хода диалога: понять текст пользователя -> получить действия (по возможности
// БЕЗ обращения к LLM) -> провалидировать каждое действие -> вернуть карточку подтверждения.
// Ничего не пишет в БД сам — только на шаге confirmActions ниже, и только то, что уже прошло
// validateAction (см. actions.js). LLM не имеет прямого доступа к Firestore.
//
// Порядок уровней — LOCAL -> LITE -> PRO, всегда начиная с самого дешёвого подходящего (см. п.4
// аудита AI-себестоимости): tryLocalParse (0 ₽, 0 вызовов) пробуется первым и для большинства
// частых команд ("100р шоколадка", "такси 700", факт-вопросы про сегодня) заканчивает ход без
// единого обращения к провайдеру. Если он не уверен — ход идёт в LLM, но максимум ОДНИМ вызовом
// (см. п.6: "классифицирует Lite -> анализирует Pro -> снова Lite пишет ответ" — запрещённый
// паттерн; здесь один route() сразу возвращает и actions, и reply).
import { validateAction, executeAction } from './actions.js';
import { buildDayContext, emptyDayContext } from './context.js';
import { DEFAULT_TZ, todayKey, dateKeyAddDays, currentMinutesInTz, getFinanceDoc } from '../reminders.js';
import { tryLocalParse, resolveDayReference, QUESTION_LIKE } from './localParser.js';
import { chooseModel } from './modelRouter.js';
import { getClassificationRules } from './classify.js';
import { getEntitiesDoc } from './entities.js';
import { parseQueryIntent, runFinanceQuery, formatQueryAnswer, goalComparisonNote, mergeQueryContext } from './financeQuery.js';

// Дешёвая проверка "похоже ли вообще на вопрос про деньги" — до того, как читать финансовый
// документ и справочник сущностей (см. ТЗ п.11/17: Query Engine не должен работать на КАЖДОЕ
// сообщение, только когда это осмысленно). Если не совпало — ни одного лишнего чтения Firestore
// сверх того, что и так делает buildDayContext.
const FINANCE_QUERY_HINT = /потрат|расход|доход|заработ|получил|перевод|перевел|перевёл|скинул|отправил|бюджет|сколько|средн|за\s+(?:год|месяц|недел)/i;

// "какие у меня планы на среду?" / "что у меня завтра?" — слова, при которых это НЕ вопрос про
// план дня, а что-то другое (финансы/создание/удаление/отметка) — такие фразы пропускаем, даже
// если в них есть день недели, чтобы не перехватить чужое намерение.
const DAY_PLAN_QUERY_EXCLUDE = /потрат|расход|доход|заработ|получил|перевод|перевел|перевёл|скинул|напомни|удали|сотри|убери|отмет|выполнил|заверш|создай|добавь|запиши|поставь|запланируй|назначь/i;
// Одного упоминания дня в вопросе НЕДОСТАТОЧНО — "какая сегодня погода?" тоже содержит "сегодня"
// и знак вопроса, но это не вопрос про план дня (тест, поймавший это, см. day-plan-query-bench).
// Нужен ЕЩЁ и явный сигнал "это про мой день/расписание" — "у меня" (тот же оборот, что уже
// требовала старая tryFactualQuery для "что у меня сегодня") или прямое слово план/событ/дела/
// расписание/занятость.
const DAY_PLAN_QUERY_HINT = /у\s+меня|план(?:ы|ов)?|событ|расписан|дела\b|занят/i;

// "HH:MM" сейчас в DEFAULT_TZ — без этого модель не может посчитать относительное время
// ("напомни через час"): дата у неё уже есть (today/tomorrow), а часов и минут не было вовсе,
// так что "через час" ей было решительно не от чего прибавлять.
function currentTimeHHMM(tz) {
  const minutes = currentMinutesInTz(tz);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Большинство сообщений касаются только сегодняшнего дня — второй buildDayContext (три
// дополнительных чтения Firestore + вторая порция JSON в system prompt на КАЖДЫЙ Lite/Pro-вызов)
// нужен только когда текст реально похож на "завтра"/"послезавтра"/перенос на другой день (см.
// п.10/11 аудита: контекст под конкретный запрос, а не "на всякий случай").
const TOMORROW_RELEVANT = /(завтра|послезавтра|следующ)/i;

// Имя "операции" для лога расходов (usage.js) — до вызова LLM оно неизвестно, но известно СРАЗУ
// после: если модель (или local-парсер) вернула ровно одно действие, это и есть операция
// ("create_expense" и т.п. — те самые типы из п.22 аудита); несколько действий разом —
// "multi_action"; ни одного — вопрос/диалог без действия ("factual_query" для local, иначе
// "general_chat").
function deriveOperation(route, actions) {
  if (actions.length === 1) return actions[0].action;
  if (actions.length > 1) return 'multi_action';
  return route === 'local' ? 'factual_query' : 'general_chat';
}

// opts.proReason — необязательная явная причина использовать Pro (см. modelRouter.js); сейчас ни
// один вызывающий код её не передаёт, поэтому chooseModel всегда вернёт lite — маршрут уже готов
// принять её от будущей функции вроде "проанализируй расходы за 3 месяца" без изменений здесь.
export async function planTurn(provider, firestore, uid, text, opts = {}) {
  const today = todayKey(DEFAULT_TZ);
  const tomorrow = dateKeyAddDays(today, 1);
  const todayCtx = await buildDayContext(firestore, uid, today);
  const classificationRules = await getClassificationRules(firestore, uid);

  const local = tryLocalParse(text, todayCtx, dateKeyAddDays, todayKey, classificationRules);
  if (local) {
    const actions = [];
    const rejected = [];
    for (const raw of local.actions || []) {
      const validation = validateAction(raw);
      if (validation.ok) actions.push(raw);
      else rejected.push({ action: raw, error: validation.error });
    }
    return {
      reply: local.reply || '', actions, rejected, usage: null,
      route: 'local', proReason: null, operation: deriveOperation('local', actions),
    };
  }

  // "какие у меня планы на среду?" / "что у меня завтра?" — тот же принцип, что у "что у меня
  // сегодня?" внутри tryLocalParse (см. localParser.js#tryFactualQuery), только для ЛЮБОГО
  // распознаваемого дня, не только сегодняшнего. Раньше такой вопрос уходил в Lite вместе с
  // ТОЛЬКО today/tomorrow контекстом (см. context ниже) — реальный живой баг: спрошенная про
  // среду, модель не получала про неё вообще никаких данных и отвечала данными сегодняшнего дня,
  // выдавая их за среду. Здесь дата считается кодом (resolveDayReference — та же арифметика,
  // что чинит create_event, см. localParser.js), а сам ответ — прямое чтение того же документа
  // Планера/Привычек, что видит сам пользователь на экране — 0 ₽ и не может "перепутать" день.
  if (QUESTION_LIKE.test(text) && DAY_PLAN_QUERY_HINT.test(text) && !DAY_PLAN_QUERY_EXCLUDE.test(text)) {
    const dayRef = resolveDayReference(text, todayKey, dateKeyAddDays);
    if (dayRef) {
      const dayCtx = dayRef.dateKey === today ? todayCtx : await buildDayContext(firestore, uid, dayRef.dateKey);
      const label = dayRef.offset === 0 ? 'Сегодня' : dayRef.offset === 1 ? 'Завтра' : dayRef.offset === 2 ? 'Послезавтра'
        : `${dayRef.dateKey.slice(8, 10)}.${dayRef.dateKey.slice(5, 7)}`;
      const events = dayCtx.events.length
        ? dayCtx.events.map((e) => `${e.time ? e.time + ' ' : ''}${e.title}${e.done ? ' ✓' : ''}`).join('; ')
        : 'событий нет';
      const habits = dayCtx.habits.length
        ? dayCtx.habits.map((h) => `${h.name}${h.done ? ' ✓' : ''}`).join('; ')
        : 'привычек нет';
      return {
        reply: `${label}: ${events}. Привычки: ${habits}.`, actions: [], rejected: [], usage: null,
        route: 'local', proReason: null, operation: 'day_plan_query',
      };
    }
  }

  // Local Finance Query Engine (см. ТЗ п.11-17) — "сколько я потратил на кофе за год?" и т.п.
  // отвечаются обычным кодом по уже загруженным транзакциям, БЕЗ обращения к LLM: ни сами
  // транзакции, ни промежуточный результат подсчёта в модель не передаются (см. ТЗ п.17). Если
  // движок не уверен (parseQueryIntent вернул null) — тихо идём дальше, к Lite, как раньше.
  if (FINANCE_QUERY_HINT.test(text)) {
    const [financeDoc, entitiesDoc] = await Promise.all([
      getFinanceDoc(firestore, uid),
      getEntitiesDoc(firestore, uid),
    ]);
    const parsed = parseQueryIntent(text, entitiesDoc, today);
    const merged = parsed ? mergeQueryContext(parsed, opts.queryContext) : null;
    if (merged && merged.intent) {
      const result = runFinanceQuery(financeDoc.transactions || [], merged.intent, merged.filters);
      if (result.count || merged.filters.topic || merged.filters.period) {
        let reply = formatQueryAnswer(merged.intent, merged.filters, result);
        // Связь с целями (см. ТЗ п.18) — только для содержательной суммы трат, не для
        // count/last/list/доходов, и не для 0.
        if (merged.intent === 'sum_transactions' && merged.filters.type !== 'income') {
          reply += goalComparisonNote(result, financeDoc.goals);
        }
        return {
          reply, actions: [], rejected: [], usage: null,
          route: 'local', proReason: null, operation: 'finance_query',
          queryContext: { intent: merged.intent, filters: merged.filters },
        };
      }
    }
  }

  const tomorrowCtx = TOMORROW_RELEVANT.test(text)
    ? await buildDayContext(firestore, uid, tomorrow)
    : emptyDayContext(tomorrow);

  const { model, proReason } = chooseModel(opts.proReason);
  const llmResult = await provider.route(
    text,
    { today: todayCtx, tomorrow: tomorrowCtx, now: currentTimeHHMM(DEFAULT_TZ) },
    { model },
  );

  const actions = [];
  const rejected = [];
  for (const raw of llmResult.actions || []) {
    const validation = validateAction(raw);
    if (validation.ok) actions.push(raw);
    else rejected.push({ action: raw, error: validation.error });
  }

  return {
    reply: llmResult.reply || '', actions, rejected, usage: llmResult.usage || null,
    route: model, proReason, operation: deriveOperation(model, actions),
  };
}

// Применение уже подтверждённых пользователем действий (кнопка "Добавить всё" в интерфейсе) —
// повторно валидирует каждое (защита от подмены между показом карточки и подтверждением), любые
// уже отклонённые молча пропускает вместо попытки исполнить.
export async function confirmActions(firestore, uid, actions) {
  const results = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    const result = await executeAction(firestore, uid, action);
    results.push({ action, ...result });
  }
  return results;
}
