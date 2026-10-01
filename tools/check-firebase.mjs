/**
 * Диагностика живого Firebase-проекта.
 *
 * Запуск: npm run check:firebase
 *
 * Скрипт не требует ни браузера, ни firebase login: он берёт тот же конфиг и
 * тот же планировщик запросов, что и приложение (planJobQuery), и от лица
 * НЕАВТОРИЗОВАННОГО гостя прогоняет по проекту все сочетания фильтров и
 * сортировок каталога. Для каждого видно одно из трёх:
 *
 *   ✔ запрос прошёл              — правила пускают, индекс есть;
 *   ✖ НЕТ ИНДЕКСА                — FAILED_PRECONDITION, нужен deploy индексов;
 *   ✖ ЗАПРЕЩЕНО ПРАВИЛАМИ        — permission-denied.
 *
 * Дополнительно проверяется: включён ли вход по email/паролю, создан ли бакет
 * Storage, сколько в базе открытых вакансий и отзывов.
 */

import { readFileSync } from 'node:fs';

/* Заглушки браузерных API — модули приложения рассчитаны на браузер. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { getFirebaseConfig } = await import('../src/config.js');
const { planJobQuery } = await import('../src/data/firebase-backend.js');

const { initializeApp } = await import('firebase/app');
const FS = await import('firebase/firestore');

const config = getFirebaseConfig();
const app = initializeApp(config);

// В node SDK по умолчанию открывает gRPC-стрим Listen, который на многих
// домашних сетях не поднимается (ENETUNREACH/ECONNRESET) и засыпает отчёт
// красными строками, хотя сами запросы проходят. Скрипту стримы не нужны —
// он делает разовые чтения, поэтому переключаемся на long polling.
const db = FS.initializeFirestore(app, { experimentalForceLongPolling: true });

// Уровень логов SDK: наши сообщения и так подробные, чужие предупреждения мешают.
FS.setLogLevel('error');

const ok = (m) => console.info(`  ✔ ${m}`);
const bad = (m) => console.info(`  ✖ ${m}`);
const head = (m) => console.info(`\n${m}`);

let failures = 0;

/* --------------------------------------------------- 1. Authentication */

head('1. Authentication — вход по email и паролю');
{
  // Заведомо несуществующий аккаунт: если провайдер выключен, ответ будет
  // OPERATION_NOT_ALLOWED, а не «неверные данные». Ничего не создаётся.
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'probe-not-a-real-user@example.invalid',
        password: 'probe-password',
        returnSecureToken: true,
      }),
    },
  );
  const json = await res.json();
  const message = json?.error?.message || '';
  if (message === 'OPERATION_NOT_ALLOWED') {
    bad('провайдер Email/Password ВЫКЛЮЧЕН — включите в Console → Authentication → Sign-in method');
    failures += 1;
  } else if (message.includes('INVALID_LOGIN_CREDENTIALS') || message.includes('EMAIL_NOT_FOUND')) {
    ok('провайдер Email/Password включён');
  } else {
    bad(`неожиданный ответ Identity Toolkit: ${message || res.status}`);
    failures += 1;
  }
}

/* --------------------------------------------------- 2. Firestore: запросы */

head('2. Firestore — запросы каталога от лица гостя');

/** Один запрос по плану приложения. */
async function runPlan(label, params) {
  const plan = planJobQuery(params);
  const c = [];
  if (plan.status) c.push(FS.where('status', '==', plan.status));
  if (plan.serverFilter) c.push(FS.where(plan.serverFilter.field, '==', plan.serverFilter.value));
  if (plan.tokens.length) c.push(FS.where('searchTokens', 'array-contains', plan.tokens[0]));
  if (plan.range) c.push(FS.where(plan.range.field, plan.range.op, plan.range.value));
  c.push(FS.orderBy(plan.order.field, plan.order.direction), FS.limit(1));

  try {
    await FS.getDocs(FS.query(FS.collection(db, 'jobs'), ...c));
    return { state: 'ok', label };
  } catch (error) {
    if (error?.code === 'failed-precondition') return { state: 'index', label, error };
    if (error?.code === 'permission-denied') return { state: 'denied', label };
    return { state: 'error', label, error };
  }
}

const FILTERS = [
  ['без фильтров', {}],
  ['направление', { category: 'frontend' }],
  ['город', { city: 'Алматы' }],
  ['грейд', { level: 'middle' }],
  ['занятость', { employment: 'full' }],
  ['удалёнка', { remote: true }],
  ['три фильтра сразу', { category: 'backend', city: 'Астана', level: 'senior' }],
];
const SORTS = [['по дате', 'date'], ['зарплата ↓', 'salaryDesc'], ['зарплата ↑', 'salaryAsc'], ['по откликам', 'popular']];

