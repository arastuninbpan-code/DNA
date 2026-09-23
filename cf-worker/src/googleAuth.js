// Обмен service-account JWT на короткоживущий OAuth2 access token для Firestore REST API.
// Admin SDK в Cloudflare Workers недоступен (он рассчитан на Node), поэтому делаем этот обмен
// вручную — ровно то же самое, что Admin SDK делает внутри себя.
import { signJwt } from './jwt.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// Кэш в памяти изолята — Worker может обработать несколько запросов на одном изоляте подряд,
// не имеет смысла ходить за новым токеном на каждый вызов (токен живёт час).
let cachedToken = null;
let cachedExpiresAt = 0;

export async function getFirestoreAccessToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExpiresAt - 60) return cachedToken;

  const claims = {
    iss: clientEmail,
    scope: FIRESTORE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const assertion = await signJwt(claims, privateKeyPem);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth2 token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  cachedExpiresAt = now + json.expires_in;
  return cachedToken;
}

// Firebase custom token — тот же принцип, что "Authenticate Using JWT Without the Admin SDK"
// в документации Firebase: JWT, подписанный service-account ключом, с полем uid.
export async function createCustomToken(clientEmail, privateKeyPem, uid) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
  };
  return signJwt(claims, privateKeyPem);
}
