/**
 * Движок AI-подбора.
 *
 * Считает соответствие резюме и вакансии по шести взвешенным критериям и
 * объясняет результат: что совпало, чего не хватает и что конкретно дописать
 * в резюме. Работает целиком на клиенте и детерминированно — один и тот же
 * ввод всегда даёт один и тот же процент, поэтому цифру можно сохранять
 * в отклик (`applications.matchScore`) и сравнивать вакансии между собой.
 *
 * Внешняя языковая модель здесь намеренно не используется: она сделала бы
 * оценку нестабильной, потребовала бы серверного ключа и платного запроса
 * на каждую карточку каталога. Веса и правила ниже — та же логика, что
 * применяют ATS-системы при первичном скрининге откликов.
 */

import { DICT } from '../config.js';

/* ------------------------------------------------------------------ навыки */

/** Синонимы и разные написания одного и того же навыка. */
const SKILL_ALIASES = {
  js: 'javascript', 'java script': 'javascript', ecmascript: 'javascript',
  ts: 'typescript',
  'react.js': 'react', reactjs: 'react',
  'vue.js': 'vue', vuejs: 'vue',
  'node': 'node.js', nodejs: 'node.js', 'node js': 'node.js',
  'next': 'next.js', nextjs: 'next.js',
  'nest': 'nest.js', nestjs: 'nest.js',
  postgres: 'postgresql', psql: 'postgresql',
  'c sharp': 'c#', csharp: 'c#',
  'golang': 'go',
  'ml': 'machine learning', 'мл': 'machine learning',
  'ии': 'ai', 'искусственный интеллект': 'ai',
  'k8s': 'kubernetes',
  'rn': 'react native', 'react-native': 'react native',
  'ci/cd': 'ci/cd', cicd: 'ci/cd',
  'фигма': 'figma',
  'питон': 'python',
  'реакт': 'react',
  'докер': 'docker',
};

export function normalizeSkill(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SKILL_ALIASES[value] || value;
}

function skillSet(list) {
  return new Set((list || []).map(normalizeSkill).filter(Boolean));
}

/**
 * Пары, которые выглядят похоже, но являются разными технологиями.
 * Без этого списка «React» засчитался бы за «React Native».
 */
const DISTINCT_PAIRS = new Set([
  'react|react native',
  'vue|nuxt',
  'sql|nosql',
  'c#|c',
  'go|django',
]);

const words = (skill) => skill.split(/[\s\-_/]+/).filter(Boolean);

/** Все слова одного навыка входят в другой: «react» покрывает «react hooks». */
function covers(a, b) {
  const target = new Set(words(b));
  return words(a).every((w) => target.has(w));
}

/**
 * Совпадение навыков по границам слов, а не по подстроке: иначе «javascript»
 * ошибочно закрывал бы требование «java».
 */
