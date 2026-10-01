/**
 * Админ-панель (admin.html). Требование ТЗ 3.5.
 *
 * Доступ только для роли admin — гвард в core/page.js, а на стороне базы
 * те же ограничения повторены в firestore.rules (клиенту верить нельзя).
 *
 * Разделы: CRUD вакансий, все отклики со сменой статусов (real-time),
 * пользователи и роли, модерация отзывов, статистика на агрегатах.
 */

import { bootstrap } from '../core/page.js';
import { $, $$, el, toast, confirmDialog, openModal, emptyState, skeletons } from '../core/ui.js';
import { APP, DICT } from '../config.js';
import {
  salaryRange, levelLabel, categoryLabel, jobStatusLabel, applicationStatusLabel,
  dateShort, dateTime, timeAgo, stars, toDate, plural,
} from '../core/format.js';
import { companyLogoEl, avatarEl } from '../core/components.js';

const state = {
  backend: null,
  user: null,
  tab: 'jobs',
  jobs: { items: [], cursor: null, hasMore: false, status: '', selected: new Set() },
  apps: { items: [], cursor: null, hasMore: false, status: '' },
  users: { items: [], cursor: null, hasMore: false },
  reviews: { items: [], cursor: null, hasMore: false },
  unsubApps: null,
};

bootstrap({ active: 'admin', requireAdmin: true }).then(({ backend, user }) => {
  state.backend = backend;
  state.user = user;

  bindTabs();
  renderActions();
  loadStats();
  loadJobs(true);
});

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

  if (name === 'jobs' && !state.jobs.items.length) loadJobs(true);
  if (name === 'applications') subscribeApplications();
  if (name === 'users' && !state.users.items.length) loadUsers(true);
  if (name === 'reviews' && !state.reviews.items.length) loadReviews(true);
  if (name === 'stats') loadStats();
}

function renderActions() {
  const host = $('#admin-actions');
  host.innerHTML = '';

  host.append(el('button', { class: 'btn btn-primary', type: 'button', onclick: () => openJobForm() }, '+ Новая вакансия'));

  if (state.backend.mode === 'firebase') {
    host.append(el('button', {
      class: 'btn', type: 'button',
      onclick: async (e) => {
        if (!await confirmDialog('Залить 36 тестовых вакансий и отзывы в Firestore? Существующие документы не удаляются.', { okLabel: 'Залить', danger: false })) return;
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Заливаю…';
        try {
          const count = await state.backend.seedDatabase(state.user.uid);
          toast(`Записано вакансий: ${count}`, 'success');
          loadJobs(true); loadStats();
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          btn.disabled = false; btn.textContent = 'Тестовые данные';
        }
      },
    }, 'Тестовые данные'));
  } else {
    host.append(el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        if (!await confirmDialog('Сбросить демо-данные к исходному состоянию? Все отклики и правки будут удалены.', { okLabel: 'Сбросить' })) return;
        await state.backend.resetDemoData();
        toast('Демо-данные сброшены', 'success');
        location.reload();
      },
    }, 'Сбросить демо'));
  }
}

/* ------------------------------------------------------------- статистика */

async function loadStats() {
  const host = $('#admin-stats');
  host.innerHTML = '';
  try {
    const s = await state.backend.stats();
    const stat = (value, label) => el('div', { class: 'stat' },
      el('div', { class: 'stat-value' }, String(value ?? '—')),
      el('div', { class: 'stat-label' }, label));

    host.append(
      stat(s.jobs, 'вакансий всего'),
      stat(s.openJobs, 'открытых'),
      stat(s.users, 'пользователей'),
      stat(s.applications, 'откликов'),
      stat(s.reviews, 'отзывов'),
      stat(s.hiddenReviews, 'скрыто модератором'),
    );

    renderStatsPane(s);
  } catch (error) {
    host.append(el('div', { class: 'form-error' }, `Не удалось получить статистику: ${error.message}`));
  }
}

