/**
 * Единый запуск страницы: тема → слой данных → состояние авторизации → шапка.
 * Здесь же живут гварды доступа (авторизация и роль admin).
 */

import { getBackend } from '../data/backend.js';
import { renderHeader } from './header.js';
import { applyTheme, el, $ } from './ui.js';

const userListeners = new Set();

/** Подписка на изменение текущего пользователя (логин, выход, правка профиля). */
export function onUser(cb) {
  userListeners.add(cb);
  return () => userListeners.delete(cb);
}

function currentPageUrl() {
  return location.pathname.split('/').pop() + location.search;
}

function denyAccess(message) {
  const main = $('#app-main') || document.body;
  main.innerHTML = '';
  main.append(el('div', { class: 'container page' },
    el('div', { class: 'card center', style: 'max-width:520px;margin:40px auto' },
      el('div', { class: 'empty-icon', style: 'font-size:36px' }, '🔒'),
      el('h2', {}, 'Доступ запрещён'),
      el('p', { class: 'muted' }, message),
      el('a', { class: 'btn btn-primary', href: 'index.html' }, 'На главную'),
    ),
  ));
}

/**
 * @param {{active?:string, requireAuth?:boolean, requireAdmin?:boolean}} options
 * @returns {Promise<{backend:object, user:object|null}>} резолвится один раз
 */
export function bootstrap({ active = '', requireAuth = false, requireAdmin = false } = {}) {
  applyTheme();

  return getBackend().then((backend) => new Promise((resolve) => {
    let settled = false;

    backend.onAuthChange((user) => {
      renderHeader({ backend, user, active });

      if (!settled) {
        settled = true;

        // Тема из профиля применяется один раз при входе: дальше человек
        // может переключать её кнопкой, и мы не перетираем его выбор.
        if (user?.settings?.theme) {
          applyTheme(user.settings.theme);
          renderHeader({ backend, user, active });
        }

        if ((requireAuth || requireAdmin) && !user) {
          location.replace(`auth.html?next=${encodeURIComponent(currentPageUrl())}`);
          return;
        }
        if (requireAdmin && user?.role !== 'admin') {
          denyAccess('Раздел доступен только пользователям с ролью admin.');
          return;
        }
        resolve({ backend, user });
        return;
      }

      // Последующие изменения: разлогин на защищённой странице уводит на вход.
      if ((requireAuth || requireAdmin) && !user) {
        location.replace(`auth.html?next=${encodeURIComponent(currentPageUrl())}`);
        return;
      }
      userListeners.forEach((cb) => cb(user));
    });
  }));
}
