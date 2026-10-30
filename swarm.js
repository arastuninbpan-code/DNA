// Запуск N червей в одном направлении с авто-возрождением (для ПРИВАТНОГО сервера).
// Использование: node swarm.js <url> [count=100] [angleDeg=0] [nickPrefix=bot] [delayMs=150]
// Пример:        node swarm.js http://localhost:8080/ 100 45 sexo
const { chromium } = require('playwright');

const URL = process.argv[2];
const COUNT = +(process.argv[3] || 100);
const ANGLE = ((+(process.argv[4] || 0)) * Math.PI) / 180; // 0 = вправо, 90 = вниз
const PREFIX = process.argv[5] || 'bot';
const DELAY = +(process.argv[6] || 150); // пауза между запусками, чтобы не душить сервер
if (!URL) { console.error('Укажи URL приватного сервера'); process.exit(1); }

// Выполняется внутри каждой страницы игры
function pageScript({ nick, angle }) {
  setInterval(() => {
    try {
      if (window.playing && window.slither) {
        window.xm = Math.cos(angle) * 300;
        window.ym = Math.sin(angle) * 300;
        return;
      }
      if (window.connecting || window.want_play) return;
      const el = document.getElementById('nick');
      if (el) el.value = nick;
      const btn = document.querySelector('.btnt.nsi.sadg1') || document.querySelector('.btnt.nsi');
      if (btn) btn.click(); // возрождение после смерти
    } catch (e) {}
  }, 500);
  // не даём браузеру/игре перехватывать курсор
  window.addEventListener('mousemove', (e) => e.stopImmediatePropagation(), true);
}

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 320, height: 200 } });
  for (let i = 0; i < COUNT; i++) {
    const page = await ctx.newPage();
    // фоновые вкладки не троттлим сильно: отдельный контекст для каждой не нужен, но снижаем нагрузку
    await page.addInitScript(pageScript, { nick: PREFIX + (i + 1), angle: ANGLE });
    page.goto(URL).catch((e) => console.error('page', i + 1, e.message));
    console.log('started', i + 1 + '/' + COUNT);
    await new Promise((r) => setTimeout(r, DELAY));
  }
  console.log('Все запущены. Ctrl+C для остановки.');
  process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
})();
