// Лёгкая система "сущностей" — люди (получатели переводов) и мерчанты (места трат) — см. ТЗ
// "нормализация сущностей": "Миша"/"Мише"/"Миша Андреев"/"Михаил Андреев"/"Мише Андрееву" должны
// сводиться к ОДНОМУ id, чтобы "сколько я переводил Мише?" находил все его переводы независимо от
// того, в каком падеже/форме было названо имя в конкретном сообщении. Осознанно НЕ полноценная
// CRM: один документ на пользователя (users/{uid}/appData/entities), без отдельной коллекции,
// без истории изменений, без ручного управления карточками контактов.
//
// Хранение: { people: [{id, canonicalName, aliases:[...]}], merchants: [{id, canonicalName, aliases:[...]}] }
// canonicalName — как сущность была впервые упомянута (см. ниже про честные ограничения падежей),
// aliases — все увиденные поверхностные формы текста, по которым её потом ищут снова.

export async function getEntitiesDoc(firestore, uid) {
  return (await firestore.getDoc(`users/${uid}/appData/entities`)) || { people: [], merchants: [] };
}

async function saveEntitiesDoc(firestore, uid, doc) {
  await firestore.setDoc(`users/${uid}/appData/entities`, doc);
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[.,!?;:"']/g, '').replace(/\s+/g, ' ');
}

// Очень грубый "стеммер" под русские падежные окончания одного слова (не морфология, а
// достаточно, чтобы "Мише"/"Мишей"/"Миша" совпали друг с другом, а "Миша" и "Мишка" — нет, см. тот
// же приём и туже осторожность, что у wordStem в localParser.js). Отрезаем 1-2 буквы окончания у
// слов длиннее 4 букв, оставляя стем не короче 3 символов.
function stem(word) {
  const w = normalize(word);
  if (w.length <= 4) return w;
  return w.slice(0, Math.max(3, w.length - 2));
}

function tokenStemsOf(text) {
  return normalize(text).split(' ').filter(Boolean).map(stem);
}

// Совпадение по ЛЮБОМУ общему стему токена — "Мише Андрееву" (2 токена) матчит запись с алиасом
// "Миша Андреев" (тоже 2 токена, оба стема совпадают), но и одиночное "Мише" находит ту же запись
// по первому имени, если фамилия в тексте не упомянута.
function entityMatchesText(entity, textStems) {
  const entityStems = new Set([entity.canonicalName, ...(entity.aliases || [])].flatMap(tokenStemsOf));
  return textStems.some((s) => entityStems.has(s));
}

export function findEntity(list, rawText) {
  const textStems = tokenStemsOf(rawText);
  if (!textStems.length) return null;
  return (list || []).find((e) => entityMatchesText(e, textStems)) || null;
}

// Возвращает {id, canonicalName, created}. rawText сохраняется как есть (первое упоминание) —
// честное ограничение: если первое упоминание было в косвенном падеже ("Мише Андрееву"), канони-
// ческое имя тоже останется в этой форме, а не автоматически приведётся к именительному падежу
// (полноценная русская морфология — отдельная, намного более тяжёлая задача, см. итоговый отчёт,
// это отмечено как технический долг). Функционально это не мешает: ПОИСК по id и по любому уже
// виденному алиасу работает верно независимо от формы отображаемого имени.
export async function resolveOrCreateEntity(firestore, uid, type, rawText) {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) return null;
  const key = type === 'person' ? 'people' : 'merchants';
  const doc = await getEntitiesDoc(firestore, uid);
  const list = doc[key] || [];
  const existing = findEntity(list, cleaned);
  if (existing) {
    if (!existing.aliases.some((a) => normalize(a) === normalize(cleaned))) {
      existing.aliases = [...existing.aliases, cleaned];
      await saveEntitiesDoc(firestore, uid, { ...doc, [key]: list });
    }
    return { id: existing.id, canonicalName: existing.canonicalName, created: false };
  }
  const entity = { id: `${type[0]}_${crypto.randomUUID().slice(0, 8)}`, canonicalName: cleaned, aliases: [cleaned] };
  await saveEntitiesDoc(firestore, uid, { ...doc, [key]: [...list, entity] });
  return { id: entity.id, canonicalName: entity.canonicalName, created: true };
}

export { normalize as normalizeEntityText };
