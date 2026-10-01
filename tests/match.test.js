/**
 * Тесты движка AI-подбора (src/ai/match.js).
 * Запуск: npm run test:match  (или node --test tests/match.test.js)
 *
 * Проверяется главное свойство движка — предсказуемость: одинаковый ввод
 * всегда даёт одинаковый процент, а понятные жизненные ситуации
 * («не тот город», «мало опыта», «путаница java/javascript») дают тот
 * результат, который ожидает человек.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchJob, rankJobs, resumeCompleteness, skillGapReport,
  verdictFor, normalizeSkill, isResumeReady, EMPTY_RESUME, WEIGHTS,
} from '../src/ai/match.js';

const middleFrontend = {
  title: 'Frontend-разработчик',
  level: 'middle',
  yearsExperience: 3,
  skills: ['JavaScript', 'TypeScript', 'React', 'CSS', 'REST API'],
  desiredSalary: 700000,
  employment: ['full'],
  remoteOnly: false,
  cities: ['Алматы'],
  education: 'Университет',
};

const reactJob = {
  id: 'j1',
  title: 'Frontend-разработчик (React)',
  level: 'middle',
  experienceYears: 2,
  skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'REST API'],
  niceToHave: ['Next.js'],
  salaryMin: 600000,
  salaryMax: 900000,
  city: 'Алматы',
  remote: false,
  employment: 'full',
  category: 'frontend',
};

const part = (result, key) => result.breakdown.find((b) => b.key === key);

/* ------------------------------------------------------------ базовые случаи */

test('полное совпадение даёт высокий процент и пустой список пробелов', () => {
  const result = matchJob(middleFrontend, reactJob);

  assert.ok(result.score >= 90, `ожидал >= 90, получил ${result.score}`);
  assert.deepEqual(result.missingSkills, []);
  assert.equal(result.verdict.label, 'Отличное совпадение');
  assert.equal(part(result, 'skills').score, 100);
});

test('сумма вкладов критериев не превышает 100', () => {
  const result = matchJob(middleFrontend, reactJob);
  const total = result.breakdown.reduce((sum, b) => sum + b.points, 0);

  assert.ok(total <= 100, `сумма вкладов ${total}`);
  assert.equal(
    Object.values(WEIGHTS).reduce((a, b) => a + b, 0),
    100,
    'веса критериев должны складываться в 100',
  );
});

test('оценка детерминирована: повторный вызов даёт тот же результат', () => {
  const first = matchJob(middleFrontend, reactJob).score;
  const second = matchJob(middleFrontend, reactJob).score;
  assert.equal(first, second);
});

/* --------------------------------------------------------------- пробелы */

test('нехватка обязательных навыков снижает оценку и попадает в рекомендации', () => {
  const job = { ...reactJob, skills: ['React', 'Vue', 'GraphQL', 'Docker'] };
  const result = matchJob(middleFrontend, job);

  assert.ok(result.missingSkills.includes('vue'));
  assert.ok(result.missingSkills.includes('docker'));
  assert.ok(result.score < 80, `ожидал < 80, получил ${result.score}`);
  assert.ok(result.advice.some((tip) => tip.includes('Добавьте в резюме')));
});

test('завышенные ожидания по зарплате штрафуют критерий «Зарплата»', () => {
  const greedy = { ...middleFrontend, desiredSalary: 2000000 };
  const result = matchJob(greedy, reactJob);

  assert.ok(part(result, 'salary').score < 60);
  assert.ok(result.advice.some((tip) => tip.includes('зарплате')));
});

test('другой город заметно снижает критерий «Локация»', () => {
  const result = matchJob(middleFrontend, { ...reactJob, city: 'Астана' });
  assert.ok(part(result, 'location').score < 50);
});

test('удалённая вакансия закрывает вопрос локации', () => {
  const result = matchJob(middleFrontend, { ...reactJob, city: 'Астана', remote: true });
  assert.ok(part(result, 'location').score >= 90);
});

test('соискателю, который ищет только удалёнку, офисная вакансия не подходит', () => {
  const remoteOnly = { ...middleFrontend, remoteOnly: true };
  const result = matchJob(remoteOnly, reactJob);

  assert.ok(part(result, 'location').score < 30);
  assert.ok(result.advice.some((tip) => tip.includes('гибрид')));
});