function renderStatsPane(s) {
  const host = $('#pane-stats');
  host.innerHTML = '';

  const max = Math.max(1, ...Object.values(s.byStatus || {}));
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h2', {}, 'Отклики по статусам'),
      el('span', { class: 'faint' }, state.backend.mode === 'firebase'
        ? 'посчитано getCountFromServer() — документы не выгружались'
        : 'демо-режим: подсчёт в браузере'),
    ),
    ...Object.entries(DICT.applicationStatus).map(([key, label]) => {
      const value = (s.byStatus || {})[key] || 0;
      return el('div', { class: 'bar-row' },
        el('span', { class: 'muted' }, label),
        el('span', { class: 'bar' }, el('span', { style: `width:${(value / max) * 100}%` })),
        el('span', { class: 'faint' }, String(value)),
      );
    }),
  ));

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h2', {}, 'Отклики по дням'),
      el('span', { class: 'faint' }, 'последние 30 дней'),
    ),
    el('div', { id: 'apps-chart' }, el('div', { class: 'skeleton', style: 'height:190px' })),
  ));
  loadChartData();

  if ((s.topJobs || []).length) {
    host.append(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', {}, 'Больше всего откликов')),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Вакансия'), el('th', {}, 'Компания'), el('th', {}, 'Откликов'), el('th', {}, 'Просмотров'))),
          el('tbody', {}, s.topJobs.map((job) => el('tr', {},
            el('td', {}, el('a', { href: `job.html?id=${encodeURIComponent(job.id)}` }, job.title)),
            el('td', {}, job.companyName || job.company?.name || ''),
            el('td', {}, String(job.applicationsCount || 0)),
            el('td', {}, String(job.viewsCount || 0)),
          ))),
        ),
      ),
    ));
  }
}

/** Данные для графика: до 300 последних откликов одним запросом. */
async function loadChartData() {
  const host = $('#apps-chart');
  if (!host) return;
  try {
    const result = await state.backend.listAllApplications({ pageSize: 300 });
    host.innerHTML = '';
    host.append(applicationsChart(result.items));
  } catch (error) {
    host.innerHTML = '';
    host.append(el('p', { class: 'muted mb-0' }, `Не удалось построить график: ${error.message}`));
  }
}

/* ------------------------------------------------------------- вакансии */

async function loadJobs(reset = false) {
  const host = $('#pane-jobs');
  if (reset) {
    state.jobs.items = [];
    state.jobs.cursor = null;
    skeletons(host, 3);
  }
  try {
    const result = await state.backend.listJobs({
      includeAllStatuses: true,
      status: state.jobs.status,
      pageSize: APP.adminPageSize,
      cursor: state.jobs.cursor,
      sort: 'new',
    });
    state.jobs.items.push(...result.items);
    state.jobs.cursor = result.cursor;
    state.jobs.hasMore = result.hasMore;
    renderJobs();
  } catch (error) {
    emptyState(host, '⚠️', 'Не удалось загрузить вакансии', error.message);
  }
}

function renderJobs() {
  const host = $('#pane-jobs');
  host.innerHTML = '';

  const filter = el('select', { class: 'select', style: 'width:auto' },
    el('option', { value: '' }, 'Все статусы'),
    ...Object.entries(DICT.jobStatus).map(([v, l]) =>
      el('option', { value: v, selected: state.jobs.status === v ? 'selected' : null }, l)));
  filter.addEventListener('change', (e) => { state.jobs.status = e.target.value; loadJobs(true); });

  const selectedCount = state.jobs.selected.size;

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' },
    el('h2', { style: 'margin:0;font-size:17px' }, `Вакансии (${state.jobs.items.length})`),
    el('div', { class: 'row' },
      selectedCount ? el('span', { class: 'chip chip-accent' }, `выбрано: ${selectedCount}`) : null,
      selectedCount ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkStatus('closed') }, 'Закрыть') : null,
      selectedCount ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkStatus('open') }, 'Открыть') : null,
      selectedCount ? el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: bulkDelete }, 'Удалить') : null,
      filter,
    ),
  ));

  if (!state.jobs.items.length) {
    const body = el('div', { class: 'panel-body' });
    emptyState(body, '📋', 'Вакансий нет', 'Создайте первую вакансию кнопкой «Новая вакансия».');
    panel.append(body);
    host.append(panel);
    return;
  }

  const rows = state.jobs.items.map((job) => el('tr', {},
    el('td', { style: 'width:34px' },
      el('input', {
        type: 'checkbox',
        'aria-label': `Выбрать «${job.title}»`,
        checked: state.jobs.selected.has(job.id) ? 'checked' : null,
        onchange: (e) => {
          if (e.target.checked) state.jobs.selected.add(job.id);
          else state.jobs.selected.delete(job.id);
          renderJobs();
        },
      })),
    el('td', {},
      el('a', { href: `job.html?id=${encodeURIComponent(job.id)}`, style: 'font-weight:600' }, job.title),
      el('div', { class: 'faint' }, `${job.companyName || job.company?.name} · ${job.city}`)),
    el('td', {}, categoryLabel(job.category)),
    el('td', {}, levelLabel(job.level)),
    el('td', { class: 'nowrap' }, salaryRange(job.salaryMin, job.salaryMax)),
    el('td', {}, el('span', {
      class: `chip ${job.status === 'open' ? 'chip-success' : job.status === 'draft' ? 'chip-warning' : 'chip-danger'}`,
    }, jobStatusLabel(job.status))),
    el('td', {}, String(job.applicationsCount || 0)),
    el('td', {}, el('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openJobForm(job) }, 'Изменить'),
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: async () => {
          const next = job.status === 'open' ? 'closed' : 'open';
          await state.backend.updateJob(job.id, { status: next });
          job.status = next;
          renderJobs();
          toast(next === 'open' ? 'Вакансия открыта' : 'Вакансия закрыта — на странице статус обновится сразу', 'info');
        },
      }, job.status === 'open' ? 'Закрыть' : 'Открыть'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => removeJob(job) }, '✕'),
    )),
  ));

  panel.append(el('div', { class: 'panel-body' },
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', {}, el('input', {
            type: 'checkbox',
            'aria-label': 'Выбрать все вакансии на странице',
            checked: state.jobs.items.length && state.jobs.selected.size === state.jobs.items.length ? 'checked' : null,
            onchange: (e) => {
              state.jobs.selected = e.target.checked
                ? new Set(state.jobs.items.map((j) => j.id))
                : new Set();
              renderJobs();
            },
          })),
          el('th', {}, 'Вакансия'), el('th', {}, 'Направление'), el('th', {}, 'Грейд'),
          el('th', {}, 'Зарплата'), el('th', {}, 'Статус'), el('th', {}, 'Откликов'), el('th', {}, ''))),
        el('tbody', {}, rows),
      ),
    ),
    state.jobs.hasMore
      ? el('button', { class: 'btn btn-block mt-16', type: 'button', onclick: () => loadJobs(false) }, 'Показать ещё')
      : null,
  ));

  host.append(panel);
}

