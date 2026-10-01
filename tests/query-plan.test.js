/**
 * Тесты планировщика запросов каталога (node --test).
 *
 * planJobQuery решает, что посчитает Firestore, а что доуточнит клиент.
 * Это решение напрямую определяет список составных индексов, поэтому здесь же
 * проверяется, что на КАЖДОЕ сочетание, которое умеет построить интерфейс,
 * в firestore.indexes.json есть индекс. Иначе фильтр в проде отвечает
 * FAILED_PRECONDITION и каталог выглядит пустым.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// firebase-backend рассчитан на браузер; для импорта достаточно заглушек.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { planJobQuery } = await import('../src/data/firebase-backend.js');

const INDEXES = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));

/* ------------------------------------------------------------ план запроса */

test('без параметров: только открытые вакансии по дате, дофильтровки нет', () => {
  const plan = planJobQuery({});
  assert.equal(plan.status, 'open');
  assert.equal(plan.serverFilter, null);
  assert.deepEqual(plan.clientFilters, []);
  assert.deepEqual(plan.order, { field: 'createdAt', direction: 'desc' });
  assert.equal(plan.refines, false);
});

test('один фильтр уходит в запрос и клиенту делать нечего', () => {
  const plan = planJobQuery({ city: 'Алматы' });
  assert.deepEqual(plan.serverFilter, { field: 'city', value: 'Алматы' });
  assert.deepEqual(plan.clientFilters, []);
  assert.equal(plan.refines, false);
});

test('из нескольких фильтров в запрос уходит самый избирательный', () => {
  const plan = planJobQuery({ remote: true, level: 'senior', category: 'backend' });
  assert.deepEqual(plan.serverFilter, { field: 'category', value: 'backend' });
  assert.deepEqual(plan.clientFilters.map((f) => f.field), ['level', 'remote']);
  assert.equal(plan.refines, true);
});

test('при поиске место серверного фильтра занимает токен', () => {
  const plan = planJobQuery({ q: 'react hooks', city: 'Астана' });
  assert.equal(plan.serverFilter, null);
  assert.equal(plan.tokens[0], 'react');
  assert.deepEqual(plan.clientFilters.map((f) => f.field), ['city']);
  assert.equal(plan.refines, true);
});

test('«зарплата от» переключает сортировку на зарплату — иначе Firestore откажет', () => {
  const plan = planJobQuery({ minSalary: 700000, sort: 'date' });
  assert.deepEqual(plan.range, { field: 'salaryMax', op: '>=', value: 700000 });
  assert.equal(plan.order.field, 'salaryMax');
});

test('«зарплата от» вместе с сортировкой по возрастанию не меняет поле диапазона', () => {
  const plan = planJobQuery({ minSalary: 500000, sort: 'salaryAsc' });
  assert.equal(plan.range.field, 'salaryMax');
  assert.deepEqual(plan.order, { field: 'salaryMax', direction: 'asc' });
});

test('сортировки соответствуют пунктам интерфейса', () => {
  assert.deepEqual(planJobQuery({ sort: 'salaryDesc' }).order, { field: 'salaryMax', direction: 'desc' });
  assert.deepEqual(planJobQuery({ sort: 'salaryAsc' }).order, { field: 'salaryMin', direction: 'asc' });
  assert.deepEqual(planJobQuery({ sort: 'popular' }).order, { field: 'applicationsCount', direction: 'desc' });
  assert.deepEqual(planJobQuery({ sort: 'date' }).order, { field: 'createdAt', direction: 'desc' });
});

test('админка может запросить любой статус, включая черновики', () => {
  assert.equal(planJobQuery({ includeAllStatuses: true }).status, null);
  assert.equal(planJobQuery({ includeAllStatuses: true, status: 'draft' }).status, 'draft');
});

/* --------------------------------------------- покрытие составными индексами */

const dir = (d) => (d === 'asc' ? 'ASCENDING' : 'DESCENDING');

/**
 * Есть ли в firestore.indexes.json индекс под этот план.
 *
 * Правило подбора у Firestore такое: поля равенства образуют префикс индекса
 * (порядок внутри префикса не важен — сам Firestore в подсказках расставляет
 * их по алфавиту), а поле сортировки идёт последним и с тем же направлением.
 * Поэтому сравниваем префикс как множество, а хвост — позиционно.
 */
function hasIndexFor(plan) {
  const equality = [];
  if (plan.status) equality.push('status:ASCENDING');
  if (plan.serverFilter) equality.push(`${plan.serverFilter.field}:ASCENDING`);
  if (plan.tokens.length) equality.push('searchTokens:CONTAINS');
  const sortKey = `${plan.order.field}:${dir(plan.order.direction)}`;

  // Сортировка по одному полю без фильтров обслуживается автоматически.
  if (equality.length === 0) return true;

  return INDEXES.indexes.some((index) => {
    if (index.collectionGroup !== 'jobs') return false;
    if (index.fields.length !== equality.length + 1) return false;

    const keys = index.fields.map((f) => `${f.fieldPath}:${f.order || f.arrayConfig}`);
    if (keys[keys.length - 1] !== sortKey) return false;

    const prefix = keys.slice(0, -1).sort();
    return JSON.stringify(prefix) === JSON.stringify([...equality].sort());
  });
}

test('каждое сочетание фильтров и сортировок интерфейса покрыто индексом', () => {
  const filters = [
    {},
    { category: 'frontend' },
    { city: 'Алматы' },
    { level: 'middle' },
    { employment: 'full' },
    { remote: true },
    // Комбинации: лишние условия уходят на клиент, индекс тот же.
    { category: 'backend', city: 'Астана' },
    { category: 'data', city: 'Шымкент', level: 'senior', employment: 'part', remote: true },
  ];
  const sorts = ['date', 'salaryDesc', 'salaryAsc', 'popular'];
  const searches = ['', 'react', 'react senior remote'];
  const salaries = [0, 700000];

  const missing = [];
  for (const filter of filters) {
    for (const sort of sorts) {
      for (const q of searches) {
        for (const minSalary of salaries) {
          const params = { ...filter, sort, q, minSalary };
          const plan = planJobQuery(params);
          if (!hasIndexFor(plan)) {
            missing.push(JSON.stringify({
              status: plan.status,
              filter: plan.serverFilter?.field ?? null,
              token: plan.tokens[0] ?? null,
              order: `${plan.order.field} ${plan.order.direction}`,
            }));
          }
        }
      }
    }
  }

  const unique = [...new Set(missing)];
  assert.deepEqual(unique, [], `нет индекса под сочетания:\n${unique.join('\n')}`);
});

test('индексов меньше лимита Firestore (200 на базу)', () => {
  assert.ok(INDEXES.indexes.length < 200, `объявлено ${INDEXES.indexes.length} индексов`);
});

test('похожие вакансии и админские выборки тоже покрыты', () => {
  // listSimilar: status + category + createdAt desc
  assert.ok(hasIndexFor(planJobQuery({ category: 'frontend' })));
  // Админка: конкретный статус + дата
  assert.ok(hasIndexFor(planJobQuery({ includeAllStatuses: true, status: 'draft' })));
});
