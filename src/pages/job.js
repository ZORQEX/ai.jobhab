/**
 * Страница детального просмотра вакансии (job.html).
 *
 * Требования ТЗ 3.2:
 *  • полная информация о вакансии;
 *  • интерактив — отзывы с оценкой, редактирование и удаление своих;
 *  • связанные элементы (похожие вакансии) с пагинацией;
 *  • основное действие — отклик, плюс сохранение;
 *  • real-time: статус вакансии, счётчик откликов и новые отзывы.
 */

import { bootstrap, onUser } from '../core/page.js';
import { $, el, qs, toast, openModal, confirmDialog, emptyState } from '../core/ui.js';
import { jobCard, matchGauge, breakdownRow, loadMoreButton, companyLogoEl, avatarEl } from '../core/components.js';
import { salaryRange, levelLabel, employmentLabel, categoryLabel, timeAgo, dateShort, stars, counted } from '../core/format.js';
import { matchJob, resumeOf, isResumeReady } from '../ai/match.js';
import { APP } from '../config.js';

const state = {
  backend: null,
  user: null,
  resume: null,
  job: null,
  match: null,
  isSaved: false,
  applied: false,
  reviews: [],
  similar: [],
  similarCursor: null,
  similarHasMore: false,
  unsubJob: null,
  unsubSaved: null,
  unsubReviews: null,
  viewCounted: false,
};

const jobId = qs('id');

bootstrap({ active: 'catalog' }).then(async ({ backend, user }) => {
  state.backend = backend;
  state.user = user;
  state.resume = resumeOf(user);

  if (!jobId) {
    $('#job-layout').innerHTML = '';
    emptyState($('#job-layout'), '🤷', 'Вакансия не выбрана', 'Вернитесь в каталог и откройте любую вакансию.');
    return;
  }

  state.unsubJob = backend.watchJob(jobId, (job) => {
    if (!job) {
      $('#job-layout').innerHTML = '';
      emptyState($('#job-layout'), '🗑️', 'Вакансия не найдена', 'Возможно, её удалил администратор.');
      return;
    }
    const isFirst = !state.job;
    state.job = job;
    state.match = matchJob(state.resume, job);
    renderMain();
    renderAside();
    if (isFirst) {
      loadSimilar(true);
      backend.incrementViews(job.id);
      updatePageMeta(job);
    }
  });

  state.unsubReviews = backend.watchReviews(jobId, (items) => {
    state.reviews = items;
    renderReviews();
  });

  await refreshUserState();

  onUser(async (nextUser) => {
    state.user = nextUser;
    state.resume = resumeOf(nextUser);
    if (state.job) state.match = matchJob(state.resume, state.job);
    await refreshUserState();
    renderMain();
    renderAside();
  });
});

/** Заголовок вкладки и Open Graph-теги из самой вакансии. */
function updatePageMeta(job) {
  const company = job.companyName || job.company?.name || '';
  const title = `${job.title} — ${company} | AI JobHub`;
  const description = `${salaryRange(job.salaryMin, job.salaryMax)} · ${job.city}`
    + `${job.remote ? ' · можно удалённо' : ''} · ${levelLabel(job.level)}. ${
     String(job.description || '').slice(0, 140)}`;

  document.title = title;

  const set = (kind, key, value) => {
    let tag = document.head.querySelector(`meta[${kind}="${key}"]`);
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute(kind, key);
      document.head.append(tag);
    }
    tag.setAttribute('content', value);
  };

  set('name', 'description', description);
  set('property', 'og:title', title);
  set('property', 'og:description', description);
  set('property', 'og:url', location.href);
}

async function refreshUserState() {
  if (state.unsubSaved) { state.unsubSaved(); state.unsubSaved = null; }
  state.isSaved = false;
  state.applied = false;

  if (!state.user) { renderAside(); return; }

  state.unsubSaved = state.backend.watchSaved(state.user.uid, (items) => {
    state.isSaved = items.some((i) => i.jobId === jobId);
    renderAside();
  });
  state.applied = await state.backend.hasApplied(state.user.uid, jobId);
  renderAside();
}