/** Массовая смена статуса выбранных вакансий. */
async function bulkStatus(status) {
  const ids = [...state.jobs.selected];
  if (!ids.length) return;
  const label = status === 'open' ? 'открыть' : 'закрыть';
  if (!await confirmDialog(`Действие затронет ${ids.length} вакансий: ${label}?`, {
    okLabel: status === 'open' ? 'Открыть' : 'Закрыть', danger: false,
  })) return;

  let done = 0;
  for (const id of ids) {
    try {
      await state.backend.updateJob(id, { status });
      const job = state.jobs.items.find((j) => j.id === id);
      if (job) job.status = status;
      done += 1;
    } catch (error) {
      toast(error.message, 'error');
      break;
    }
  }
  state.jobs.selected.clear();
  renderJobs();
  loadStats();
  toast(`Обновлено вакансий: ${done}`, 'success');
}

/** Массовое удаление выбранных вакансий. */
async function bulkDelete() {
  const ids = [...state.jobs.selected];
  if (!ids.length) return;
  if (!await confirmDialog(
    `Удалить ${ids.length} вакансий? Отклики на них останутся в истории пользователей.`,
  )) return;

  let done = 0;
  for (const id of ids) {
    try {
      await state.backend.deleteJob(id);
      done += 1;
    } catch (error) {
      toast(error.message, 'error');
      break;
    }
  }
  state.jobs.items = state.jobs.items.filter((j) => !state.jobs.selected.has(j.id));
  state.jobs.selected.clear();
  renderJobs();
  loadStats();
  toast(`Удалено вакансий: ${done}`, 'info');
}

