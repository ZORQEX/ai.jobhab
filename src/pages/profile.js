/**
 * Личный кабинет (profile.html).
 *
 * Требования ТЗ 3.3:
 *  • история откликов со статусами в реальном времени;
 *  • редактирование и удаление своих отзывов;
 *  • редактирование профиля и резюме — именно резюме кормит AI-подбор.
 */

import { bootstrap, onUser } from '../core/page.js';
import { $, $$, el, toast, confirmDialog, openModal, emptyState, skeletons, applyTheme } from '../core/ui.js';
import { DICT } from '../config.js';
import {
  salaryRange, dateTime, dateShort, timeAgo, stars, applicationStatusLabel,
} from '../core/format.js';
import { resumeOf, resumeCompleteness } from '../ai/match.js';
import { companyLogoEl, avatarEl } from '../core/components.js';

const state = {
  backend: null,
  user: null,
  applications: [],
  reviews: [],
  savedCount: 0,
  unsubApps: null,
  unsubSaved: null,
  tab: 'history',
  // Ошибки загрузки держим в состоянии: вкладку могут открыть уже после того,
  // как запрос упал, и тогда её нужно нарисовать с сообщением, а не пустой.
  historyError: null,
  reviewsError: null,
};

bootstrap({ active: 'profile', requireAuth: true }).then(async ({ backend, user }) => {
  state.backend = backend;
  state.user = user;

  renderHead();
  bindTabs();
  skeletons($('#pane-history'), 3);

  // Резюме и профиль рисуются ПЕРВЫМИ и из уже загруженного объекта user —
  // им не нужны ни отклики, ни отзывы. Раньше они шли после `await
  // loadReviews()`, и упавший запрос отзывов (например, пока строится индекс)
  // обрывал функцию: обе вкладки оставались пустыми, заполнить резюме было
  // нельзя. Теперь сетевые части подключаются после и каждая падает отдельно.
  renderResume();
  renderSettings();

  // Открыть вкладку резюме по ссылке profile.html#resume нужно сразу, не дожидаясь
  // отзывов: именно по этой ссылке приходят из подсказки «заполните резюме».
  if (location.hash === '#resume') switchTab('resume');

  state.unsubApps = backend.watchApplications(user.uid, (items) => {
    state.applications = items;
    state.historyError = null;
    renderStats();
    if (state.tab === 'history') renderHistory();
  }, (error) => {
    // Без этого вкладка истории висела бы в скелетонах вечно.
    state.historyError = error;
    renderHistory();
  });

  state.unsubSaved = backend.watchSaved(user.uid, (items) => {
    state.savedCount = items.length;
    renderStats();
  }, (error) => {
    // Счётчик сохранённых — не повод ломать страницу, достаточно записи в консоль.
    console.error('[profile] не удалось получить сохранённые вакансии', error);
  });

  await loadReviews();

  onUser((nextUser) => {
    if (!nextUser) return;
    state.user = nextUser;
    renderHead();
    renderStats();
    renderResume();
    renderSettings();
  });
});

function renderHead() {
  $('#user-name').textContent = state.user.displayName || 'Личный кабинет';
  $('#user-avatar').replaceChildren(avatarEl(state.user, 52));
  const resume = resumeOf(state.user);
  $('#user-sub').textContent = [
    state.user.email,
    resume.title || null,
    state.user.role === 'admin' ? 'роль: администратор' : null,
  ].filter(Boolean).join(' · ');
}

