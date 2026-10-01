/**
 * Каталог вакансий (index.html).
 *
 * Требования ТЗ 3.1: пагинация «Показать ещё», поиск через запросы к БД,
 * фильтрация, сортировка и режим реального времени.
 *
 * Как устроено: первая страница живёт на подписке onSnapshot и обновляется
 * сама, а «Показать ещё» дозагружает следующие страницы курсором startAfter
 * и складывает их в state.extra. Итоговый список = снимок + дозагруженное.
 */

import { bootstrap, onUser } from '../core/page.js';
import { $, el, debounce, toast, skeletons, emptyState } from '../core/ui.js';
import { jobCard, loadMoreButton, matchBadge } from '../core/components.js';
import { APP, DICT } from '../config.js';
import { resumeOf, rankJobs, isResumeReady, skillGapReport } from '../ai/match.js';
import { counted } from '../core/format.js';

const state = {
  backend: null,
  user: null,
  resume: null,
  params: { q: '', category: '', city: '', level: '', employment: '', remote: false, minSalary: '', sort: 'new' },
  live: [],          // первая страница из onSnapshot
  extra: [],         // дозагруженные страницы
  cursor: null,
  hasMore: false,
  total: null,
  savedIds: new Set(),
  knownIds: new Set(),
  unsubJobs: null,
  unsubSaved: null,
  firstRender: true,
};

const QUICK = [
  { label: 'Frontend', patch: { category: 'frontend' } },
  { label: 'Backend', patch: { category: 'backend' } },
  { label: 'AI / ML', patch: { category: 'ai' } },
  { label: 'Удалённо', patch: { remote: true } },
  { label: 'Junior', patch: { level: 'junior' } },
  { label: 'Senior', patch: { level: 'senior' } },
  { label: 'От 800 000 ₸', patch: { minSalary: '800000' } },
];

/* ------------------------------------------------------------------ запуск */

bootstrap({ active: 'catalog' }).then(({ backend, user }) => {
  state.backend = backend;
  state.user = user;
  state.resume = resumeOf(user);

  readParamsFromUrl();
  buildFilters();
  buildQuickFilters();
  bindControls();
  subscribeSaved();
  reload();

  onUser((nextUser) => {
    state.user = nextUser;
    state.resume = resumeOf(nextUser);
    subscribeSaved();
    render();
    renderAiPicks();
  });
});

/* ------------------------------------------------------- параметры и URL */

function readParamsFromUrl() {
  const url = new URLSearchParams(location.search);
  for (const key of Object.keys(state.params)) {
    if (!url.has(key)) continue;
    const value = url.get(key);
    state.params[key] = key === 'remote' ? value === '1' : value;
  }
}

function writeParamsToUrl() {
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(state.params)) {
    if (!value || (key === 'sort' && value === 'new')) continue;
    url.set(key, key === 'remote' ? '1' : value);
  }
  const qs = url.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/* ---------------------------------------------------------------- фильтры */

function optionList(select, dict, placeholder) {
  select.append(el('option', { value: '' }, placeholder));
  for (const [value, label] of Object.entries(dict)) {
    select.append(el('option', { value }, label));
  }
}

function buildFilters() {
  const sort = $('#sort');
  optionList(sort, {
    new: 'Сначала новые',
    salaryDesc: 'Зарплата: по убыванию',
    salaryAsc: 'Зарплата: по возрастанию',
    popular: 'Больше откликов',
  }, 'Сортировка');
  sort.querySelector('option[value=""]').remove();
  sort.value = state.params.sort;

  optionList($('#f-category'), DICT.categories, 'Все направления');
  optionList($('#f-city'), Object.fromEntries(DICT.cities.map((c) => [c, c])), 'Любой город');
  optionList($('#f-level'), DICT.levels, 'Любой грейд');
  optionList($('#f-employment'), DICT.employment, 'Любая занятость');

  $('#search').value = state.params.q;
  $('#f-category').value = state.params.category;
  $('#f-city').value = state.params.city;
  $('#f-level').value = state.params.level;
  $('#f-employment').value = state.params.employment;
  $('#f-salary').value = state.params.minSalary;
  $('#f-remote').checked = state.params.remote;
}

function buildQuickFilters() {
  const host = $('#quick-filters');
  host.innerHTML = '';
  for (const item of QUICK) {
    const active = Object.entries(item.patch).every(([k, v]) => String(state.params[k]) === String(v));
    host.append(el('button', {
      class: `chip chip-btn${active ? ' chip-accent' : ''}`,
      type: 'button',
      onclick: () => {
        for (const [k, v] of Object.entries(item.patch)) {
          state.params[k] = active ? (typeof v === 'boolean' ? false : '') : v;
        }
        syncControls();
        reload();
      },
    }, item.label));
  }
}

