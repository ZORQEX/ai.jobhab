/**
 * Конфигурация ESLint (flat config, ESLint 9).
 * Запуск: npm run lint
 */

import globals from 'globals';

const commonRules = {
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    ignoreRestSiblings: true,
  }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implicit-coercion': ['warn', { boolean: false }],
  'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
  'prefer-template': 'warn',
  'object-shorthand': 'warn',
  'no-else-return': 'warn',
  'no-param-reassign': ['warn', { props: false }],
  'arrow-body-style': ['warn', 'as-needed'],
  quotes: ['warn', 'single', { avoidEscape: true }],
  semi: ['error', 'always'],
  'comma-dangle': ['warn', 'always-multiline'],
  'max-len': ['warn', { code: 120, ignoreComments: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
};

export default [
  {
    ignores: ['node_modules/**', 'functions/node_modules/**'],
  },
  {
    // Клиентский код: только браузерные глобальные объекты.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: commonRules,
  },
  {
    // Тесты, Cloud Functions и локальный сервер исполняются в Node.
    files: ['tests/**/*.js', 'functions/**/*.js', 'tools/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, fetch: 'readonly' },
    },
    rules: commonRules,
  },
];