function bindTabs() {
  for (const tab of $$('#tabs .tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }
}

function switchTab(name) {
  state.tab = name;
  for (const tab of $$('#tabs .tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const pane of $$('.pane')) pane.classList.add('hidden');
  $(`#pane-${name}`).classList.remove('hidden');
  if (name === 'history') renderHistory();
  if (name === 'reviews') renderReviews();
}

/* --------------------------------------------------------------- сводка */

function renderStats() {
  const active = state.applications.filter((a) => !['rejected', 'withdrawn'].includes(a.status)).length;
  const offers = state.applications.filter((a) => a.status === 'offer').length;
  const avg = state.applications.length
    ? Math.round(state.applications.reduce((s, a) => s + (a.matchScore || 0), 0) / state.applications.length)
    : 0;
  const completeness = resumeCompleteness(resumeOf(state.user));

  const host = $('#quick-stats');
  host.innerHTML = '';
  const stat = (value, label) => el('div', { class: 'stat' },
    el('div', { class: 'stat-value' }, String(value)),
    el('div', { class: 'stat-label' }, label));

  host.append(
    stat(state.applications.length, 'всего откликов'),
    stat(active, 'в работе'),
    stat(offers, 'офферов'),
    stat(state.savedCount, 'сохранено'),
    stat(`${avg}%`, 'среднее совпадение'),
    stat(`${completeness.percent}%`, 'заполненность резюме'),
  );
}

/* ------------------------------------------------------ история откликов */

function renderHistory() {
  const host = $('#pane-history');
  host.innerHTML = '';

  if (state.historyError) {
    emptyState(host, '⚠️', 'Не удалось загрузить историю откликов', state.historyError.message);
    return;
  }

  if (!state.applications.length) {
    emptyState(host, '📮', 'Откликов пока нет',
      'Найдите подходящую вакансию в каталоге и отправьте первый отклик.');
    host.append(el('div', { class: 'center' }, el('a', { class: 'btn btn-primary', href: 'index.html' }, 'В каталог')));
    return;
  }

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' },
    el('h2', { style: 'margin:0;font-size:17px' }, 'История откликов'),
    el('span', { class: 'live-dot' }, el('i', {}), 'статусы обновляются в реальном времени'),
  ));

  const body = el('div', { class: 'panel-body' });
  for (const app of state.applications) {
    body.append(applicationRow(app));
  }
  panel.append(body);
  host.append(panel);
}

function applicationRow(app) {
  const tone = DICT.applicationStatusTone[app.status] || 'chip';
  const canWithdraw = !['withdrawn', 'rejected', 'offer'].includes(app.status);

  return el('div', { style: 'padding:14px 0;border-bottom:1px solid var(--border-soft)' },
    el('div', { class: 'row-between' },
      el('div', { class: 'row', style: 'gap:12px;min-width:0' },
        companyLogoEl(app),
        el('div', { style: 'min-width:0' },
          el('a', { href: `job.html?id=${encodeURIComponent(app.jobId)}`, style: 'font-weight:600;color:var(--text)' }, app.jobTitle),
          el('div', { class: 'faint' }, `${app.companyName} · ${app.city || ''} · ${salaryRange(app.salaryMin, app.salaryMax)}`),
        ),
      ),
      el('div', { class: 'row', style: 'gap:8px' },
        app.matchScore ? el('span', { class: 'chip' }, `AI ${app.matchScore}%`) : null,
        el('span', { class: `chip ${tone}` }, el('i', { class: 'status-dot' }), applicationStatusLabel(app.status)),
      ),
    ),

    el('div', { class: 'row-between mt-8' },
      el('span', { class: 'faint' }, `Отправлен ${timeAgo(app.createdAt)}`),
      el('span', { class: 'row', style: 'gap:6px' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openApplication(app) }, 'Подробнее'),
        canWithdraw
          ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => withdraw(app) }, 'Отозвать')
          : null,
      ),
    ),
  );
}

function openApplication(app) {
  openModal({
    title: app.jobTitle,
    size: 'modal-lg',
    body: el('div', {},
      el('p', { class: 'muted' }, `${app.companyName} · ${salaryRange(app.salaryMin, app.salaryMax)}`),
      el('h4', { style: 'margin-bottom:6px' }, 'Движение отклика'),
      el('ul', { class: 'timeline' },
        (app.statusHistory || []).map((h) => el('li', {}, `${applicationStatusLabel(h.status)} — ${dateTime(h.at)}`)),
      ),
      app.coverLetter ? el('div', {},
        el('h4', { style: 'margin-bottom:6px' }, 'Сопроводительное письмо'),
        el('p', { style: 'white-space:pre-wrap' }, app.coverLetter),
      ) : null,
      el('a', { class: 'btn btn-sm', href: `job.html?id=${encodeURIComponent(app.jobId)}` }, 'Открыть вакансию'),
    ),
  });
}

