// Панель разработчика, промокоды, поддержка — см. просьбу пользователя: секретный пароль,
// открывающий скрытую админку (траты на AI, обращения в поддержку) и в приложении, и в боте;
// промокоды, которые можно активировать и там, и там; обращения в поддержку от пользователей,
// видные владельцу в этой же панели.
//
// Модель прав здесь намеренно простая: у проекта один владелец, поэтому вместо полноценных
// ролей — один флаг isAdmin на users/{uid} владельца, выставляемый один раз после ввода
// секретного пароля. Сам пароль хранится ТОЛЬКО как секрет Worker'а (env.ADMIN_SECRET,
// wrangler secret put — не коммитится в репозиторий), а не в коде и не в Firestore.
export async function tryUnlockAdmin(firestore, env, uid, password) {
  if (!env.ADMIN_SECRET) return { ok: false, error: 'ADMIN_SECRET не настроен на сервере' };
  if (!password || String(password) !== env.ADMIN_SECRET) return { ok: false, error: 'неверный пароль' };
  await firestore.mergeDoc(`users/${uid}`, { isAdmin: true });
  return { ok: true };
}

export async function isUserAdmin(firestore, uid) {
  const user = await firestore.getDoc(`users/${uid}`);
  return !!(user && user.isAdmin);
}

// Выход из режима разработчика — по просьбе пользователя. Снимает isAdmin на сервере (а не
// только прячет кнопку локально в интерфейсе) — иначе профиль, перезагруженный из Firestore на
// другом устройстве/после переустановки, тут же вернул бы доступ без повторного ввода пароля.
export async function lockAdmin(firestore, uid) {
  await firestore.mergeDoc(`users/${uid}`, { isAdmin: false });
  return { ok: true };
}

// -------- Промокоды --------
// Код хранится как ИМЯ документа (в верхнем регистре), не как поле внутри — тогда "это
// промокод?" (и в боте, и на /promo/redeem) — один прямой getDoc по известному пути, без query
// API, которого у REST-клиента нет (см. firestore.js).
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Пока в приложении нет платных тарифов/лимитов (см. аудит AI-расходов) — активация кода не
// снимает никаких ограничений (их просто нет), а помечает аккаунт как premium на будущее: когда
// появятся платные ограничения (см. п.14/15 ТЗ по контролю AI-себестоимости — soft/hard limit по
// подписке), этот флаг уже будет на месте и не потребует отдельной миграции промокодов.
export async function redeemPromoCode(firestore, uid, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'пустой код' };
  const promo = await firestore.getDoc(`promoCodes/${code}`);
  if (!promo || promo.active === false) return { ok: false, error: 'код не найден или больше не активен' };
  if (promo.maxUses != null && (promo.usedCount || 0) >= promo.maxUses) {
    return { ok: false, error: 'лимит активаций этого кода исчерпан' };
  }
  const redemptionPath = `promoRedemptions/${code}_${uid}`;
  if (await firestore.getDoc(redemptionPath)) return { ok: false, error: 'этот код уже активирован на этом аккаунте' };
  await firestore.setDoc(redemptionPath, { code, uid, redeemedAt: Date.now() });
  await firestore.mergeDoc(`users/${uid}`, { premium: true, premiumCode: code, premiumActivatedAt: Date.now() });
  await firestore.mergeDoc(`promoCodes/${code}`, { usedCount: (promo.usedCount || 0) + 1 });
  return { ok: true };
}

// Без похожих друг на друга символов (0/O, 1/I/L) — код иногда придётся продиктовать или
// перепечатать руками.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePromoCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function createPromoCode(firestore, { code, maxUses, note } = {}) {
  const finalCode = normalizeCode(code) || generatePromoCode();
  await firestore.setDoc(`promoCodes/${finalCode}`, {
    code: finalCode, createdAt: Date.now(), active: true,
    maxUses: maxUses == null || maxUses === '' ? null : Number(maxUses), usedCount: 0, note: note || null,
  });
  return finalCode;
}

export async function listPromoCodes(firestore) {
  const docs = await firestore.listCollection('promoCodes');
  return docs.map((d) => d.data).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// -------- Поддержка --------
export async function submitSupportMessage(firestore, { uid, text, source }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'пустое сообщение' };
  const id = crypto.randomUUID();
  await firestore.setDoc(`supportMessages/${id}`, {
    uid, text: trimmed.slice(0, 2000), source, status: 'new', createdAt: Date.now(),
  });
  return { ok: true };
}

