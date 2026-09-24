// Единственное место с тарифами Yandex Cloud для AI — см. п.10 ТЗ по контролю AI-себестоимости:
// не хардкодить цены в разных файлах, а держать их в одном месте, которое можно поправить.
// Цифры ниже собраны по открытым источникам на сентябрь 2026 и являются ПРИБЛИЗИТЕЛЬНЫМИ —
// сверь их с реальным биллингом в консоли Yandex Cloud (Биллинг → Детализация) и поправь при
// расхождении. Дальше во всём проекте это единственный файл, который для этого нужно менять.
export const AI_PRICING = {
  yandexgptLite: { inputPer1000Rub: 0.2, outputPer1000Rub: 0.2 },
  // Pro нигде в проекте пока не вызывается (см. provider.js — модель захардкожена на lite ради
  // цены), но тариф держим здесь на случай, если он понадобится позже — см. п.3 ТЗ "Pro
  // использовать только там, где он реально нужен".
  yandexgptPro: { inputPer1000Rub: 2, outputPer1000Rub: 6 },
  speechkitSttRubPerSecond: 0.167,
};

export function estimateGptCostRub(model, inputTokens, outputTokens) {
  const cfg = model === 'yandexgpt' ? AI_PRICING.yandexgptPro : AI_PRICING.yandexgptLite;
  return (Number(inputTokens || 0) / 1000) * cfg.inputPer1000Rub
    + (Number(outputTokens || 0) / 1000) * cfg.outputPer1000Rub;
}

export function estimateSttCostRub(seconds) {
  return Number(seconds || 0) * AI_PRICING.speechkitSttRubPerSecond;
}