async function withdraw(app) {
  if (!await confirmDialog('Отозвать отклик? Работодатель перестанет его видеть в активных.', { okLabel: 'Отозвать' })) return;
  try {
    await state.backend.withdrawApplication(app.id, state.user.uid);
    toast('Отклик отозван', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

/* ------------------------------------------------------------- мои отзывы */

async function loadReviews() {
  try {
    state.reviews = await state.backend.listUserReviews(state.user.uid);
    state.reviewsError = null;
  } catch (error) {
    // Частая причина — составной индекс reviews (userId, createdAt) ещё
    // строится. Показываем текст ошибки, а не «отзывов нет»: иначе выглядит
    // так, будто отзывы пропали.
    console.error('[profile] не удалось загрузить отзывы', error);
    state.reviews = [];
    state.reviewsError = error;
  }
  if (state.tab === 'reviews') renderReviews();
}

function renderReviews() {
  const host = $('#pane-reviews');
  host.innerHTML = '';

  if (state.reviewsError) {
    emptyState(host, '⚠️', 'Не удалось загрузить отзывы', state.reviewsError.message);
    return;
  }

  if (!state.reviews.length) {
    emptyState(host, '💬', 'Вы ещё не оставляли отзывов',
      'Отзыв можно написать на странице любой вакансии — он поможет другим соискателям.');
    return;
  }

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('h2', { style: 'margin:0;font-size:17px' }, 'Мои отзывы')));
  const body = el('div', { class: 'panel-body' });

  for (const review of state.reviews) {
    body.append(el('div', { class: 'review' },
      el('div', { class: 'review-head' },
        el('div', { style: 'flex:1' },
          el('a', { href: `job.html?id=${encodeURIComponent(review.jobId)}`, style: 'font-weight:600;color:var(--text)' }, review.companyName || 'Вакансия'),
          el('div', { class: 'faint' }, dateShort(review.createdAt)),
        ),
        el('span', { class: 'stars' }, stars(review.rating)),
      ),
      review.hidden ? el('p', { class: 'chip chip-danger' }, 'Скрыт модератором') : null,
      el('p', { class: 'mb-0' }, review.text),
      el('div', { class: 'row mt-8' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => editReview(review) }, 'Редактировать'),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => deleteReview(review) }, 'Удалить'),
      ),
    ));
  }

  panel.append(body);
  host.append(panel);
}

function editReview(review) {
  const textarea = el('textarea', { class: 'textarea', rows: '4', maxlength: '1500' });
  textarea.value = review.text;
  const select = el('select', { class: 'select' }, [5, 4, 3, 2, 1].map((n) =>
    el('option', { value: String(n), selected: Number(review.rating) === n ? 'selected' : null }, `${n} — ${stars(n)}`)));

  openModal({
    title: 'Редактирование отзыва',
    body: el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Оценка'), select),
      el('div', { class: 'field' }, el('label', {}, 'Текст'), textarea),
    ),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: 'Сохранить', kind: 'btn-primary', onClick: async (close) => {
        try {
          await state.backend.updateReview(review.id, { rating: Number(select.value), text: textarea.value.trim() });
          await loadReviews();
          renderReviews();
          close();
          toast('Отзыв обновлён', 'success');
        } catch (error) { toast(error.message, 'error'); }
      } },
    ],
  });
}

