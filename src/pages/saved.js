/**
 * Функциональная страница «Сохранённые вакансии» (saved.html).
 *
 * Требование ТЗ 3.4: список активных действий с управлением и финализацией.
 * Здесь это аналог корзины: выбранные вакансии превращаются в отклики,
 * после чего исчезают отсюда и появляются в истории личного кабинета.
 *
 * Список работает на onSnapshot — если открыть страницу в двух вкладках,
 * изменения видны в обеих.
 */

import { bootstrap } from '../core/page.js';
import { $, el, toast, emptyState, skeletons, confirmDialog, openModal } from '../core/ui.js';
import { salaryRange, levelLabel, timeAgo, money, counted } from '../core/format.js';
import { matchBadge, companyLogoEl } from '../core/components.js';
import { resumeOf, matchJob, isResumeReady } from '../ai/match.js';

const state = {
  backend: null,
  user: null,
  resume: null,
  items: [],
  selected: new Set(),
  sort: 'new',
  unsub: null,
};

bootstrap({ active: 'saved', requireAuth: true }).then(({ backend, user }) => {
  state.backend = backend;
  state.user = user;
  state.resume = resumeOf(user);

  skeletons($('#saved-list'), 3);

  state.unsub = backend.watchSaved(user.uid, (items) => {
    state.items = items;
    // Выбранные, которых больше нет в списке, снимаем.
    state.selected = new Set([...state.selected].filter((id) => items.some((i) => i.jobId === id)));
    render();
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('#select-all').addEventListener('change', (e) => {
    state.selected = e.target.checked ? new Set(state.items.map((i) => i.jobId)) : new Set();
    render();
  });
  $('#clear-all').addEventListener('click', clearAll);
});

function sortedItems() {
  const items = [...state.items];
  if (state.sort === 'match') items.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  else if (state.sort === 'salary') items.sort((a, b) => (b.salaryMax || 0) - (a.salaryMax || 0));
  else items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return items;
}

function render() {
  const host = $('#saved-list');

  if (!state.items.length) {
    emptyState(host, '☆', 'Здесь пока пусто',
      'Открывайте вакансии в каталоге и жмите звёздочку — они соберутся здесь.');
    host.append(el('div', { class: 'center' }, el('a', { class: 'btn btn-primary', href: 'index.html' }, 'В каталог')));
    renderSummary();
    return;
  }

  host.innerHTML = '';
  for (const item of sortedItems()) {
    host.append(savedCard(item));
  }
  $('#select-all').checked = state.selected.size === state.items.length && state.items.length > 0;
  renderSummary();
}

function savedCard(item) {
  const checked = state.selected.has(item.jobId);

  const card = el('div', { class: 'job-card', style: 'cursor:default' },
    el('div', { class: 'job-card-head' },
      el('label', { class: 'checkbox', style: 'align-self:center' },
        el('input', {
          type: 'checkbox',
          checked: checked ? 'checked' : null,
          onchange: (e) => {
            if (e.target.checked) state.selected.add(item.jobId);
            else state.selected.delete(item.jobId);
            renderSummary();
            $('#select-all').checked = state.selected.size === state.items.length;
          },
        }),
      ),
      companyLogoEl(item),
      el('div', { class: 'job-card-main' },
        el('a', { href: `job.html?id=${encodeURIComponent(item.jobId)}`, style: 'color:var(--text)' },
          el('h3', { style: 'margin-bottom:3px' }, item.jobTitle)),
        el('p', { class: 'job-company mb-0' }, `${item.companyName} · ${item.city}${item.remote ? ' · удалённо' : ''}`),
      ),
    ),

    el('div', { class: 'job-meta' },
      el('span', { class: 'chip' }, levelLabel(item.level)),
      el('span', { class: 'chip' }, salaryRange(item.salaryMin, item.salaryMax)),
      item.matchScore ? matchBadge(item.matchScore) : null,
    ),

    item.note ? el('p', { class: 'faint mt-8 mb-0' }, `Заметка: ${item.note}`) : null,

    el('div', { class: 'job-card-foot' },
      el('span', { class: 'faint' }, `Сохранено ${timeAgo(item.createdAt)}`),
      el('span', { class: 'row', style: 'gap:6px' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openNote(item) }, item.note ? 'Изменить заметку' : 'Заметка'),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => remove(item) }, 'Убрать'),
      ),
    ),
  );

  return card;
}