/* ------------------------------------------------------- основная колонка */

function bulletList(title, items) {
  if (!items || !items.length) return null;
  return el('div', {},
    el('h3', {}, title),
    el('ul', {}, items.map((item) => el('li', {}, item))),
  );
}

function renderMain() {
  const job = state.job;
  const host = $('#job-main');
  host.innerHTML = '';

  const closed = job.status !== 'open';

  host.append(el('div', { class: 'card' },
    closed ? el('div', { class: 'banner' }, el('span', {}, '⛔'),
      el('span', {}, `Вакансия ${job.status === 'closed' ? 'закрыта' : 'в черновике'} — отклик недоступен. Статус обновляется в реальном времени.`)) : null,

    el('div', { class: 'job-card-head' },
      companyLogoEl(job, 56),
      el('div', { class: 'job-card-main' },
        el('h1', { style: 'font-size:24px;margin-bottom:4px' }, job.title),
        el('p', { class: 'job-company mb-0' },
          `${job.companyName || job.company?.name} · ${job.company?.industry || ''} · ${job.company?.size || ''} сотрудников`),
      ),
    ),

    el('div', { class: 'row mt-16' },
      el('span', { class: 'job-salary', style: 'font-size:19px' }, salaryRange(job.salaryMin, job.salaryMax)),
    ),

    el('div', { class: 'job-meta' },
      el('span', { class: 'chip chip-accent' }, categoryLabel(job.category)),
      el('span', { class: 'chip' }, levelLabel(job.level)),
      el('span', { class: 'chip' }, employmentLabel(job.employment)),
      el('span', { class: 'chip' }, job.city),
      job.remote ? el('span', { class: 'chip chip-success' }, 'Удалённо') : null,
      job.experienceYears ? el('span', { class: 'chip' }, `опыт от ${job.experienceYears} лет`) : null,
    ),

    el('div', { class: 'job-card-foot' },
      el('span', { class: 'faint' }, `Опубликовано ${timeAgo(job.createdAt)}`),
      el('span', { class: 'row', style: 'gap:12px' },
        el('span', { class: 'live-dot' }, el('i', {}), `${counted(job.applicationsCount || 0, 'отклик', 'отклика', 'откликов')}`),
        el('span', { class: 'faint' }, `${counted(job.viewsCount || 0, 'просмотр', 'просмотра', 'просмотров')}`),
      ),
    ),

    // На узком экране кнопки действия показываются здесь, а не в боковой колонке.
    el('div', { class: 'mobile-actions', id: 'mobile-actions' }),
  ));

  host.append(el('div', { class: 'card desc-block' },
    el('h2', {}, 'О вакансии'),
    el('p', {}, job.description),
    bulletList('Что нужно делать', job.responsibilities),
    bulletList('Требования', job.requirements),
    bulletList('Будет плюсом', job.niceToHave),
    bulletList('Условия', job.benefits),
    (job.skills || []).length ? el('div', {},
      el('h3', {}, 'Навыки'),
      el('div', { class: 'chip-list' }, job.skills.map((s) => {
        const known = state.match?.matchedSkills.some((m) => m === s.toLowerCase() || s.toLowerCase().includes(m));
        return el('span', { class: `chip ${known ? 'chip-success' : ''}`, title: known ? 'Есть в вашем резюме' : 'Нет в вашем резюме' }, s);
      })),
    ) : null,
  ));

  host.append(el('div', { class: 'card', id: 'reviews-card' }));
  host.append(el('div', { class: 'card', id: 'similar-card' }));

  renderReviews();
  renderSimilar();
}

/* --------------------------------------------------------- боковая панель */

