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
  // ИСПРАВЛЕНО: SpeechKit (и синхронное, и потоковое распознавание) тарифицируется НЕ линейно
  // за секунду, а БЛОКАМИ по 15 секунд одноканального аудио, с округлением КАЖДОГО отрезка
  // ВВЕРХ до полного блока (даже 1 секунда звука = 1 полный блок) — подтверждено официальной
  // документацией Yandex Cloud (cloud.yandex.ru/docs/speechkit/pricing) и независимо реальным
  // биллингом пользователя (13 запросов × 15 сек = 2.11 ₽ → 2.11/13 ≈ 0.162 ₽/блок, совпадает
  // с официальной ставкой 0.1626 ₽ за блок). Старое значение 0.167 ₽/сек с линейным умножением
  // было в ~5+ раз дороже реальности для типичных коротких голосовых команд (5 сек по факту
  // стоят как 1 блок = 0.1626 ₽, а не 5×0.167=0.835 ₽) — см. estimateSttCostRub ниже.
  speechkitSttRubPer15SecBlock: 0.1626,
};

export function estimateGptCostRub(model, inputTokens, outputTokens) {
  const cfg = model === 'yandexgpt' ? AI_PRICING.yandexgptPro : AI_PRICING.yandexgptLite;
  return (Number(inputTokens || 0) / 1000) * cfg.inputPer1000Rub
    + (Number(outputTokens || 0) / 1000) * cfg.outputPer1000Rub;
}

// seconds — реальная длительность отправленного аудио; тарифицируется НЕ как seconds*ставка, а
// как ceil(seconds/15) полных 15-секундных блоков — 1 секунда и 15 секунд стоят ОДИНАКОВО (один
// блок), 16 секунд стоят как два блока. См. комментарий у speechkitSttRubPer15SecBlock выше.
export function estimateSttCostRub(seconds) {
  const s = Number(seconds || 0);
  if (s <= 0) return 0;
  const blocks = Math.ceil(s / 15);
  return blocks * AI_PRICING.speechkitSttRubPer15SecBlock;
}
