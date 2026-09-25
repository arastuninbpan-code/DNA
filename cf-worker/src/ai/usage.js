// Учёт фактических AI-расходов — см. п.17/21/22 аудита AI-себестоимости: у каждого платного
// вызова остаётся запись "кто, откуда, зачем, сколько это стоило" (включая trace_id, чтобы
// SpeechKit и YandexGPT одного и того же хода диалога были видны как один и тот же "запрос
// пользователя", а не как две несвязанные строки), а дневной агрегат (aiUsageDaily/{dateKey})
// хранит уже не только суммы, но и разбивку по операциям/пользователям и ограниченную выборку
// отдельных стоимостей — этого достаточно, чтобы посчитать среднее/медиану/перцентили и стоимость
// по типу операции, не читая весь сырой лог (aiUsage/*) целиком (см. ниже про SAMPLE_CAP).
import { DEFAULT_TZ, todayKey, dateKeyAddDays } from '../reminders.js';
import { estimateGptCostRub, estimateSttCostRub } from './pricing.js';

// Сколько отдельных стоимостей хранить В ОДНОМ дневном документе для перцентилей (п.21/22) —
// не весь сырой лог (он растёт бессрочно и есть отдельно в aiUsage/* для полного аудита), а
// ограниченная выборка последних вызовов за день. Для личного проекта с текущим объёмом трафика
// этого достаточно для точных P50/P75/P90/P95 за сутки/неделю; если трафик вырастет на порядки,
// это стоит заменить на честный гистограммный подход — отмечено как технический долг, не решается
// здесь ради самого аудита себестоимости.
const SAMPLE_CAP = 200;

function emptyTotals() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, speechSeconds: 0, gptCostRub: 0, sttCostRub: 0 };
}

function emptyOpTotals() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, costRub: 0 };
}

function emptyUserTotals() {
  return { requests: 0, costRub: 0, liteCostRub: 0, proCostRub: 0, sttCostRub: 0 };
}

