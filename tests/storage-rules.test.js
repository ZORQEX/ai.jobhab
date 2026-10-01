/**
 * Модульные тесты правил безопасности Firebase Storage (storage.rules).
 *
 * Запуск: npm run test:storage-rules
 * (поднимает эмулятор Storage; как и эмулятору Firestore, ему нужна Java)
 *
 * Проверяется то же, что и в Rules Playground, только автоматически:
 * что чужой аватар не перезапишешь, что логотип компании грузит только админ,
 * что нельзя залить не-картинку или файл больше лимита, и что читать
 * загруженное может кто угодно — логотипы и аватары видны в каталоге
 * неавторизованному посетителю.
 */

import { readFileSync } from 'node:fs';
import { test, before, after } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const ADMIN = 'admin-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

const JPEG = { contentType: 'image/jpeg' };
const smallImage = () => new Uint8Array(1024).fill(7);      // ~1 КБ, лимит 1 МБ
const hugeImage = () => new Uint8Array(1024 * 1024 + 512).fill(7);

let env;
let guest;
let alice;
let bob;
let admin;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'ai-jobhub-rules-test',
    storage: { rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8') },
  });

  guest = env.unauthenticatedContext().storage();
  alice = env.authenticatedContext(ALICE, { email: 'alice@example.com' }).storage();
  bob = env.authenticatedContext(BOB, { email: 'bob@example.com' }).storage();
  // Роль админа приходит из custom claim — ровно так её выставляет
  // Cloud Function syncAdminClaim, и именно её читают правила.
  admin = env.authenticatedContext(ADMIN, { admin: true }).storage();

  // Файлы для проверки чтения заливаем в обход правил.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const storage = ctx.storage();
    await uploadBytes(ref(storage, `avatars/${ALICE}/avatar.jpg`), smallImage(), JPEG);
    await uploadBytes(ref(storage, 'logos/job-1/logo.jpg'), smallImage(), JPEG);
  });
});

after(async () => {
  await env?.cleanup();
});

/* ---------------------------------------------------------------- чтение */

test('аватар и логотип читает любой, даже неавторизованный посетитель', async () => {
  await assertSucceeds(getBytes(ref(guest, `avatars/${ALICE}/avatar.jpg`)));
  await assertSucceeds(getBytes(ref(guest, 'logos/job-1/logo.jpg')));
});

/* ---------------------------------------------------------------- аватары */

test('пользователь загружает свой аватар', async () => {
  await assertSucceeds(uploadBytes(ref(alice, `avatars/${ALICE}/avatar.jpg`), smallImage(), JPEG));
});

test('чужой аватар перезаписать нельзя', async () => {
  await assertFails(uploadBytes(ref(bob, `avatars/${ALICE}/avatar.jpg`), smallImage(), JPEG));
});

test('неавторизованный не может загрузить аватар', async () => {
  await assertFails(uploadBytes(ref(guest, `avatars/${ALICE}/avatar.jpg`), smallImage(), JPEG));
});

test('не-картинку в аватары не пускают', async () => {
  await assertFails(uploadBytes(
    ref(alice, `avatars/${ALICE}/avatar.jpg`),
    new Uint8Array([1, 2, 3]),
    { contentType: 'application/pdf' },
  ));
});

test('файл больше 1 МБ не проходит', async () => {
  await assertFails(uploadBytes(ref(alice, `avatars/${ALICE}/avatar.jpg`), hugeImage(), JPEG));
});

test('свой аватар можно удалить, чужой — нет', async () => {
  await assertFails(deleteObject(ref(bob, `avatars/${ALICE}/avatar.jpg`)));
  await assertSucceeds(deleteObject(ref(alice, `avatars/${ALICE}/avatar.jpg`)));
});

/* ------------------------------------------------------- логотипы компаний */

test('логотип компании грузит только админ', async () => {
  await assertFails(uploadBytes(ref(alice, 'logos/job-1/logo.jpg'), smallImage(), JPEG));
  await assertSucceeds(uploadBytes(ref(admin, 'logos/job-1/logo.jpg'), smallImage(), JPEG));
});

test('логотип удаляет только админ', async () => {
  await assertFails(deleteObject(ref(alice, 'logos/job-1/logo.jpg')));
  await assertSucceeds(deleteObject(ref(admin, 'logos/job-1/logo.jpg')));
});

/* ------------------------------------------------- всё остальное запрещено */

test('посторонние пути закрыты даже для админа', async () => {
  await assertFails(uploadBytes(ref(admin, 'resumes/secret.pdf'), smallImage(), JPEG));
  await assertFails(getBytes(ref(alice, 'resumes/secret.pdf')));
});
