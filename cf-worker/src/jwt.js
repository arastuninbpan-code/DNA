// RS256 JWT-подпись через Web Crypto API — работает и в Cloudflare Workers, и в обычном
// Node (crypto.subtle доступен в обоих), так что этот файл можно юнит-тестировать локально.
// В Workers нет Node-модуля 'crypto'/'jsonwebtoken', поэтому подписываем вручную по спеке JWT
// (используется и для Google OAuth2 service-account JWT, и для Firebase custom token — оба
// требуют RS256 одним и тем же способом).

function base64UrlEncode(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    // Вставленное из JSON-файла значение private_key нередко содержит буквальные
    // символы `\` + `n` (как они записаны в самом JSON), а не настоящие переводы
    // строк — их тоже нужно вырезать, иначе atob() падает на "\n" как на мусоре.
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedKey = null;
let cachedKeyPem = null;
async function importPrivateKey(pem) {
  if (cachedKey && cachedKeyPem === pem) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cachedKeyPem = pem;
  return cachedKey;
}

// claims — произвольный объект полезной нагрузки; privateKeyPem — PEM-строка из service
// account JSON (поле private_key, с реальными переводами строк, не \n-экранированными).
export async function signJwt(claims, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function base64UrlDecodeToString(str) {
  return new TextDecoder().decode(base64UrlDecode(str));
}

// Публичные ключи Firebase Auth (Google secure token service) — обновляются редко, ETag/
// Cache-Control в ответе обычно даёт часы жизни, но здесь проще держать свой недолгий TTL
// в памяти изолята (тот же принцип, что и кэш access-токена в googleAuth.js) — не ходить в
// сеть на каждую проверку токена, но и не держать ключи вечно, если Google их когда-нибудь
// ротирует раньше срока.
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let cachedJwks = null;
let cachedJwksAt = 0;
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

async function getFirebaseJwks() {
  const now = Date.now();
  if (cachedJwks && now - cachedJwksAt < JWKS_TTL_MS) return cachedJwks;
  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) throw new Error(`Firebase JWKS fetch failed: ${res.status}`);
  const json = await res.json();
  cachedJwks = json.keys || [];
  cachedJwksAt = now;
  return cachedJwks;
}

// Проверка Firebase ID-токена без Admin SDK — тот же принцип верификации, что описан в
// документации Firebase ("Verify ID tokens using a third-party JWT library"): подпись RS256
// сверяется с публичным ключом Google по kid из заголовка, плюс стандартные claims (iss/aud/
// exp/iat/sub). Возвращает uid (claims.sub) при успехе, иначе бросает исключение — вызывающий
// код (см. index.js) отвечает 401, не пытаясь угадать, что имелось в виду.
export async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecodeToString(headerB64));
  const claims = JSON.parse(base64UrlDecodeToString(payloadB64));
  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`);

  const jwks = await getFirebaseJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('no matching JWKS key (kid not found)');
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64UrlDecode(signatureB64), new TextEncoder().encode(signingInput)
  );
  if (!valid) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new Error('token expired');
  if (claims.iat > now + 60) throw new Error('token issued in the future');
  if (claims.aud !== projectId) throw new Error('bad audience');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('bad issuer');
  if (!claims.sub) throw new Error('missing sub (uid)');
  return claims.sub;
}
