// Белый список действий, которые AI может попросить выполнить, и их безопасное исполнение —
// см. п.10/36 просьбы: LLM не работает с БД напрямую, а возвращает структурированное действие;
// backend сам проверяет action, параметры и права, и только потом что-то пишет. Неизвестный
// action или отсутствующее обязательное поле — действие целиком отклоняется, ничего не пишется.
import {
  DEFAULT_TZ, todayKey, dateKeyAddDays, formatRub,
  getHabitsDoc, habitsOn, markHabitDoneByName,
  createPlannerEvent, addFinanceTransaction, createSection, completeEventByTitle, deleteEventByTitle,
  findSectionIdByName, deleteSectionByName,
} from '../reminders.js';
import { resolveOrCreateEntity } from './entities.js';

// Семантические поля транзакции (см. ТЗ "расширить модель транзакции") — все optional, ни один
// вызывающий код (ни local parser, ни Lite) не обязан их присылать. subcategory/item/purpose/tags —
// просто текст, category уже проверяется отдельно нигде (модель присылает то же, что видела в
// системном промпте, см. buildSystemPrompt), поэтому здесь только длины/типы, не белый список.
const SEMANTIC_OPTIONAL = ['subcategory', 'item', 'merchant', 'counterparty', 'purpose', 'tags', 'title', 'classificationSource'];

export const ACTION_SCHEMA = {
  create_event: { required: ['title', 'date'], optional: ['time', 'duration', 'section'] },
  create_expense: { required: ['amount'], optional: ['category', 'description', ...SEMANTIC_OPTIONAL] },
  create_income: { required: ['amount'], optional: ['category', 'description', ...SEMANTIC_OPTIONAL] },
  complete_habit: { required: ['name'], optional: [] },
  complete_event: { required: ['title'], optional: ['date'] },
  delete_event: { required: ['title'], optional: ['date'] },
  create_section: { required: ['name'], optional: ['color'] },
  delete_section: { required: ['name'], optional: [] },
};

// Верхняя граница суммы — раньше проверялась только внутри localParser.js (parsed.amount>1e9), но
// НЕ для действий, пришедших от Lite/Pro — модель теоретически может прислать любое число. Один
// триллион ₽ — тот же потолок, что уже используют формы в index.html (parseFinInput/поле "Баланс").
const MAX_AMOUNT = 1e12;

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
  if (action.action === 'create_expense' || action.action === 'create_income') {
    if (!(Number(action.amount) > 0) || Number(action.amount) > MAX_AMOUNT) {
      return { ok: false, error: 'amount must be a positive number within range' };
    }
    if (action.tags !== undefined && action.tags !== null) {
      if (!Array.isArray(action.tags) || action.tags.some((tag) => typeof tag !== 'string')) {
        return { ok: false, error: 'tags must be an array of strings' };
      }
    }
    for (const field of ['subcategory', 'item', 'merchant', 'counterparty', 'purpose', 'title']) {
      if (action[field] !== undefined && action[field] !== null && typeof action[field] !== 'string') {
        return { ok: false, error: `${field} must be a string` };
      }
    }
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
  // a.section — НАЗВАНИЕ существующего раздела (не id — AI видит только имена в контексте, см.
  // context.js), ищем совпадение среди уже созданных разделов пользователя. Если не нашли —
  // событие создаётся БЕЗ раздела, а не с новым придуманным: раньше create_event вообще не умел
  // принимать раздел, и модель в попытке выполнить просьбу "создай в разделе Х" отдельно вызывала
  // create_section, даже если такой раздел уже существовал — на выходе плодились дубликаты.
  const sectionId = await findSectionIdByName(firestore, uid, a.section);
  const ev = await createPlannerEvent(firestore, uid, {
    title: a.title, date: a.date, time: a.time || null, duration: a.duration, sectionId,
  });
  const when = `${dayLabelShort(ev.date)}${ev.time ? ' · ' + ev.time : ''}`;
  return { summary: `📅 ${ev.title} — ${when}` };
}

// merchant/counterparty приходят как СВОБОДНЫЙ ТЕКСТ (от словаря localParser.js или от модели) —
// resolveOrCreateEntity сводит его к стабильному id (см. entities.js: "Мише"/"Миша Андреев" и т.п.
// → один и тот же person_id), это и даёт Query Engine возможность искать "сколько переводил
// Мише?" независимо от формы, в которой имя встретилось в КОНКРЕТНОЙ операции.
async function resolveSemanticFields(firestore, uid, a) {
  const out = {
    title: a.title || undefined, subcategory: a.subcategory || undefined, item: a.item || undefined,
    purpose: a.purpose || undefined, tags: Array.isArray(a.tags) ? a.tags : undefined,
    originalText: a.originalText || undefined,
    classificationSource: a.classificationSource || 'ai',
    classificationConfidence: a.classificationConfidence,
  };
  if (a.merchant) {
    const entity = await resolveOrCreateEntity(firestore, uid, 'merchant', a.merchant);
    out.merchant = entity?.canonicalName || a.merchant;
    out.merchantId = entity?.id;
  }
  if (a.counterparty) {
    const entity = await resolveOrCreateEntity(firestore, uid, 'person', a.counterparty);
    out.counterparty = entity?.canonicalName || a.counterparty;
    out.counterpartyId = entity?.id;
  }
  return out;
}

async function execCreateExpense(firestore, uid, a) {
  const semantic = await resolveSemanticFields(firestore, uid, a);
  const tx = await addFinanceTransaction(firestore, uid, {
    amount: -Math.abs(Number(a.amount)),
    type: 'expense',
    category: a.category || null,
    note: a.description || '',
    date: todayKey(DEFAULT_TZ),
    ...semantic,
  });
  return { summary: `💰 −${formatRub(Math.abs(tx.amount))} · ${tx.category || tx.note || 'Расход'}` };
}

async function execCreateIncome(firestore, uid, a) {
  const semantic = await resolveSemanticFields(firestore, uid, a);
  const tx = await addFinanceTransaction(firestore, uid, {
    amount: Math.abs(Number(a.amount)),
    type: 'income',
    category: a.category || null,
    note: a.description || '',
    date: todayKey(DEFAULT_TZ),
    ...semantic,
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

// a.name может быть как точным именем раздела, так и названием цвета ("зелёный") — сопоставление
// по цвету модель делает сама на основе colorName из контекста (см. context.js) и присылает то же
// название, что видела там, так что здесь достаточно точного совпадения по имени.
async function execDeleteSection(firestore, uid, a) {
  const removed = await deleteSectionByName(firestore, uid, a.name);
  if (!removed) return { error: `Не нашёл раздел «${a.name}»` };
  return { summary: `🗑️ Раздел «${removed.name}»` };
}

const EXECUTORS = {
  create_event: execCreateEvent,
  create_expense: execCreateExpense,
  create_income: execCreateIncome,
  complete_habit: execCompleteHabit,
  complete_event: execCompleteEvent,
  delete_event: execDeleteEvent,
  create_section: execCreateSection,
  delete_section: execDeleteSection,
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
