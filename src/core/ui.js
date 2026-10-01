/** Мелкие утилиты интерфейса: DOM, тосты, модалки, тема. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, ms = 350) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function qs(name, fallback = '') {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

/* ------------------------------------------------------------------ тосты */

function toastStack() {
  let stack = $('.toast-stack');
  if (!stack) {
    // role=status + aria-live: скринридер проговаривает уведомления,
    // не перебивая текущее чтение страницы.
    stack = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(stack);
  }
  return stack;
}

export function toast(message, type = 'info', ms = 3600) {
  const node = el('div', { class: `toast toast-${type}` }, message);
  toastStack().append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}

/* ---------------------------------------------------------------- модалки */

/**
 * openModal({ title, body, actions, size })
 * body — Node или HTML-строка; actions — массив { label, kind, onClick, close }.
 * Возвращает объект с close() и ссылкой на .modal.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal({ title, body, actions = [], size = '', onClose } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', {
    class: `modal ${size}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Диалог',
    tabindex: '-1',
  });

  const previouslyFocused = document.activeElement;

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    if (onClose) onClose();
  };

  // Ловушка фокуса: Tab не уводит за пределы диалога, Escape закрывает.
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;

    const items = $$(FOCUSABLE, modal).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  modal.append(el('div', { class: 'modal-head' },
    el('h3', { text: title || '' }),
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: close }, '✕'),
  ));

  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.append(body);
  modal.append(bodyNode);

  if (actions.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const action of actions) {
      foot.append(el('button', {
        class: `btn ${action.kind || ''}`,
        type: 'button',
        onclick: async (e) => {
          if (action.onClick) {
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await action.onClick(close, modal); } finally { btn.disabled = false; }
          }
          if (action.close !== false && !action.onClick) close();
        },
      }, action.label));
    }
    modal.append(foot);
  }

  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';

  // Фокус переносится внутрь диалога: на первое поле ввода, иначе на сам диалог.
  const firstField = modal.querySelector('input, textarea, select') || modal.querySelector(FOCUSABLE);
  (firstField || modal).focus();

  return { close, modal, body: bodyNode };
}

export function confirmDialog(message, { title = 'Подтверждение', okLabel = 'Удалить', danger = true } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const ref = openModal({
      title,
      body: el('p', { class: 'mb-0', text: message }),
      onClose: () => { if (!decided) resolve(false); },
      actions: [
        { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => { decided = true; close(); resolve(false); } },
        { label: okLabel, kind: danger ? 'btn-danger' : 'btn-primary', onClick: (close) => { decided = true; close(); resolve(true); } },
      ],
    });
    return ref;
  });
}

/* ------------------------------------------------------------------- тема */

const THEME_KEY = 'jobhub:theme';

export function applyTheme(theme) {
  const value = theme || localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem(THEME_KEY, value); } catch (_) {}
  return value;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  return applyTheme(next);
}

/* --------------------------------------------------------------- скелетон */

export function skeletons(container, count = 4) {
  container.innerHTML = '';
  for (let i = 0; i < count; i += 1) container.append(el('div', { class: 'skeleton' }));
}

export function emptyState(container, icon, title, hint) {
  container.innerHTML = '';
  container.append(el('div', { class: 'empty' },
    el('div', { class: 'empty-icon', text: icon }),
    el('div', { style: 'font-weight:600;color:var(--text)', text: title }),
    hint ? el('div', { class: 'faint mt-8', text: hint }) : null,
  ));
}

/** Кнопка загрузки, которая сама показывает состояние ожидания. */
export async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
