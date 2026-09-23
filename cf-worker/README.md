# D.N.A. Telegram bot — Cloudflare Worker

Замена серверной части из `functions/` (Firebase Cloud Functions), которая требует платный
Blaze-план. Cloudflare Workers дают тот же результат на бесплатном тарифе без привязки карты.
База данных не меняется — это тот же Firestore-проект (`dnaa-a8ca3`), Worker обращается к нему
напрямую через REST API (см. `src/firestore.js`), а не через Admin SDK.

## Три эндпоинта + одно расписание

- `POST /telegramAuthVerify` — вход через Telegram Login Widget (виджет в настройках).
- `POST /telegramLinkAuth` — вход по одноразовой ссылке, которую шлёт бот на `/start`.
- `POST /telegramWebhook` — сюда Telegram шлёт апдейты (команды, нажатия кнопок).
- `scheduled` (cron, каждые 30 минут) — рассылка напоминаний о невыполненных привычках.

## Что нужно для деплоя

1. Аккаунт Cloudflare (бесплатно, без карты) — https://dash.cloudflare.com/sign-up
2. API-токен с правами «Edit Cloudflare Workers» (Account API Tokens → Create Token)
3. Firebase service account key (JSON) — Firebase Console → Project settings → Service accounts
   → Generate new private key. Из него берутся `client_email` и `private_key` — они идут в
   секреты Worker'а, а не в код и не в git.

## Секреты (не в коде, задаются через `wrangler secret put`)

```
wrangler secret put TELEGRAM_BOT_TOKEN     # из BotFather
wrangler secret put FIREBASE_PRIVATE_KEY   # поле private_key из service account JSON, как есть
```

`FIREBASE_CLIENT_EMAIL` и `FIREBASE_PROJECT_ID` не секретны (email виден в самом же JSON-файле,
без private_key он бесполезен) — заданы прямо в `wrangler.toml` как `[vars]`.

## Деплой

```
npm install
npm run deploy
```

После первого деплоя Wrangler покажет URL вида `https://dna-telegram-bot.<subdomain>.workers.dev`.
Дальше нужно:

1. Обновить `TELEGRAM_AUTH_VERIFY_URL` / `TELEGRAM_LINK_AUTH_URL` в `index.html` (сейчас там
   заглушки под старые Firebase Function URL) на `<worker-url>/telegramAuthVerify` и
   `<worker-url>/telegramLinkAuth`.
2. Обновить `APP_URL` в `wrangler.toml`, если домен приложения изменится.
3. Один раз вызвать Telegram `setWebhook`, указав `<worker-url>/telegramWebhook` (можно через
   `src/telegram.js#setWebhook` вручную или прямым POST на
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<worker-url>/telegramWebhook`).
