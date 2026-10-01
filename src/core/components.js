/** Переиспользуемые куски интерфейса: карточка вакансии, индикаторы совпадения. */

import { el } from './ui.js';
import { salaryRange, levelLabel, employmentLabel, timeAgo, initials } from './format.js';
import { matchJob, verdictFor } from '../ai/match.js';

/**
 * Аватар пользователя: картинка из Firebase Storage, если она загружена,
 * иначе инициалы на градиенте. Один компонент на шапку, профиль и отзывы —
 * чтобы кружок везде выглядел одинаково.
 *
 * @param {{displayName?:string, userName?:string, photoURL?:string}} user
 * @param {number} size сторона кружка в пикселях
 */
export function avatarEl(user = {}, size = 32) {
  const name = user.displayName || user.userName || '';
  // photoURL — профиль, userPhotoURL — денормализованная копия в отзыве.
  const photo = user.photoURL || user.userPhotoURL || null;
  const style = `width:${size}px;height:${size}px;font-size:${Math.max(9, Math.round(size * 0.4))}px`;
  if (photo) {
    return el('img', {
      class: 'avatar avatar-img',
      style,
      src: photo,
      alt: name ? `Аватар: ${name}` : 'Аватар',
      loading: 'lazy',
      // Битая ссылка (файл удалён из бакета) не должна оставлять пустой квадрат.
      onerror: (e) => e.currentTarget.replaceWith(el('span', { class: 'avatar', style }, initials(name))),
    });
  }
  return el('span', { class: 'avatar', style }, initials(name));
}

/**
 * Логотип компании: загруженная картинка, иначе эмодзи из справочника.
 * Принимает и вакансию (`company.logoUrl`), и денормализованную запись
 * сохранённой вакансии или отклика (`companyLogoUrl`).
 */
export function companyLogoEl(source = {}, size = 44) {
  const url = source.company?.logoUrl || source.companyLogoUrl || null;
  const emoji = source.company?.logo || source.companyLogo || '💼';
  const name = source.companyName || source.company?.name || 'компания';
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`;
  if (url) {
    return el('img', {
      class: 'company-logo company-logo-img',
      style,
      src: url,
      alt: `Логотип ${name}`,
      loading: 'lazy',
      onerror: (e) => e.currentTarget.replaceWith(el('div', { class: 'company-logo', style }, emoji)),
    });
  }
  return el('div', { class: 'company-logo', style }, emoji);
}

/** Компактный индикатор «подхожу на N%». */
export function matchBadge(score) {
  const verdict = verdictFor(score);
  return el('span', { class: `match ${verdict.tone}`, title: verdict.label },
    el('span', { class: 'match-ring' }, String(score)),
    el('span', {}, 'совпадение'),
  );
}

/** Крупный круговой индикатор. */
export function matchGauge(score) {
  const verdict = verdictFor(score);
  return el('div', {
    class: 'gauge-circle',
    style: `--p:${score};--gauge-color:${verdict.color}`,
  }, el('span', { class: 'gauge-value' }, `${score}%`));
}

/**
 * Карточка вакансии для каталога и списков.
 * @param {object} job
 * @param {{resume?:object, isSaved?:boolean, onToggleSave?:Function, isNew?:boolean}} options
 */
export function jobCard(job, options = {}) {
  const { resume, isSaved = false, onToggleSave, isNew = false } = options;
  const match = resume ? matchJob(resume, job) : null;

  const card = el('a', {
    class: `job-card${isNew ? ' is-new' : ''}`,
    href: `job.html?id=${encodeURIComponent(job.id)}`,
    dataset: { jobId: job.id },
  });

  card.append(el('div', { class: 'job-card-head' },
    companyLogoEl(job),
    el('div', { class: 'job-card-main' },
      el('h3', {}, job.title),
      el('p', { class: 'job-company' }, `${job.companyName || job.company?.name || ''} · ${job.city}${job.remote ? ' · можно удалённо' : ''}`),
    ),
  ));

  const meta = el('div', { class: 'job-meta' },
    el('span', { class: 'chip' }, levelLabel(job.level)),
    el('span', { class: 'chip' }, employmentLabel(job.employment)),
    ...(job.skills || []).slice(0, 3).map((s) => el('span', { class: 'chip' }, s)),
    (job.skills || []).length > 3 ? el('span', { class: 'chip' }, `+${job.skills.length - 3}`) : null,
  );
  card.append(meta);

  card.append(el('div', { class: 'job-card-foot' },
    el('span', { class: 'job-salary' }, salaryRange(job.salaryMin, job.salaryMax)),
    el('span', { class: 'row', style: 'gap:8px' },
      match ? matchBadge(match.score) : null,
      el('span', { class: 'faint' }, timeAgo(job.createdAt)),
    ),
  ));

  if (onToggleSave) {
    const btn = el('button', {
      class: `save-btn${isSaved ? ' active' : ''}`,
      type: 'button',
      title: isSaved ? 'Убрать из сохранённых' : 'Сохранить вакансию',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggleSave(job, match ? match.score : 0, btn);
      },
    }, '★');
    card.append(btn);
  }

  return card;
}

/** Строка разбора оценки: критерий, полоса, вклад в итог. */
export function breakdownRow(item) {
  return el('div', { class: 'bar-row', title: item.detail },
    el('span', { class: 'muted' }, item.label),
    el('span', { class: 'bar' }, el('span', { style: `width:${item.score}%` })),
    el('span', { class: 'faint nowrap' }, `${item.points}/${item.weight}`),
  );
}

/** Кнопка «Показать ещё» с обработкой состояния загрузки. */
export function loadMoreButton(onClick, label = 'Показать ещё') {
  const btn = el('button', { class: 'btn btn-block', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Загружаю…';
    try {
      await onClick();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return btn;
}

