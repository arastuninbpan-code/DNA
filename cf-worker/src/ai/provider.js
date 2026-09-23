// Единая точка вызова внешнего AI — весь остальной код (router.js) работает с этим
// интерфейсом { transcribe, route }, не зная, какой именно провайдер за ним стоит
// (см. п.9 просьбы: не привязывать бизнес-логику приложения к одному AI-провайдеру напрямую,
// абстракция AIProvider с заменяемой реализацией под конкретного вендора).
//
// createYandexProvider(env) — реализация поверх Yandex SpeechKit (распознавание речи) и
// YandexGPT (разбор намерения). Требует секреты env.YANDEX_API_KEY и env.YANDEX_FOLDER_ID
// (wrangler secret put — не коммитятся в репозиторий); пока их нет, оба метода бросают понятную
// ошибку "не настроено", а не молча делают вид, что работают.

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
  // ответов на вопросы о состоянии дня (см. п.14 просьбы).
  async function route(text, context) {
    assertConfigured();
    const res = await fetch(GPT_URL, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        // Lite, не Pro — задача модели тут строго "разобрать намерение и вернуть JSON по схеме",
        // а не творческая генерация текста, для неё точности Lite с запасом хватает, а стоит она
        // в разы дешевле (см. https://cloud.yandex.ru/docs/speechkit/pricing и обсуждение
        // стоимости с пользователем).
        modelUri: `gpt://${folderId}/yandexgpt-lite/latest`,
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
    return parseModelJson(raw);
  }

  return { transcribe, route };
}

function buildSystemPrompt(context) {
  return [
    'Ты — ассистент личного приложения D.N.A. (финансы, события, привычки).',
    'Отвечай СТРОГО валидным JSON без пояснений и без markdown-обёртки, формата:',
    '{"actions":[{...}],"reply":"короткий ответ пользователю на русском"}',
    '',
    'Допустимые action и их поля:',
    '- create_event: {"action":"create_event","title":"строка","date":"YYYY-MM-DD","time":"HH:MM"(опционально)} — если пользователь НЕ назвал время, поле time вообще не указывать (не придумывать "по умолчанию" 09:00 или любое другое) — событие без времени это нормальный случай, бот и приложение напомнят о нём в течение дня и без конкретного часа',
    '- create_expense / create_income: {"action":"create_expense","amount":число_рублей,"category":"строка"(опц.),"description":"строка"(опц.)}',
    '- complete_habit: {"action":"complete_habit","name":"..."} — name ТОЛЬКО из списка сегодняшних привычек ниже, не придумывай новые',
    '- complete_event: {"action":"complete_event","title":"...","date":"YYYY-MM-DD"(опц., по умолчанию сегодня)} — title ТОЛЬКО из списка событий ниже (сегодня/завтра), не придумывай новые',
    '- create_section: {"action":"create_section","name":"строка","color":"#rrggbb"(опц.)} — раздел планера (категория событий); ПЕРЕД созданием свериться со списком существующих разделов ниже — если подходящий уже есть, использовать его, а не плодить дубликат',
    '',
    'Если пользователь просто спрашивает о своих данных (что сегодня/завтра, сколько потратил и т.п.),',
    'а не просит что-то создать или отметить — actions оставь пустым массивом [], а в reply ответь,',
    'опираясь ТОЛЬКО на контекст ниже, не выдумывая цифры и события, которых там нет.',
    'Если сообщение содержит несколько действий сразу (несколько расходов/событий/привычек) —',
    'верни их все отдельными элементами массива actions.',
    '',
    `Сегодня: ${context.today.dateKey}. Завтра: ${context.tomorrow.dateKey}.`,
    `Данные на сегодня: ${JSON.stringify(context.today)}`,
    `Данные на завтра: ${JSON.stringify(context.tomorrow)}`,
  ].join('\n');
}

// Модель иногда оборачивает JSON в ```json ... ``` несмотря на инструкцию отвечать без обёртки —
// снимаем её перед парсингом. Если распарсить всё равно не удалось, не считаем это ошибкой
// запроса — отдаём сырой текст как обычный разговорный ответ без действий: лучше показать
// пользователю что-то осмысленное, чем упасть с "техническая ошибка" на любую опечатку модели.
function parseModelJson(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    };
  } catch (err) {
    return { actions: [], reply: raw.trim() || 'Не понял запрос — попробуй переформулировать.' };
  }
}
