/**
 * Модульные тесты правил безопасности Firestore.
 *
 * Запуск: npm run test:rules
 * (поднимает эмулятор Firestore и прогоняет сценарии против firestore.rules)
 *
 * Проверяется то, что нельзя проверить «на глаз»: что запрос без нужного
 * фильтра действительно падает, что пользователь не может повысить себе роль,
 * переписать журнал статусов или накрутить счётчик откликов.
 */

import { readFileSync } from 'node:fs';
import { test, before, after } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, limit,
} from 'firebase/firestore';

const ADMIN = 'admin-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let env;
let guest;
let alice;
let bob;
let admin;

const ts = new Date();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'ai-jobhub-rules-test',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });

  guest = env.unauthenticatedContext().firestore();
  alice = env.authenticatedContext(ALICE, { email: 'alice@example.com' }).firestore();
  bob = env.authenticatedContext(BOB, { email: 'bob@example.com' }).firestore();
  admin = env.authenticatedContext(ADMIN, { email: 'admin@example.com' }).firestore();

  // Данные готовим в обход правил.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'users', ADMIN), {
      uid: ADMIN, email: 'admin@example.com', displayName: 'Админ',
      role: 'admin', disabled: false, resume: {}, settings: {}, stats: {},
    });
    await setDoc(doc(db, 'users', ALICE), {
      uid: ALICE, email: 'alice@example.com', displayName: 'Алиса',
      role: 'user', disabled: false, resume: { skills: ['React'] }, settings: {}, stats: {},
    });
    await setDoc(doc(db, 'users', BOB), {
      uid: BOB, email: 'bob@example.com', displayName: 'Боб',
      role: 'user', disabled: false, resume: {}, settings: {}, stats: {},
    });

    await setDoc(doc(db, 'jobs', 'open-job'), {
      title: 'Frontend-разработчик', status: 'open', city: 'Алматы',
      applicationsCount: 3, viewsCount: 10, savesCount: 1,
    });
    await setDoc(doc(db, 'jobs', 'draft-job'), {
      title: 'Черновик', status: 'draft', city: 'Алматы',
      applicationsCount: 0, viewsCount: 0, savesCount: 0,
    });

    await setDoc(doc(db, 'applications', 'alice-app'), {
      userId: ALICE, jobId: 'open-job', jobTitle: 'Frontend-разработчик',
      status: 'sent', coverLetter: 'Здравствуйте', matchScore: 80,
      statusHistory: [{ status: 'sent', at: ts.toISOString(), by: ALICE }],
    });

    await setDoc(doc(db, 'saved', `${ALICE}_open-job`), { userId: ALICE, jobId: 'open-job' });

    await setDoc(doc(db, 'reviews', 'visible-review'), {
      jobId: 'open-job', userId: BOB, userName: 'Боб', rating: 5,
      text: 'Хорошая компания', hidden: false,
    });
    await setDoc(doc(db, 'reviews', 'hidden-review'), {
      jobId: 'open-job', userId: BOB, userName: 'Боб', rating: 1,
      text: 'Скрытый отзыв', hidden: true,
    });

    await setDoc(doc(db, 'meta', 'stats'), { jobs: 2 });
  });
});

after(async () => {
  await env?.cleanup();
});

/* ------------------------------------------------------------- вакансии */

test('гость видит открытые вакансии, если запрос сужен по статусу', async () => {
  await assertSucceeds(getDocs(query(collection(guest, 'jobs'), where('status', '==', 'open'), limit(10))));
});

test('гость не может выгрузить коллекцию вакансий без фильтра', async () => {
  await assertFails(getDocs(query(collection(guest, 'jobs'), limit(10))));
});

test('гость не может открыть черновик вакансии', async () => {
  await assertFails(getDoc(doc(guest, 'jobs', 'draft-job')));
});

