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
