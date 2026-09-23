// Минимальный клиент Firestore REST API — замена Admin SDK, которого нет в Cloudflare
// Workers. Работает с тем же проектом (dnaa-a8ca3) и той же коллекцией users/{uid}/appData/*,
// что и клиентский Firebase SDK в index.html — форматы документов совместимы 1:1.
import { getFirestoreAccessToken } from './googleAuth.js';

const BASE = 'https://firestore.googleapis.com/v1';

function docUrl(projectId, path) {
  return `${BASE}/projects/${projectId}/databases/(default)/documents/${path}`;
}

// --- Конвертация между обычными JS-значениями и типизированным форматом Firestore REST ---

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  throw new Error(`Unsupported value type for Firestore: ${typeof value}`);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) fields[key] = toFirestoreValue(val);
  return fields;
}

function fromFirestoreValue(value) {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [key, val] of Object.entries(fields)) obj[key] = fromFirestoreValue(val);
  return obj;
}

// --- Публичный API ---

export function createFirestoreClient(projectId, clientEmail, privateKeyPem) {
  async function authHeaders() {
    const token = await getFirestoreAccessToken(clientEmail, privateKeyPem);
    return { authorization: `Bearer ${token}` };
  }

  async function getDoc(path) {
    const res = await fetch(docUrl(projectId, path), { headers: await authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore getDoc(${path}) failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return fromFirestoreFields(json.fields || {});
  }

  // Полная замена документа (как Admin SDK .set(data) без merge) — ровно то, что нужно для
  // полного снапшота привычек, который шлёт клиент.
  async function setDoc(path, data) {
    const res = await fetch(docUrl(projectId, path), {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore setDoc(${path}) failed: ${res.status} ${await res.text()}`);
  }

  // Мердж отдельных полей (как Admin SDK .set(data, {merge:true})) — нужен для
  // markHabitDone (трогаем только один ключ-дату) и для апдейта профиля пользователя.
  async function mergeDoc(path, data) {
    const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const res = await fetch(`${docUrl(projectId, path)}?${mask}`, {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore mergeDoc(${path}) failed: ${res.status} ${await res.text()}`);
  }

  async function deleteDoc(path) {
    const res = await fetch(docUrl(projectId, path), { method: 'DELETE', headers: await authHeaders() });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Firestore deleteDoc(${path}) failed: ${res.status} ${await res.text()}`);
    }
  }

  // Список документов коллекции верхнего уровня (используется для перебора всех users при
  // рассылке напоминаний). pageSize подобран с запасом — пользователей у личного проекта мало.
  async function listCollection(collectionPath, pageSize = 300) {
    const docs = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`${docUrl(projectId, collectionPath)}?${params}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Firestore listCollection(${collectionPath}) failed: ${res.status} ${await res.text()}`);
      const json = await res.json();
      for (const d of json.documents || []) {
        const id = d.name.split('/').pop();
        docs.push({ id, data: fromFirestoreFields(d.fields || {}) });
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return docs;
  }

  return { getDoc, setDoc, mergeDoc, deleteDoc, listCollection };
}
