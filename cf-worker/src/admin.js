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