test('админ видит черновики', async () => {
  await assertSucceeds(getDoc(doc(admin, 'jobs', 'draft-job')));
  await assertSucceeds(getDocs(query(collection(admin, 'jobs'), limit(10))));
});

test('обычный пользователь не может создать вакансию', async () => {
  await assertFails(setDoc(doc(alice, 'jobs', 'hacked'), {
    title: 'Своя вакансия', status: 'open', applicationsCount: 0,
  }));
});

test('админ создаёт вакансию', async () => {
  await assertSucceeds(setDoc(doc(admin, 'jobs', 'by-admin'), {
    title: 'Новая вакансия', status: 'open', applicationsCount: 0,
  }));
});

test('счётчик откликов можно увеличить только на единицу', async () => {
  await assertSucceeds(updateDoc(doc(alice, 'jobs', 'open-job'), { applicationsCount: 4 }));
  await assertFails(updateDoc(doc(alice, 'jobs', 'open-job'), { applicationsCount: 9999 }));
});

test('обычный пользователь не может править текст вакансии', async () => {
  await assertFails(updateDoc(doc(alice, 'jobs', 'open-job'), { title: 'Подменённое название' }));
});

/* --------------------------------------------------------------- отклики */

test('пользователь читает свои отклики', async () => {
  await assertSucceeds(getDocs(query(
    collection(alice, 'applications'), where('userId', '==', ALICE), limit(10),
  )));
});

test('пользователь не может выгрузить все отклики', async () => {
  await assertFails(getDocs(query(collection(alice, 'applications'), limit(10))));
});

test('пользователь не может прочитать чужой отклик по прямой ссылке', async () => {
  await assertFails(getDoc(doc(bob, 'applications', 'alice-app')));
});

test('админ видит все отклики', async () => {
  await assertSucceeds(getDocs(query(collection(admin, 'applications'), limit(10))));
});

test('отклик создаётся только со статусом sent и от своего имени', async () => {
  await assertSucceeds(setDoc(doc(bob, 'applications', 'bob-app'), {
    userId: BOB, jobId: 'open-job', status: 'sent', coverLetter: '',
    statusHistory: [{ status: 'sent', at: ts.toISOString(), by: BOB }],
  }));

  await assertFails(setDoc(doc(bob, 'applications', 'bob-offer'), {
    userId: BOB, jobId: 'open-job', status: 'offer', coverLetter: '',
    statusHistory: [{ status: 'offer', at: ts.toISOString(), by: BOB }],
  }));

  await assertFails(setDoc(doc(bob, 'applications', 'bob-fake'), {
    userId: ALICE, jobId: 'open-job', status: 'sent', coverLetter: '',
    statusHistory: [{ status: 'sent', at: ts.toISOString(), by: BOB }],
  }));
});

test('пользователь может отозвать свой отклик, дописав одну запись в журнал', async () => {
  await assertSucceeds(updateDoc(doc(alice, 'applications', 'alice-app'), {
    status: 'withdrawn',
    updatedAt: ts,
    statusHistory: [
      { status: 'sent', at: ts.toISOString(), by: ALICE },
      { status: 'withdrawn', at: ts.toISOString(), by: ALICE },
    ],
  }));
});

test('пользователь не может переписать журнал статусов', async () => {
  await assertFails(updateDoc(doc(alice, 'applications', 'alice-app'), {
    status: 'withdrawn',
    updatedAt: ts,
    statusHistory: [{ status: 'withdrawn', at: ts.toISOString(), by: ALICE }],
  }));
});

test('пользователь не может выдать себе оффер', async () => {
  await assertFails(updateDoc(doc(alice, 'applications', 'alice-app'), { status: 'offer' }));
});

test('админ меняет статус отклика', async () => {
  await assertSucceeds(updateDoc(doc(admin, 'applications', 'alice-app'), { status: 'interview' }));
});

/* ------------------------------------------------------------ профили */

test('пользователь правит своё резюме', async () => {
  await assertSucceeds(updateDoc(doc(alice, 'users', ALICE), {
    resume: { skills: ['React', 'TypeScript'] },
  }));
});