/** Основное действие + сохранение. Один набор кнопок на две точки вывода. */
function actionButtons(closed) {
  const nodes = [];

  if (state.applied) {
    nodes.push(el('button', { class: 'btn btn-block btn-lg', type: 'button', disabled: true }, '✓ Отклик отправлен'));
    nodes.push(el('a', { class: 'btn btn-ghost btn-block', href: 'profile.html' }, 'Смотреть в кабинете'));
  } else {
    nodes.push(el('button', {
      class: 'btn btn-primary btn-block btn-lg',
      type: 'button',
      disabled: closed,
      onclick: openApplyModal,
    }, closed ? 'Приём откликов закрыт' : 'Откликнуться'));
  }

  nodes.push(el('button', {
    class: `btn btn-block${state.isSaved ? ' btn-danger' : ''}`,
    type: 'button',
    onclick: toggleSave,
  }, state.isSaved ? '★ Убрать из сохранённых' : '☆ Сохранить вакансию'));

  return nodes;
}

function renderAside() {
  const host = $('#job-aside');
  if (!state.job) return;
  const job = state.job;
  const match = state.match;
  const ready = isResumeReady(state.resume);
  const closed = job.status !== 'open';

  host.innerHTML = '';

  const actions = el('div', { class: 'card sticky actions-card' }, actionButtons(closed));
  host.append(actions);

  // Тот же набор кнопок дублируется в основной колонке для мобильной вёрстки.
  const mobile = $('#mobile-actions');
  if (mobile) {
    mobile.innerHTML = '';
    mobile.append(...actionButtons(closed));
  }

  /* --- карточка AI-анализа --- */

  const ai = el('div', { class: 'card' });
  ai.append(el('div', { class: 'card-title' },
    el('h3', {}, 'AI-анализ соответствия'),
  ));

  if (!state.user) {
    ai.append(el('p', { class: 'muted' }, 'Войдите и заполните резюме — покажем, насколько вы подходите и чего не хватает.'));
    ai.append(el('a', { class: 'btn btn-block', href: `auth.html?next=${encodeURIComponent(`job.html?id=${jobId}`)}` }, 'Войти'));
    host.append(ai);
    return;
  }

  if (!ready) {
    ai.append(el('p', { class: 'muted' }, 'Резюме почти пустое: укажите грейд и хотя бы 3 навыка, чтобы оценка была честной.'));
    ai.append(el('a', { class: 'btn btn-block', href: 'profile.html#resume' }, 'Заполнить резюме'));
    host.append(ai);
    return;
  }

  ai.append(el('div', { class: 'gauge' },
    matchGauge(match.score),
    el('div', {},
      el('div', { style: `font-weight:650;color:${match.verdict.color}` }, match.verdict.label),
      el('div', { class: 'faint' }, `подхожу на ${match.score}%`),
    ),
  ));

  ai.append(el('hr', { class: 'divider' }));
  ai.append(el('div', {}, match.breakdown.map(breakdownRow)));

  if (match.missingSkills.length) {
    ai.append(el('hr', { class: 'divider' }));
    ai.append(el('h4', { style: 'margin:0 0 8px;font-size:14px' }, 'Чего не хватает в резюме'));
    ai.append(el('div', { class: 'chip-list' }, match.missingSkills.map((s) => el('span', { class: 'chip chip-danger' }, s))));
  }

  if (match.advice.length) {
    ai.append(el('hr', { class: 'divider' }));
    ai.append(el('h4', { style: 'margin:0 0 8px;font-size:14px' }, 'Что сделать'));
    ai.append(el('ul', { class: 'timeline' }, match.advice.map((tip) => el('li', {}, tip))));
  }

  host.append(ai);
}

/* --------------------------------------------------------------- действия */

