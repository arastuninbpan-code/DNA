// Реальные данные пользователя для AI — собираются backend'ом из тех же документов, что уже
// читает бот (см. п.14 просьбы: "фактические данные всегда берутся из базы, а не из
// предположений AI"). LLM получает этот контекст в промпте и ссылается на него, а не
// придумывает цифры сама; для create_event/create_expense и т.п. backend всё равно исполняет
// только провалидированные действия (см. actions.js), а не то, что "сказала" модель о контексте.
import {
  getHabitsDoc, habitsOn, getPlannerDoc, plannerOn, getFinanceDoc, nearestColorName,
} from '../reminders.js';
import { computeHabitStreaks } from '../streaks.js';

export async function buildDayContext(firestore, uid, dateKey) {
  const [habitsDoc, plannerDoc, financeDoc] = await Promise.all([
    getHabitsDoc(firestore, uid),
    getPlannerDoc(firestore, uid),
    getFinanceDoc(firestore, uid),
  ]);
  const habits = habitsOn(habitsDoc, dateKey);
  const events = plannerOn(plannerDoc, dateKey);
  const transactions = (Array.isArray(financeDoc.transactions) ? financeDoc.transactions : [])
    .filter((t) => t && t.date === dateKey);
  const spent = transactions
    .filter((t) => t.type === 'expense')
    .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
  const earned = transactions
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
  const streaks = computeHabitStreaks(habitsDoc, dateKey);

  const sections = Array.isArray(plannerDoc.sections) ? plannerDoc.sections : [];

  return {
    dateKey,
    habits: habits.map((h) => ({ name: h.name, done: !!h.done, streak: streaks[h.name]?.current || 0 })),
    events: events.map((e) => ({ id: e.id, title: e.title, time: e.time || null, done: !!e.done })),
    // Список уже существующих разделов — чтобы AI не плодил дубликат "Спорт"/"спорт" вторым
    // раздела с тем же смыслом, а сначала свериться, нет ли уже подходящего (см. create_section
    // в actions.js/provider.js). colorName — приблизительное русское название цвета (см.
    // nearestColorName в reminders.js), чтобы можно было сослаться на раздел по цвету
    // ("удали зелёный раздел"), а не только по точному имени.
    sections: sections.filter(Boolean).map((s) => ({ name: s.name, colorName: nearestColorName(s.color) })),
    finance: { spent, earned, transactions: transactions.map((t) => ({ amount: t.amount, category: t.category, type: t.type })) },
  };
}
