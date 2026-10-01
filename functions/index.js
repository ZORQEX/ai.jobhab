/**
 * Cloud Functions для AI JobHub.
 *
 * ВАЖНО: развёртывание функций требует тарифного плана Blaze (с картой).
 * Приложение работает и без них — клиент сам ведёт счётчики, а роль читается
 * из документа users/{uid}. Функции убирают эти компромиссы:
 *
 *   onApplicationWritten  — счётчики откликов считает сервер, а не клиент;
 *   syncAdminClaim        — роль уезжает в custom claim, и правила перестают
 *                           делать get() на users/{uid} при каждом запросе;
 *   refreshStats          — держит готовый документ meta/stats для админки;
 *   onApplicationStatus   — письмо кандидату при смене статуса отклика;
 *   generateCoverLetter   — вызываемая функция: LLM пишет сопроводительное.
 *
 * Развернуть:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * После развёртывания в firestore.rules можно ужесточить правило для jobs,
 * убрав ветку с counterStep() — клиенту запись в вакансии станет не нужна.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';

initializeApp();
const db = getFirestore();

const REGION = 'europe-west1';

/* ------------------------------------------------------------------ счётчики */

/**
 * Отклик создан → +1 к счётчику вакансии и к статистике пользователя.
 * Считает сервер, поэтому клиенту можно полностью запретить запись в jobs.
 */
export const onApplicationCreated = onDocumentCreated(
  { document: 'applications/{appId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data?.jobId) return;

    const batch = db.batch();
    batch.update(db.doc(`jobs/${data.jobId}`), {
      applicationsCount: FieldValue.increment(1),
    });
    batch.update(db.doc(`users/${data.userId}`), {
      'stats.applicationsCount': FieldValue.increment(1),
    });
    await batch.commit().catch((error) => logger.error('счётчик отклика', error));
  },
);

/**
 * Отклик отозван → счётчик вакансии уменьшается.
 * Ловим именно переход в withdrawn, а не любое обновление.
 */
export const onApplicationWithdrawn = onDocumentUpdated(
  { document: 'applications/{appId}', region: REGION },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return;

    if (after.status === 'withdrawn' && before.status !== 'withdrawn') {
      await db.doc(`jobs/${after.jobId}`)
        .update({ applicationsCount: FieldValue.increment(-1) })
        .catch((error) => logger.error('счётчик отзыва', error));
    }
  },
);

/* ------------------------------------------------------ роль в custom claim */

/**
 * Роль из users/{uid} уезжает в токен пользователя.
 * После этого правила проверяют request.auth.token.admin без чтения документа —
 * минус одно платное чтение на КАЖДЫЙ запрос к базе.
 *
 * Токен обновляется у клиента в течение часа либо сразу после
 * getIdToken(true) / повторного входа.
 */
export const syncAdminClaim = onDocumentWritten(
  { document: 'users/{uid}', region: REGION },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!after) {
      await getAuth().setCustomUserClaims(uid, null).catch(() => {});
      return;
    }
    if (before?.role === after.role) return;

    const isAdmin = after.role === 'admin';
    await getAuth().setCustomUserClaims(uid, isAdmin ? { admin: true } : null)
      .catch((error) => logger.error('custom claim', error));

    logger.info(`роль пользователя ${uid}: ${after.role}`);
  },
);

/* --------------------------------------------------------------- агрегаты */

/**
 * Готовый документ meta/stats для админ-панели: один документ вместо восьми
 * агрегатных запросов на каждое открытие вкладки статистики.
 */