export async function listSupportMessages(firestore, limit = 30) {
  const docs = await firestore.listCollection('supportMessages');
  return docs.map((d) => d.data).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
}

// -------- Заметки для разработки --------
// Отдельно от supportMessages выше: то — жалобы/вопросы ОТ пользователей владельцу, это —
// собственные заметки владельца "поправить/добавить" в самой панели разработчика (см. просьбу
// "какие-то запросы присылались прямяком тебе, какие-то правки или дополнения"). Настоящей
// прямой доставки в чужую переписку у Worker'а нет — заметки просто копятся здесь и видны в
// панели, откуда их разбирают вручную или по расписанию (см. /admin/devrequests в index.js —
// его можно опрашивать скриптом по секрету, не только из самого приложения).
export async function submitDevRequest(firestore, { uid, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'пустая заметка' };
  const id = crypto.randomUUID();
  await firestore.setDoc(`devRequests/${id}`, {
    uid, text: trimmed.slice(0, 4000), status: 'new', createdAt: Date.now(),
  });
  return { ok: true };
}

export async function listDevRequests(firestore, limit = 50) {
  const docs = await firestore.listCollection('devRequests');
  return docs.map((d) => ({ id: d.id, ...d.data })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
}

// Убрать заметку из панели после того, как правки по ней сделаны — прямая просьба владельца
// ("если ты что-то сделал из панели разработчика, то надо задачи эти убирать"): раньше заметки
// копились в списке навсегда (submit/list, без удаления), из-за чего уже решённые вопросы
// продолжали висеть как новые. Просто удаляем документ — не "статус done", список и так должен
// показывать только реально открытое.
export async function resolveDevRequest(firestore, id) {
  if (!id) return { ok: false, error: 'нет id' };
  await firestore.deleteDoc(`devRequests/${id}`);
  return { ok: true };
}

// -------- Статистика пользователей --------
// lastSeenAt обновляет touchUserActivity (index.js — вызывается из requireFirebaseUid на КАЖДОМ
// аутентифицированном запросе и из handleTelegramWebhook на каждом апдейте бота), поэтому
// "активен" тут значит буквально "было любое взаимодействие", а не только вход. activeDaysCount —
// растёт максимум на 1 в календарный день (МСК, см. lastSeenDateKey) — грубая, но дешёвая оценка
// "частоты заходов" без отдельной таблицы визитов.
export async function touchUserActivity(firestore, uid, todayDateKey) {
  try {
    const path = `users/${uid}`;
    const user = await firestore.getDoc(path);
    const patch = { lastSeenAt: Date.now() };
    if (!user?.firstSeenAt) patch.firstSeenAt = user?.linkedAt || Date.now();
    if (user?.lastSeenDateKey !== todayDateKey) {
      patch.lastSeenDateKey = todayDateKey;
      patch.activeDaysCount = (user?.activeDaysCount || 0) + 1;
    }
    await firestore.mergeDoc(path, patch);
  } catch (err) {
    // Побочный учёт — сбой не должен ронять сам запрос, ради которого он вызван.
    console.error('touchUserActivity failed', err);
  }
}

export async function getUserStatsOverview(firestore) {
  const rows = await firestore.listCollection('users');
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const seenWithin = (ms) => rows.filter((r) => now - (r.data.lastSeenAt || 0) < ms).length;
  const createdWithin = (ms) => rows.filter((r) => now - (r.data.firstSeenAt || r.data.linkedAt || 0) < ms).length;
  const topActive = rows
    .map((r) => ({
      uid: r.id,
      name: r.data.telegramFirstName || r.data.telegramUsername || r.id,
      activeDaysCount: r.data.activeDaysCount || 0,
      lastSeenAt: r.data.lastSeenAt || 0,
    }))
    .sort((a, b) => b.activeDaysCount - a.activeDaysCount)
    .slice(0, 5);
  return {
    total: rows.length,
    activeToday: seenWithin(DAY),
    activeWeek: seenWithin(7 * DAY),
    activeMonth: seenWithin(30 * DAY),
    newToday: createdWithin(DAY),
    newWeek: createdWithin(7 * DAY),
    topActive,
  };
}
