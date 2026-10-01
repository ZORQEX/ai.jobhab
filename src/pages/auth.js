/**
 * Вход, регистрация и восстановление пароля (auth.html).
 * Требование ТЗ 3.6. Сессия сохраняется средствами Firebase Auth
 * (browserLocalPersistence) либо localStorage в демо-режиме.
 */

import { bootstrap } from '../core/page.js';
import { $, $$, el, openModal, toast, qs } from '../core/ui.js';
import { SEED_USERS } from '../data/seed.js';

let backend = null;
let mode = 'login';

bootstrap({ active: 'auth' }).then((ctx) => {
  backend = ctx.backend;

  if (ctx.user) {
    location.replace(nextUrl());
    return;
  }

  mode = qs('mode') === 'register' ? 'register' : 'login';
  applyMode();
  bindTabs();
  bindForm();
  renderDemoAccounts();
});

function nextUrl() {
  const next = qs('next');
  return next && !next.startsWith('http') ? next : 'index.html';
}

function bindTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      applyMode();
    });
  }
}

function applyMode() {
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.mode === mode);

  const isRegister = mode === 'register';
  $('#name-field').hidden = !isRegister;
  $('#name').required = isRegister;
  $('#password').autocomplete = isRegister ? 'new-password' : 'current-password';
  $('#auth-title').textContent = isRegister ? 'Создание аккаунта' : 'Вход в аккаунт';
  $('#auth-subtitle').textContent = isRegister
    ? 'Регистрация занимает полминуты — потом сразу можно откликаться'
    : 'Отклики, сохранённые вакансии и AI-анализ доступны после входа';
  $('#submit-btn').textContent = isRegister ? 'Зарегистрироваться' : 'Войти';
  $('#switch-hint').textContent = isRegister ? 'Роль по умолчанию — user' : '';
  $('#auth-message').innerHTML = '';
}

function showError(message) {
  $('#auth-message').innerHTML = '';
  $('#auth-message').append(el('div', { class: 'form-error' }, message));
}

function bindForm() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    const name = $('#name').value.trim();

    if (!email || !password) return showError('Заполните почту и пароль');
    if (mode === 'register' && name.length < 2) return showError('Укажите имя — оно будет видно работодателю');
    if (password.length < 6) return showError('Пароль должен быть не короче 6 символов');

    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = mode === 'register' ? 'Создаю аккаунт…' : 'Вхожу…';

    try {
      if (mode === 'register') {
        await backend.register({ email, password, displayName: name });
        toast('Аккаунт создан. Заполните резюме, чтобы включить AI-подбор', 'success', 5000);
        location.href = 'profile.html#resume';
      } else {
        await backend.login(email, password);
        location.href = nextUrl();
      }
    } catch (error) {
      showError(error.message);
      btn.disabled = false;
      btn.textContent = mode === 'register' ? 'Зарегистрироваться' : 'Войти';
    }
  });

  $('#forgot-btn').addEventListener('click', openReset);
}

function openReset() {
  const input = el('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: $('#email').value });
  const note = el('div');

  openModal({
    title: 'Восстановление пароля',
    body: el('div', {},
      el('p', { class: 'muted' }, 'Укажите почту — на неё придёт письмо со ссылкой для смены пароля.'),
      input,
      note,
    ),
    actions: [
      { label: 'Отправить письмо', kind: 'btn-primary', onClick: async (close) => {
        try {
          await backend.resetPassword(input.value.trim());
          close();
          toast(backend.mode === 'demo'
            ? 'В демо-режиме письма не отправляются — с настоящим Firebase письмо придёт на почту'
            : 'Письмо отправлено. Проверьте почту и папку «Спам»', 'success', 6000);
        } catch (error) {
          note.innerHTML = '';
          note.append(el('div', { class: 'form-error mt-16' }, error.message));
        }
      } },
    ],
  });
}

/** Готовые аккаунты — чтобы проверяющий не регистрировался вручную. */
function renderDemoAccounts() {
  const host = $('#demo-accounts');
  if (backend.mode !== 'demo') {
    host.innerHTML = '';
    host.append(
      el('h3', {}, 'Проект подключён к Firebase'),
      el('p', { class: 'muted mb-0' },
        'Аккаунты создаются через Firebase Authentication. Первый администратор назначается вручную: в Firestore у документа users/{uid} поле role меняется на admin.'),
    );
    return;
  }

  host.innerHTML = '';
  host.append(el('h3', {}, 'Демо-аккаунты'));
  host.append(el('p', { class: 'faint' }, 'Один клик — и вы внутри, без регистрации.'));

  for (const account of SEED_USERS) {
    host.append(el('div', { class: 'row-between', style: 'padding:8px 0;border-top:1px solid var(--border-soft)' },
      el('div', {},
        el('div', { style: 'font-weight:600' }, account.role === 'admin' ? 'Администратор' : 'Соискатель'),
        el('div', { class: 'faint' }, `${account.email} · ${account.password}`),
      ),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await backend.login(account.email, account.password);
            location.href = account.role === 'admin' ? 'admin.html' : nextUrl();
          } catch (error) {
            toast(error.message, 'error');
            e.currentTarget.disabled = false;
          }
        },
      }, 'Войти'),
    ));
  }
}