async function removeJob(job) {
  if (!await confirmDialog(`Удалить вакансию «${job.title}»? Отклики на неё останутся в истории пользователей.`)) return;
  try {
    await state.backend.deleteJob(job.id);
    state.jobs.items = state.jobs.items.filter((j) => j.id !== job.id);
    renderJobs();
    loadStats();
    toast('Вакансия удалена', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

/** Форма создания и редактирования вакансии. */
function openJobForm(job = null) {
  const v = job || {};
  const company = v.company || {};

  const f = {
    title: el('input', { class: 'input', value: v.title || '', required: true }),
    companyName: el('input', { class: 'input', value: company.name || '', required: true }),
    companyLogo: el('input', { class: 'input', value: company.logo || '💼', maxlength: '4' }),
    industry: el('input', { class: 'input', value: company.industry || '' }),
    size: el('input', { class: 'input', value: company.size || '' }),
    category: el('select', { class: 'select' }, Object.entries(DICT.categories).map(([k, l]) =>
      el('option', { value: k, selected: v.category === k ? 'selected' : null }, l))),
    level: el('select', { class: 'select' }, Object.entries(DICT.levels).map(([k, l]) =>
      el('option', { value: k, selected: v.level === k ? 'selected' : null }, l))),
    employment: el('select', { class: 'select' }, Object.entries(DICT.employment).map(([k, l]) =>
      el('option', { value: k, selected: v.employment === k ? 'selected' : null }, l))),
    city: el('select', { class: 'select' }, DICT.cities.map((c) =>
      el('option', { value: c, selected: v.city === c ? 'selected' : null }, c))),
    status: el('select', { class: 'select' }, Object.entries(DICT.jobStatus).map(([k, l]) =>
      el('option', { value: k, selected: (v.status || 'open') === k ? 'selected' : null }, l))),
    salaryMin: el('input', { class: 'input', type: 'number', step: '10000', value: String(v.salaryMin || '') }),
    salaryMax: el('input', { class: 'input', type: 'number', step: '10000', value: String(v.salaryMax || '') }),
    experienceYears: el('input', { class: 'input', type: 'number', min: '0', max: '20', value: String(v.experienceYears || 0) }),
    remote: el('input', { type: 'checkbox', checked: v.remote ? 'checked' : null }),
    description: el('textarea', { class: 'textarea', rows: '4' }),
    skills: el('input', { class: 'input', value: (v.skills || []).join(', '), placeholder: 'React, TypeScript, CSS' }),
    niceToHave: el('input', { class: 'input', value: (v.niceToHave || []).join(', ') }),
    responsibilities: el('textarea', { class: 'textarea', rows: '3', placeholder: 'По одному пункту на строку' }),
    requirements: el('textarea', { class: 'textarea', rows: '3', placeholder: 'По одному пункту на строку' }),
    benefits: el('textarea', { class: 'textarea', rows: '3', placeholder: 'По одному пункту на строку' }),
  };

  f.description.value = v.description || '';
  f.responsibilities.value = (v.responsibilities || []).join('\n');
  f.requirements.value = (v.requirements || []).join('\n');
  f.benefits.value = (v.benefits || []).join('\n');

  const field = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
  const lines = (value) => value.split('\n').map((s) => s.trim()).filter(Boolean);
  const csv = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

  // Логотип-картинка живёт в Firebase Storage по пути logos/{jobId}/logo.jpg,
  // поэтому загрузить его можно только у уже существующей вакансии — у новой
  // ещё нет ID. До загрузки (и если картинку удалили) карточка показывает эмодзи.
  let logoUrl = company.logoUrl || null;
  const logoBlock = logoUploader();

  function logoUploader() {
    const host = el('div', { class: 'avatar-editor', style: 'margin-bottom:14px' });
    const draw = () => {
      const preview = companyLogoEl({ company: { logoUrl, logo: f.companyLogo.value.trim() || '💼' }, companyName: f.companyName.value }, 56);

      if (!job) {
        host.replaceChildren(preview, el('p', { class: 'faint mb-0' },
          'Картинку-логотип можно загрузить после создания вакансии — файл в Storage привязан к её ID.'));
        return;
      }

      const input = el('input', {
        type: 'file',
        accept: 'image/jpeg,image/png,image/webp,image/gif',
        class: 'visually-hidden',
      });
      const pick = el('button', { class: 'btn btn-sm', type: 'button' }, logoUrl ? 'Заменить картинку' : 'Загрузить картинку');
      pick.addEventListener('click', () => input.click());

      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        pick.disabled = true;
        pick.textContent = 'Загружаю…';
        try {
          logoUrl = await state.backend.uploadCompanyLogo(job.id, file);
          toast('Логотип загружен', 'success');
          draw();
          loadJobs(true);
        } catch (error) {
          toast(error.message, 'error');
          pick.disabled = false;
          pick.textContent = 'Загрузить картинку';
        }
      });

      const remove = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Убрать картинку');
      remove.addEventListener('click', async () => {
        try {
          await state.backend.removeCompanyLogo(job.id);
          logoUrl = null;
          toast('Логотип убран — снова показывается эмодзи', 'info');
          draw();
          loadJobs(true);
        } catch (error) { toast(error.message, 'error'); }
      });

      host.replaceChildren(
        preview,
        el('div', {},
          el('p', { class: 'faint', style: 'margin-bottom:8px' },
            'Картинка обрезается по центру и уменьшается до 128×128. Если её нет, в каталоге показывается эмодзи из поля выше.'),
          el('div', { class: 'row' }, input, pick, logoUrl ? remove : null),
        ),
      );
    };
    draw();
    return host;
  }

  openModal({
    title: job ? 'Редактирование вакансии' : 'Новая вакансия',
    size: 'modal-lg',
    body: el('div', {},
      field('Название вакансии', f.title),
      el('div', { class: 'form-grid' },
        field('Компания', f.companyName),
        field('Логотип (эмодзи)', f.companyLogo),
        field('Отрасль', f.industry),
        field('Размер компании', f.size),
        field('Направление', f.category),
        field('Грейд', f.level),
        field('Занятость', f.employment),
        field('Город', f.city),
        field('Зарплата от, ₸', f.salaryMin),
        field('Зарплата до, ₸', f.salaryMax),
        field('Опыт от, лет', f.experienceYears),
        field('Статус', f.status),
      ),
      field('Логотип-картинка', logoBlock),
      el('label', { class: 'checkbox', style: 'margin-bottom:14px' }, f.remote, 'Можно работать удалённо'),
      field('Описание', f.description),
      field('Обязательные навыки (через запятую)', f.skills),
      field('Будет плюсом (через запятую)', f.niceToHave),
      field('Обязанности', f.responsibilities),
      field('Требования', f.requirements),
      field('Условия', f.benefits),
    ),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: job ? 'Сохранить' : 'Создать', kind: 'btn-primary', onClick: async (close) => {
        if (!f.title.value.trim() || !f.companyName.value.trim()) {
          return toast('Название вакансии и компания обязательны', 'error');
        }
        const payload = {
          title: f.title.value.trim(),
          company: {
            id: (company.id || f.companyName.value.trim().toLowerCase().replace(/\s+/g, '-')),
            name: f.companyName.value.trim(),
            logo: f.companyLogo.value.trim() || '💼',
            // Ссылку на загруженную картинку сохраняем явно: payload заменяет
            // объект company целиком, без этой строки логотип бы стирался.
            logoUrl,
            industry: f.industry.value.trim(),
            size: f.size.value.trim(),
          },
          category: f.category.value,
          level: f.level.value,
          employment: f.employment.value,
          city: f.city.value,
          remote: f.remote.checked,
          status: f.status.value,
          salaryMin: Number(f.salaryMin.value) || 0,
          salaryMax: Number(f.salaryMax.value) || 0,
          experienceYears: Number(f.experienceYears.value) || 0,
          currency: 'KZT',
          description: f.description.value.trim(),
          skills: csv(f.skills.value),
          niceToHave: csv(f.niceToHave.value),
          responsibilities: lines(f.responsibilities.value),
          requirements: lines(f.requirements.value),
          benefits: lines(f.benefits.value),
          createdBy: state.user.uid,
        };

        try {
          if (job) {
            await state.backend.updateJob(job.id, payload);
            toast('Вакансия обновлена', 'success');
          } else {
            await state.backend.createJob(payload);
            toast('Вакансия создана — она уже видна в каталоге', 'success');
          }
          close();
          loadJobs(true);
          loadStats();
        } catch (error) {
          toast(error.message, 'error');
        }
      } },
    ],
  });
}

