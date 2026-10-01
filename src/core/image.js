/**
 * Подготовка картинок перед загрузкой в Firebase Storage.
 *
 * Зачем нужен отдельный модуль: телефон снимает фото на 4–8 МБ, а в интерфейсе
 * аватар показывается кружком 32–96 px. Грузить оригинал — это лишние деньги
 * за трафик Storage и заметная пауза на мобильном интернете. Поэтому файл
 * сначала уменьшается через <canvas> в браузере, и на сервер уходит
 * квадратный JPEG ~30–60 КБ.
 *
 * Тот же результат используется и демо-режимом: там blob не загружается
 * никуда, а сохраняется в localStorage как data URL — контракт адаптеров
 * остаётся одинаковым.
 */

/** Допустимые типы: то, что умеет отрисовать <img> во всех браузерах. */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Предел на исходный файл — до уменьшения. 8 МБ хватает любой фотографии. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Проверка файла до чтения: тип и размер.
 * Бросает ошибку с готовым текстом для тоста.
 */
export function assertImage(file) {
  if (!file) throw new Error('Файл не выбран');
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Нужна картинка: JPEG, PNG, WebP или GIF');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`Файл слишком большой: ${Math.round(file.size / 1024 / 1024)} МБ, максимум 8 МБ`);
  }
  return true;
}

/** Читает файл в объектный URL и дожидается декодирования картинки. */
function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

/**
 * Уменьшает картинку до квадрата size×size с обрезкой по центру.
 *
 * @param {File} file          исходный файл из <input type="file">
 * @param {number} size        сторона результата в пикселях
 * @param {number} quality     качество JPEG, 0..1
 * @returns {Promise<{blob: Blob, dataUrl: string, contentType: string, size: number}>}
 */
export async function prepareSquareImage(file, size = 256, quality = 0.82) {
  assertImage(file);
  const img = await loadBitmap(file);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Обрезка по центру: берём из оригинала максимальный квадрат.
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const blob = await new Promise((resolve) => {
    // toBlob поддерживается везде, но на всякий случай есть путь через dataURL.
    if (canvas.toBlob) canvas.toBlob(resolve, 'image/jpeg', quality);
    else resolve(dataUrlToBlob(dataUrl));
  });

  return { blob: blob || dataUrlToBlob(dataUrl), dataUrl, contentType: 'image/jpeg', size: blob?.size || 0 };
}

/** data URL → Blob. Нужен как запасной путь и для демо-режима. */
export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const contentType = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bytes = atob(body);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: contentType });
}