async function buildStats() {
  const [jobs, openJobs, users, applications, reviews, hiddenReviews] = await Promise.all([
    db.collection('jobs').count().get(),
    db.collection('jobs').where('status', '==', 'open').count().get(),
    db.collection('users').count().get(),
    db.collection('applications').count().get(),
    db.collection('reviews').count().get(),
    db.collection('reviews').where('hidden', '==', true).count().get(),
  ]);

  const statuses = ['sent', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn'];
  const byStatusSnaps = await Promise.all(statuses.map(
    (status) => db.collection('applications').where('status', '==', status).count().get(),
  ));

  const byStatus = {};
  statuses.forEach((status, i) => { byStatus[status] = byStatusSnaps[i].data().count; });

  await db.doc('meta/stats').set({
    jobs: jobs.data().count,
    openJobs: openJobs.data().count,
    users: users.data().count,
    applications: applications.data().count,
    reviews: reviews.data().count,
    hiddenReviews: hiddenReviews.data().count,
    byStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export const refreshStats = onSchedule(
  { schedule: 'every 60 minutes', region: REGION, timeZone: 'Asia/Almaty' },
  async () => { await buildStats(); },
);

/* ----------------------------------------------------------- уведомления */

/**
 * Смена статуса отклика → письмо кандидату.
 *
 * Отправка намеренно вынесена в отдельную функцию: подставьте свой транспорт
 * (SendGrid, Resend, SMTP через nodemailer) и положите ключ в секрет:
 *   firebase functions:secrets:set MAIL_API_KEY
 */
const MAIL_API_KEY = defineSecret('MAIL_API_KEY');

const STATUS_LABELS = {
  viewed: 'просмотрен работодателем',
  interview: 'приглашение на собеседование',
  offer: 'оффер',
  rejected: 'отказ',
};

export const onApplicationStatus = onDocumentUpdated(
  { document: 'applications/{appId}', region: REGION, secrets: [MAIL_API_KEY] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status) return;

    const label = STATUS_LABELS[after.status];
    if (!label) return;

    const user = await db.doc(`users/${after.userId}`).get();
    if (user.data()?.settings?.emailNotifications === false) return;

    const payload = {
      to: after.userEmail,
      subject: `AI JobHub: ${after.jobTitle} — ${label}`,
      text: `Статус вашего отклика на вакансию «${after.jobTitle}» (${after.companyName}) изменился: ${label}.`,
    };

    if (!MAIL_API_KEY.value()) {
      logger.info('письмо не отправлено — секрет MAIL_API_KEY не задан', payload);
      return;
    }

    // Пример для Resend; замените на свой транспорт при необходимости.
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MAIL_API_KEY.value()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AI JobHub <noreply@example.com>',
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      }),
    });

    if (!response.ok) logger.error('почта не отправлена', await response.text());
  },
);

/* --------------------------------------------------- LLM: письмо под вакансию */

const LLM_API_KEY = defineSecret('LLM_API_KEY');

/**
 * Генерация сопроводительного письма под конкретную вакансию.
 *
 * Детерминированный движок в src/ai/match.js остаётся основным: он считает
 * проценты мгновенно и бесплатно для каждой карточки каталога. Языковая
 * модель подключается точечно — там, где нужен связный текст.
 *
 * Вызов с клиента:
 *   const fn = httpsCallable(getFunctions(app, 'europe-west1'), 'generateCoverLetter');
 *   const { data } = await fn({ jobId });
 */
export const generateCoverLetter = onCall(
  { region: REGION, secrets: [LLM_API_KEY], enforceAppCheck: false },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
    if (!LLM_API_KEY.value()) throw new HttpsError('failed-precondition', 'Не задан секрет LLM_API_KEY');

    const { jobId } = request.data || {};
    if (!jobId) throw new HttpsError('invalid-argument', 'Не передан jobId');

    const [jobSnap, userSnap] = await Promise.all([
      db.doc(`jobs/${jobId}`).get(),
      db.doc(`users/${request.auth.uid}`).get(),
    ]);
    if (!jobSnap.exists) throw new HttpsError('not-found', 'Вакансия не найдена');

    const job = jobSnap.data();
    const resume = userSnap.data()?.resume || {};

    const prompt = [
      'Напиши короткое сопроводительное письмо на русском языке, 3–4 абзаца, без канцелярита.',
      `Вакансия: ${job.title} в компании ${job.companyName}.`,
      `Требования: ${(job.requirements || []).join('; ')}.`,
      `Навыки вакансии: ${(job.skills || []).join(', ')}.`,
      `Опыт кандидата: ${resume.yearsExperience || 0} лет, грейд ${resume.level || 'не указан'}.`,
      `Навыки кандидата: ${(resume.skills || []).join(', ')}.`,
      'Не выдумывай факты, которых нет в данных кандидата.',
    ].join('\n');

    // OpenAI-совместимый эндпоинт: подставьте своего провайдера в LLM_BASE_URL.
    const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LLM_API_KEY.value()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      logger.error('LLM вернул ошибку', await response.text());
      throw new HttpsError('internal', 'Не удалось сгенерировать письмо');
    }

    const data = await response.json();
    return { letter: data.choices?.[0]?.message?.content?.trim() || '' };
  },
);
