/**
 * Конфигурация приложения.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * КАК ПОДКЛЮЧИТЬ СВОЙ FIREBASE
 * ────────────────────────────────────────────────────────────────────────────
 * Вариант A (навсегда, в коде): вставить значения из
 *   Firebase Console → Настройки проекта → Ваши приложения → Web
 * в объект FIREBASE_CONFIG ниже вместо строк "PASTE_...".
 *
 * Вариант B (без пересборки): открыть приложение и нажать «Подключить Firebase»
 * в шапке — конфиг сохранится в localStorage этого браузера и перекроет то,
 * что записано в коде.
 *
 * Пока конфиг не задан, приложение работает в ДЕМО-РЕЖИМЕ: тот же интерфейс
 * и тот же контракт слоя данных, но хранилище — localStorage браузера.
 * Ключи Firebase Web SDK не являются секретом: доступ ограничивают
 * правила безопасности (см. firestore.rules), а не сокрытие ключа.
 */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA1Upfmrt63CAm9TFGtL_RqoCzCM6F539g',
  authDomain: 'ai-jobhub.firebaseapp.com',
  projectId: 'ai-jobhub',
  storageBucket: 'ai-jobhub.firebasestorage.app',
  messagingSenderId: '1095629691073',
  appId: '1:1095629691073:web:410f5a9ab2167248189c40',
};

const OVERRIDE_KEY = 'jobhub:firebase-config';

/** Конфиг из localStorage (вариант B) имеет приоритет над кодом. */
export function getFirebaseConfig() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.projectId && parsed.apiKey) return parsed;
    }
  } catch (_) { /* приватный режим браузера — молча игнорируем */ }
  return FIREBASE_CONFIG;
}

export function saveFirebaseConfig(config) {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(config));
}

export function clearFirebaseConfig() {
  localStorage.removeItem(OVERRIDE_KEY);
}

/** true — если ключи реальные, а не плейсхолдеры. */
export function isFirebaseConfigured() {
  const c = getFirebaseConfig();
  return Boolean(
    c.apiKey && c.projectId &&
    !String(c.apiKey).startsWith('PASTE') &&
    !String(c.projectId).startsWith('PASTE'),
  );
}

/**
 * Принудительный демо-режим: ?demo=1 в адресе страницы.
 * Нужен для трёх вещей — показать приложение без сети, прогнать автотесты
 * интерфейса и не расходовать квоту Firestore во время отладки вёрстки.
 * Флаг живёт в sessionStorage, поэтому переходы по страницам его не теряют.
 */
const FORCE_DEMO_KEY = 'jobhub:force-demo';

(function readDemoFlag() {
  try {
    const value = new URLSearchParams(location.search).get('demo');
    if (value === null) return;
    if (value === '0' || value === 'false') sessionStorage.removeItem(FORCE_DEMO_KEY);
    else sessionStorage.setItem(FORCE_DEMO_KEY, '1');
  } catch (_) { /* приватный режим браузера */ }
}());

export function isDemoForced() {
  try {
    return sessionStorage.getItem(FORCE_DEMO_KEY) === '1';
  } catch (_) {
    return false;
  }
}

/** Итоговое решение, какой адаптер данных поднимать. */
export function shouldUseFirebase() {
  return isFirebaseConfigured() && !isDemoForced();
}

export const APP = {
  name: 'AI JobHub',
  pageSize: 12,          // элементов на странице каталога
  similarPageSize: 4,    // похожих вакансий за раз
  reviewsPageSize: 5,
  adminPageSize: 15,
  firebaseSdk: 'https://www.gstatic.com/firebasejs/10.14.1',
};

/** Справочники предметной области — используются в фильтрах, формах и админке. */
export const DICT = {
  categories: {
    frontend: 'Frontend',
    backend: 'Backend',
    mobile: 'Mobile',
    ai: 'AI / ML',
    data: 'Data',
    devops: 'DevOps',
    qa: 'QA',
    design: 'Design',
    pm: 'Продукт и проекты',
    marketing: 'Маркетинг',
  },
  levels: {
    intern: 'Стажёр',
    junior: 'Junior',
    middle: 'Middle',
    senior: 'Senior',
    lead: 'Lead',
  },
  levelOrder: ['intern', 'junior', 'middle', 'senior', 'lead'],
  employment: {
    full: 'Полная занятость',
    part: 'Частичная занятость',
    project: 'Проектная работа',
    internship: 'Стажировка',
  },
  cities: ['Алматы', 'Астана', 'Шымкент', 'Караганда', 'Актобе', 'Удалённо'],
  jobStatus: {
    open: 'Открыта',
    closed: 'Закрыта',
    draft: 'Черновик',
  },
  applicationStatus: {
    sent: 'Отправлен',
    viewed: 'Просмотрен',
    interview: 'Собеседование',
    offer: 'Оффер',
    rejected: 'Отказ',
    withdrawn: 'Отозван',
  },
  applicationStatusTone: {
    sent: 'chip-accent',
    viewed: 'chip',
    interview: 'chip-warning',
    offer: 'chip-success',
    rejected: 'chip-danger',
    withdrawn: 'chip',
  },
};