/* --------------------------------------------------------------- отклики */

function subscribeApplications() {
  const host = $('#pane-applications');
  if (state.unsubApps) return;
  skeletons(host, 3);
  state.unsubApps = state.backend.watchAllApplications((items) => {
    state.apps.items = items;
    renderApplications();
  });
}

function renderApplications() {
  const host = $('#pane-applications');
  host.innerHTML = '';

  const filter = el('select', { class: 'select', style: 'width:auto' },
    el('option', { value: '' }, 'Все статусы'),
    ...Object.entries(DICT.applicationStatus).map(([v, l]) =>
      el('option', { value: v, selected: state.apps.status === v ? 'selected' : null }, l)));
  filter.addEventListener('change', (e) => { state.apps.status = e.target.value; renderApplications(); });

  const items = state.apps.status
    ? state.apps.items.filter((a) => a.status === state.apps.status)
    : state.apps.items;

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' },
    el('h2', { style: 'margin:0;font-size:17px' }, `Отклики (${items.length})`),
    el('div', { class: 'row' },
      el('span', { class: 'live-dot' }, el('i', {}), 'реальное время'),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        disabled: !items.length,
        onclick: () => exportApplicationsCsv(items),
      }, 'Выгрузить CSV'),
      filter,
    ),
  ));

  if (!items.length) {
    const body = el('div', { class: 'panel-body' });
    emptyState(body, '📭', 'Откликов нет', 'Как только пользователи начнут откликаться, отклики появятся здесь мгновенно.');
    panel.append(body);
    host.append(panel);
    return;
  }

  const rows = items.map((app) => {
    const select = el('select', { class: 'select', style: 'width:auto;padding:5px 28px 5px 9px;font-size:13px' },
      ...Object.entries(DICT.applicationStatus).map(([v, l]) =>
        el('option', { value: v, selected: app.status === v ? 'selected' : null }, l)));
    select.addEventListener('change', async (e) => {
      try {
        await state.backend.setApplicationStatus(app.id, e.target.value, state.user.uid);
        toast(`Статус изменён: ${applicationStatusLabel(e.target.value)}`, 'success');
        loadStats();
      } catch (error) { toast(error.message, 'error'); }
    });

    return el('tr', {},
      el('td', {},
        el('div', { style: 'font-weight:600' }, app.userName || '—'),
        el('div', { class: 'faint' }, app.userEmail || '')),
      el('td', {}, el('a', { href: `job.html?id=${encodeURIComponent(app.jobId)}` }, app.jobTitle)),
      el('td', {}, app.companyName),
      el('td', {}, app.matchScore ? el('span', { class: 'chip' }, `${app.matchScore}%`) : '—'),
      el('td', { class: 'nowrap' }, timeAgo(app.createdAt)),
      el('td', {}, select),
      el('td', {}, el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: () => openModal({
          title: `Отклик: ${app.jobTitle}`,
          body: el('div', {},
            el('p', { class: 'muted' }, `${app.userName} · ${app.userEmail}`),
            el('p', { style: 'white-space:pre-wrap' }, app.coverLetter || 'Без сопроводительного письма'),
            el('h4', {}, 'История статусов'),
            el('ul', { class: 'timeline' }, (app.statusHistory || []).map((h) =>
              el('li', {}, `${applicationStatusLabel(h.status)} — ${dateShort(h.at)}`))),
          ),
        }),
      }, 'Письмо')),
    );
  });

  panel.append(el('div', { class: 'panel-body' },
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Кандидат'), el('th', {}, 'Вакансия'), el('th', {}, 'Компания'),
          el('th', {}, 'AI'), el('th', {}, 'Отправлен'), el('th', {}, 'Статус'), el('th', {}, ''))),
        el('tbody', {}, rows),
      ),
    ),
  ));

  host.append(panel);
}

