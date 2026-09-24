// Учёт фактических AI-расходов — см. п.6/7/8 ТЗ по контролю AI-себестоимости: у каждого вызова
// SpeechKit/YandexGPT должна остаться запись "кто, откуда, сколько это стоило", чтобы траты
// были видны в панели разработчика (см. admin.js + renderAdminUsageScreen в bot.js), а не
// оставались только цифрой в биллинге Yandex Cloud без привязки к конкретному действию.
import { DEFAULT_TZ, todayKey, dateKeyAddDays } from '../reminders.js';
import { estimateGptCostRub, estimateSttCostRub } from './pricing.js';

function emptyTotals() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, speechSeconds: 0, gptCostRub: 0, sttCostRub: 0 };
}

// Пишет одну запись о факте AI-вызова (aiUsage/{id} — сырой лог для аудита/трассировки) и сразу
// плюсует её в дневной агрегат (aiUsageDaily/{dateKey}). Агрегат существует, чтобы панель
// разработчика не пролистывала весь список сырых записей при каждом открытии (см.
// getUsageOverview ниже) — там просто сумма нескольких дневных документов вместо query по всей
// истории, которого у этого REST-клиента Firestore и нет (см. firestore.js — только getDoc по
// известному пути и listCollection постранично). get+merge вместо атомарного инкремента — у
// клиента такой операции нет; для личного проекта без высокой конкурентной нагрузки это
// безопасно.
export async function logAiUsage(firestore, { uid, source, kind, model, inputTokens, outputTokens, speechSeconds }) {
  try {
    const dateKey = todayKey(DEFAULT_TZ);
    const gptCostRub = kind === 'gpt' ? estimateGptCostRub(model, inputTokens, outputTokens) : 0;
    const sttCostRub = kind === 'stt' ? estimateSttCostRub(speechSeconds) : 0;
    const id = crypto.randomUUID();
    await firestore.setDoc(`aiUsage/${id}`, {
      uid, source, kind, model: model || null,
      inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, speechSeconds: speechSeconds || 0,
      costRub: gptCostRub + sttCostRub, dateKey, createdAt: Date.now(),
    });
    const dailyPath = `aiUsageDaily/${dateKey}`;
    const daily = (await firestore.getDoc(dailyPath)) || {};
    await firestore.setDoc(dailyPath, {
      dateKey,
      requests: (daily.requests || 0) + 1,
      inputTokens: (daily.inputTokens || 0) + (inputTokens || 0),
      outputTokens: (daily.outputTokens || 0) + (outputTokens || 0),
      speechSeconds: (daily.speechSeconds || 0) + (speechSeconds || 0),
      gptCostRub: (daily.gptCostRub || 0) + gptCostRub,
      sttCostRub: (daily.sttCostRub || 0) + sttCostRub,
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

// today/7 дней/30 дней — прямые чтения по известным путям (aiUsageDaily/{dateKey}), без query
// API (которого у этого клиента нет, см. выше) — до 30 отдельных getDoc, приемлемо: вызывается
// только при открытии панели разработчика, не на каждый AI-запрос.
export async function getUsageOverview(firestore) {
  const today = todayKey(DEFAULT_TZ);
  const dayKeys = [];
  for (let i = 0; i < 30; i++) dayKeys.push(dateKeyAddDays(today, -i));
  const docs = await Promise.all(dayKeys.map((k) => firestore.getDoc(`aiUsageDaily/${k}`)));
  return {
    today: sumTotals([docs[0]]),
    week: sumTotals(docs.slice(0, 7)),
    month: sumTotals(docs),
  };
}
