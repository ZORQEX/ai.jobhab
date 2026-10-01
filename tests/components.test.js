/**
 * Тесты компонентов аватара и логотипа компании (node --test).
 *
 * Эти компоненты живут в DOM, а node про DOM ничего не знает, поэтому здесь
 * поднимается минимальная заглушка: ровно те методы, которые использует
 * хелпер el() из src/core/ui.js. Смысл теста — поймать опечатку в атрибутах
 * и проверить логику выбора «картинка или инициалы» без запуска браузера.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ заглушка DOM */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.textContent = '';
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  /** Текст всего поддерева — так удобно проверять инициалы. */
  get text() {
    if (this.children.length === 0) return this.textContent;
    return this.children.map((c) => (c instanceof FakeNode ? c.text : String(c.textContent ?? c))).join('');
  }
}

// Текстовый узел наследует FakeNode: el() проверяет child instanceof Node,
// и текст должен эту проверку проходить.
class FakeText extends FakeNode {
  constructor(value) {
    super('#text');
    this.textContent = String(value);
  }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (value) => new FakeText(value),
};

const { avatarEl, companyLogoEl } = await import('../src/core/components.js');

/* ---------------------------------------------------------------- аватар */

test('без фото аватар показывает инициалы', () => {
  const node = avatarEl({ displayName: 'Айдана Сериковна' }, 32);
  assert.equal(node.tagName, 'SPAN');
  assert.equal(node.className, 'avatar');
  assert.equal(node.text, 'АС');
});

test('с фото аватар становится картинкой с alt и ленивой загрузкой', () => {
  const node = avatarEl({ displayName: 'Ержан', photoURL: 'https://example.com/a.jpg' }, 48);
  assert.equal(node.tagName, 'IMG');
  assert.equal(node.attributes.src, 'https://example.com/a.jpg');
  assert.equal(node.attributes.loading, 'lazy');
  assert.match(node.attributes.alt, /Ержан/);
  assert.match(node.attributes.style, /width:48px/);
  // Битая ссылка обрабатывается — обработчик error навешен.
  assert.equal(node.listeners.error.length, 1);
});

test('аватар автора отзыва берётся из денормализованного userPhotoURL', () => {
  const node = avatarEl({ userName: 'Данияр Ахметов', userPhotoURL: 'https://example.com/r.jpg' });
  assert.equal(node.tagName, 'IMG');
  assert.equal(node.attributes.src, 'https://example.com/r.jpg');
});

test('аватар без имени не падает и остаётся кружком', () => {
  const node = avatarEl({}, 20);
  assert.equal(node.tagName, 'SPAN');
  assert.match(node.attributes.style, /width:20px/);
});

/* ------------------------------------------------------- логотип компании */

test('без картинки логотип — эмодзи из справочника', () => {
  const node = companyLogoEl({ company: { logo: '🏔️', name: 'Alatau Digital' } });
  assert.equal(node.tagName, 'DIV');
  assert.equal(node.className, 'company-logo');
  assert.equal(node.text, '🏔️');
});

test('загруженный логотип отдаётся картинкой с названием компании в alt', () => {
  const node = companyLogoEl({ company: { logoUrl: 'https://example.com/l.jpg', name: 'Tumar Tech' } }, 56);
  assert.equal(node.tagName, 'IMG');
  assert.equal(node.attributes.src, 'https://example.com/l.jpg');
  assert.match(node.attributes.alt, /Tumar Tech/);
  assert.match(node.attributes.style, /height:56px/);
});

test('денормализованная запись сохранённой вакансии тоже показывает логотип', () => {
  const saved = { companyName: 'Qazaq Cloud', companyLogo: '☁️', companyLogoUrl: 'https://example.com/q.jpg' };
  assert.equal(companyLogoEl(saved).tagName, 'IMG');

  const withoutUrl = { companyName: 'Qazaq Cloud', companyLogo: '☁️', companyLogoUrl: null };
  assert.equal(companyLogoEl(withoutUrl).text, '☁️');
});

test('пустой источник даёт эмодзи по умолчанию', () => {
  assert.equal(companyLogoEl().text, '💼');
});