/* ------------------------------------------------------- выгрузка в CSV */

function csvCell(value) {
  const text = String(value ?? '').replace(/"/g, '""');
  return /[";\n\r]/.test(text) ? `"${text}"` : text;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Выгрузка откликов. Разделитель «;» и BOM в начале — чтобы файл открывался
 * в Excel с русской локалью без танцев с импортом.
 */
function exportApplicationsCsv(items) {
  const header = [
    'Кандидат', 'Почта', 'Вакансия', 'Компания', 'Город',
    'Соответствие, %', 'Статус', 'Отправлен', 'Сопроводительное письмо',
  ];
  const rows = items.map((a) => [
    a.userName, a.userEmail, a.jobTitle, a.companyName, a.city,
    a.matchScore ?? '', applicationStatusLabel(a.status), dateTime(a.createdAt),
    String(a.coverLetter || '').replace(/\s+/g, ' ').trim(),
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`﻿${csv}`, `otkliki-${stamp}.csv`, 'text/csv;charset=utf-8');
  toast(`Выгружено строк: ${rows.length}`, 'success');
}

/* ------------------------------------------ график откликов по дням */

/**
 * Столбиковая диаграмма «отклики по дням» за 30 дней.
 * Одна серия, поэтому легенда не нужна — заголовок называет величину.
 * Подпись значением только у максимума, у остальных столбцов — подсказка
 * при наведении. Сетка и ось намеренно бледные, чтобы не спорить с данными.
 */
function applicationsChart(items) {
  const DAYS = 30;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets = [];
  const index = new Map();
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    index.set(date.toDateString(), buckets.length);
    buckets.push({ date, count: 0 });
  }

  for (const app of items) {
    const created = toDate(app.createdAt);
    if (!created) continue;
    const key = new Date(created.getFullYear(), created.getMonth(), created.getDate()).toDateString();
    const slot = index.get(key);
    if (slot !== undefined) buckets[slot].count += 1;
  }

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (!total) {
    return el('p', { class: 'muted mb-0' }, 'За последние 30 дней откликов не было.');
  }

  const max = Math.max(...buckets.map((b) => b.count));
  const W = 720;
  const H = 190;
  const padLeft = 32;
  const padRight = 10;
  const padTop = 22;
  const padBottom = 28;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const band = plotW / DAYS;
  const barW = Math.min(band - 2, 16);            // 2px просвета между столбцами
  const y = (value) => padTop + plotH - (value / max) * plotH;

  const svgNs = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs = {}, text) => {
    const n = document.createElementNS(svgNs, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `Отклики по дням за 30 дней, всего ${total}`,
    // Размер задаётся стилями: атрибут height="auto" SVG не понимает.
    style: 'display:block;width:100%;height:auto;max-width:100%',
  });

  // Бледная сетка и подписи шкалы: 0, половина, максимум.
  for (const value of [0, Math.round(max / 2), max]) {
    if (value === 0 && max === 0) continue;
    svg.append(node('line', {
      x1: padLeft, x2: W - padRight, y1: y(value), y2: y(value),
      stroke: 'var(--border-soft)', 'stroke-width': 1,
    }));
    svg.append(node('text', {
      x: padLeft - 8, y: y(value) + 4, 'text-anchor': 'end',
      fill: 'var(--text-faint)', 'font-size': 11,
    }, String(value)));
  }

  const wrap = el('div', { style: 'position:relative' });
  const tip = el('div', {
    class: 'chip',
    style: 'position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;white-space:nowrap;z-index:2',
  });

  buckets.forEach((bucket, i) => {
    const x = padLeft + i * band + (band - barW) / 2;
    const height = bucket.count === 0 ? 0 : Math.max(3, padTop + plotH - y(bucket.count));

    if (height) {
      svg.append(node('rect', {
        x, y: y(bucket.count), width: barW, height,
        rx: 3, fill: 'var(--accent)',
      }));
    }

    // Прозрачная зона наведения на всю высоту — попасть в неё легче, чем в столбец.
    const hit = node('rect', {
      x: padLeft + i * band, y: padTop, width: band, height: plotH,
      fill: 'transparent', style: 'cursor:default',
    });
    hit.addEventListener('mouseenter', () => {
      tip.textContent = `${bucket.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}: `
        + `${bucket.count} ${plural(bucket.count, 'отклик', 'отклика', 'откликов')}`;
      tip.style.left = `${Math.min(88, (i / DAYS) * 100)}%`;
      tip.style.top = '0px';
      tip.style.opacity = '1';
    });
    hit.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    svg.append(hit);

    // Подпись значением — только у максимального столбца.
    if (bucket.count === max) {
      svg.append(node('text', {
        x: x + barW / 2, y: y(bucket.count) - 7, 'text-anchor': 'middle',
        fill: 'var(--text-dim)', 'font-size': 11, 'font-weight': 600,
      }, String(max)));
    }

    if (i % 6 === 0 || i === DAYS - 1) {
      svg.append(node('text', {
        x: x + barW / 2, y: H - 9, 'text-anchor': 'middle',
        fill: 'var(--text-faint)', 'font-size': 11,
      }, bucket.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })));
    }
  });

  svg.append(node('line', {
    x1: padLeft, x2: W - padRight, y1: padTop + plotH, y2: padTop + plotH,
    stroke: 'var(--border)', 'stroke-width': 1,
  }));

  wrap.append(svg, tip);
  return wrap;
}

