// Явный выбор уровня модели — LOCAL (localParser.js, 0 ₽) -> LITE (по умолчанию) -> PRO (только
// по явной причине). См. п.4/5 аудита AI-себестоимости: "всегда начинать с самого дешёвого
// подходящего уровня" и "для вызова Pro требуется явная техническая причина (pro_reason)".
//
// Сейчас в проекте НЕТ ни одного места, которое передаёт proReason — значит chooseModel всегда
// вернёт 'lite', и Pro физически не вызывается (это уже так и в текущем коде, см. pricing.js).
// Список ниже — не "включение" Pro, а официальный, документированный список причин, единственно
// допустимых для него в будущем (finance_analysis и т.п. из п.24 просьбы), чтобы Pro нельзя было
// включить случайно (опечаткой в model) или "потому что Lite не ответил" (п.5: ошибка JSON —
// НЕ причина для Pro; см. parseModelJson в provider.js — он и так восстанавливает ответ модели
// без повторного вызова).
export const PRO_REASONS = new Set([
  'complex_financial_analysis',
  'complex_multistep_reasoning',
  'large_cross_domain_analysis',
]);

// proReason — необязательная строка; если её нет или она не входит в PRO_REASONS, модель — lite,
// без исключений (в т.ч. никакого автоматического fallback с lite на pro при ошибке/неуверенности).
export function chooseModel(proReason) {
  if (proReason && PRO_REASONS.has(proReason)) return { model: 'pro', proReason };
  return { model: 'lite', proReason: null };
}
