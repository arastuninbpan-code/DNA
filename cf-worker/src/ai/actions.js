// Белый список действий, которые AI может попросить выполнить, и их безопасное исполнение —
// см. п.10/36 просьбы: LLM не работает с БД напрямую, а возвращает структурированное действие;
// backend сам проверяет action, параметры и права, и только потом что-то пишет. Неизвестный
// action или отсутствующее обязательное поле — действие целиком отклоняется, ничего не пишется.
import {
  DEFAULT_TZ, todayKey, dateKeyAddDays, formatRub,
  getHabitsDoc, habitsOn, markHabitDoneByName,
  createPlannerEvent, addFinanceTransaction, createSection, completeEventByTitle, deleteEventByTitle,
} from '../reminders.js';

export const ACTION_SCHEMA = {
  create_event: { required: ['title', 'date'], optional: ['time', 'duration'] },
  create_expense: { required: ['amount'], optional: ['category', 'description'] },
  create_income: { required: ['amount'], optional: ['category', 'description'] },
  complete_habit: { required: ['name'], optional: [] },
  complete_event: { required: ['title'], optional: ['date'] },
  delete_event: { required: ['title'], optional: ['date'] },
  create_section: { required: ['name'], optional: ['color'] },
};

export function validateAction(action) {
  if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
    return { ok: false, error: 'malformed action' };
  }
  const schema = ACTION_SCHEMA[action.action];
  if (!schema) return { ok: false, error: `unknown action: ${action.action}` };
  for (const field of schema.required) {
    const v = action[field];
    if (v === undefined || v === null || v === '') return { ok: false, error: `missing field: ${field}` };
  }
  if ((action.action === 'create_expense' || action.action === 'create_income') && !(Number(action.amount) > 0)) {
    return { ok: false, error: 'amount must be a positive number' };
  }
  // date — не только у create_event: complete_event тоже принимает его опционально, обе схемы
  // требуют одинаковый формат, поэтому проверка общая, а не привязана к конкретному action.
  if (action.date !== undefined && action.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(action.date))) {
    return { ok: false, error: 'date must be YYYY-MM-DD' };
  }
  if (action.action === 'create_section' && action.color !== undefined && action.color !== null
    && !/^#[0-9a-fA-F]{6}$/.test(String(action.color))) {
    return { ok: false, error: 'color must be #rrggbb' };
  }
  return { ok: true };
}

function dayLabelShort(dateKey) {
  const today = todayKey(DEFAULT_TZ);
  if (dateKey === today) return 'сегодня';
  if (dateKey === dateKeyAddDays(today, 1)) return 'завтра';
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

async function execCreateEvent(firestore, uid, a) {
  const ev = await createPlannerEvent(firestore, uid, {
    title: a.title, date: a.date, time: a.time || null, duration: a.duration,
  });
  const when = `${dayLabelShort(ev.date)}${ev.time ? ' · ' + ev.time : ''}`;
  return { summary: `📅 ${ev.title} — ${when}` };
}

async function execCreateExpense(firestore, uid, a) {
  const tx = await addFinanceTransaction(firestore, uid, {
    amount: -Math.abs(Number(a.amount)),
    type: 'expense',
    category: a.category || null,
    note: a.description || '',
    date: todayKey(DEFAULT_TZ),
  });
  return { summary: `💰 −${formatRub(Math.abs(tx.amount))} · ${tx.category || tx.note || 'Расход'}` };
}

async function execCreateIncome(firestore, uid, a) {
  const tx = await addFinanceTransaction(firestore, uid, {
    amount: Math.abs(Number(a.amount)),
    type: 'income',
    category: a.category || null,
    note: a.description || '',
    date: todayKey(DEFAULT_TZ),
  });
  return { summary: `💰 +${formatRub(Math.abs(tx.amount))} · ${tx.category || tx.note || 'Доход'}` };
}

async function execCompleteHabit(firestore, uid, a) {
  const dateKey = todayKey(DEFAULT_TZ);
  const habitsDoc = await getHabitsDoc(firestore, uid);
  const list = habitsOn(habitsDoc, dateKey);
  const habit = list.find((h) => h && h.name === a.name);
  if (!habit) return { error: `Не нашёл привычку «${a.name}» на сегодня` };
  await markHabitDoneByName(firestore, uid, dateKey, habit.name, true);
  return { summary: `✅ ${habit.name}` };
}

async function execCompleteEvent(firestore, uid, a) {
  const updated = await completeEventByTitle(firestore, uid, { title: a.title, date: a.date });
  if (!updated) return { error: `Не нашёл невыполненное событие «${a.title}»${a.date ? ' на ' + dayLabelShort(a.date) : ' на сегодня'}` };
  return { summary: `✅ ${updated.title}` };
}

async function execDeleteEvent(firestore, uid, a) {
  const removed = await deleteEventByTitle(firestore, uid, { title: a.title, date: a.date });
  if (!removed) return { error: `Не нашёл событие «${a.title}»${a.date ? ' на ' + dayLabelShort(a.date) : ' на сегодня'}` };
  return { summary: `🗑️ ${removed.title}` };
}

async function execCreateSection(firestore, uid, a) {
  const section = await createSection(firestore, uid, { name: a.name, color: a.color });
  return { summary: `📁 Раздел «${section.name}» создан` };
}

const EXECUTORS = {
  create_event: execCreateEvent,
  create_expense: execCreateExpense,
  create_income: execCreateIncome,
  complete_habit: execCompleteHabit,
  complete_event: execCompleteEvent,
  delete_event: execDeleteEvent,
  create_section: execCreateSection,
};

// Единственная точка, которая реально пишет в Firestore от лица AI — вызывается только для
// действий, уже прошедших validateAction (см. router.js#confirmActions), и только после того,
// как пользователь явно подтвердил их в интерфейсе (см. п.16/18 просьбы: ничего не применяется
// автоматически без подтверждения, особенно опасные/множественные изменения).
export async function executeAction(firestore, uid, action) {
  const validation = validateAction(action);
  if (!validation.ok) return { ok: false, error: validation.error };
  const executor = EXECUTORS[action.action];
  try {
    const result = await executor(firestore, uid, action);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, summary: result.summary };
  } catch (err) {
    console.error(`AI action ${action.action} failed`, err);
    return { ok: false, error: 'internal error' };
  }
}