function syncControls() {
  $('#search').value = state.params.q;
  $('#f-category').value = state.params.category;
  $('#f-city').value = state.params.city;
  $('#f-level').value = state.params.level;
  $('#f-employment').value = state.params.employment;
  $('#f-salary').value = state.params.minSalary;
  $('#f-remote').checked = state.params.remote;
  $('#sort').value = state.params.sort;
  buildQuickFilters();
}

function bindControls() {
  const onSearch = debounce((value) => { state.params.q = value.trim(); reload(); }, 350);
  $('#search').addEventListener('input', (e) => onSearch(e.target.value));

  $('#sort').addEventListener('change', (e) => { state.params.sort = e.target.value; reload(); });
  $('#f-category').addEventListener('change', (e) => { state.params.category = e.target.value; reload(); });
  $('#f-city').addEventListener('change', (e) => { state.params.city = e.target.value; reload(); });
  $('#f-level').addEventListener('change', (e) => { state.params.level = e.target.value; reload(); });
  $('#f-employment').addEventListener('change', (e) => { state.params.employment = e.target.value; reload(); });
  $('#f-remote').addEventListener('change', (e) => { state.params.remote = e.target.checked; reload(); });

  const onSalary = debounce((value) => { state.params.minSalary = value; reload(); }, 450);
  $('#f-salary').addEventListener('input', (e) => onSalary(e.target.value));

  $('#reset-filters').addEventListener('click', () => {
    state.params = { q: '', category: '', city: '', level: '', employment: '', remote: false, minSalary: '', sort: 'new' };
    syncControls();
    reload();
  });
}

/* -------------------------------------------------------------- загрузка */

function queryParams() {
  return { ...state.params, pageSize: APP.pageSize };
}

function reload() {
  writeParamsToUrl();
  buildQuickFilters();

  state.extra = [];
  state.cursor = null;
  state.hasMore = false;
  state.knownIds = new Set();
  state.firstRender = true;

  skeletons($('#job-list'), 4);
  $('#load-more-wrap').innerHTML = '';

  $('#filters-hint').textContent = state.params.minSalary
    ? 'При фильтре по зарплате Firestore сортирует по ней же — так требует диапазонный запрос.'
    : '';

  if (state.unsubJobs) state.unsubJobs();
  state.unsubJobs = state.backend.watchFirstPage(queryParams(), (result) => {
    const incoming = result.items;

    // Подсветка и уведомление о вакансиях, появившихся после открытия страницы.
    if (!state.firstRender) {
      const fresh = incoming.filter((job) => !state.knownIds.has(job.id));
      fresh.forEach((job) => { job.__isNew = true; });
      if (fresh.length === 1) {
        toast(`Новая вакансия по вашему фильтру: ${fresh[0].title}`, 'success', 6000);
      } else if (fresh.length > 1) {
        toast(`Появились новые вакансии по вашему фильтру: ${fresh.length}`, 'success', 6000);
      }
    }
    incoming.forEach((job) => state.knownIds.add(job.id));

    state.live = incoming;
    state.cursor = state.cursor || result.cursor;
    state.hasMore = result.hasMore;
    state.total = result.total ?? null;
    state.firstRender = false;

    render();
    renderAiPicks();
  }, (error) => showQueryError(error));
}

/**
 * Понятное сообщение вместо пустого списка.
 * Отдельно разбирается случай отсутствующего составного индекса: Firestore
 * кладёт в ошибку прямую ссылку на его создание — показываем её кнопкой.
 */
function showQueryError(error) {
  const host = $('#job-list');
  const isIndex = error?.code === 'failed-precondition';
  const url = error?.indexUrl
    || (String(error?.message || '').match(/https:\/\/console\.firebase\.google\.com\/\S+/) || [])[0];

  emptyState(
    host,
    isIndex ? '🗂️' : '⚠️',
    isIndex ? 'Для этого сочетания фильтров нужен индекс' : 'Не удалось загрузить вакансии',
    error?.message || '',
  );

  if (url) {
    host.querySelector('.empty').append(el('div', { class: 'mt-16' },
      el('a', { class: 'btn btn-sm', href: url.replace(/[).]+$/, ''), target: '_blank', rel: 'noopener' },
        'Создать индекс в Firebase Console'),
    ));
  }

  $('#results-info').textContent = '';
  $('#load-more-wrap').innerHTML = '';
}

async function loadMore() {
  try {
    const result = await state.backend.listJobs({ ...queryParams(), cursor: state.cursor });
    state.extra.push(...result.items);
    result.items.forEach((job) => state.knownIds.add(job.id));
    state.cursor = result.cursor;
    state.hasMore = result.hasMore;
    render();
  } catch (error) {
    toast(error.message, 'error', 6000);
  }
}