/* ---------------------------------------------------------- пользователи */

async function loadUsers(reset = false) {
  const host = $('#pane-users');
  if (reset) { state.users.items = []; state.users.cursor = null; skeletons(host, 3); }
  try {
    const result = await state.backend.listUsers({ pageSize: APP.adminPageSize, cursor: state.users.cursor });
    state.users.items.push(...result.items);
    state.users.cursor = result.cursor;
    state.users.hasMore = result.hasMore;
    renderUsers();
  } catch (error) {
    emptyState(host, '⚠️', 'Не удалось загрузить пользователей', error.message);
  }
}

function renderUsers() {
  const host = $('#pane-users');
  host.innerHTML = '';

  const rows = state.users.items.map((user) => {
    const roleSelect = el('select', { class: 'select', style: 'width:auto;padding:5px 28px 5px 9px;font-size:13px' },
      el('option', { value: 'user', selected: user.role === 'user' ? 'selected' : null }, 'user'),
      el('option', { value: 'admin', selected: user.role === 'admin' ? 'selected' : null }, 'admin'));

    roleSelect.addEventListener('change', async (e) => {
      const role = e.target.value;
      if (user.uid === state.user.uid && role !== 'admin') {
        e.target.value = 'admin';
        return toast('Нельзя снять роль admin с самого себя', 'error');
      }
      try {
        await state.backend.setUserRole(user.uid, role);
        user.role = role;
        toast(`Роль ${user.displayName}: ${role}`, 'success');
      } catch (error) { toast(error.message, 'error'); }
    });

    const resume = user.resume || {};
    return el('tr', {},
      el('td', {},
        el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' },
          avatarEl(user, 32),
          el('div', {},
            el('div', { style: 'font-weight:600' }, user.displayName || '—'),
            el('div', { class: 'faint' }, user.email)))),
      el('td', {}, resume.title || '—'),
      el('td', {}, resume.level ? levelLabel(resume.level) : '—'),
      el('td', {}, (resume.skills || []).slice(0, 3).join(', ') || '—'),
      el('td', { class: 'nowrap' }, dateShort(user.createdAt)),
      el('td', {}, roleSelect),
      el('td', {}, el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: async (e) => {
          try {
            await state.backend.setUserDisabled(user.uid, !user.disabled);
            user.disabled = !user.disabled;
            e.currentTarget.textContent = user.disabled ? 'Разблокировать' : 'Заблокировать';
            toast(user.disabled ? 'Пользователь заблокирован' : 'Пользователь разблокирован', 'info');
          } catch (error) { toast(error.message, 'error'); }
        },
      }, user.disabled ? 'Разблокировать' : 'Заблокировать')),
    );
  });

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' },
    el('h2', { style: 'margin:0;font-size:17px' }, `Пользователи (${state.users.items.length})`),
    el('span', { class: 'faint' }, 'роль admin открывает доступ к этой панели'),
  ));
  panel.append(el('div', { class: 'panel-body' },
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Пользователь'), el('th', {}, 'Должность'), el('th', {}, 'Грейд'),
          el('th', {}, 'Навыки'), el('th', {}, 'Регистрация'), el('th', {}, 'Роль'), el('th', {}, ''))),
        el('tbody', {}, rows),
      ),
    ),
    state.users.hasMore
      ? el('button', { class: 'btn btn-block mt-16', type: 'button', onclick: () => loadUsers(false) }, 'Показать ещё')
      : null,
  ));
  host.append(panel);
}

