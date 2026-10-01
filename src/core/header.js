/** Общая шапка сайта: навигация, тема, счётчик сохранённых, меню пользователя. */

import { $, el, openModal, toast, toggleTheme } from './ui.js';
import { avatarEl } from './components.js';
import { saveFirebaseConfig, clearFirebaseConfig, isFirebaseConfigured } from '../config.js';

const NAV = [
  { href: 'index.html', label: 'Вакансии', key: 'catalog' },
  { href: 'saved.html', label: 'Сохранённые', key: 'saved', auth: true },
  { href: 'profile.html', label: 'Кабинет', key: 'profile', auth: true },
  { href: 'admin.html', label: 'Админ-панель', key: 'admin', admin: true },
];

let savedUnsub = null;
let savedCount = 0;

export function renderHeader({ backend, user, active }) {
  const host = $('#app-header');
  if (!host) return;

  const isAdmin = user?.role === 'admin';

  const nav = el('nav', { class: 'main-nav', id: 'main-nav' },
    NAV.filter((item) => (!item.auth || user) && (!item.admin || isAdmin))
      .map((item) => el('a', {
        href: item.href,
        class: item.key === active ? 'active' : '',
      }, item.label)),
  );

  const actions = el('div', { class: 'header-actions' });

  if (backend?.mode === 'demo') {
    actions.append(el('button', {
      class: 'chip chip-warning chip-btn',
      type: 'button',
      title: 'Данные хранятся в браузере. Нажмите, чтобы подключить настоящий Firebase',
      onclick: () => openFirebaseModal(),
    }, 'Демо-режим'));
  } else {
    actions.append(el('span', { class: 'chip chip-success', title: 'Данные приходят из Firestore' }, 'Firebase'));
  }

  actions.append(el('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Сменить тему',
    'aria-label': 'Сменить тему оформления',
    onclick: (e) => {
      const theme = toggleTheme();
      e.currentTarget.textContent = theme === 'light' ? '☾' : '☀';
      // Выбор темы — часть настроек профиля, поэтому переживает смену браузера.
      if (user) {
        backend.updateProfile(user.uid, { settings: { ...(user.settings || {}), theme } })
          .catch(() => { /* тема уже применена локально, ошибка не критична */ });
      }
    },
  }, document.documentElement.dataset.theme === 'light' ? '☾' : '☀'));

  if (user) {
    const savedBtn = el('a', {
      href: 'saved.html',
      class: 'icon-btn with-badge',
      title: 'Сохранённые вакансии',
      id: 'saved-indicator',
    }, '★');
    actions.append(savedBtn);

    actions.append(el('button', {
      class: 'btn btn-sm',
      type: 'button',
      onclick: (e) => openUserMenu(e.currentTarget, backend, user),
    },
      avatarEl(user, 20),
      el('span', { class: 'nowrap' }, (user.displayName || '').split(' ')[0] || 'Профиль'),
    ));

    subscribeSaved(backend, user);
  } else {
    actions.append(el('a', { class: 'btn btn-sm', href: 'auth.html' }, 'Войти'));
    actions.append(el('a', { class: 'btn btn-sm btn-primary', href: 'auth.html?mode=register' }, 'Регистрация'));
  }

  const burger = el('button', {
    class: 'icon-btn burger',
    type: 'button',
    'aria-label': 'Меню',
    onclick: () => nav.classList.toggle('open'),
  }, '☰');

  host.innerHTML = '';
  host.className = 'site-header';
  host.append(el('div', { class: 'container' },
    el('a', { class: 'logo', href: 'index.html' },
      el('span', { class: 'logo-mark' }, 'AI'),
      el('span', {}, 'JobHub'),
    ),
    nav,
    actions,
    burger,
  ));

  updateSavedBadge();
}

function subscribeSaved(backend, user) {
  if (savedUnsub) savedUnsub();
  savedUnsub = backend.watchSaved(user.uid, (items) => {
    savedCount = items.length;
    updateSavedBadge();
  });
}

function updateSavedBadge() {
  const host = $('#saved-indicator');
  if (!host) return;
  host.querySelector('.badge-count')?.remove();
  if (savedCount > 0) host.append(el('span', { class: 'badge-count' }, String(savedCount)));
}

function openUserMenu(anchor, backend, user) {
  openModal({
    title: user.displayName || 'Профиль',
    body: el('div', {},
      el('p', { class: 'muted', style: 'margin-bottom:14px' }, user.email),
      el('div', { class: 'row', style: 'margin-bottom:16px' },
        el('span', { class: `chip ${user.role === 'admin' ? 'chip-accent' : ''}` }, user.role === 'admin' ? 'Администратор' : 'Пользователь'),
        user.city ? el('span', { class: 'chip' }, user.city) : null,
      ),
      el('div', { class: 'row' },
        el('a', { class: 'btn btn-sm', href: 'profile.html' }, 'Личный кабинет'),
        el('a', { class: 'btn btn-sm', href: 'saved.html' }, 'Сохранённые'),
        user.role === 'admin' ? el('a', { class: 'btn btn-sm', href: 'admin.html' }, 'Админ-панель') : null,
      ),
    ),
    actions: [
      { label: 'Выйти', kind: 'btn-danger', onClick: async (close) => {
        await backend.logout();
        close();
        toast('Вы вышли из аккаунта', 'info');
        if (/profile|saved|admin/.test(location.pathname)) location.href = 'index.html';
      } },
    ],
  });
}

/* ------------------------------------------- подключение реального Firebase */

function parseFirebaseConfig(text) {
  const result = {};
  const keys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];
  for (const key of keys) {
    const match = text.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`));
    if (match) result[key] = match[1];
  }
  if (!result.apiKey || !result.projectId) {
    throw new Error('Не нашёл apiKey и projectId. Скопируйте объект firebaseConfig целиком.');
  }
  return result;
}

export function openFirebaseModal() {
  const textarea = el('textarea', {
    class: 'textarea',
    rows: '9',
    placeholder: `const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "my-app.firebaseapp.com",
  projectId: "my-app",
  storageBucket: "my-app.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234:web:abcd"
};`,
  });

  openModal({
    title: 'Подключить Firebase',
    size: 'modal-lg',
    body: el('div', {},
      el('p', { class: 'muted' },
        'Сейчас приложение работает на localStorage. Чтобы переключиться на настоящий Firestore, вставьте объект firebaseConfig из Firebase Console → Настройки проекта → Ваши приложения → Web.'),
      el('p', { class: 'faint' },
        'В самом проекте Firebase нужно включить Authentication → Email/Password и создать базу Cloud Firestore, затем залить правила из firestore.rules.'),
      textarea,
      el('p', { class: 'faint mt-8' },
        'Конфиг сохранится в localStorage этого браузера. Ключи веб-SDK не секретны — доступ ограничивают правила безопасности.'),
    ),
    actions: [
      isFirebaseConfigured()
        ? { label: 'Отключить', kind: 'btn-danger', onClick: (close) => { clearFirebaseConfig(); close(); location.reload(); } }
        : null,
      { label: 'Сохранить и перезагрузить', kind: 'btn-primary', onClick: (close) => {
        try {
          const config = parseFirebaseConfig(textarea.value);
          saveFirebaseConfig(config);
          close();
          location.reload();
        } catch (error) {
          toast(error.message, 'error');
        }
      } },
    ].filter(Boolean),
  });
}