test('junior на senior-вакансии получает низкий грейд и опыт', () => {
  const junior = { ...middleFrontend, level: 'junior', yearsExperience: 1 };
  const job = { ...reactJob, level: 'senior', experienceYears: 5 };
  const result = matchJob(junior, job);

  assert.ok(part(result, 'level').score <= 40);
  assert.ok(part(result, 'experience').score < 60);
  assert.notEqual(result.verdict.label, 'Отличное совпадение');
});

test('пустое резюме помечается как незаполненное и получает подсказку', () => {
  const result = matchJob(EMPTY_RESUME, reactJob);

  assert.equal(result.ready, false);
  assert.equal(isResumeReady(EMPTY_RESUME), false);
  assert.equal(result.advice.length, 1);
  assert.ok(result.advice[0].includes('Заполните резюме'));
});

/* ------------------------------------------------------ сопоставление навыков */

test('синонимы навыков засчитываются', () => {
  assert.equal(normalizeSkill('JS'), 'javascript');
  assert.equal(normalizeSkill('k8s'), 'kubernetes');
  assert.equal(normalizeSkill('  React.JS '), 'react');

  const resume = { ...middleFrontend, skills: ['JS', 'TS', 'React'] };
  const job = { ...reactJob, skills: ['JavaScript', 'TypeScript', 'React'] };
  assert.deepEqual(matchJob(resume, job).missingSkills, []);
});

test('javascript НЕ закрывает требование java', () => {
  const resume = { ...middleFrontend, skills: ['JavaScript'] };
  const job = { ...reactJob, skills: ['Java'] };

  assert.deepEqual(matchJob(resume, job).missingSkills, ['java']);
});

test('react НЕ закрывает требование react native', () => {
  const resume = { ...middleFrontend, skills: ['React'] };
  const job = { ...reactJob, skills: ['React Native'] };

  assert.deepEqual(matchJob(resume, job).missingSkills, ['react native']);
});

test('уточнённый навык засчитывается: react закрывает react hooks', () => {
  const resume = { ...middleFrontend, skills: ['React'] };
  const job = { ...reactJob, skills: ['React Hooks'] };

  assert.deepEqual(matchJob(resume, job).missingSkills, []);
});

/* --------------------------------------------------------- вспомогательное */

test('вердикт зависит от порога', () => {
  assert.equal(verdictFor(95).label, 'Отличное совпадение');
  assert.equal(verdictFor(75).label, 'Хорошее совпадение');
  assert.equal(verdictFor(55).label, 'Есть шансы');
  assert.equal(verdictFor(20).label, 'Слабое совпадение');
});

test('rankJobs сортирует вакансии по убыванию соответствия', () => {
  const jobs = [
    { ...reactJob, id: 'far', city: 'Астана', level: 'lead', experienceYears: 8, skills: ['Go', 'Kubernetes'] },
    reactJob,
    { ...reactJob, id: 'mid', skills: ['React', 'Vue'] },
  ];
  const ranked = rankJobs(middleFrontend, jobs);

  assert.equal(ranked[0].job.id, 'j1');
  assert.ok(ranked[0].match.score >= ranked[1].match.score);
  assert.ok(ranked[1].match.score >= ranked[2].match.score);
});

test('resumeCompleteness считает заполненность и называет пробелы', () => {
  const full = resumeCompleteness({
    ...middleFrontend,
    skills: ['JavaScript', 'TypeScript', 'React', 'CSS', 'REST API'],
  });
  assert.equal(full.percent, 100);
  assert.deepEqual(full.missing, []);

  const empty = resumeCompleteness(EMPTY_RESUME);
  assert.equal(empty.percent, 0);
  assert.ok(empty.missing.some((m) => m.key === 'skills'));
});

test('skillGapReport показывает, каких навыков не хватает чаще всего', () => {
  const resume = { ...middleFrontend, skills: ['JavaScript'] };
  const jobs = [
    { ...reactJob, skills: ['React', 'Docker'] },
    { ...reactJob, skills: ['React', 'Go'] },
    { ...reactJob, skills: ['React'] },
  ];
  const report = skillGapReport(resume, jobs, 3);

  assert.equal(report[0].skill, 'React');
  assert.equal(report[0].count, 3);
});