/* ------------------------------------------------------------- модерация */

async function loadReviews(reset = false) {
  const host = $('#pane-reviews');
  if (reset) { state.reviews.items = []; state.reviews.cursor = null; skeletons(host, 3); }
  try {
    const result = await state.backend.listAllReviews({ pageSize: APP.adminPageSize, cursor: state.reviews.cursor });
    state.reviews.items.push(...result.items);
    state.reviews.cursor = result.cursor;
    state.reviews.hasMore = result.hasMore;
    renderReviewsPane();
  } catch (error) {
    emptyState(host, '⚠️', 'Не удалось загрузить отзывы', error.message);
  }
}

function renderReviewsPane() {
  const host = $('#pane-reviews');
  host.innerHTML = '';

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' },
    el('h2', { style: 'margin:0;font-size:17px' }, `Отзывы (${state.reviews.items.length})`),
    el('span', { class: 'faint' }, 'скрытые отзывы не видны в каталоге'),
  ));

  const body = el('div', { class: 'panel-body' });

  if (!state.reviews.items.length) {
    emptyState(body, '💬', 'Отзывов нет', 'Модерировать пока нечего.');
  } else {
    for (const review of state.reviews.items) {
      body.append(el('div', { class: 'review' },
        el('div', { class: 'review-head' },
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { style: 'font-weight:600' }, `${review.userName} → ${review.companyName}`),
            el('div', { class: 'faint' }, dateShort(review.createdAt)),
          ),
          el('span', { class: 'stars' }, stars(review.rating)),
          review.hidden ? el('span', { class: 'chip chip-danger' }, 'скрыт') : null,
        ),
        el('p', { class: 'mb-0' }, review.text),
        el('div', { class: 'row mt-8' },
          el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button',
            onclick: async () => {
              try {
                await state.backend.updateReview(review.id, { hidden: !review.hidden, moderatedBy: state.user.uid });
                review.hidden = !review.hidden;
                renderReviewsPane();
                loadStats();
                toast(review.hidden ? 'Отзыв скрыт' : 'Отзыв возвращён', 'info');
              } catch (error) { toast(error.message, 'error'); }
            },
          }, review.hidden ? 'Показать' : 'Скрыть'),
          el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button',
            onclick: async () => {
              if (!await confirmDialog('Удалить отзыв навсегда?')) return;
              try {
                await state.backend.deleteReview(review.id);
                state.reviews.items = state.reviews.items.filter((r) => r.id !== review.id);
                renderReviewsPane();
                loadStats();
                toast('Отзыв удалён', 'info');
              } catch (error) { toast(error.message, 'error'); }
            },
          }, 'Удалить'),
          el('a', { class: 'btn btn-ghost btn-sm', href: `job.html?id=${encodeURIComponent(review.jobId)}` }, 'К вакансии'),
        ),
      ));
    }
    if (state.reviews.hasMore) {
      body.append(el('button', { class: 'btn btn-block mt-16', type: 'button', onclick: () => loadReviews(false) }, 'Показать ещё'));
    }
  }

  panel.append(body);
  host.append(panel);
}
