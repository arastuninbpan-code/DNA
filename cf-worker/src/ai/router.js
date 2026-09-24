// Оркестратор одного хода диалога: понять текст пользователя -> получить от провайдера список
// действий + черновой ответ -> провалидировать каждое действие -> вернуть карточку
// подтверждения. Ничего не пишет в БД сам — только на шаге confirmActions ниже, и только то,
// что уже прошло validateAction (см. actions.js). LLM не имеет прямого доступа к Firestore.
import { validateAction, executeAction } from './actions.js';
import { buildDayContext } from './context.js';
import { DEFAULT_TZ, todayKey, dateKeyAddDays, currentMinutesInTz } from '../reminders.js';

// "HH:MM" сейчас в DEFAULT_TZ — без этого модель не может посчитать относительное время
// ("напомни через час"): дата у неё уже есть (today/tomorrow), а часов и минут не было вовсе,
// так что "через час" ей было решительно не от чего прибавлять.
function currentTimeHHMM(tz) {
  const minutes = currentMinutesInTz(tz);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export async function planTurn(provider, firestore, uid, text) {
  const today = todayKey(DEFAULT_TZ);
  const tomorrow = dateKeyAddDays(today, 1);
  const [todayCtx, tomorrowCtx] = await Promise.all([
    buildDayContext(firestore, uid, today),
    buildDayContext(firestore, uid, tomorrow),
  ]);

  const llmResult = await provider.route(text, { today: todayCtx, tomorrow: tomorrowCtx, now: currentTimeHHMM(DEFAULT_TZ) });

  const actions = [];
  const rejected = [];
  for (const raw of llmResult.actions || []) {
    const validation = validateAction(raw);
    if (validation.ok) actions.push(raw);
    else rejected.push({ action: raw, error: validation.error });
  }

  return { reply: llmResult.reply || '', actions, rejected, usage: llmResult.usage || null };
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