test('пользователь не может выдать себе роль admin', async () => {
  await assertFails(updateDoc(doc(alice, 'users', ALICE), { role: 'admin' }));
});

test('пользователь не может разблокировать себя', async () => {
  await assertFails(updateDoc(doc(alice, 'users', ALICE), { disabled: true }));
});

test('пользователь не может прочитать чужой профиль, админ может', async () => {
  await assertFails(getDoc(doc(alice, 'users', BOB)));
  await assertSucceeds(getDoc(doc(admin, 'users', BOB)));
});

test('список пользователей доступен только админу', async () => {
  await assertFails(getDocs(query(collection(alice, 'users'), limit(10))));
  await assertSucceeds(getDocs(query(collection(admin, 'users'), limit(10))));
});

test('регистрация создаёт профиль только с ролью user', async () => {
  const carol = env.authenticatedContext('carol-uid', { email: 'carol@example.com' }).firestore();
  await assertFails(setDoc(doc(carol, 'users', 'carol-uid'), {
    uid: 'carol-uid', email: 'carol@example.com', displayName: 'Кэрол', role: 'admin',
  }));
  await assertSucceeds(setDoc(doc(carol, 'users', 'carol-uid'), {
    uid: 'carol-uid', email: 'carol@example.com', displayName: 'Кэрол', role: 'user',
  }));
});

/* ------------------------------------------------- сохранённые вакансии */

test('пользователь работает только со своими сохранёнными', async () => {
  await assertSucceeds(setDoc(doc(alice, 'saved', `${ALICE}_by-admin`), {
    userId: ALICE, jobId: 'by-admin',
  }));
  await assertFails(setDoc(doc(bob, 'saved', `${ALICE}_open-job`), {
    userId: ALICE, jobId: 'open-job',
  }));
  await assertFails(getDoc(doc(bob, 'saved', `${ALICE}_open-job`)));
  await assertFails(deleteDoc(doc(bob, 'saved', `${ALICE}_open-job`)));
});

test('нельзя создать сохранённое с чужим префиксом в ID', async () => {
  await assertFails(setDoc(doc(bob, 'saved', `${ALICE}_draft-job`), {
    userId: BOB, jobId: 'draft-job',
  }));
});

/* ---------------------------------------------------------------- отзывы */

test('публичный список отзывов требует фильтра hidden == false', async () => {
  await assertSucceeds(getDocs(query(
    collection(guest, 'reviews'), where('hidden', '==', false), limit(10),
  )));
  await assertFails(getDocs(query(collection(guest, 'reviews'), limit(10))));
});

test('скрытый отзыв недоступен обычному пользователю', async () => {
  await assertFails(getDoc(doc(alice, 'reviews', 'hidden-review')));
  await assertSucceeds(getDoc(doc(admin, 'reviews', 'hidden-review')));
});

test('автор правит свой отзыв, чужой — нет', async () => {
  await assertSucceeds(updateDoc(doc(bob, 'reviews', 'visible-review'), {
    text: 'Обновлённый отзыв', rating: 4,
  }));
  await assertFails(updateDoc(doc(alice, 'reviews', 'visible-review'), {
    text: 'Чужой отзыв', rating: 1,
  }));
});

test('скрыть отзыв может только админ', async () => {
  await assertFails(updateDoc(doc(bob, 'reviews', 'visible-review'), { hidden: true }));
  await assertSucceeds(updateDoc(doc(admin, 'reviews', 'visible-review'), {
    hidden: true, moderatedBy: ADMIN,
  }));
});

/* ------------------------------------------------------------- агрегаты */

test('документ агрегатов клиент не пишет', async () => {
  await assertFails(setDoc(doc(admin, 'meta', 'stats'), { jobs: 100 }));
  await assertSucceeds(getDoc(doc(admin, 'meta', 'stats')));
});
