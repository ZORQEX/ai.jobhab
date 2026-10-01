/**
 * Подготовка поисковых полей вакансии.
 *
 * Firestore не умеет полнотекстовый поиск, поэтому индекс собирается на записи:
 *  • titleLower    — префиксный поиск через where('titleLower','>=',q) и '<=' q+''
 *  • searchTokens  — массив токенов для where('searchTokens','array-contains',token)
 *
 * Обе стратегии дешёвые по чтениям и покрываются составными индексами
 * из firestore.indexes.json.
 */

import { normalizeSkill } from '../ai/match.js';

const STOP_WORDS = new Set([
  'и', 'в', 'на', 'для', 'с', 'по', 'от', 'до', 'the', 'a', 'an', 'of', 'to', 'in',
  'разработчик', 'специалист', 'инженер',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .split(/[\s\-]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/** Максимум токенов в документе — ограничение Firestore на array-contains-поле. */
const MAX_TOKENS = 40;

export function buildJobIndex(job) {
  const tokens = new Set();

  for (const token of tokenize(job.title)) tokens.add(token);
  for (const token of tokenize(job.company?.name || job.companyName)) tokens.add(token);
  for (const skill of job.skills || []) {
    tokens.add(normalizeSkill(skill));
    for (const token of tokenize(skill)) tokens.add(token);
  }
  for (const token of tokenize(job.description).slice(0, 12)) tokens.add(token);
  if (job.city) tokens.add(String(job.city).toLowerCase());
  if (job.category) tokens.add(job.category);
  if (job.level) tokens.add(job.level);

  return {
    titleLower: String(job.title || '').toLowerCase(),
    searchTokens: Array.from(tokens).filter(Boolean).slice(0, MAX_TOKENS),
  };
}

/** Локальная проверка совпадения — используется демо-адаптером и дофильтрацией. */
export function matchesQuery(job, query) {
  if (!query) return true;
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  const haystack = [
    job.title, job.companyName || job.company?.name, job.description,
    (job.skills || []).join(' '), job.city,
  ].join(' ').toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}
