/**
 * Тест контракта слоя данных (node --test).
 *
 * Главное архитектурное правило проекта: firebase-backend.js и demo-backend.js
 * реализуют ОДИН И ТОТ ЖЕ набор методов, потому что страницы не знают, с каким
 * из них работают. Нарушить это легко — добавил метод в один адаптер, забыл во
 * втором, и демо-режим падает на середине сценария. Тест сравнивает наборы
 * автоматически, чтобы это ловилось до браузера.
 *
 * Оба модуля рассчитаны на браузер, поэтому здесь минимальные заглушки window
 * и localStorage: они нужны только на момент импорта, никакие методы адаптеров
 * в этом тесте не вызываются.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------- заглушки браузерных API */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
// demo-backend подписывается на событие storage на уровне модуля.
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { demoBackend } = await import('../src/data/demo-backend.js');
const { firebaseBackend } = await import('../src/data/firebase-backend.js');

/**
 * Два метода намеренно существуют только в своём режиме, и админ-панель
 * выбирает нужный по `backend.mode`:
 *   • seedDatabase  — заливка тестовых данных в Firestore через writeBatch();
 *   • resetDemoData — сброс localStorage к исходному набору.
 * Смысла подделывать их во втором адаптере нет: «сбросить Firestore к
 * заводскому состоянию» — не та операция, которую стоит давать кнопкой.
 * Остальной контракт обязан совпадать полностью.
 */
const MODE_SPECIFIC = ['seedDatabase', 'resetDemoData'];

/** Только публичные методы: служебные поля вроде _profile не в контракте. */
function methodsOf(backend) {
  return Object.entries(backend)
    .filter(([name, value]) => typeof value === 'function' && !name.startsWith('_'))
    .map(([name]) => name)
    .filter((name) => !MODE_SPECIFIC.includes(name))
    .sort();
}

test('оба адаптера объявляют одинаковый набор методов', () => {
  const demo = methodsOf(demoBackend);
  const firebase = methodsOf(firebaseBackend);

  const onlyInFirebase = firebase.filter((m) => !demo.includes(m));
  const onlyInDemo = demo.filter((m) => !firebase.includes(m));

  assert.deepEqual(onlyInFirebase, [],
    `есть в firebase-backend, но нет в demo-backend: ${onlyInFirebase.join(', ')}`);
  assert.deepEqual(onlyInDemo, [],
    `есть в demo-backend, но нет в firebase-backend: ${onlyInDemo.join(', ')}`);
});

test('контракт включает обязательные по ТЗ операции', () => {
  const required = [
    'init', 'register', 'login', 'logout', 'resetPassword', 'onAuthChange', 'currentUser',
    'listJobs', 'watchFirstPage', 'getJob', 'listSimilar', 'incrementViews',
    'createJob', 'updateJob', 'deleteJob',
    'listReviews', 'addReview', 'updateReview', 'deleteReview',
    'listSaved', 'saveJob', 'unsaveJob', 'updateSavedNote',
    'applyToJob', 'hasApplied', 'withdrawApplication', 'setApplicationStatus',
    'listUsers', 'setUserRole', 'setUserDisabled', 'stats',
    'uploadAvatar', 'removeAvatar', 'uploadCompanyLogo', 'removeCompanyLogo',
  ];

  for (const backend of [demoBackend, firebaseBackend]) {
    const methods = methodsOf(backend);
    for (const name of required) {
      assert.ok(methods.includes(name), `метод ${name} отсутствует в адаптере`);
    }
  }
});

test('режим-специфичные методы есть ровно в своём адаптере', () => {
  // Если их перепутать, кнопка в админке вызовет отсутствующий метод.
  assert.equal(typeof firebaseBackend.seedDatabase, 'function');
  assert.equal(typeof demoBackend.seedDatabase, 'undefined');
  assert.equal(typeof demoBackend.resetDemoData, 'function');
  assert.equal(typeof firebaseBackend.resetDemoData, 'undefined');
});

test('у методов совпадает объявленное число аргументов', () => {
  // Расхождение в арности — обычно признак разного порядка параметров,
  // а значит и разного поведения при одинаковом вызове со страницы.
  const mismatched = methodsOf(demoBackend)
    .filter((name) => demoBackend[name].length !== firebaseBackend[name].length)
    .map((name) => `${name}: demo=${demoBackend[name].length}, firebase=${firebaseBackend[name].length}`);

  assert.deepEqual(mismatched, [], `разная арность методов:\n${mismatched.join('\n')}`);
});