async function deleteReview(review) {
  if (!await confirmDialog('Удалить отзыв?')) return;
  try {
    await state.backend.deleteReview(review.id, review.userId);
    await loadReviews();
    renderReviews();
    toast('Отзыв удалён', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

/* ------------------------------------------------------------------ резюме */

/** Редактор списка тегов (навыки, города). */
function tagEditor(values = [], placeholder = 'Добавить и нажать Enter') {
  const items = [...values];
  const list = el('div', { class: 'chip-list', style: 'margin-bottom:8px' });
  const input = el('input', { class: 'input', type: 'text', placeholder });

  const paint = () => {
    list.innerHTML = '';
    if (!items.length) list.append(el('span', { class: 'faint' }, 'пока пусто'));
    items.forEach((value, index) => {
      list.append(el('span', { class: 'chip chip-btn', onclick: () => { items.splice(index, 1); paint(); } }, `${value} ✕`));
    });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const value = input.value.trim().replace(/,$/, '');
    if (value && !items.some((i) => i.toLowerCase() === value.toLowerCase())) items.push(value);
    input.value = '';
    paint();
  });

  paint();
  return { node: el('div', {}, list, input), get value() { return items; } };
}

function renderResume() {
  const host = $('#pane-resume');
  const resume = resumeOf(state.user);
  const completeness = resumeCompleteness(resume);

  const title = el('input', { class: 'input', value: resume.title || '', placeholder: 'Frontend-разработчик' });
  const level = el('select', { class: 'select' },
    el('option', { value: '' }, 'Не выбран'),
    ...Object.entries(DICT.levels).map(([v, l]) => el('option', { value: v, selected: resume.level === v ? 'selected' : null }, l)));
  const years = el('input', { class: 'input', type: 'number', min: '0', max: '40', value: String(resume.yearsExperience || 0) });
  const salary = el('input', { class: 'input', type: 'number', min: '0', step: '50000', value: String(resume.desiredSalary || 0) });
  const education = el('input', { class: 'input', value: resume.education || '', placeholder: 'Вуз, специальность или курсы' });
  const github = el('input', { class: 'input', value: resume.links?.github || '', placeholder: 'https://github.com/username' });
  const skills = tagEditor(resume.skills, 'Навык и Enter — например, React');
  const cities = tagEditor(resume.cities, 'Город и Enter — например, Алматы');
  const remoteOnly = el('input', { type: 'checkbox', checked: resume.remoteOnly ? 'checked' : null });

  const employmentBoxes = Object.entries(DICT.employment).map(([value, label]) =>
    el('label', { class: 'checkbox' },
      el('input', { type: 'checkbox', value, checked: resume.employment?.includes(value) ? 'checked' : null }),
      label));

  const form = el('form', {},
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, 'Желаемая должность'), title),
      el('div', { class: 'field' }, el('label', {}, 'Грейд'), level),
      el('div', { class: 'field' }, el('label', {}, 'Опыт, лет'), years),
      el('div', { class: 'field' }, el('label', {}, 'Желаемая зарплата, ₸'), salary),
    ),
    el('div', { class: 'field' }, el('label', {}, 'Навыки — по ним считается совпадение'), skills.node),
    el('div', { class: 'field' }, el('label', {}, 'Города для работы'), cities.node),
    el('div', { class: 'field' },
      el('label', {}, 'Формат занятости'),
      el('div', { class: 'row', id: 'employment-boxes' }, employmentBoxes),
    ),
    el('label', { class: 'checkbox', style: 'margin-bottom:14px' }, remoteOnly, 'Рассматриваю только удалённую работу'),
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, 'Образование'), education),
      el('div', { class: 'field' }, el('label', {}, 'GitHub'), github),
    ),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить резюме'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const employment = Array.from(form.querySelectorAll('#employment-boxes input:checked')).map((i) => i.value);
    const payload = {
      title: title.value.trim(),
      level: level.value,
      yearsExperience: Number(years.value) || 0,
      desiredSalary: Number(salary.value) || 0,
      skills: skills.value,
      cities: cities.value,
      employment,
      remoteOnly: remoteOnly.checked,
      education: education.value.trim(),
      links: { ...(resume.links || {}), github: github.value.trim() },
    };
    try {
      await state.backend.updateProfile(state.user.uid, { resume: payload });
      state.user = { ...state.user, resume: payload };
      renderHead();
      renderStats();
      renderResume();
      toast('Резюме сохранено — оценки соответствия пересчитаны', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });

  host.innerHTML = '';
  host.append(el('div', { class: 'layout-detail' },
    el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', {}, 'Резюме для AI-подбора')),
      el('p', { class: 'faint' }, 'Эти поля — вход для движка соответствия. Чем точнее заполнено, тем честнее процент на карточках вакансий.'),
      form,
    ),
    el('div', { class: 'card detail-aside' },
      el('h3', {}, 'Заполненность'),
      el('div', { class: 'gauge', style: 'margin-bottom:14px' },
        el('div', { class: 'gauge-circle', style: `--p:${completeness.percent};--gauge-color:var(--accent)` },
          el('span', { class: 'gauge-value' }, `${completeness.percent}%`)),
        el('div', { class: 'faint' }, `${completeness.done} из ${completeness.total} пунктов`),
      ),
      completeness.missing.length
        ? el('div', {},
          el('h4', { style: 'font-size:14px;margin-bottom:8px' }, 'Осталось заполнить'),
          el('ul', { class: 'timeline' }, completeness.missing.map((m) =>
            el('li', {}, el('strong', { style: 'color:var(--text)' }, m.label), ` — ${m.hint}`))))
        : el('p', { class: 'chip chip-success' }, 'Резюме заполнено полностью'),
    ),
  ));
}

/* ---------------------------------------------------------------- профиль */

/**
 * Карточка аватара.
 *
 * Файл не уходит на сервер как есть: src/core/image.js обрезает его по центру
 * и уменьшает до 256×256 JPEG, а дальше адаптер решает, куда положить —
 * в Firebase Storage (`avatars/{uid}/avatar.jpg`) или, в демо-режиме,
 * в localStorage как data URL.
 */
