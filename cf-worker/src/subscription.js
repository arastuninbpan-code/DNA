// Единый источник правды "есть ли у пользователя активный Premium" (см. ТЗ п.26/31 — не плодить
// разные независимые проверки adminPremium/hasAi/atlasEnabled, а использовать один сервис
// одновременно из AI-эндпоинтов, панели разработчика и (позже) payment webhook).
//
// Хранится прямо в users/{uid}.subscription — тот же документ, что уже содержит isAdmin/premium/
// telegramId (экономит getDoc на каждой проверке, лишний документ не нужен):
//   { plan:'premium', status:'active'|'cancelled', source:'admin'|'payment'|'promo',
//     startedAt, expiresAt (число мс или null = бессрочно), lifetime:bool, grantedBy,
//     createdAt, updatedAt }
// "expired" — не отдельный статус в базе, а то, что возвращает subscriptionStatus(), когда
// status:'active' но expiresAt уже в прошлом (не lifetime) — не нужно отдельным кроном сбрасывать
// статус у каждой истёкшей подписки, срок сам решает при каждой проверке.
//
// Старое плоское поле users/{uid}.premium (см. admin.js#redeemPromoCode, было заглушкой без
// реальных ограничений) этим не заменяется и не трогается — оставлено как есть для обратной
// совместимости с уже выданными кодами; gate теперь только через .subscription.

const ACTIVE_STATUS = 'active';

export function subscriptionStatus(sub, now = Date.now()) {
  if (!sub) return 'none';
  if (sub.status === 'cancelled') return 'cancelled';
  if (sub.lifetime) return 'active';
  if (sub.expiresAt != null && sub.expiresAt < now) return 'expired';
  return sub.status === ACTIVE_STATUS ? 'active' : (sub.status || 'none');
}

export async function getSubscription(firestore, uid) {
  const user = await firestore.getDoc(`users/${uid}`);
  return (user && user.subscription) || null;
}

export async function hasPremium(firestore, uid) {
  return subscriptionStatus(await getSubscription(firestore, uid)) === 'active';
}

// Выдача/продление — вызывается и из Developer Panel (source:'admin', см. ТЗ п.28/29), и в
// будущем из payment webhook (source:'payment') без изменения этой функции (см. ТЗ п.26/31).
// days — сколько дней добавить; lifetime:true — бессрочный доступ (expiresAt=null), а не дата
// "через 100 лет" (прямой запрет ТЗ п.29). Если подписка ЕЩЁ активна — продление считается от
// текущего expiresAt, а не от now: иначе повторное "+30 дней" на ещё не истёкшей подписке отбирало
// бы уже действующие дни (см. ТЗ п.29 "если Premium ещё активен: expiresAt = expiresAt + срок").
export async function grantPremium(firestore, uid, { days = null, lifetime = false, source = 'admin', grantedBy = null } = {}) {
  const existing = await getSubscription(firestore, uid);
  const now = Date.now();
  const wasActive = subscriptionStatus(existing, now) === 'active';
  let expiresAt;
  if (lifetime) {
    expiresAt = null;
  } else if (days) {
    const base = wasActive && existing?.expiresAt != null ? existing.expiresAt : now;
    expiresAt = base + days * 86400000;
  } else {
    // Ни days, ни lifetime не переданы — просто "снять cancelled"/переактивировать на прежних
    // условиях (например повторная выдача тем же сроком) — сохраняем прежний expiresAt как есть.
    expiresAt = existing?.expiresAt ?? null;
  }
  const sub = {
    plan: 'premium',
    status: 'active',
    source,
    startedAt: existing?.startedAt || now,
    expiresAt,
    lifetime: !!lifetime || (!days && !!existing?.lifetime),
    grantedBy: grantedBy || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await firestore.mergeDoc(`users/${uid}`, { subscription: sub });
  return sub;
}

// Отзыв — status:'cancelled', сразу лишает Atlas (см. ТЗ п.30); остальные данные пользователя
// (транзакции/привычки/события/цели/история) не трогаются никак.
export async function revokePremium(firestore, uid) {
  const existing = await getSubscription(firestore, uid);
  const sub = { ...(existing || { plan: 'premium', source: 'admin', createdAt: Date.now(), startedAt: Date.now() }), status: 'cancelled', updatedAt: Date.now() };
  await firestore.mergeDoc(`users/${uid}`, { subscription: sub });
  return sub;
}