/* ---------------------------------------------------------------- saved */

function subscribeSaved() {
  if (state.unsubSaved) { state.unsubSaved(); state.unsubSaved = null; }
  state.savedIds = new Set();
  if (!state.user) { render(); return; }
  state.unsubSaved = state.backend.watchSaved(state.user.uid, (items) => {
    state.savedIds = new Set(items.map((i) => i.jobId));
    render();
  });
}

async function toggleSave(job, score) {
  if (!state.user) {
    toast('Войдите, чтобы сохранять вакансии', 'info');
    setTimeout(() => { location.href = `auth.html?next=${encodeURIComponent('index.html')}`; }, 900);
    return;
  }
  try {
    if (state.savedIds.has(job.id)) {
      await state.backend.unsaveJob(state.user.uid, job.id);
      toast('Убрано из сохранённых', 'info');
    } else {
      await state.backend.saveJob(state.user.uid, job, score);
      toast('Вакансия сохранена', 'success');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* --------------------------------------------------------------- отрисовка */

function visibleJobs() {
  const seen = new Set();
  const all = [];
  for (const job of [...state.live, ...state.extra]) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    all.push(job);
  }
  return all;
}

function render() {
  const host = $('#job-list');
  const jobs = visibleJobs();
  const hasResume = isResumeReady(state.resume);

  if (!jobs.length) {
    emptyState(host, '🔍', 'Ничего не нашлось',
      'Попробуйте изменить фильтры или очистить поисковый запрос.');
    $('#results-info').textContent = '';
    $('#load-more-wrap').innerHTML = '';
    return;
  }

  host.innerHTML = '';
  for (const job of jobs) {
    host.append(jobCard(job, {
      resume: hasResume ? state.resume : null,
      isSaved: state.savedIds.has(job.id),
      isNew: job.__isNew,
      onToggleSave: toggleSave,
    }));
    delete job.__isNew;
  }

  $('#results-info').textContent = state.total !== null && state.total !== undefined
    ? `Показано ${jobs.length} из ${counted(state.total, 'вакансии', 'вакансий', 'вакансий')}`
    : `Показано ${counted(jobs.length, 'вакансия', 'вакансии', 'вакансий')}`;

  $('#live-indicator').innerHTML = '';
  $('#live-indicator').append(el('span', { class: 'live-dot', title: 'Список обновляется в реальном времени' },
    el('i', {}), 'обновляется автоматически'));

  const wrap = $('#load-more-wrap');
  wrap.innerHTML = '';
  if (state.hasMore) {
    wrap.append(loadMoreButton(loadMore, 'Показать ещё'));
  } else if (jobs.length > APP.pageSize) {
    wrap.append(el('p', { class: 'faint center' }, 'Это все вакансии по вашему запросу'));
  }
}

/* ------------------------------------------------ AI-подборка для профиля */

function renderAiPicks() {
  const host = $('#ai-picks');
  host.innerHTML = '';
  if (!state.user) return;

  if (!isResumeReady(state.resume)) {
    host.append(el('div', { class: 'banner' },
      el('span', {}, '🤖'),
      el('span', {},
        'Заполните резюме в личном кабинете — и каждая вакансия получит оценку «подхожу на N%», а здесь появится персональная подборка. ',
        el('a', { href: 'profile.html#resume' }, 'Заполнить резюме'),
      ),
    ));
    return;
  }

  const pool = visibleJobs();
  if (pool.length < 3) return;

  const top = rankJobs(state.resume, pool).slice(0, 3);
  const gaps = skillGapReport(state.resume, pool, 5);

  const grid = el('div', { class: 'job-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(240px,1fr))' });
  for (const { job, match } of top) {
    grid.append(el('a', { class: 'job-card', href: `job.html?id=${encodeURIComponent(job.id)}` },
      el('div', { class: 'row-between' },
        el('strong', {}, job.title),
        matchBadge(match.score),
      ),
      el('p', { class: 'job-company mt-8' }, job.companyName || job.company?.name),
      match.missingSkills.length
        ? el('p', { class: 'faint mb-0' }, `Не хватает: ${match.missingSkills.slice(0, 3).join(', ')}`)
        : el('p', { class: 'faint mb-0' }, 'Все обязательные навыки закрыты'),
    ));
  }

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h2', {}, 'AI подобрал для вас'),
      el('span', { class: 'faint' }, `по резюме: ${state.resume.title || 'без названия'}`),
    ),
    grid,
    gaps.length ? el('p', { class: 'faint mt-16 mb-0' },
      `Чаще всего в этих вакансиях требуют то, чего нет в вашем резюме: ${gaps.map((g) => `${g.skill} (${g.count})`).join(', ')}`,
    ) : null,
  ));
}