async function toggleSave() {
  if (!state.user) {
    location.href = `auth.html?next=${encodeURIComponent(`job.html?id=${jobId}`)}`;
    return;
  }
  try {
    if (state.isSaved) {
      await state.backend.unsaveJob(state.user.uid, jobId);
      toast('Убрано из сохранённых', 'info');
    } else {
      await state.backend.saveJob(state.user.uid, state.job, state.match.score);
      toast('Вакансия сохранена', 'success');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function coverLetterTemplate() {
  const match = state.match;
  const strong = match.matchedSkills.slice(0, 4).join(', ');
  return `Здравствуйте!\n\nОткликаюсь на вакансию «${state.job.title}».${
     strong ? `\nИз ваших требований у меня есть опыт с: ${strong}.` : ''
     }${state.resume.yearsExperience ? `\nОпыт коммерческой разработки — ${state.resume.yearsExperience} г.` : ''
     }\n\nБуду рад обсудить детали.`;
}

function openApplyModal() {
  if (!state.user) {
    location.href = `auth.html?next=${encodeURIComponent(`job.html?id=${jobId}`)}`;
    return;
  }

  const textarea = el('textarea', { class: 'textarea', rows: '7', maxlength: '2000' });
  textarea.value = coverLetterTemplate();

  openModal({
    title: `Отклик: ${state.job.title}`,
    size: 'modal-lg',
    body: el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:14px' },
        el('span', { class: 'chip chip-accent' }, `AI: подхожу на ${state.match.score}%`),
        state.match.missingSkills.length
          ? el('span', { class: 'chip chip-warning' }, `нет: ${state.match.missingSkills.slice(0, 3).join(', ')}`)
          : el('span', { class: 'chip chip-success' }, 'все обязательные навыки закрыты'),
      ),
      el('div', { class: 'field' },
        el('label', {}, 'Сопроводительное письмо'),
        textarea,
      ),
      el('p', { class: 'faint mb-0' }, 'Оценка соответствия сохранится вместе с откликом — её увидит и работодатель, и вы в истории.'),
    ),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: 'Отправить отклик', kind: 'btn-primary', onClick: async (close) => {
        try {
          await state.backend.applyToJob({
            user: state.user,
            job: state.job,
            coverLetter: textarea.value.trim(),
            matchScore: state.match.score,
          });
          state.applied = true;
          close();
          renderAside();
          toast('Отклик отправлен. Статус можно отслеживать в личном кабинете', 'success', 5000);
        } catch (error) {
          toast(error.message, 'error');
        }
      } },
    ],
  });
}

/* ---------------------------------------------------------------- отзывы */

function renderReviews() {
  const host = $('#reviews-card');
  if (!host) return;
  host.innerHTML = '';

  const avg = state.reviews.length
    ? (state.reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / state.reviews.length)
    : 0;

  host.append(el('div', { class: 'card-title' },
    el('h2', {}, 'Отзывы о работодателе'),
    state.reviews.length
      ? el('span', { class: 'row', style: 'gap:6px' },
        el('span', { class: 'stars' }, stars(avg)),
        el('span', { class: 'faint' }, `${avg.toFixed(1)} · ${counted(state.reviews.length, 'отзыв', 'отзыва', 'отзывов')}`))
      : el('span', { class: 'faint' }, 'пока нет отзывов'),
  ));

  const mine = state.user ? state.reviews.find((r) => r.userId === state.user.uid) : null;

  if (state.user && !mine) {
    host.append(reviewForm());
    host.append(el('hr', { class: 'divider' }));
  } else if (!state.user) {
    host.append(el('p', { class: 'faint' },
      el('a', { href: `auth.html?next=${encodeURIComponent(`job.html?id=${jobId}`)}` }, 'Войдите'),
      ', чтобы оставить отзыв о работодателе.'));
  }

  if (!state.reviews.length) {
    host.append(el('p', { class: 'muted mb-0' }, 'Будьте первым, кто расскажет об опыте работы или собеседования здесь.'));
    return;
  }

  const list = el('div', {});
  for (const review of state.reviews) {
    const own = state.user && review.userId === state.user.uid;
    list.append(el('div', { class: 'review' },
      el('div', { class: 'review-head' },
        avatarEl(review, 32),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { style: 'font-weight:600' }, review.userName || 'Аноним'),
          el('div', { class: 'faint' }, dateShort(review.createdAt)),
        ),
        el('span', { class: 'stars' }, stars(review.rating)),
      ),
      el('p', { class: 'mb-0' }, review.text),
      own ? el('div', { class: 'row mt-8' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openEditReview(review) }, 'Редактировать'),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => removeReview(review) }, 'Удалить'),
      ) : null,
    ));
  }
  host.append(list);
}