function skillHit(userSkills, needed) {
  if (userSkills.has(needed)) return true;
  for (const own of userSkills) {
    if (own === needed) return true;
    if (DISTINCT_PAIRS.has(`${own}|${needed}`) || DISTINCT_PAIRS.has(`${needed}|${own}`)) continue;
    if (covers(own, needed) || covers(needed, own)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- веса */

export const WEIGHTS = {
  skills: 45,
  level: 18,
  experience: 12,
  salary: 10,
  location: 9,
  employment: 6,
};

const LEVELS = DICT.levelOrder;

/* --------------------------------------------------------------- критерии */

function scoreSkills(resume, job) {
  const required = (job.skills || []).map(normalizeSkill).filter(Boolean);
  const nice = (job.niceToHave || []).map(normalizeSkill).filter(Boolean);
  const own = skillSet(resume.skills);

  if (!required.length) {
    return { score: own.size ? 80 : 55, matched: [], missing: [], niceMatched: [], niceMissing: nice,
      detail: 'В вакансии не перечислены обязательные навыки' };
  }

  const matched = required.filter((s) => skillHit(own, s));
  const missing = required.filter((s) => !skillHit(own, s));
  const niceMatched = nice.filter((s) => skillHit(own, s));
  const niceMissing = nice.filter((s) => !skillHit(own, s));

  let score = (matched.length / required.length) * 100;
  // Дополнительные навыки из «будет плюсом» добавляют до 8 пунктов сверху.
  if (nice.length) score += Math.min(8, (niceMatched.length / nice.length) * 8);

  return {
    score: Math.min(100, Math.round(score)),
    matched, missing, niceMatched, niceMissing,
    detail: `${matched.length} из ${required.length} обязательных навыков`,
  };
}

function scoreLevel(resume, job) {
  const own = LEVELS.indexOf(resume.level);
  const need = LEVELS.indexOf(job.level);
  if (own < 0 || need < 0) return { score: 60, detail: 'Грейд не указан' };

  const delta = own - need;
  if (delta === 0) return { score: 100, detail: `Ваш грейд совпадает: ${DICT.levels[job.level]}` };
  if (delta === 1) return { score: 88, detail: 'Вы на грейд выше — запас есть' };
  if (delta >= 2) return { score: 66, detail: 'Вы заметно выше грейдом, задачи могут показаться простыми' };
  if (delta === -1) return { score: 62, detail: `Вакансия на грейд выше вашего (${DICT.levels[job.level]})` };
  return { score: 26, detail: `Вакансия на ${Math.abs(delta)} грейда выше вашего` };
}

function scoreExperience(resume, job) {
  const need = Number(job.experienceYears) || 0;
  const own = Number(resume.yearsExperience) || 0;
  if (!need) return { score: 95, detail: 'Опыт не является жёстким требованием' };
  if (own >= need) return { score: 100, detail: `${own} лет опыта при требуемых ${need}` };
  const gap = need - own;
  return {
    score: Math.max(10, Math.round(100 - gap * 34)),
    detail: `Не хватает ${gap} ${gap === 1 ? 'года' : 'лет'} опыта из ${need}`,
  };
}

function scoreSalary(resume, job) {
  const want = Number(resume.desiredSalary) || 0;
  const min = Number(job.salaryMin) || 0;
  const max = Number(job.salaryMax) || min;
  if (!want) return { score: 75, detail: 'Желаемая зарплата не указана' };
  if (!max) return { score: 60, detail: 'В вакансии не указана вилка' };
  if (want <= max) {
    const comfort = want <= min ? 100 : 92;
    return { score: comfort, detail: want <= min ? 'Вилка выше ваших ожиданий' : 'Ожидания попадают в вилку' };
  }
  const over = (want - max) / want;
  return {
    score: Math.max(0, Math.round(100 - over * 190)),
    detail: `Потолок вилки ниже ожиданий на ${Math.round(over * 100)}%`,
  };
}

function scoreLocation(resume, job) {
  const cities = (resume.cities || []).map((c) => String(c).toLowerCase());
  const city = String(job.city || '').toLowerCase();
  if (resume.remoteOnly) {
    return job.remote
      ? { score: 100, detail: 'Удалённый формат — как вы и хотите' }
      : { score: 22, detail: 'Вы ищете удалёнку, а вакансия офисная' };
  }
  if (job.remote) return { score: 96, detail: 'Можно работать удалённо' };
  if (!cities.length) return { score: 70, detail: 'Города в резюме не указаны' };
  if (cities.includes(city)) return { score: 100, detail: `Ваш город: ${job.city}` };
  return { score: 34, detail: `Другой город: ${job.city}` };
}

function scoreEmployment(resume, job) {
  const want = resume.employment || [];
  if (!want.length) return { score: 80, detail: 'Формат занятости не выбран' };
  return want.includes(job.employment)
    ? { score: 100, detail: DICT.employment[job.employment] }
    : { score: 45, detail: `Вакансия — ${String(DICT.employment[job.employment] || '').toLowerCase()}` };
}

/* ------------------------------------------------------------------ вывод */

export function verdictFor(score) {
  if (score >= 85) return { label: 'Отличное совпадение', tone: 'match-high', color: 'var(--success)' };
  if (score >= 70) return { label: 'Хорошее совпадение', tone: 'match-high', color: 'var(--success)' };
  if (score >= 50) return { label: 'Есть шансы', tone: 'match-mid', color: 'var(--warning)' };
  return { label: 'Слабое совпадение', tone: 'match-low', color: 'var(--text-faint)' };
}

/** Пустое резюме — чтобы неавторизованный гость видел осмысленный интерфейс. */
export const EMPTY_RESUME = {
  title: '', level: '', yearsExperience: 0, skills: [],
  desiredSalary: 0, employment: [], remoteOnly: false, cities: [], education: '',
};

export function resumeOf(user) {
  if (!user || !user.resume) return { ...EMPTY_RESUME };
  const r = user.resume;
  return {
    ...EMPTY_RESUME,
    ...r,
    skills: Array.isArray(r.skills) ? r.skills : [],
    employment: Array.isArray(r.employment) ? r.employment : [],
    cities: Array.isArray(r.cities) ? r.cities : (user.city ? [user.city] : []),
  };
}

/** Заполнено ли резюме настолько, чтобы оценка была осмысленной. */
export function isResumeReady(resume) {
  return Boolean(resume && (resume.skills || []).length >= 2 && resume.level);
}

/**
 * Основная функция: соответствие резюме вакансии.
 * @returns {{score:number, verdict:object, breakdown:Array, matchedSkills:string[],
 *            missingSkills:string[], niceMissing:string[], advice:string[], ready:boolean}}
 */
export function matchJob(resume, job) {
  const r = resume || EMPTY_RESUME;
  const parts = {
    skills: scoreSkills(r, job),
    level: scoreLevel(r, job),
    experience: scoreExperience(r, job),
    salary: scoreSalary(r, job),
    location: scoreLocation(r, job),
    employment: scoreEmployment(r, job),
  };

  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (parts[key].score / 100) * weight;
  }
  const score = Math.max(0, Math.min(100, Math.round(total)));

  const labels = {
    skills: 'Навыки',
    level: 'Грейд',
    experience: 'Опыт',
    salary: 'Зарплата',
    location: 'Локация',
    employment: 'Занятость',
  };

  const breakdown = Object.entries(WEIGHTS).map(([key, weight]) => ({
    key,
    label: labels[key],
    weight,
    score: parts[key].score,
    points: Math.round((parts[key].score / 100) * weight),
    detail: parts[key].detail,
  })).sort((a, b) => b.weight - a.weight);

  return {
    score,
    verdict: verdictFor(score),
    breakdown,
    matchedSkills: parts.skills.matched || [],
    missingSkills: parts.skills.missing || [],
    niceMissing: parts.skills.niceMissing || [],
    advice: buildAdvice(r, job, parts, score),
    ready: isResumeReady(r),
  };
}

/** Конкретные рекомендации: что дописать или подтянуть. */
function buildAdvice(resume, job, parts, score) {
  const tips = [];
  const missing = parts.skills.missing || [];

  if (!isResumeReady(resume)) {
    tips.push('Заполните резюме в личном кабинете — укажите грейд и хотя бы 3-5 навыков, тогда оценка станет точной.');
    return tips;
  }

  if (missing.length) {
    const top = missing.slice(0, 4).join(', ');
    tips.push(`Добавьте в резюме: ${top}${missing.length > 4 ? ` и ещё ${missing.length - 4}` : ''} — это обязательные требования вакансии.`);
  }
  if (!missing.length) {
    tips.push('Все обязательные навыки закрыты — в сопроводительном письме сошлитесь на проект, где применяли их вместе.');
  }
  if ((parts.skills.niceMissing || []).length) {
    tips.push(`Будет плюсом: ${parts.skills.niceMissing.slice(0, 3).join(', ')}. Даже учебный проект на этих технологиях повышает шанс.`);
  }
  if (parts.experience.score < 80) {
    tips.push('Компенсируйте нехватку опыта: вынесите в начало резюме 2-3 проекта с измеримым результатом и ссылками на репозитории.');
  }
  if (parts.level.score < 70 && LEVELS.indexOf(resume.level) < LEVELS.indexOf(job.level)) {
    tips.push(`Вакансия уровня ${DICT.levels[job.level]}. Опишите зоны ответственности, где вы работали самостоятельно — это то, что отличает следующий грейд.`);
  }
  if (parts.salary.score < 60) {
    tips.push('Ожидания по зарплате выше вилки — либо отметьте готовность обсуждать, либо ищите вакансии уровнем выше.');
  }
  if (parts.location.score < 50) {
    tips.push(resume.remoteOnly
      ? 'Вакансия офисная. Уточните у работодателя, возможен ли гибрид — часть команд идут навстречу.'
      : `Вакансия в городе ${job.city}. Если релокация возможна, укажите это прямо в резюме.`);
  }
  if (score >= 85) tips.push('Отклик стоит отправить сегодня: у откликов в первые 48 часов после публикации заметно выше отклик рекрутера.');
  return tips;
}

/** Чего не хватает в самом резюме (независимо от конкретной вакансии). */
export function resumeCompleteness(resume) {
  const checks = [
    { key: 'title', ok: Boolean(resume.title), label: 'Желаемая должность', hint: 'Например: Frontend-разработчик' },
    { key: 'level', ok: Boolean(resume.level), label: 'Грейд', hint: 'От стажёра до lead' },
    { key: 'skills', ok: (resume.skills || []).length >= 5, label: 'Минимум 5 навыков', hint: 'Именно по ним считается совпадение' },
    { key: 'yearsExperience', ok: Number(resume.yearsExperience) > 0, label: 'Опыт в годах', hint: 'Учитывается в требованиях вакансий' },
    { key: 'desiredSalary', ok: Number(resume.desiredSalary) > 0, label: 'Желаемая зарплата', hint: 'Нужна для оценки вилки' },
    { key: 'employment', ok: (resume.employment || []).length > 0, label: 'Формат занятости', hint: 'Полная, частичная, проектная' },
    { key: 'cities', ok: (resume.cities || []).length > 0 || resume.remoteOnly, label: 'Город или удалёнка', hint: 'Иначе локация оценивается вслепую' },
    { key: 'education', ok: Boolean(resume.education), label: 'Образование', hint: 'Вуз, курсы, сертификаты' },
  ];
  const done = checks.filter((c) => c.ok).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    done,
    total: checks.length,
    missing: checks.filter((c) => !c.ok),
  };
}

/** Топ навыков, которых чаще всего не хватает по выборке вакансий. */
export function skillGapReport(resume, jobs, limit = 6) {
  const counter = new Map();
  for (const job of jobs) {
    for (const skill of (job.skills || [])) {
      const norm = normalizeSkill(skill);
      if (!norm) continue;
      if (skillHit(skillSet(resume.skills), norm)) continue;
      const entry = counter.get(norm) || { skill, count: 0 };
      entry.count += 1;
      counter.set(norm, entry);
    }
  }
  return Array.from(counter.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Сортировка списка вакансий по проценту соответствия. */
export function rankJobs(resume, jobs) {
  return jobs
    .map((job) => ({ job, match: matchJob(resume, job) }))
    .sort((a, b) => b.match.score - a.match.score);
}
