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
  return null;
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

// todayCtx — тот же объект, что planTurn уже получил от buildDayContext(today) для system prompt
// на случай, если распознать не удастся; передаём его сюда, чтобы factual-запросы не требовали
// повторного чтения Firestore.
export function tryLocalParse(text, todayCtx) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  return tryFactualQuery(raw, todayCtx) || tryExpenseIncome(raw);
}