// Пишет одну запись о факте AI-вызова (aiUsage/{id} — сырой лог для аудита/трассировки) и сразу
// плюсует её в дневной агрегат (aiUsageDaily/{dateKey}). Агрегат существует, чтобы панель
// разработчика не пролистывала весь список сырых записей при каждом открытии (см.
// getUsageOverview ниже) — там просто сумма нескольких дневных документов вместо query по всей
// истории, которого у этого REST-клиента Firestore и нет (см. firestore.js — только getDoc по
// известному пути и listCollection постранично). get+merge вместо атомарного инкремента — у
// клиента такой операции нет; для личного проекта без высокой конкурентной нагрузки это
// безопасно.
//
// traceId — общий у SpeechKit и YandexGPT одного и того же пользовательского хода (см. п.17
// аудита); requestId по умолчанию равен traceId (для одного действия пользователя это один и тот
// же идентификатор — отдельный requestId нужен только если один trace когда-нибудь распадётся на
// несколько независимо повторяемых запросов, сейчас такого нет). operation/proReason/success —
// см. router.js#planTurn (operation/proReason) и вызывающий код в index.js (success=false при
// пойманной ошибке — тоже полезно видеть в логе, а не только успешные вызовы).
export async function logAiUsage(firestore, {
  uid, source, kind, model, operation, proReason, traceId, requestId,
  inputTokens, outputTokens, cachedTokens, speechSeconds, success = true,
}) {
  try {
    const dateKey = todayKey(DEFAULT_TZ);
    const gptCostRub = kind === 'gpt' ? estimateGptCostRub(model, inputTokens, outputTokens) : 0;
    const sttCostRub = kind === 'stt' ? estimateSttCostRub(speechSeconds) : 0;
    const costRub = gptCostRub + sttCostRub;
    const id = crypto.randomUUID();
    const resolvedTraceId = traceId || id;
    await firestore.setDoc(`aiUsage/${id}`, {
      uid, source, kind, model: model || null, operation: operation || null, proReason: proReason || null,
      traceId: resolvedTraceId, requestId: requestId || resolvedTraceId,
      inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, cachedTokens: cachedTokens || 0,
      speechSeconds: speechSeconds || 0, costRub, success: !!success, dateKey, createdAt: Date.now(),
    });

    const dailyPath = `aiUsageDaily/${dateKey}`;
    const daily = (await firestore.getDoc(dailyPath)) || {};

    const byOperation = { ...(daily.byOperation || {}) };
    if (operation) {
      const prev = byOperation[operation] || emptyOpTotals();
      byOperation[operation] = {
        requests: prev.requests + 1,
        inputTokens: prev.inputTokens + (inputTokens || 0),
        outputTokens: prev.outputTokens + (outputTokens || 0),
        costRub: prev.costRub + costRub,
      };
    }

    const byUser = { ...(daily.byUser || {}) };
    if (uid) {
      const prev = byUser[uid] || emptyUserTotals();
      byUser[uid] = {
        requests: prev.requests + 1,
        costRub: prev.costRub + costRub,
        liteCostRub: prev.liteCostRub + (kind === 'gpt' && model !== 'yandexgpt' ? gptCostRub : 0),
        proCostRub: prev.proCostRub + (kind === 'gpt' && model === 'yandexgpt' ? gptCostRub : 0),
        sttCostRub: prev.sttCostRub + sttCostRub,
      };
    }

    // Только реально платные записи (costRub>0) имеет смысл использовать для перцентилей —
    // одна STT-запись и один GPT-вызов одного хода диалога иначе искусственно завышали бы
    // "количество запросов" для перцентиля по сравнению с суммой их стоимости.
    const samples = costRub > 0 ? [...(daily.samples || []), { op: operation || null, kind, costRub }].slice(-SAMPLE_CAP) : (daily.samples || []);

    await firestore.setDoc(dailyPath, {
      dateKey,
      requests: (daily.requests || 0) + 1,
      inputTokens: (daily.inputTokens || 0) + (inputTokens || 0),
      outputTokens: (daily.outputTokens || 0) + (outputTokens || 0),
      speechSeconds: (daily.speechSeconds || 0) + (speechSeconds || 0),
      gptCostRub: (daily.gptCostRub || 0) + gptCostRub,
      sttCostRub: (daily.sttCostRub || 0) + sttCostRub,
      byOperation, byUser, samples,
    });
  } catch (err) {
    // Сбой учёта расходов не должен ронять сам AI-ответ пользователю — это побочный, а не
    // критичный для пути запроса учёт.
    console.error('logAiUsage failed', err);
  }
}

function sumTotals(list) {
  const total = emptyTotals();
  for (const d of list) {
    if (!d) continue;
    total.requests += d.requests || 0;
    total.inputTokens += d.inputTokens || 0;
    total.outputTokens += d.outputTokens || 0;
    total.speechSeconds += d.speechSeconds || 0;
    total.gptCostRub += d.gptCostRub || 0;
    total.sttCostRub += d.sttCostRub || 0;
  }
  return total;
}

// Ближайший-ранг перцентиль (без интерполяции — для панели разработчика достаточно, не
// статистическое исследование) по уже отсортированному по возрастанию массиву чисел.
function percentileOf(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// P50/P75/P90/P95 стоимости ОДНОГО запроса — из объединённых samples всех переданных дневных
// документов (см. п.22 аудита: "cost-per-operation-type visibility"). opFilter — если задан,
// считает только сэмплы этой операции.
function requestPercentiles(dailyDocs, opFilter) {
  const values = [];
  for (const d of dailyDocs) {
    for (const s of (d && d.samples) || []) {
      if (opFilter && s.op !== opFilter) continue;
      values.push(s.costRub);
    }
  }
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentileOf(values, 50), p75: percentileOf(values, 75),
    p90: percentileOf(values, 90), p95: percentileOf(values, 95),
  };
}

