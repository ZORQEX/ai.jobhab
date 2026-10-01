/** Форматирование значений для интерфейса. */

import { DICT } from '../config.js';

const nf = new Intl.NumberFormat('ru-RU');

export function money(value) {
  if (!value && value !== 0) return '';
  return nf.format(Math.round(value));
}

/** «от 450 000 ₸» / «450 000 – 700 000 ₸» / «з/п не указана» */
export function salaryRange(min, max) {
  if (!min && !max) return 'з/п не указана';
  if (min && max && min !== max) return `${money(min)} – ${money(max)} ₸`;
  const one = min || max;
  return `${min ? 'от' : 'до'} ${money(one)} ₸`;
}

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') return new Date(value);
  if (typeof value.toDate === 'function') return value.toDate();   // Firestore Timestamp
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

export function dateShort(value) {
  const d = toDate(value);
  if (!d || isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(value) {
  const d = toDate(value);
  if (!d || isNaN(d)) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** «сегодня» / «3 дня назад» / «12 мар 2026» */
export function timeAgo(value) {
  const d = toDate(value);
  if (!d || isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 8) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return dateShort(d);
}

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function counted(n, one, few, many) {
  return `${nf.format(n)} ${plural(n, one, few, many)}`;
}

export const levelLabel = (v) => DICT.levels[v] || v || '';
export const categoryLabel = (v) => DICT.categories[v] || v || '';
export const employmentLabel = (v) => DICT.employment[v] || v || '';
export const jobStatusLabel = (v) => DICT.jobStatus[v] || v || '';
export const applicationStatusLabel = (v) => DICT.applicationStatus[v] || v || '';

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

export function stars(rating) {
  const r = Math.round(Number(rating) || 0);
  return '★'.repeat(r) + '☆'.repeat(Math.max(0, 5 - r));
}