function renderSummary() {
  const host = $('#summary');
  const chosen = state.items.filter((i) => state.selected.has(i.jobId));
  const avgMatch = chosen.length
    ? Math.round(chosen.reduce((s, i) => s + (i.matchScore || 0), 0) / chosen.length)
    : 0;
  const avgSalary = chosen.length
    ? Math.round(chosen.reduce((s, i) => s + (i.salaryMax || i.salaryMin || 0), 0) / chosen.length)
    : 0;

  host.innerHTML = '';
  host.append(el('h3', {}, 'Отклик одной кнопкой'));
  host.append(el('p', { class: 'muted' }, `Выбрано: ${counted(chosen.length, 'вакансия', 'вакансии', 'вакансий')} из ${state.items.length}`));

  if (chosen.length) {
    host.append(el('div', { class: 'stat-grid', style: 'grid-template-columns:1fr 1fr;margin-bottom:14px' },
      el('div', { class: 'stat' },
        el('div', { class: 'stat-value' }, `${avgMatch}%`),
        el('div', { class: 'stat-label' }, 'среднее совпадение')),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-value', style: 'font-size:18px' }, avgSalary ? money(avgSalary) : '—'),
        el('div', { class: 'stat-label' }, 'средний потолок ₸')),
    ));
  }

  host.append(el('button', {
    class: 'btn btn-primary btn-block btn-lg',
    type: 'button',
    disabled: !chosen.length,
    onclick: () => finalize(chosen),
  }, chosen.length ? `Откликнуться (${chosen.length})` : 'Выберите вакансии'));

  host.append(el('p', { class: 'faint mt-16 mb-0' },
    'После отправки вакансии уходят из этого списка, а отклики появляются в разделе «История» личного кабинета со статусом «Отправлен».'));
}

/* --------------------------------------------------------------- действия */

async function remove(item) {
  try {
    await state.backend.unsaveJob(state.user.uid, item.jobId);
    state.selected.delete(item.jobId);
    toast('Убрано из сохранённых', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

async function clearAll() {
  if (!state.items.length) return;
  if (!await confirmDialog(`Убрать все ${state.items.length} вакансий из сохранённых?`, { okLabel: 'Очистить' })) return;
  try {
    await Promise.all(state.items.map((i) => state.backend.unsaveJob(state.user.uid, i.jobId)));
    state.selected.clear();
    toast('Список очищен', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

function openNote(item) {
  const textarea = el('textarea', { class: 'textarea', rows: '3', maxlength: '300', placeholder: 'Например: написать рекрутеру в понедельник' });
  textarea.value = item.note || '';
  openModal({
    title: item.jobTitle,
    body: el('div', {}, el('label', { class: 'faint' }, 'Личная заметка — видна только вам'), textarea),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: 'Сохранить', kind: 'btn-primary', onClick: async (close) => {
        await state.backend.updateSavedNote(state.user.uid, item.jobId, textarea.value.trim());
        close();
        toast('Заметка сохранена', 'success');
      } },
    ],
  });
}

/** Финализация: превращаем сохранённые вакансии в отклики. */
async function finalize(chosen) {
  const letter = el('textarea', { class: 'textarea', rows: '5', maxlength: '2000' });
  letter.value = 'Здравствуйте!\n\nЗаинтересован в вашей вакансии, буду рад обсудить детали и пройти техническое интервью.';

  openModal({
    title: `Отправить ${counted(chosen.length, 'отклик', 'отклика', 'откликов')}`,
    size: 'modal-lg',
    body: el('div', {},
      el('ul', {}, chosen.map((i) => el('li', {}, `${i.jobTitle} — ${i.companyName}`))),
      el('div', { class: 'field' },
        el('label', {}, 'Общее сопроводительное письмо'),
        letter,
      ),
      el('p', { class: 'faint mb-0' }, 'К каждому отклику приложится процент соответствия, посчитанный по вашему резюме.'),
    ),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: 'Отправить', kind: 'btn-primary', onClick: async (close) => {
        const results = { ok: 0, fail: 0 };
        const ready = isResumeReady(state.resume);

        for (const item of chosen) {
          try {
            const job = await state.backend.getJob(item.jobId);
            if (!job || job.status !== 'open') { results.fail += 1; continue; }
            const score = ready ? matchJob(state.resume, job).score : (item.matchScore || 0);
            await state.backend.applyToJob({
              user: state.user, job, coverLetter: letter.value.trim(), matchScore: score,
            });
            await state.backend.unsaveJob(state.user.uid, item.jobId);
            results.ok += 1;
          } catch (_) {
            results.fail += 1;
          }
        }

        close();
        state.selected.clear();
        if (results.ok) toast(`Отправлено откликов: ${results.ok}. Смотрите статусы в кабинете`, 'success', 5000);
        if (results.fail) toast(`Не удалось отправить: ${results.fail} (уже откликались или вакансия закрыта)`, 'error', 6000);
      } },
    ],
  });
}