// Себестоимость по типу операции за период (п.22): сколько раз вызывалась, средние
// input/output-токены, средняя ₽, P95 ₽ по этой операции.
function operationBreakdown(dailyDocs) {
  const merged = {};
  for (const d of dailyDocs) {
    for (const [op, t] of Object.entries((d && d.byOperation) || {})) {
      const prev = merged[op] || emptyOpTotals();
      merged[op] = {
        requests: prev.requests + t.requests, inputTokens: prev.inputTokens + t.inputTokens,
        outputTokens: prev.outputTokens + t.outputTokens, costRub: prev.costRub + t.costRub,
      };
    }
  }
  const result = {};
  for (const [op, t] of Object.entries(merged)) {
    result[op] = {
      requests: t.requests,
      avgInputTokens: t.requests ? Math.round(t.inputTokens / t.requests) : 0,
      avgOutputTokens: t.requests ? Math.round(t.outputTokens / t.requests) : 0,
      avgCostRub: t.requests ? t.costRub / t.requests : 0,
      p95CostRub: requestPercentiles(dailyDocs, op).p95,
    };
  }
  return result;
}

// Себестоимость AI НА ПЛАТЯЩЕГО ПОЛЬЗОВАТЕЛЯ за период (п.19-21): суммирует byUser по всем дням,
// затем считает среднее/медиану/P75/P90/P95 уже ПО ПОЛЬЗОВАТЕЛЯМ (не по отдельным запросам) — это
// то самое число, с которым сравниваются targetMonthlyAiCostRub/maxAverageMonthlyAiCostRub из
// economics.js. Отдельно — то же самое только по Lite/Pro/SpeechKit, потому что цель "средний
// пользователь около 30-40₽" должна быть видна в разбивке по источнику траты, а не только суммой.
function perUserCohort(dailyDocs) {
  const totals = {};
  for (const d of dailyDocs) {
    for (const [uid, t] of Object.entries((d && d.byUser) || {})) {
      const prev = totals[uid] || emptyUserTotals();
      totals[uid] = {
        requests: prev.requests + t.requests, costRub: prev.costRub + t.costRub,
        liteCostRub: prev.liteCostRub + t.liteCostRub, proCostRub: prev.proCostRub + t.proCostRub,
        sttCostRub: prev.sttCostRub + t.sttCostRub,
      };
    }
  }
  const users = Object.values(totals);
  function statsOf(pick) {
    const values = users.map(pick).sort((a, b) => a - b);
    const sum = values.reduce((s, v) => s + v, 0);
    return {
      users: values.length, avgRub: values.length ? sum / values.length : 0,
      medianRub: percentileOf(values, 50), p75Rub: percentileOf(values, 75),
      p90Rub: percentileOf(values, 90), p95Rub: percentileOf(values, 95),
    };
  }
  return {
    total: statsOf((u) => u.costRub),
    lite: statsOf((u) => u.liteCostRub),
    pro: statsOf((u) => u.proCostRub),
    stt: statsOf((u) => u.sttCostRub),
  };
}

// today/7 дней/30 дней — прямые чтения по известным путям (aiUsageDaily/{dateKey}), без query
// API (которого у этого клиента нет, см. выше) — до 30 отдельных getDoc, приемлемо: вызывается
// только при открытии панели разработчика, не на каждый AI-запрос.
export async function getUsageOverview(firestore) {
  const today = todayKey(DEFAULT_TZ);
  const dayKeys = [];
  for (let i = 0; i < 30; i++) dayKeys.push(dateKeyAddDays(today, -i));
  const docs = await Promise.all(dayKeys.map((k) => firestore.getDoc(`aiUsageDaily/${k}`)));
  const todayDocs = [docs[0]];
  const weekDocs = docs.slice(0, 7);
  const monthDocs = docs;
  return {
    today: sumTotals(todayDocs),
    week: sumTotals(weekDocs),
    month: sumTotals(monthDocs),
    requestPercentiles: {
      today: requestPercentiles(todayDocs), week: requestPercentiles(weekDocs), month: requestPercentiles(monthDocs),
    },
    byOperation: { week: operationBreakdown(weekDocs), month: operationBreakdown(monthDocs) },
    perUser: { week: perUserCohort(weekDocs), month: perUserCohort(monthDocs) },
  };
}