function renderAvatarCard() {
  const user = state.user;
  const preview = el('div', { class: 'avatar-editor-preview' }, avatarEl(user, 96));

  const input = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/gif',
    class: 'visually-hidden',
    id: 'avatar-file',
  });

  const pickBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' },
    user.photoURL ? 'Заменить фото' : 'Загрузить фото');
  pickBtn.addEventListener('click', () => input.click());

  const removeBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Удалить');
  removeBtn.addEventListener('click', async () => {
    if (!await confirmDialog('Удалить фото профиля?', { okLabel: 'Удалить' })) return;
    try {
      await state.backend.removeAvatar(user.uid);
      state.user = { ...state.user, photoURL: null };
      renderSettings();
      renderHead();
      toast('Фото удалено', 'info');
    } catch (error) { toast(error.message, 'error'); }
  });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';               // чтобы повторный выбор того же файла сработал
    if (!file) return;
    pickBtn.disabled = true;
    const original = pickBtn.textContent;
    pickBtn.textContent = 'Загружаю…';
    try {
      const url = await state.backend.uploadAvatar(user.uid, file);
      state.user = { ...state.user, photoURL: url };
      renderSettings();
      renderHead();
      toast('Фото профиля обновлено', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      pickBtn.disabled = false;
      pickBtn.textContent = original;
    }
  });

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', {}, 'Фото профиля')),
    el('div', { class: 'avatar-editor' },
      preview,
      el('div', {},
        el('p', { class: 'faint', style: 'margin-bottom:10px' },
          'JPEG, PNG, WebP или GIF до 8 МБ. Картинка обрезается по центру и уменьшается до 256×256 — на сервер уходит около 40 КБ.'),
        el('div', { class: 'row' },
          input,
          pickBtn,
          user.photoURL ? removeBtn : null,
        ),
      ),
    ),
  );
}

function renderSettings() {
  const host = $('#pane-settings');
  const user = state.user;

  const name = el('input', { class: 'input', value: user.displayName || '' });
  const phone = el('input', { class: 'input', value: user.phone || '', placeholder: '+7 700 000-00-00' });
  const city = el('input', { class: 'input', value: user.city || '', placeholder: 'Алматы' });
  const about = el('textarea', { class: 'textarea', rows: '3', placeholder: 'Пара предложений о себе' });
  about.value = user.about || '';
  const notifications = el('input', { type: 'checkbox', checked: user.settings?.emailNotifications !== false ? 'checked' : null });
  const currentTheme = user.settings?.theme || document.documentElement.dataset.theme || 'dark';
  const theme = el('select', { class: 'select' },
    el('option', { value: 'dark', selected: currentTheme === 'dark' ? 'selected' : null }, 'Тёмная'),
    el('option', { value: 'light', selected: currentTheme === 'light' ? 'selected' : null }, 'Светлая'));
  theme.addEventListener('change', (e) => applyTheme(e.target.value));

  const form = el('form', {},
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, 'Имя и фамилия'), name),
      el('div', { class: 'field' }, el('label', {}, 'Телефон'), phone),
      el('div', { class: 'field' }, el('label', {}, 'Город'), city),
      el('div', { class: 'field' }, el('label', {}, 'Почта'),
        el('input', { class: 'input', value: user.email || '', disabled: true })),
      el('div', { class: 'field' }, el('label', {}, 'Тема оформления'), theme),
    ),
    el('div', { class: 'field' }, el('label', {}, 'О себе'), about),
    el('label', { class: 'checkbox', style: 'margin-bottom:14px' }, notifications, 'Присылать уведомления об изменении статуса откликов'),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить профиль'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const patch = {
        displayName: name.value.trim(),
        phone: phone.value.trim(),
        city: city.value.trim(),
        about: about.value.trim(),
        settings: {
          ...(user.settings || {}),
          emailNotifications: notifications.checked,
          theme: theme.value,
        },
      };
      applyTheme(theme.value);
      await state.backend.updateProfile(user.uid, patch);
      state.user = { ...state.user, ...patch };
      renderHead();
      toast('Профиль сохранён', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });

  host.innerHTML = '';
  host.append(renderAvatarCard());
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', {}, 'Данные профиля')),
    form,
  ));

  host.append(el('div', { class: 'card' },
    el('h3', {}, 'Аккаунт'),
    el('div', { class: 'row' },
      el('span', { class: 'chip' }, `ID: ${user.uid}`),
      el('span', { class: `chip ${user.role === 'admin' ? 'chip-accent' : ''}` }, `Роль: ${user.role}`),
      el('span', { class: 'chip' }, `Регистрация: ${dateShort(user.createdAt) || '—'}`),
    ),
    el('p', { class: 'faint mt-16 mb-0' },
      'Роль меняется только администратором в админ-панели — правила безопасности Firestore запрещают пользователю править собственное поле role.'),
  ));
}
