/**
 * Демо-адаптер данных: localStorage вместо Firestore.
 *
 * Реализует ТОТ ЖЕ контракт, что и firebase-backend.js, поэтому страницы
 * не знают, откуда пришли данные. Нужен для двух вещей:
 *  • демонстрация на GitHub Pages без ключей Firebase;
 *  • возможность прощёлкать весь сценарий, не расходуя квоту Firestore.
 *
 * Подписки (watch*) эмулируют onSnapshot: слушатель вызывается сразу и затем
 * при каждом изменении коллекции, в том числе из другой вкладки — через
 * событие storage.
 */

import { APP } from '../config.js';
import { SEED_JOBS, SEED_REVIEWS, SEED_USERS } from './seed.js';
import { buildJobIndex, matchesQuery } from './job-index.js';

const K = {
  jobs: 'jobhub:demo:jobs',
  users: 'jobhub:demo:users',
  apps: 'jobhub:demo:applications',
  saved: 'jobhub:demo:saved',
  reviews: 'jobhub:demo:reviews',
  session: 'jobhub:demo:session',
  version: 'jobhub:demo:version',
};

const SCHEMA_VERSION = '3';
const LATENCY = 90;                 // искусственная задержка, чтобы были видны скелетоны

const bus = new EventTarget();
const emit = (name) => bus.dispatchEvent(new CustomEvent(`change:${name}`));
const sleep = (ms = LATENCY) => new Promise((r) => setTimeout(r, ms));
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function read(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[demo] не удалось записать в localStorage', e);
  }
}

window.addEventListener('storage', (e) => {
  const name = Object.entries(K).find(([, key]) => key === e.key)?.[0];
  if (name) emit(name);
});

/* --------------------------------------------------------------- хэш пароля */