const results = [];
for (const [filterName, filter] of FILTERS) {
  for (const [sortName, sort] of SORTS) {
    results.push(await runPlan(`${filterName} + ${sortName}`, { ...filter, sort }));
  }
}
results.push(await runPlan('поиск «react» + по дате', { q: 'react', sort: 'date' }));
results.push(await runPlan('поиск «react senior» + зарплата ↓', { q: 'react senior', sort: 'salaryDesc' }));
results.push(await runPlan('зарплата от 700 000', { minSalary: 700000 }));
results.push(await runPlan('зарплата от 700 000 + город', { minSalary: 700000, city: 'Алматы' }));

const passed = results.filter((r) => r.state === 'ok');
const noIndex = results.filter((r) => r.state === 'index');
const denied = results.filter((r) => r.state === 'denied');
const errored = results.filter((r) => r.state === 'error');

ok(`прошло запросов: ${passed.length} из ${results.length}`);
if (noIndex.length) {
  bad(`нет индекса: ${noIndex.length}`);
  for (const r of noIndex) console.info(`      • ${r.label}`);
  const link = String(noIndex[0].error?.message || '').match(/https:\/\/\S+/);
  console.info('      Исправление: npm run deploy:rules (нужен firebase login)');
  if (link) console.info(`      Ручная ссылка на первый индекс: ${link[0]}`);
  failures += 1;
}
if (denied.length) {
  bad(`запрещено правилами: ${denied.length}`);
  for (const r of denied) console.info(`      • ${r.label}`);
  failures += 1;
}
if (errored.length) {
  bad(`прочие ошибки: ${errored.length}`);
  for (const r of errored) console.info(`      • ${r.label}: ${r.error?.code || r.error?.message}`);
  failures += 1;
}

/* --------------------------------------- 3. Firestore: правила «в минус» */

head('3. Firestore — то, что гостю НЕЛЬЗЯ');
async function mustFail(label, build) {
  try {
    await FS.getDocs(build());
    bad(`${label} — запрос ПРОШЁЛ, а должен был упасть`);
    failures += 1;
  } catch (error) {
    if (error?.code === 'permission-denied') ok(`${label} — закрыто правилами`);
    else bad(`${label} — упало с ${error?.code}, ожидалось permission-denied`);
  }
}
await mustFail('вакансии без фильтра по статусу (черновики)',
  () => FS.query(FS.collection(db, 'jobs'), FS.limit(1)));
await mustFail('чужие отклики с сопроводительными письмами',
  () => FS.query(FS.collection(db, 'applications'), FS.limit(1)));
await mustFail('профили пользователей',
  () => FS.query(FS.collection(db, 'users'), FS.limit(1)));
await mustFail('скрытые модератором отзывы',
  () => FS.query(FS.collection(db, 'reviews'), FS.limit(1)));

/* --------------------------------------------------- 4. Наполнение базы */

head('4. Данные в базе');
async function countOf(label, ...constraints) {
  try {
    const snap = await FS.getCountFromServer(FS.query(FS.collection(db, 'jobs'), ...constraints));
    return snap.data().count;
  } catch (error) {
    bad(`${label}: ${error?.code || error?.message}`);
    return null;
  }
}
const openJobs = await countOf('открытые вакансии', FS.where('status', '==', 'open'));
if (openJobs === 0) {
  bad('открытых вакансий: 0 — каталог будет пустым. Залейте тестовые данные:'
    + ' войдите в приложение, выдайте себе роль admin в Console, затем в админ-панели «Тестовые данные»');
  failures += 1;
} else if (openJobs !== null) {
  ok(`открытых вакансий: ${openJobs}`);
}

try {
  const reviews = await FS.getCountFromServer(
    FS.query(FS.collection(db, 'reviews'), FS.where('hidden', '==', false)),
  );
  ok(`видимых отзывов: ${reviews.data().count}`);
} catch (error) {
  bad(`отзывы: ${error?.code || error?.message}`);
}

/* --------------------------------------------------- 5. Storage */

head('5. Storage — бакет для аватаров и логотипов');
{
  const bucket = config.storageBucket;
  const res = await fetch(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o?maxResults=1`);
  if (res.status === 404) {
    bad(`бакет ${bucket} не создан — Console → Storage → «Начать», затем npm run deploy:rules`);
    failures += 1;
  } else if (res.ok || res.status === 403) {
    // 403 тоже годится: бакет есть, просто листинг закрыт правилами.
    ok(`бакет ${bucket} существует`);
  } else {
    bad(`неожиданный ответ Storage: ${res.status}`);
    failures += 1;
  }
}

/* --------------------------------------------------- 6. Локальные файлы */

head('6. Локальные файлы проекта');
{
  const indexes = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));
  ok(`объявлено индексов: ${indexes.indexes.length}, отключено автоиндексируемых полей: ${indexes.fieldOverrides.length}`);
}

head(failures ? `Итог: есть незакрытые пункты (${failures}). Смотрите ✖ выше.` : 'Итог: всё в порядке.');

// Закрываем соединение явно, иначе процесс висит на открытом канале Firestore.
await FS.terminate(db).catch(() => {});
process.exit(failures ? 1 : 0);
