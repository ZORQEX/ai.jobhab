/**
 * Локальный статический сервер для разработки.
 *
 * Зачем он нужен: ES6-модули не работают по file:// — браузер блокирует
 * импорты из-за политики CORS. Раньше в package.json стоял
 * `python3 -m http.server`, но Python есть не на каждой машине (на Windows
 * вместо него часто заглушка из Microsoft Store). Node для проекта и так
 * нужен — ESLint и тесты, — поэтому сервер написан на нём и без зависимостей.
 *
 * Запуск:  npm run serve        (http://localhost:8080)
 *          node tools/serve.js 3000
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

// Правильный Content-Type обязателен: при text/plain браузер откажется
// исполнять .js как модуль.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.rules': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Путь из URL → путь на диске, с защитой от выхода за корень проекта. */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = resolve(join(ROOT, normalize(clean)));
  if (target !== ROOT && !target.startsWith(ROOT + (process.platform === 'win32' ? '\\' : '/'))) {
    return null;                                   // попытка вылезти через ../
  }
  return target;
}

async function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    // Кэш выключен: правка файла видна по F5 без бубна.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let target = resolvePath(req.url === '/' ? '/index.html' : req.url);
  if (!target) return send(res, 403, 'Запрещено');

  try {
    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target);
    }
    const body = await readFile(target);
    return send(res, 200, body, TYPES[extname(target).toLowerCase()] || 'application/octet-stream');
  } catch (_) {
    // Своя страница 404 проекта, если она есть.
    try {
      return send(res, 404, await readFile(join(ROOT, '404.html')), TYPES['.html']);
    } catch (__) {
      return send(res, 404, 'Не найдено');
    }
  }
});

server.listen(PORT, () => {
  console.info(`AI JobHub: http://localhost:${PORT}  (Ctrl+C — остановить)`);
});