async function hashPassword(password) {
  const data = new TextEncoder().encode(`jobhub::${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------- сидинг */

async function ensureSeeded() {
  if (localStorage.getItem(K.version) === SCHEMA_VERSION && read(K.jobs).length) return;

  const jobs = SEED_JOBS.map((job) => ({
    ...job,
    ...buildJobIndex(job),
    updatedAt: job.createdAt,
    publishedAt: job.createdAt,
  }));

  const users = [];
  for (const u of SEED_USERS) {
    const { password, ...rest } = u;
    users.push({
      ...rest,
      passwordHash: await hashPassword(password),
      disabled: false,
      stats: { applicationsCount: 0, savedCount: 0, reviewsCount: 0 },
      settings: { theme: 'dark', emailNotifications: true },
      createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const reviews = SEED_REVIEWS.map((r) => {
    const job = jobs[r.jobIndex];
    return {
      id: uid(),
      jobId: job.id,
      companyId: job.company.id,
      companyName: job.company.name,
      userId: `seed-${uid()}`,
      userName: r.userName,
      rating: r.rating,
      text: r.text,
      hidden: false,
      moderatedBy: null,
      createdAt: new Date(Date.now() - r.daysAgo * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - r.daysAgo * 86400000).toISOString(),
    };
  });

  write(K.jobs, jobs);
  write(K.users, users);
  write(K.reviews, reviews);
  write(K.apps, []);
  write(K.saved, []);
  localStorage.setItem(K.version, SCHEMA_VERSION);
  emit('jobs'); emit('users'); emit('reviews');
}

/* -------------------------------------------------------------------- auth */

const authListeners = new Set();

function sessionUid() {
  try { return localStorage.getItem(K.session); } catch (_) { return null; }
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function currentUserSync() {
  const id = sessionUid();
  if (!id) return null;
  return publicUser(read(K.users).find((u) => u.uid === id));
}

function notifyAuth() {
  const user = currentUserSync();
  authListeners.forEach((cb) => cb(user));
}

/* ------------------------------------------------------------- фильтрация */

function applyFilters(jobs, p = {}) {
  let list = jobs.filter((j) => (p.includeAllStatuses ? true : j.status === 'open'));

  if (p.status) list = list.filter((j) => j.status === p.status);
  if (p.category) list = list.filter((j) => j.category === p.category);
  if (p.city) list = list.filter((j) => j.city === p.city);
  if (p.level) list = list.filter((j) => j.level === p.level);
  if (p.employment) list = list.filter((j) => j.employment === p.employment);
  if (p.remote) list = list.filter((j) => j.remote === true);
  if (p.minSalary) list = list.filter((j) => (j.salaryMax || j.salaryMin || 0) >= Number(p.minSalary));
  if (p.q) list = list.filter((j) => matchesQuery(j, p.q));

  // Firestore разрешает диапазонный фильтр только по полю первой сортировки,
  // поэтому в Firebase-режиме «зарплата от» принудительно сортирует по зарплате.
  // Здесь это ограничение воспроизводится, иначе один и тот же набор фильтров
  // давал бы в двух режимах разный порядок карточек.
  const ts = (v) => new Date(v).getTime() || 0;
  const top = (j) => j.salaryMax || j.salaryMin || 0;

  if (p.minSalary) {
    // Сортировка идёт по тому же полю, что и диапазон, — по salaryMax.
    list.sort((a, b) => (p.sort === 'salaryAsc' ? top(a) - top(b) : top(b) - top(a)));
    return list;
  }

  const sort = p.sort || 'new';
  if (sort === 'salaryDesc') list.sort((a, b) => (b.salaryMax || b.salaryMin || 0) - (a.salaryMax || a.salaryMin || 0));
  else if (sort === 'salaryAsc') list.sort((a, b) => (a.salaryMin || a.salaryMax || 0) - (b.salaryMin || b.salaryMax || 0));
  else if (sort === 'popular') list.sort((a, b) => (b.applicationsCount || 0) - (a.applicationsCount || 0));
  else list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));

  return list;
}

function page(list, cursor, pageSize) {
  const offset = Number(cursor) || 0;
  const items = list.slice(offset, offset + pageSize);
  const next = offset + items.length;
  return { items, cursor: next < list.length ? next : null, hasMore: next < list.length, total: list.length };
}

/** Денормализованные счётчики профиля — те же, что ведёт Firestore через increment(). */
function bumpUserStats(userId, field, delta) {
  const users = read(K.users);
  const user = users.find((u) => u.uid === userId);
  if (!user) return;
  user.stats = user.stats || { applicationsCount: 0, savedCount: 0, reviewsCount: 0 };
  user.stats[field] = Math.max(0, (user.stats[field] || 0) + delta);
  write(K.users, users);
  emit('users');
  if (userId === sessionUid()) notifyAuth();
}

/** Подписка «вызвать сразу и при каждом изменении коллекции». */
function subscribe(collection, run) {
  const handler = () => run();
  bus.addEventListener(`change:${collection}`, handler);
  run();
  return () => bus.removeEventListener(`change:${collection}`, handler);
}

/* ------------------------------------------------------------------ API */

export const demoBackend = {
  mode: 'demo',

  async init() {
    await ensureSeeded();
    return this;
  },

  /* ---- auth ---- */

  currentUser: currentUserSync,

  onAuthChange(cb) {
    authListeners.add(cb);
    Promise.resolve().then(() => cb(currentUserSync()));
    return () => authListeners.delete(cb);
  },

  async register({ email, password, displayName }) {
    await sleep();
    const users = read(K.users);
    const normalized = String(email).trim().toLowerCase();
    if (users.some((u) => u.email.toLowerCase() === normalized)) {
      throw new Error('Пользователь с такой почтой уже зарегистрирован');
    }
    if (String(password).length < 6) throw new Error('Пароль должен быть не короче 6 символов');

    const user = {
      uid: uid(),
      email: normalized,
      displayName: displayName || normalized.split('@')[0],
      role: 'user',
      photoURL: null,
      phone: '', city: '', about: '',
      passwordHash: await hashPassword(password),
      resume: {
        title: '', level: '', yearsExperience: 0, skills: [], desiredSalary: 0,
        employment: [], remoteOnly: false, cities: [], education: '', links: {},
      },
      settings: { theme: 'dark', emailNotifications: true },
      stats: { applicationsCount: 0, savedCount: 0, reviewsCount: 0 },
      disabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    users.push(user);
    write(K.users, users);
    localStorage.setItem(K.session, user.uid);
    emit('users');
    notifyAuth();
    return publicUser(user);
  },

  async login(email, password) {
    await sleep();
    const users = read(K.users);
    const normalized = String(email).trim().toLowerCase();
    const user = users.find((u) => u.email.toLowerCase() === normalized);
    if (!user) throw new Error('Пользователь не найден');
    if (user.disabled) throw new Error('Аккаунт заблокирован администратором');
    if (user.passwordHash !== await hashPassword(password)) throw new Error('Неверный пароль');

    user.lastLoginAt = new Date().toISOString();
    write(K.users, users);
    localStorage.setItem(K.session, user.uid);
    notifyAuth();
    return publicUser(user);
  },

  async logout() {
    localStorage.removeItem(K.session);
    notifyAuth();
  },

  async resetPassword(email) {
    await sleep();
    const user = read(K.users).find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
    if (!user) throw new Error('Пользователь с такой почтой не найден');
    // Настоящее письмо отправляет Firebase Auth; в демо-режиме просто подтверждаем.
    return true;
  },

  async updateProfile(userId, patch) {
    await sleep(40);
    const users = read(K.users);
    const user = users.find((u) => u.uid === userId);
    if (!user) throw new Error('Профиль не найден');
    Object.assign(user, patch, { updatedAt: new Date().toISOString() });
    write(K.users, users);
    emit('users');
    if (userId === sessionUid()) notifyAuth();
    return publicUser(user);
  },

  async getUser(userId) {
    return publicUser(read(K.users).find((u) => u.uid === userId));
  },

  /* ---- файлы: аватары и логотипы компаний ---- */
  // В Firebase-режиме это Firebase Storage, здесь — data URL в localStorage.
  // Картинка проходит через тот же src/core/image.js, поэтому после
  // уменьшения до 256×256 занимает ~40 КБ и в квоту localStorage влезает.

  async uploadAvatar(userId, file) {
    const { prepareSquareImage } = await import('../core/image.js');
    const { dataUrl } = await prepareSquareImage(file, 256);
    await this.updateProfile(userId, { photoURL: dataUrl });
    return dataUrl;
  },

  async removeAvatar(userId) {
    await this.updateProfile(userId, { photoURL: null });
    return true;
  },

  async uploadCompanyLogo(jobId, file) {
    const { prepareSquareImage } = await import('../core/image.js');
    const { dataUrl } = await prepareSquareImage(file, 128);
    const jobs = read(K.jobs);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('Вакансия не найдена');
    job.company = { ...(job.company || {}), logoUrl: dataUrl };
    job.updatedAt = new Date().toISOString();
    write(K.jobs, jobs);
    emit('jobs');
    return dataUrl;
  },

  async removeCompanyLogo(jobId) {
    const jobs = read(K.jobs);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('Вакансия не найдена');
    job.company = { ...(job.company || {}), logoUrl: null };
    job.updatedAt = new Date().toISOString();
    write(K.jobs, jobs);
    emit('jobs');
    return true;
  },

  /* ---- jobs ---- */

  async listJobs(params = {}) {
    await sleep();
    const pageSize = params.pageSize || APP.pageSize;
    return page(applyFilters(read(K.jobs), params), params.cursor, pageSize);
  },

  // Третий аргумент — тот же колбэк ошибки, что у onSnapshot в Firebase-режиме.
  // Здесь падать почти нечему, но без него сбой (например, испорченный JSON
  // в localStorage) уходил бы в консоль, а каталог оставался с пустым списком
  // без объяснения — в Firebase-режиме в этом случае показывается сообщение.
  watchFirstPage(params, cb, onError) {
    const pageSize = params.pageSize || APP.pageSize;
    return subscribe('jobs', () => {
      try {
        cb(page(applyFilters(read(K.jobs), params), 0, pageSize));
      } catch (error) {
        console.error('[demo] не удалось собрать первую страницу каталога', error);
        if (onError) onError(error);
      }
    });
  },

  async getJob(id) {
    await sleep(50);
    return read(K.jobs).find((j) => j.id === id) || null;
  },

  watchJob(id, cb) {
    return subscribe('jobs', () => cb(read(K.jobs).find((j) => j.id === id) || null));
  },

  async listSimilar(job, { pageSize = APP.similarPageSize, cursor = 0 } = {}) {
    await sleep(60);
    const all = read(K.jobs)
      .filter((j) => j.id !== job.id && j.status === 'open')
      .map((j) => {
        let score = 0;
        if (j.category === job.category) score += 3;
        if (j.level === job.level) score += 2;
        if (j.city === job.city) score += 1;
        const shared = (j.skills || []).filter((s) => (job.skills || []).includes(s)).length;
        return { job: j, score: score + shared };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.job);
    return page(all, cursor, pageSize);
  },

  async createJob(data) {
    await sleep();
    const jobs = read(K.jobs);
    const job = {
      ...data,
      id: uid(),
      companyName: data.company?.name || '',
      ...buildJobIndex(data),
      applicationsCount: 0, viewsCount: 0, savesCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
    };
    jobs.unshift(job);
    write(K.jobs, jobs);
    emit('jobs');
    return job.id;
  },

  async updateJob(id, patch) {
    await sleep(60);
    const jobs = read(K.jobs);
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error('Вакансия не найдена');
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    Object.assign(job, buildJobIndex(job));
    job.companyName = job.company?.name || job.companyName;
    write(K.jobs, jobs);
    emit('jobs');
  },

  async deleteJob(id) {
    await sleep(60);
    write(K.jobs, read(K.jobs).filter((j) => j.id !== id));
    write(K.saved, read(K.saved).filter((s) => s.jobId !== id));
    emit('jobs'); emit('saved');
  },

  async incrementViews(id) {
    const jobs = read(K.jobs);
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    job.viewsCount = (job.viewsCount || 0) + 1;
    write(K.jobs, jobs);
    emit('jobs');   // в Firestore это делает onSnapshot — здесь эмулируем вручную
  },

  /* ---- reviews ---- */

  async listReviews(jobId, { pageSize = APP.reviewsPageSize, cursor = 0 } = {}) {
    await sleep(60);
    const list = read(K.reviews)
      .filter((r) => r.jobId === jobId && !r.hidden)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return page(list, cursor, pageSize);
  },

  watchReviews(jobId, cb) {
    return subscribe('reviews', () => {
      const list = read(K.reviews)
        .filter((r) => r.jobId === jobId && !r.hidden)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      cb(list);
    });
  },

  async addReview({ job, user, rating, text }) {
    await sleep();
    const reviews = read(K.reviews);
    reviews.unshift({
      id: uid(),
      jobId: job.id,
      companyId: job.company?.id || '',
      companyName: job.companyName || job.company?.name || '',
      userId: user.uid,
      userName: user.displayName,
      userPhotoURL: user.photoURL || null,
      rating: Number(rating),
      text: String(text).trim(),
      hidden: false,
      moderatedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    write(K.reviews, reviews);
    bumpUserStats(user.uid, 'reviewsCount', 1);
    emit('reviews');
  },

  async updateReview(id, patch) {
    await sleep(50);
    const reviews = read(K.reviews);
    const review = reviews.find((r) => r.id === id);
    if (!review) throw new Error('Отзыв не найден');
    Object.assign(review, patch, { updatedAt: new Date().toISOString() });
    write(K.reviews, reviews);
    emit('reviews');
  },

  async deleteReview(id, ownerId = null) {
    await sleep(50);
    write(K.reviews, read(K.reviews).filter((r) => r.id !== id));
    if (ownerId) bumpUserStats(ownerId, 'reviewsCount', -1);
    emit('reviews');
  },

  async listUserReviews(userId) {
    await sleep(50);
    return read(K.reviews)
      .filter((r) => r.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async listAllReviews({ pageSize = APP.adminPageSize, cursor = 0 } = {}) {
    await sleep(60);
    const list = read(K.reviews).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return page(list, cursor, pageSize);
  },

  /* ---- saved ---- */

  watchSaved(userId, cb, onError) {
    return subscribe('saved', () => {
      try {
        cb(read(K.saved)
          .filter((s) => s.userId === userId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      } catch (error) {
        console.error('[demo] не удалось собрать сохранённые вакансии', error);
        if (onError) onError(error);
      }
    });
  },

  async listSaved(userId) {
    await sleep(50);
    return read(K.saved).filter((s) => s.userId === userId);
  },

  async saveJob(userId, job, matchScore = 0) {
    await sleep(40);
    const saved = read(K.saved);
    const id = `${userId}_${job.id}`;
    if (saved.some((s) => s.id === id)) return;
    saved.unshift({
      id, userId, jobId: job.id,
      jobTitle: job.title,
      companyName: job.companyName || job.company?.name || '',
      companyLogo: job.company?.logo || '💼',
      companyLogoUrl: job.company?.logoUrl || null,
      city: job.city, remote: job.remote, level: job.level,
      salaryMin: job.salaryMin, salaryMax: job.salaryMax,
      matchScore, note: '',
      createdAt: new Date().toISOString(),
    });
    write(K.saved, saved);
    const jobs = read(K.jobs);
    const target = jobs.find((j) => j.id === job.id);
    if (target) { target.savesCount = (target.savesCount || 0) + 1; write(K.jobs, jobs); }
    bumpUserStats(userId, 'savedCount', 1);
    emit('saved'); emit('jobs');
  },

  async unsaveJob(userId, jobId) {
    await sleep(40);
    const existed = read(K.saved).some((s) => s.id === `${userId}_${jobId}`);
    write(K.saved, read(K.saved).filter((s) => s.id !== `${userId}_${jobId}`));
    if (existed) {
      const jobs = read(K.jobs);
      const target = jobs.find((j) => j.id === jobId);
      if (target) { target.savesCount = Math.max(0, (target.savesCount || 0) - 1); write(K.jobs, jobs); }
      bumpUserStats(userId, 'savedCount', -1);
      emit('jobs');
    }
    emit('saved');
  },

  async updateSavedNote(userId, jobId, note) {
    const saved = read(K.saved);
    const item = saved.find((s) => s.id === `${userId}_${jobId}`);
    if (!item) return;
    item.note = note;
    write(K.saved, saved);
    emit('saved');
  },

  /* ---- applications ---- */

  async applyToJob({ user, job, coverLetter = '', matchScore = 0 }) {
    await sleep();
    const apps = read(K.apps);
    if (apps.some((a) => a.userId === user.uid && a.jobId === job.id && a.status !== 'withdrawn')) {
      throw new Error('Вы уже откликнулись на эту вакансию');
    }
    const now = new Date().toISOString();
    apps.unshift({
      id: uid(),
      userId: user.uid, userName: user.displayName, userEmail: user.email,
      jobId: job.id, jobTitle: job.title,
      companyName: job.companyName || job.company?.name || '',
      companyLogo: job.company?.logo || '💼',
      companyLogoUrl: job.company?.logoUrl || null,
      city: job.city, level: job.level,
      salaryMin: job.salaryMin, salaryMax: job.salaryMax,
      status: 'sent', matchScore, coverLetter,
      statusHistory: [{ status: 'sent', at: now, by: user.uid }],
      createdAt: now, updatedAt: now,
    });
    write(K.apps, apps);

    const jobs = read(K.jobs);
    const target = jobs.find((j) => j.id === job.id);
    if (target) { target.applicationsCount = (target.applicationsCount || 0) + 1; write(K.jobs, jobs); }
    bumpUserStats(user.uid, 'applicationsCount', 1);

    emit('apps'); emit('jobs');
  },

  // Третий аргумент — тот же колбэк ошибки, что у onSnapshot в Firebase-режиме
  // (см. watchFirstPage): сигнатуры адаптеров должны совпадать.
  watchApplications(userId, cb, onError) {
    return subscribe('apps', () => {
      try {
        cb(read(K.apps)
          .filter((a) => a.userId === userId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      } catch (error) {
        console.error('[demo] не удалось собрать историю откликов', error);
        if (onError) onError(error);
      }
    });
  },

  async hasApplied(userId, jobId) {
    return read(K.apps).some((a) => a.userId === userId && a.jobId === jobId && a.status !== 'withdrawn');
  },

  async withdrawApplication(id, userId) {
    await sleep(50);
    const apps = read(K.apps);
    const app = apps.find((a) => a.id === id);
    if (!app) throw new Error('Отклик не найден');
    app.status = 'withdrawn';
    app.updatedAt = new Date().toISOString();
    app.statusHistory.push({ status: 'withdrawn', at: app.updatedAt, by: userId });
    write(K.apps, apps);

    const jobs = read(K.jobs);
    const target = jobs.find((j) => j.id === app.jobId);
    if (target) { target.applicationsCount = Math.max(0, (target.applicationsCount || 0) - 1); write(K.jobs, jobs); }
    bumpUserStats(userId, 'applicationsCount', -1);

    emit('apps'); emit('jobs');
  },

  async listAllApplications({ status = '', pageSize = APP.adminPageSize, cursor = 0 } = {}) {
    await sleep(60);
    let list = read(K.apps).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (status) list = list.filter((a) => a.status === status);
    return page(list, cursor, pageSize);
  },

  watchAllApplications(cb) {
    return subscribe('apps', () => {
      cb(read(K.apps).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    });
  },

  async setApplicationStatus(id, status, adminUid) {
    await sleep(50);
    const apps = read(K.apps);
    const app = apps.find((a) => a.id === id);
    if (!app) throw new Error('Отклик не найден');
    app.status = status;
    app.updatedAt = new Date().toISOString();
    app.statusHistory.push({ status, at: app.updatedAt, by: adminUid });
    write(K.apps, apps);
    emit('apps');
  },

  async deleteApplication(id) {
    await sleep(50);
    write(K.apps, read(K.apps).filter((a) => a.id !== id));
    emit('apps');
  },

  /* ---- users (админ) ---- */

  async listUsers({ pageSize = APP.adminPageSize, cursor = 0 } = {}) {
    await sleep(60);
    const list = read(K.users)
      .map(publicUser)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return page(list, cursor, pageSize);
  },

  async setUserRole(userId, role) {
    return this.updateProfile(userId, { role });
  },

  async setUserDisabled(userId, disabled) {
    return this.updateProfile(userId, { disabled });
  },

  /* ---- статистика ---- */

  async stats() {
    await sleep(60);
    const jobs = read(K.jobs);
    const apps = read(K.apps);
    const byStatus = {};
    for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    return {
      jobs: jobs.length,
      openJobs: jobs.filter((j) => j.status === 'open').length,
      users: read(K.users).length,
      applications: apps.length,
      reviews: read(K.reviews).length,
      hiddenReviews: read(K.reviews).filter((r) => r.hidden).length,
      saved: read(K.saved).length,
      byStatus,
      topJobs: jobs.slice().sort((a, b) => (b.applicationsCount || 0) - (a.applicationsCount || 0)).slice(0, 5),
    };
  },

  /** Демо-режим: сбросить всё к исходному набору. */
  async resetDemoData() {
    localStorage.removeItem(K.version);
    for (const key of [K.jobs, K.users, K.apps, K.saved, K.reviews]) localStorage.removeItem(key);
    localStorage.removeItem(K.session);
    await ensureSeeded();
    notifyAuth();
    emit('jobs'); emit('apps'); emit('saved'); emit('reviews'); emit('users');
  },
};
