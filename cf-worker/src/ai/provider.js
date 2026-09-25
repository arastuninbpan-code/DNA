// Единая точка вызова внешнего AI — весь остальной код (router.js) работает с этим
// интерфейсом { transcribe, route }, не зная, какой именно провайдер за ним стоит
// (см. п.9 просьбы: не привязывать бизнес-логику приложения к одному AI-провайдеру напрямую,
// абстракция AIProvider с заменяемой реализацией под конкретного вендора).
//
// createYandexProvider(env) — реализация поверх Yandex SpeechKit (распознавание речи) и
// YandexGPT (разбор намерения). Требует секреты env.YANDEX_API_KEY и env.YANDEX_FOLDER_ID
// (wrangler secret put — не коммитятся в репозиторий); пока их нет, оба метода бросают понятную
// ошибку "не настроено", а не молча делают вид, что работают.

import { COLOR_NAME_TO_HEX } from '../reminders.js';

const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const GPT_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

export function createYandexProvider(env) {
  const apiKey = env.YANDEX_API_KEY;
  const folderId = env.YANDEX_FOLDER_ID;

  function assertConfigured() {
    if (!apiKey || !folderId) {
      throw new Error('Yandex AI не настроен: нет YANDEX_API_KEY/YANDEX_FOLDER_ID в секретах Worker\'а');
    }
  }

  // audioBytes — сырые байты записи. opts.format различает два реальных источника:
  // - 'lpcm' (+ opts.sampleRateHertz) — из браузера (index.html): там MediaRecorder отдаёт
  //   WebM-контейнер с Opus-кодеком, а не настоящий Ogg — раньше это ошибочно посылалось как
  //   format=oggopus (WebM ≠ Ogg-контейнер несмотря на тот же кодек внутри), и SpeechKit не мог
  //   разобрать звук, поэтому голос не распознавался вообще. Теперь браузер сам декодирует запись
  //   в сырой PCM через Web Audio API (см. audioBlobToPcm16 в index.html) — раз данные без
  //   контейнера, разночтений с форматом на входе SpeechKit больше нет.
  // - 'oggopus' — из Telegram (голосовые сообщения бота): Telegram действительно присылает
  //   настоящий Ogg/Opus файл, тут формат совпадает буквально, декодировать не нужно.
  async function transcribe(audioBytes, opts = {}) {
    assertConfigured();
    const format = opts.format === 'oggopus' ? 'oggopus' : 'lpcm';
    const params = new URLSearchParams({
      lang: 'ru-RU',
      folderId,
      format,
      ...(format === 'lpcm' ? { sampleRateHertz: String(opts.sampleRateHertz || 16000) } : {}),
    });
    const res = await fetch(`${STT_URL}?${params}`, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${apiKey}` },
      body: audioBytes,
    });
    if (!res.ok) throw new Error(`Yandex SpeechKit: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (json.error_code) throw new Error(`Yandex SpeechKit: ${json.error_code} ${json.error_message || ''}`);
    return json.result || '';
  }

  // text — реплика пользователя (надиктованная или напечатанная); context — { today, tomorrow }
  // от buildDayContext (context.js), реальные данные, чтобы модель не придумывала цифры для
  // ответов на вопросы о состоянии дня (см. п.14 просьбы). opts.model — 'lite' (по умолчанию)
  // или 'pro', решает modelRouter.js#chooseModel ДО вызова route() — сам provider модель не
  // выбирает и не подменяет одну на другую при неудаче (см. п.5 аудита AI-себестоимости: нет
  // автоматического fallback lite->pro).
  async function route(text, context, opts = {}) {
    assertConfigured();
    const model = opts.model === 'pro' ? 'yandexgpt' : 'yandexgpt-lite';
    const res = await fetch(GPT_URL, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        modelUri: `gpt://${folderId}/${model}/latest`,
        completionOptions: { stream: false, temperature: 0.2, maxTokens: '800' },
        messages: [
          { role: 'system', text: buildSystemPrompt(context) },
          { role: 'user', text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`YandexGPT: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const raw = json.result?.alternatives?.[0]?.message?.text || '';
    // usage — реальный расход токенов из ответа модели (не оценка) — прокидывается наверх через
    // planTurn (router.js) до конкретного вызывающего в index.js, который знает канал (source) и
    // логирует его через logAiUsage (usage.js) — см. п.6/8 ТЗ по контролю AI-себестоимости.
    const usage = json.result?.usage || {};
    return {
      ...parseModelJson(raw),
      usage: {
        model,
        inputTokens: Number(usage.inputTextTokens) || 0,
        outputTokens: Number(usage.completionTokens) || 0,
        // "Закэшированные" input-токены (строка в биллинге Yandex Cloud) — у YandexGPT
        // completion API официально задокументированы только inputTextTokens/completionTokens/
        // totalTokens в result.usage; поля с кэшированными токенами там нет (проверено по
        // реальному ответу API), а не просто "неизвестно как называется" — значит вычислить его
        // из этого ответа нельзя, 0 здесь честный "нет данных", а не подставленное с потолка
        // число. Если это поле когда-нибудь появится в API, можно будет заменить 0 на реальное
        // значение прямо тут, ничего больше в проекте менять не придётся.
        cachedTokens: 0,
      },
    };
  }

  return { transcribe, route };
}

// Сжатый промпт — см. п.13 аудита AI-себестоимости: замер (см. scratchpad-бенчмарк в отчёте)
// показал, что ~93% байт каждого Lite/Pro-запроса были этим статическим текстом, а не реальными
// данными пользователя (JSON today/tomorrow после оптимизации п.10/11 — уже маленький). Ниже —
// та же самая схема действий и те же правила, что и раньше, просто без повторяющихся оговорок и
// пояснений "для читателя-человека" — по смыслу для модели ничего не потеряно, действия и их
// поля, запреты и формат ответа те же самые.
export function buildSystemPrompt(context) {
  return [
    'Ты — Атлас, ассистент D.N.A. (финансы/события/привычки). Ответ — СТРОГО валидный JSON без markdown: {"actions":[{...}],"reply":"короткий ответ на русском"}. Можно несколько actions за раз.',
    '',
    'actions:',
    '- create_event {title,date:"YYYY-MM-DD",time?:"HH:MM",section?}: time не указывай, если пользователь его не назвал (не придумывай "по умолчанию"). section — точное имя из списка разделов ниже; если такой уже есть, НЕ вызывай отдельно create_section.',
    '- create_expense / create_income {amount,category?,description?}',
    '- complete_habit {name} — name строго из списка привычек на сегодня ниже',
    '- complete_event {title,date?=сегодня} — отмечает выполненным, событие остаётся в списке (не путать с delete_event)',
    '- delete_event {title,date?=сегодня} — полностью удаляет событие',
    `- create_section {name,color?:"#rrggbb"} — сверься со списком разделов ниже, дубликат не создавай. Слово цвета переводи в hex сам по таблице: ${Object.entries(COLOR_NAME_TO_HEX).map(([name, hex]) => `${name}=${hex}`).join(', ')}.`,
    '- delete_section {name} — раздел удаляется, его события остаются без раздела; name можно указать по цвету (colorName из списка ниже) — впиши точное name найденного раздела.',
    '',
    'Удаление финансовых операций НЕ поддерживается никаким action — не изображай его через нулевую/отрицательную сумму (будет отклонено); в этом случае actions:[], а в reply честно скажи, что не поддерживается.',
    'Если это просто вопрос о данных (не команда создать/отметить) — actions:[], reply строго по контексту ниже, ничего не выдумывай.',
    '',
    'reply: перечисленные actions ещё НЕ применены (пользователь подтвердит кнопкой) — пиши "Вот что сделаю:"/"Предлагаю:", не как будто уже сделано. Если actions пуст — пиши обычным тоном.',
    'Относительное время ("через час/30 минут") — сам посчитай HH:MM от текущего времени ниже; если через полночь — дата "Завтра".',
    '',
    `Сегодня: ${context.today.dateKey}. Завтра: ${context.tomorrow.dateKey}. Время сейчас: ${context.now}.`,
    `Данные на сегодня: ${JSON.stringify(context.today)}`,
    `Данные на завтра: ${JSON.stringify(context.tomorrow)}`,
  ].join('\n');
}

// Проходит по строке и находит top-level {...} блоки (сбалансированные скобки, не считая те,
// что внутри строковых литералов) — нужно для parseModelJson ниже, когда модель вместо ОДНОГО
// JSON-объекта возвращает несколько подряд.
function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) { objects.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return objects;
}

// При нескольких actions в одном ответе yandexgpt-lite иногда вместо {"action":"create_event",
// "title":...} пишет {"create_event{"title":...}} — то есть теряет ключ "action": и вместо
// него/запятой вставляет лишнюю {, задваивая её симметричной лишней } в конце того же объекта.
// Обнаружено на реальном сообщении пользователя ("занеси на завтра в 15:00 встречу а также у
// меня трата 380р за шоколадку" — два действия сразу): JSON.parse падал целиком, а старый
// фолбэк ниже показывал пользователю этот сырой, нечитаемый JSON как будто это осмысленный
// ответ. Это НЕ повод переходить на Pro (см. п.5 аудита AI-себестоимости — ошибка JSON не
// причина для эскалации модели) — чинится восстановлением конкретно этой известной поломки:
// {"ИМЯ{"ПОЛЯ"}} -> {"action":"ИМЯ",ПОЛЯ}. На уже валидном JSON и на обычном разговорном тексте
// без JSON эта замена ничего не меняет (паттерн специфичен и в них не встречается).
function repairMissingActionKey(text) {
  return text.replace(/\{"([a-zA-Z_]+)\{([^{}]*)\}\}/g, (_m, name, fields) => `{"action":"${name}",${fields}}`);
}

// Модель иногда оборачивает JSON в ```json ... ``` несмотря на инструкцию отвечать без обёртки —
// снимаем её перед парсингом. Отдельная проблема (замечена на yandexgpt-lite): вместо ОДНОГО
// объекта {"actions":[...],"reply":"..."} модель иногда возвращает два отдельных top-level
// объекта подряд — {"actions":[...]}{"reply":"..."} — обычный JSON.parse на этом падает целиком,
// и раньше пользователь видел сырой текст с фигурными скобками вместо ответа. Теперь при неудаче
// целиком пробуем распарсить каждый top-level {...} блок по отдельности (после repairMissingActionKey
// выше) и собрать actions/reply из того, что нашлось — так конкатенация нескольких валидных
// объектов больше не теряется. Если после всех попыток текст ВСЁ ЕЩЁ похож на неудавшуюся
// попытку JSON (начинается с { или содержит характерные "action"/actions/reply), показывать его
// пользователем как "разговорный ответ" нельзя — это нечитаемый мусор, а не текст; в этом случае
// отдаём нейтральное "не понял, попробуй ещё раз". Настоящий разговорный ответ модели (без всякого
// JSON) по-прежнему проходит как есть — лучше показать что-то осмысленное, чем упасть на опечатку.
function looksLikeFailedJson(text) {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') || /"actions"|"reply"|"action"\s*:/.test(t);
}

function parseModelJson(raw) {
  const cleaned = repairMissingActionKey(
    String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim(),
  );
  let actions = null;
  let reply = null;
  for (const candidate of [cleaned, ...extractJsonObjects(cleaned)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (actions === null && Array.isArray(parsed.actions)) actions = parsed.actions;
      if (reply === null && typeof parsed.reply === 'string') reply = parsed.reply;
    } catch (_) { /* не JSON — пропускаем этот кандидат */ }
  }
  if (actions !== null || reply !== null) return { actions: actions || [], reply: reply || '' };
  if (looksLikeFailedJson(cleaned)) return { actions: [], reply: 'Не понял запрос — попробуй переформулировать.' };
  return { actions: [], reply: raw.trim() || 'Не понял запрос — попробуй переформулировать.' };
}

export { parseModelJson };
