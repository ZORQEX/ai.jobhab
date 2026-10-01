/**
 * Точка входа в слой данных.
 *
 * Возвращает один из двух адаптеров с одинаковым контрактом:
 *  • firebase-backend.js — если в config.js заданы реальные ключи;
 *  • demo-backend.js     — иначе (или если Firebase не поднялся).
 *
 * Благодаря этому страницы приложения не содержат ни одного прямого вызова
 * Firestore: логика представления и логика хранения разделены.
 */

import { shouldUseFirebase } from '../config.js';

let instance = null;
let pending = null;

async function create() {
  if (shouldUseFirebase()) {
    try {
      const { firebaseBackend } = await import('./firebase-backend.js');
      const backend = await firebaseBackend.init();
      console.info('[jobhub] режим данных: Firebase');
      return backend;
    } catch (error) {
      console.error('[jobhub] Firebase не поднялся, откатываюсь в демо-режим', error);
    }
  }
  const { demoBackend } = await import('./demo-backend.js');
  const backend = await demoBackend.init();
  console.info('[jobhub] режим данных: демо (localStorage)');
  return backend;
}

export function getBackend() {
  if (instance) return Promise.resolve(instance);
  if (!pending) {
    pending = create().then((backend) => {
      instance = backend;
      return backend;
    });
  }
  return pending;
}