function ratingInput(initial = 5) {
  let value = initial;
  const wrap = el('div', { class: 'rating-input' });
  const paint = () => Array.from(wrap.children).forEach((b, i) => b.classList.toggle('on', i < value));
  for (let i = 1; i <= 5; i += 1) {
    wrap.append(el('button', {
      type: 'button', 'aria-label': `${i} из 5`,
      onclick: () => { value = i; paint(); },
    }, '★'));
  }
  paint();
  return { node: wrap, get value() { return value; } };
}

function reviewForm() {
  const rating = ratingInput(5);
  const textarea = el('textarea', { class: 'textarea', rows: '3', maxlength: '1500', placeholder: 'Как проходило собеседование? Что понравилось в компании?' });

  const form = el('form', { class: 'field' },
    el('label', {}, 'Ваш отзыв'),
    el('div', { class: 'row', style: 'margin-bottom:8px' }, rating.node),
    textarea,
    el('button', { class: 'btn btn-primary mt-8', type: 'submit' }, 'Опубликовать отзыв'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (text.length < 10) return toast('Напишите хотя бы пару предложений', 'error');
    try {
      await state.backend.addReview({ job: state.job, user: state.user, rating: rating.value, text });
      textarea.value = '';
      toast('Спасибо! Отзыв опубликован', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

function openEditReview(review) {
  const rating = ratingInput(review.rating);
  const textarea = el('textarea', { class: 'textarea', rows: '4', maxlength: '1500' });
  textarea.value = review.text;

  openModal({
    title: 'Редактирование отзыва',
    body: el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:10px' }, rating.node),
      textarea,
    ),
    actions: [
      { label: 'Отмена', kind: 'btn-ghost', onClick: (close) => close() },
      { label: 'Сохранить', kind: 'btn-primary', onClick: async (close) => {
        try {
          await state.backend.updateReview(review.id, { rating: rating.value, text: textarea.value.trim() });
          close();
          toast('Отзыв обновлён', 'success');
        } catch (error) { toast(error.message, 'error'); }
      } },
    ],
  });
}

async function removeReview(review) {
  if (!await confirmDialog('Удалить ваш отзыв? Это действие необратимо.')) return;
  try {
    await state.backend.deleteReview(review.id, review.userId);
    toast('Отзыв удалён', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

/* ------------------------------------------------ похожие вакансии (пагинация) */

async function loadSimilar(reset = false) {
  if (reset) { state.similar = []; state.similarCursor = null; }
  const result = await state.backend.listSimilar(state.job, {
    pageSize: APP.similarPageSize,
    cursor: state.similarCursor,
  });
  state.similar.push(...result.items.filter((j) => j.id !== state.job.id));
  state.similarCursor = result.cursor;
  state.similarHasMore = result.hasMore;
  renderSimilar();
}

function renderSimilar() {
  const host = $('#similar-card');
  if (!host) return;
  host.innerHTML = '';
  host.append(el('div', { class: 'card-title' }, el('h2', {}, 'Похожие вакансии')));

  if (!state.similar.length) {
    host.append(el('p', { class: 'muted mb-0' }, 'Похожих вакансий пока нет.'));
    return;
  }

  const grid = el('div', { class: 'job-grid' });
  const ready = isResumeReady(state.resume);
  for (const job of state.similar) {
    grid.append(jobCard(job, { resume: ready ? state.resume : null }));
  }
  host.append(grid);

  if (state.similarHasMore) {
    host.append(el('div', { class: 'mt-16' }, loadMoreButton(() => loadSimilar(false), 'Показать ещё похожие')));
  }
}
