/**
 * Основной адаптер данных: Firebase Firestore + Firebase Authentication.
 *
 * SDK подключается динамическим import() с CDN — сборщик проекту не нужен,
 * страницы остаются чистыми ES6-модулями и работают на GitHub Pages как есть.
 *
 * Что здесь используется из обязательного списка ТЗ:
 *   • onSnapshot            — каталог, карточка вакансии, отклики, сохранённые, админка
 *   • startAfter + limit    — курсорная пагинация каталога, похожих, отзывов, таблиц админки
 *   • increment             — атомарные счётчики откликов, просмотров, сохранений
 *   • writeBatch            — массовая заливка тестовых данных
 *   • getCountFromServer    — агрегаты для статистики без выгрузки документов
 */

import { APP, getFirebaseConfig } from '../config.js';
import { SEED_JOBS, SEED_REVIEWS } from './seed.js';
import { buildJobIndex, matchesQuery, tokenize } from './job-index.js';

let app, db, auth, FS, AUTH;

/* ------------------------------------------------------------- инициализация */

async function loadSdk() {
  const [appMod, authMod, storeMod] = await Promise.all([
    import(`${APP.firebaseSdk}/firebase-app.js`),
    import(`${APP.firebaseSdk}/firebase-auth.js`),
    import(`${APP.firebaseSdk}/firebase-firestore.js`),
  ]);
  AUTH = authMod;
  FS = storeMod;
  app = appMod.initializeApp(getFirebaseConfig());

  // Офлайн-кэш в IndexedDB: повторное открытие каталога отдаётся из кэша,
  // а не оплачивается новыми чтениями Firestore. Несколько вкладок разделяют
  // один кэш через persistentMultipleTabManager.
  try {
    db = storeMod.initializeFirestore(app, {
      localCache: storeMod.persistentLocalCache({
        tabManager: storeMod.persistentMultipleTabManager(),
      }),
    });
  } catch (error) {
    // Приватный режим браузера или уже инициализированный экземпляр.
    console.warn('[firebase] офлайн-кэш недоступен, работаю без него', error);
    db = storeMod.getFirestore(app);
  }

  auth = authMod.getAuth(app);
  await authMod.setPersistence(auth, authMod.browserLocalPersistence);
}

/**
 * Storage подключается отдельно и только по требованию: аватар грузят редко,
 * а на каждой загрузке каталога тянуть ещё один модуль SDK смысла нет.
 * Результат кэшируется, повторные вызовы бесплатны.
 */
let storagePromise = null;

function loadStorage() {
  if (!storagePromise) {
    storagePromise = import(`${APP.firebaseSdk}/firebase-storage.js`).then((mod) => ({
      mod,
      storage: mod.getStorage(app),
    }));
  }
  return storagePromise;
}

/* ---------------------------------------------------------------- утилиты */

const AUTH_ERRORS = {
  'auth/invalid-email': 'Некорректный адрес почты',
  'auth/user-disabled': 'Аккаунт отключён',
  'auth/user-not-found': 'Пользователь с такой почтой не найден',
  'auth/wrong-password': 'Неверный пароль',
  'auth/invalid-credential': 'Неверная почта или пароль',
  'auth/email-already-in-use': 'Эта почта уже зарегистрирована',
  'auth/weak-password': 'Пароль должен быть не короче 6 символов',
  'auth/too-many-requests': 'Слишком много попыток. Повторите через несколько минут',
  'auth/network-request-failed': 'Нет связи с Firebase. Проверьте подключение',
  'auth/operation-not-allowed': 'В Firebase Console не включён вход по email и паролю',
};

/**
 * Если запросу не хватает составного индекса, Firestore возвращает
 * failed-precondition и кладёт прямую ссылку на создание индекса в текст
 * ошибки. Вытаскиваем её и показываем в консоли — иначе разработчик видит
 * просто пустой список.
 */
function indexUrlFrom(error) {
  const match = String(error?.message || '').match(/https:\/\/console\.firebase\.google\.com\/\S+/);
  return match ? match[0].replace(/[).]+$/, '') : null;
}

function rethrow(error) {
  let message = AUTH_ERRORS[error?.code];

  if (!message && error?.code === 'permission-denied') {
    message = 'Недостаточно прав — операцию запретили правила безопасности';
  }

  if (!message && error?.code === 'failed-precondition') {
    const url = indexUrlFrom(error);
    if (url) console.error('[firebase] не хватает составного индекса, создать: %s', url);
    message = 'Для этого запроса нужен составной индекс Firestore. '
      + 'Ссылка на его создание выведена в консоль браузера, '
      + 'а сам индекс стоит добавить в firestore.indexes.json.';
  }

  if (!message && error?.code === 'unavailable') {
    message = 'Нет связи с Firestore. Проверьте интернет — данные покажутся из офлайн-кэша, если он есть.';
  }

  const wrapped = new Error(message || error?.message || 'Неизвестная ошибка');
  wrapped.code = error?.code;
  wrapped.indexUrl = indexUrlFrom(error);
  throw wrapped;
}

const docData = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null);
const listData = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/* ------------------------------------------------------- построение запроса */

/**
 * Фильтры каталога, которые МОГУТ уйти в Firestore, в порядке избирательности:
 * направление сужает выдачу сильнее, чем «только удалёнка».
 */
const SERVER_FILTERS = ['category', 'city', 'level', 'employment', 'remote'];

/** Во сколько раз больше документов берёт снимок, когда есть дофильтровка. */
const OVERFETCH = 4;

/**
 * План запроса каталога: что считает Firestore, а что доуточняет клиент.
 *
 * Почему не «все фильтры в запрос». Составной индекс нужен на каждое
 * сочетание «фильтры + сортировка». Фильтров пять, сортировок четыре, значит
 * сочетаний 2⁵ × 4 = 128, а с поиском — вдвое больше; лимит Firestore —
 * 200 составных индексов на базу, и половину из них никто никогда не откроет.
 * Поэтому в запрос уходит статус, ОДИН самый избирательный фильтр и сортировка
 * (34 индекса на все случаи), а остальные условия отсеиваются на клиенте тем
 * же механизмом, что и слова поискового запроса. Недобор карточек на странице
 * компенсирует цикл дочитывания в listJobs и увеличенный лимит в снимке.
 *
 * Функция чистая — ни FS, ни сети, поэтому проверяется тестами
 * (tests/query-plan.test.js).
 *
 * @returns {{status:string|null, tokens:string[], serverFilter:object|null,
 *            clientFilters:object[], order:object, range:object|null,
 *            refines:boolean}}
 */
export function planJobQuery(p = {}) {
  const status = p.includeAllStatuses ? (p.status || null) : (p.status || 'open');

  const active = SERVER_FILTERS
    .filter((field) => (field === 'remote' ? !!p.remote : !!p[field]))
    .map((field) => ({ field, value: field === 'remote' ? true : p[field] }));

  // Поиск занимает место единственного дополнительного серверного условия:
  // array-contains по токену отсеивает больше, чем любой из фильтров.
  const tokens = p.q ? tokenize(p.q) : [];
  const serverFilter = tokens.length ? null : (active[0] || null);
  const clientFilters = active.filter((f) => f !== serverFilter);

  // Firestore разрешает диапазонный фильтр только по полю первой сортировки,
  // поэтому «зарплата от» переключает сортировку на зарплату — так же ведёт
  // себя и демо-адаптер, чтобы выдача совпадала.
  let range = null;
  let order;
  if (p.minSalary) {
    range = { field: 'salaryMax', op: '>=', value: Number(p.minSalary) };
    order = { field: 'salaryMax', direction: p.sort === 'salaryAsc' ? 'asc' : 'desc' };
  } else if (p.sort === 'salaryDesc') {
    order = { field: 'salaryMax', direction: 'desc' };
  } else if (p.sort === 'salaryAsc') {
    order = { field: 'salaryMin', direction: 'asc' };
  } else if (p.sort === 'popular') {
    order = { field: 'applicationsCount', direction: 'desc' };
  } else {
    order = { field: 'createdAt', direction: 'desc' };
  }

  return {
    status,
    tokens,
    serverFilter,
    clientFilters,
    order,
    range,
    refines: clientFilters.length > 0 || tokens.length > 0,
  };
}

/** План → ограничения Firestore SDK. */
function jobConstraints(p = {}, { pageSize, plan = planJobQuery(p) } = {}) {
  const { where, orderBy, limit } = FS;
  const c = [];

  if (plan.status) c.push(where('status', '==', plan.status));
  if (plan.serverFilter) c.push(where(plan.serverFilter.field, '==', plan.serverFilter.value));
  if (plan.tokens.length) c.push(where('searchTokens', 'array-contains', plan.tokens[0]));
  if (plan.range) c.push(where(plan.range.field, plan.range.op, plan.range.value));

  c.push(orderBy(plan.order.field, plan.order.direction));

  // Когда часть условий проверяется на клиенте, из базы берётся с запасом:
  // иначе после отсева на странице осталось бы 2-3 карточки из 12.
  const size = pageSize || p.pageSize || APP.pageSize;
  c.push(limit(plan.refines ? size * OVERFETCH : size));

  return { constraints: c, plan, pageSize: size };
}

/**
 * Клиентская дофильтровка: условия, которые не ушли в запрос, плюс слова
 * поисковой строки (в индекс уходит только первый токен).
 */
function refineJobs(items, params, plan = planJobQuery(params)) {
  let out = items;
  for (const { field, value } of plan.clientFilters) {
    out = field === 'remote'
      ? out.filter((job) => !!job.remote)
      : out.filter((job) => job[field] === value);
  }
  if (plan.tokens.length) out = out.filter((job) => matchesQuery(job, params.q));
  return out;
}

/* -------------------------------------------------------------------- API */

export const firebaseBackend = {
  mode: 'firebase',

  async init() {
    await loadSdk();
    return this;
  },

  /* ---- auth ---- */

  _profile: null,

  // Подписчики на профиль. onAuthStateChanged срабатывает только на вход и
  // выход, а профиль меняется и без этого — например, при загрузке аватара.
  // Демо-адаптер в таком случае уведомляет слушателей (notifyAuth), поэтому
  // здесь тот же механизм: иначе шапка обновляла бы аватар лишь после F5,
  // и один и тот же вызов updateProfile вёл бы себя по-разному в двух режимах.
  _profileListeners: new Set(),

  currentUser() {
    return this._profile;
  },

  _notifyProfile() {
    this._profileListeners.forEach((cb) => cb(this._profile));
  },

  onAuthChange(cb) {
    this._profileListeners.add(cb);
    const unsubscribe = AUTH.onAuthStateChanged(auth, async (user) => {
      if (!user) {
        this._profile = null;
        cb(null);
        return;
      }
      try {
        const ref = FS.doc(db, 'users', user.uid);
        let snap = await FS.getDoc(ref);
        if (!snap.exists()) {
          await this._createUserDoc(user, user.displayName || user.email.split('@')[0]);
          snap = await FS.getDoc(ref);
        }
        this._profile = { uid: user.uid, ...snap.data() };
        cb(this._profile);
      } catch (error) {
        console.error('[firebase] не удалось загрузить профиль', error);
        this._profile = { uid: user.uid, email: user.email, displayName: user.email, role: 'user' };
        cb(this._profile);
      }
    });

    return () => {
      this._profileListeners.delete(cb);
      unsubscribe();
    };
  },

  async _createUserDoc(user, displayName) {
    await FS.setDoc(FS.doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email,
      displayName,
      photoURL: user.photoURL || null,
      role: 'user',
      phone: '', city: '', about: '',
      resume: {
        title: '', level: '', yearsExperience: 0, skills: [], desiredSalary: 0,
        employment: [], remoteOnly: false, cities: [], education: '', links: {},
      },
      settings: { theme: 'dark', emailNotifications: true },
      stats: { applicationsCount: 0, savedCount: 0, reviewsCount: 0 },
      disabled: false,
      createdAt: FS.serverTimestamp(),
      updatedAt: FS.serverTimestamp(),
      lastLoginAt: FS.serverTimestamp(),
    });
  },

  async register({ email, password, displayName }) {
    try {
      const cred = await AUTH.createUserWithEmailAndPassword(auth, email.trim(), password);
      await AUTH.updateProfile(cred.user, { displayName });
      await this._createUserDoc(cred.user, displayName);
      return cred.user;
    } catch (error) { rethrow(error); }
  },

  async login(email, password) {
    try {
      const cred = await AUTH.signInWithEmailAndPassword(auth, email.trim(), password);
      FS.updateDoc(FS.doc(db, 'users', cred.user.uid), { lastLoginAt: FS.serverTimestamp() }).catch(() => {});
      return cred.user;
    } catch (error) { rethrow(error); }
  },

  async logout() {
    await AUTH.signOut(auth);
    this._profile = null;
  },

  async resetPassword(email) {
    try {
      await AUTH.sendPasswordResetEmail(auth, email.trim());
      return true;
    } catch (error) { rethrow(error); }
  },

  async updateProfile(userId, patch) {
    try {
      await FS.updateDoc(FS.doc(db, 'users', userId), { ...patch, updatedAt: FS.serverTimestamp() });
      if (this._profile?.uid === userId) {
        Object.assign(this._profile, patch);
        this._notifyProfile();       // шапка и открытые страницы перерисуются сами
      }
      return this._profile;
    } catch (error) { rethrow(error); }
  },

  async getUser(userId) {
    return docData(await FS.getDoc(FS.doc(db, 'users', userId)));
  },

  /* ---- файлы: аватары и логотипы компаний (Firebase Storage) ---- */

  /**
   * Аватар пользователя.
   * Путь фиксированный — `avatars/{uid}/avatar.jpg`, поэтому повторная
   * загрузка перезаписывает старый файл и мусор в бакете не накапливается.
   * Картинка уменьшается до 256×256 ещё в браузере (src/core/image.js).
   */
  async uploadAvatar(userId, file) {
    try {
      const { prepareSquareImage } = await import('../core/image.js');
      const { blob, contentType } = await prepareSquareImage(file, 256);
      const ST = await loadStorage();
      const ref = ST.mod.ref(ST.storage, `avatars/${userId}/avatar.jpg`);
      await ST.mod.uploadBytes(ref, blob, { contentType, cacheControl: 'public,max-age=86400' });
      const photoURL = await ST.mod.getDownloadURL(ref);
      await this.updateProfile(userId, { photoURL });
      // Тот же URL кладём в сам аккаунт Auth — им пользуются письма и консоль.
      if (auth.currentUser?.uid === userId) {
        AUTH.updateProfile(auth.currentUser, { photoURL }).catch(() => {});
      }
      return photoURL;
    } catch (error) { rethrow(error); }
  },

  async removeAvatar(userId) {
    const ST = await loadStorage();
    try {
      await ST.mod.deleteObject(ST.mod.ref(ST.storage, `avatars/${userId}/avatar.jpg`));
    } catch (error) {
      // Файла может не быть (аватар пришёл из Google-аккаунта) — это не ошибка.
      if (error?.code !== 'storage/object-not-found') console.warn('[storage] удаление аватара', error);
    }
    await this.updateProfile(userId, { photoURL: null });
    if (auth.currentUser?.uid === userId) {
      AUTH.updateProfile(auth.currentUser, { photoURL: '' }).catch(() => {});
    }
    return true;
  },

  /**
   * Логотип компании. Пишет только админ — и в Storage (storage.rules),
   * и в документ вакансии (firestore.rules). Кладётся в `company.logoUrl`,
   * эмодзи в `company.logo` остаётся запасным вариантом для карточек.
   */
  async uploadCompanyLogo(jobId, file) {
    try {
      const { prepareSquareImage } = await import('../core/image.js');
      const { blob, contentType } = await prepareSquareImage(file, 128);
      const ST = await loadStorage();
      const ref = ST.mod.ref(ST.storage, `logos/${jobId}/logo.jpg`);
      await ST.mod.uploadBytes(ref, blob, { contentType, cacheControl: 'public,max-age=604800' });
      const logoUrl = await ST.mod.getDownloadURL(ref);
      await FS.updateDoc(FS.doc(db, 'jobs', jobId), {
        'company.logoUrl': logoUrl,
        updatedAt: FS.serverTimestamp(),
      });
      return logoUrl;
    } catch (error) { rethrow(error); }
  },

  async removeCompanyLogo(jobId) {
    const ST = await loadStorage();
    try {
      await ST.mod.deleteObject(ST.mod.ref(ST.storage, `logos/${jobId}/logo.jpg`));
    } catch (error) {
      if (error?.code !== 'storage/object-not-found') console.warn('[storage] удаление логотипа', error);
    }
    await FS.updateDoc(FS.doc(db, 'jobs', jobId), {
      'company.logoUrl': null,
      updatedAt: FS.serverTimestamp(),
    });
    return true;
  },

  /* ---- jobs ---- */

  /**
   * Страница каталога.
   *
   * При поиске в индекс уходит только первый токен (`array-contains`), а
   * остальные слова отсеиваются на клиенте — из-за этого страница из 12
   * документов могла показать 3. Поэтому здесь цикл: дочитываем следующие
   * страницы курсором, пока не наберётся запрошенное количество карточек
   * либо не кончатся документы. MAX_ROUNDS ограничивает число чтений,
   * чтобы редкий запрос не выгреб всю коллекцию.
   */
  async listJobs(params = {}) {
    const MAX_ROUNDS = 4;
    const pageSize = params.pageSize || APP.pageSize;
    const plan = planJobQuery(params);

    try {
      const items = [];
      let cursor = params.cursor || null;
      let hasMore = true;

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const { constraints, pageSize: fetchSize } = jobConstraints(params, { pageSize, plan });
        const all = cursor ? [...constraints, FS.startAfter(cursor)] : constraints;
        const snap = await FS.getDocs(FS.query(FS.collection(db, 'jobs'), ...all));

        // Запрошено fetchSize × (1 или OVERFETCH) — сколько ровно, знает
        // jobConstraints, поэтому «есть ли ещё» считаем по длине выдачи.
        const requested = plan.refines ? fetchSize * OVERFETCH : fetchSize;
        hasMore = snap.docs.length === requested;
        if (snap.docs.length) cursor = snap.docs[snap.docs.length - 1];

        items.push(...refineJobs(listData(snap), params, plan));

        // Без дофильтровки одной страницы достаточно.
        if (!plan.refines || items.length >= pageSize || !hasMore) break;
      }

      // Лишнее, набранное с запасом, не выбрасываем: карточки уже прочитаны
      // и оплачены, пусть пользователь увидит их сразу.
      return { items, cursor, hasMore };
    } catch (error) { rethrow(error); }
  },

  /** Real-time первая страница каталога: новые вакансии приходят без перезагрузки. */
  watchFirstPage(params, cb, onError) {
    const { constraints, plan, pageSize } = jobConstraints(params);
    const q = FS.query(FS.collection(db, 'jobs'), ...constraints);

    return FS.onSnapshot(q, (snap) => {
      // Снимок берёт документы с запасом, когда часть условий проверяется на
      // клиенте. Курсор отдаём по последней ПОКАЗАННОЙ карточке, чтобы
      // «Показать ещё» продолжило ровно с того места и без дублей.
      const pairs = snap.docs
        .map((d) => ({ doc: d, data: { id: d.id, ...d.data() } }))
        .filter((pair) => refineJobs([pair.data], params, plan).length === 1);

      const shown = pairs.slice(0, pageSize);
      const lastDoc = shown.length
        ? shown[shown.length - 1].doc
        : (snap.docs.length ? snap.docs[snap.docs.length - 1] : null);

      cb({
        items: shown.map((pair) => pair.data),
        cursor: lastDoc,
        hasMore: pairs.length > shown.length || snap.docs.length === (plan.refines ? pageSize * OVERFETCH : pageSize),
        fromCache: snap.metadata.fromCache,
      });
    }, (error) => {
      console.error('[firebase] onSnapshot jobs', error);
      if (onError) onError(error);
    });
  },

  async getJob(id) {
    return docData(await FS.getDoc(FS.doc(db, 'jobs', id)));
  },

  watchJob(id, cb) {
    return FS.onSnapshot(FS.doc(db, 'jobs', id), (snap) => cb(docData(snap)));
  },

  async listSimilar(job, { pageSize = APP.similarPageSize, cursor = null } = {}) {
    const c = [
      FS.where('status', '==', 'open'),
      FS.where('category', '==', job.category),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(pageSize + 1),
    ];
    if (cursor) c.push(FS.startAfter(cursor));
    const snap = await FS.getDocs(FS.query(FS.collection(db, 'jobs'), ...c));
    const docs = snap.docs.filter((d) => d.id !== job.id);
    const items = docs.slice(0, pageSize);
    return {
      items: items.map((d) => ({ id: d.id, ...d.data() })),
      cursor: items.length ? items[items.length - 1] : null,
      hasMore: docs.length > items.length,
    };
  },

  async createJob(data) {
    try {
      const payload = {
        ...data,
        companyName: data.company?.name || '',
        ...buildJobIndex(data),
        applicationsCount: 0, viewsCount: 0, savesCount: 0,
        createdAt: FS.serverTimestamp(),
        updatedAt: FS.serverTimestamp(),
        publishedAt: FS.serverTimestamp(),
      };
      const ref = await FS.addDoc(FS.collection(db, 'jobs'), payload);
      return ref.id;
    } catch (error) { rethrow(error); }
  },

  async updateJob(id, patch) {
    try {
      const merged = { ...patch };
      if (patch.title || patch.skills || patch.description || patch.company) {
        const current = await this.getJob(id);
        Object.assign(merged, buildJobIndex({ ...current, ...patch }));
      }
      if (patch.company) merged.companyName = patch.company.name;
      await FS.updateDoc(FS.doc(db, 'jobs', id), { ...merged, updatedAt: FS.serverTimestamp() });
    } catch (error) { rethrow(error); }
  },

  async deleteJob(id) {
    try {
      await FS.deleteDoc(FS.doc(db, 'jobs', id));
    } catch (error) { rethrow(error); }
  },

  async incrementViews(id) {
    // Ошибку глушим: незалогиненному гостю правила запрещают запись счётчика.
    FS.updateDoc(FS.doc(db, 'jobs', id), { viewsCount: FS.increment(1) }).catch(() => {});
  },

  /* ---- reviews ---- */

  async listReviews(jobId, { pageSize = APP.reviewsPageSize, cursor = null } = {}) {
    const c = [
      FS.where('jobId', '==', jobId),
      FS.where('hidden', '==', false),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(pageSize),
    ];
    if (cursor) c.push(FS.startAfter(cursor));
    const snap = await FS.getDocs(FS.query(FS.collection(db, 'reviews'), ...c));
    return {
      items: listData(snap),
      cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      hasMore: snap.docs.length === pageSize,
    };
  },

  watchReviews(jobId, cb) {
    const q = FS.query(
      FS.collection(db, 'reviews'),
      FS.where('jobId', '==', jobId),
      FS.where('hidden', '==', false),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(20),
    );
    return FS.onSnapshot(q, (snap) => cb(listData(snap)), (e) => console.error('[firebase] reviews', e));
  },

  async addReview({ job, user, rating, text }) {
    try {
      const batch = FS.writeBatch(db);
      batch.set(FS.doc(FS.collection(db, 'reviews')), {
        jobId: job.id,
        companyId: job.company?.id || '',
        companyName: job.companyName || job.company?.name || '',
        userId: user.uid,
        userName: user.displayName,
        // Копия аватара в самом отзыве: список отзывов рисуется одним запросом
        // к reviews, без чтения профиля каждого автора.
        userPhotoURL: user.photoURL || null,
        rating: Number(rating),
        text: String(text).trim(),
        hidden: false,
        moderatedBy: null,
        createdAt: FS.serverTimestamp(),
        updatedAt: FS.serverTimestamp(),
      });
      batch.update(FS.doc(db, 'users', user.uid), { 'stats.reviewsCount': FS.increment(1) });
      await batch.commit();
    } catch (error) { rethrow(error); }
  },

  async updateReview(id, patch) {
    try {
      await FS.updateDoc(FS.doc(db, 'reviews', id), { ...patch, updatedAt: FS.serverTimestamp() });
    } catch (error) { rethrow(error); }
  },

  /** ownerId передаётся, когда автор удаляет свой отзыв — чтобы поправить счётчик. */
  async deleteReview(id, ownerId = null) {
    try {
      if (ownerId && this._profile?.uid === ownerId) {
        const batch = FS.writeBatch(db);
        batch.delete(FS.doc(db, 'reviews', id));
        batch.update(FS.doc(db, 'users', ownerId), { 'stats.reviewsCount': FS.increment(-1) });
        await batch.commit();
        return;
      }
      await FS.deleteDoc(FS.doc(db, 'reviews', id));
    } catch (error) { rethrow(error); }
  },

  async listUserReviews(userId) {
    const q = FS.query(
      FS.collection(db, 'reviews'),
      FS.where('userId', '==', userId),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(50),
    );
    return listData(await FS.getDocs(q));
  },

  async listAllReviews({ pageSize = APP.adminPageSize, cursor = null } = {}) {
    const c = [FS.orderBy('createdAt', 'desc'), FS.limit(pageSize)];
    if (cursor) c.push(FS.startAfter(cursor));
    const snap = await FS.getDocs(FS.query(FS.collection(db, 'reviews'), ...c));
    return {
      items: listData(snap),
      cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      hasMore: snap.docs.length === pageSize,
    };
  },

  /* ---- saved ---- */

  watchSaved(userId, cb, onError) {
    const q = FS.query(
      FS.collection(db, 'saved'),
      FS.where('userId', '==', userId),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(100),
    );
    return FS.onSnapshot(q, (snap) => cb(listData(snap)), (error) => {
      console.error('[firebase] onSnapshot saved', error);
      if (onError) onError(error);
    });
  },

  async listSaved(userId) {
    const q = FS.query(FS.collection(db, 'saved'), FS.where('userId', '==', userId), FS.limit(100));
    return listData(await FS.getDocs(q));
  },

  async saveJob(userId, job, matchScore = 0) {
    try {
      // Документ сохранённого, счётчик вакансии и счётчик профиля — одной
      // атомарной пачкой: либо всё, либо ничего.
      const batch = FS.writeBatch(db);
      batch.set(FS.doc(db, 'saved', `${userId}_${job.id}`), {
        userId, jobId: job.id,
        jobTitle: job.title,
        companyName: job.companyName || job.company?.name || '',
        companyLogo: job.company?.logo || '💼',
        companyLogoUrl: job.company?.logoUrl || null,
        city: job.city, remote: !!job.remote, level: job.level,
        salaryMin: job.salaryMin || 0, salaryMax: job.salaryMax || 0,
        matchScore, note: '',
        createdAt: FS.serverTimestamp(),
      });
      batch.update(FS.doc(db, 'jobs', job.id), { savesCount: FS.increment(1) });
      batch.update(FS.doc(db, 'users', userId), { 'stats.savedCount': FS.increment(1) });
      await batch.commit();
    } catch (error) { rethrow(error); }
  },

  async unsaveJob(userId, jobId) {
    try {
      const batch = FS.writeBatch(db);
      batch.delete(FS.doc(db, 'saved', `${userId}_${jobId}`));
      batch.update(FS.doc(db, 'jobs', jobId), { savesCount: FS.increment(-1) });
      batch.update(FS.doc(db, 'users', userId), { 'stats.savedCount': FS.increment(-1) });
      await batch.commit();
    } catch (error) { rethrow(error); }
  },

  async updateSavedNote(userId, jobId, note) {
    await FS.updateDoc(FS.doc(db, 'saved', `${userId}_${jobId}`), { note });
  },

  /* ---- applications ---- */

  async applyToJob({ user, job, coverLetter = '', matchScore = 0 }) {
    try {
      if (await this.hasApplied(user.uid, job.id)) {
        throw new Error('Вы уже откликнулись на эту вакансию');
      }
      const batch = FS.writeBatch(db);
      const appRef = FS.doc(FS.collection(db, 'applications'));
      batch.set(appRef, {
        userId: user.uid, userName: user.displayName, userEmail: user.email,
        jobId: job.id, jobTitle: job.title,
        companyName: job.companyName || job.company?.name || '',
        companyLogo: job.company?.logo || '💼',
        companyLogoUrl: job.company?.logoUrl || null,
        city: job.city, level: job.level,
        salaryMin: job.salaryMin || 0, salaryMax: job.salaryMax || 0,
        status: 'sent',
        matchScore,
        coverLetter,
        statusHistory: [{ status: 'sent', at: new Date().toISOString(), by: user.uid }],
        createdAt: FS.serverTimestamp(),
        updatedAt: FS.serverTimestamp(),
      });
      batch.update(FS.doc(db, 'jobs', job.id), { applicationsCount: FS.increment(1) });
      batch.update(FS.doc(db, 'users', user.uid), { 'stats.applicationsCount': FS.increment(1) });
      await batch.commit();
    } catch (error) { rethrow(error); }
  },

  // onError обязателен для интерфейса: если запрос упал (нет индекса, правила),
  // без него страница навсегда остаётся в скелетонах — молча, потому что
  // подписка просто никогда не вызовет cb.
  watchApplications(userId, cb, onError) {
    const q = FS.query(
      FS.collection(db, 'applications'),
      FS.where('userId', '==', userId),
      FS.orderBy('createdAt', 'desc'),
      FS.limit(100),
    );
    return FS.onSnapshot(q, (snap) => cb(listData(snap)), (error) => {
      console.error('[firebase] onSnapshot applications', error);
      if (onError) onError(error);
    });
  },

  async hasApplied(userId, jobId) {
    const q = FS.query(
      FS.collection(db, 'applications'),
      FS.where('userId', '==', userId),
      FS.where('jobId', '==', jobId),
      FS.limit(1),
    );
    const snap = await FS.getDocs(q);
    return snap.docs.some((d) => d.data().status !== 'withdrawn');
  },

  async withdrawApplication(id, userId) {
    try {
      const ref = FS.doc(db, 'applications', id);
      const snap = await FS.getDoc(ref);
      const data = snap.data() || {};
      const history = data.statusHistory || [];

      const batch = FS.writeBatch(db);
      batch.update(ref, {
        status: 'withdrawn',
        updatedAt: FS.serverTimestamp(),
        statusHistory: [...history, { status: 'withdrawn', at: new Date().toISOString(), by: userId }],
      });
      if (data.jobId) {
        batch.update(FS.doc(db, 'jobs', data.jobId), { applicationsCount: FS.increment(-1) });
      }
      batch.update(FS.doc(db, 'users', userId), { 'stats.applicationsCount': FS.increment(-1) });
      await batch.commit();
    } catch (error) { rethrow(error); }
  },

  async listAllApplications({ status = '', pageSize = APP.adminPageSize, cursor = null } = {}) {
    const c = [];
    if (status) c.push(FS.where('status', '==', status));
    c.push(FS.orderBy('createdAt', 'desc'), FS.limit(pageSize));
    if (cursor) c.push(FS.startAfter(cursor));
    const snap = await FS.getDocs(FS.query(FS.collection(db, 'applications'), ...c));
    return {
      items: listData(snap),
      cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      hasMore: snap.docs.length === pageSize,
    };
  },

  watchAllApplications(cb) {
    const q = FS.query(FS.collection(db, 'applications'), FS.orderBy('createdAt', 'desc'), FS.limit(50));
    return FS.onSnapshot(q, (snap) => cb(listData(snap)), (e) => console.error('[firebase] all applications', e));
  },

  async setApplicationStatus(id, status, adminUid) {
    try {
      const ref = FS.doc(db, 'applications', id);
      const snap = await FS.getDoc(ref);
      const history = snap.data()?.statusHistory || [];
      await FS.updateDoc(ref, {
        status,
        updatedAt: FS.serverTimestamp(),
        statusHistory: [...history, { status, at: new Date().toISOString(), by: adminUid }],
      });
    } catch (error) { rethrow(error); }
  },

  async deleteApplication(id) {
    await FS.deleteDoc(FS.doc(db, 'applications', id));
  },

  /* ---- users ---- */

  async listUsers({ pageSize = APP.adminPageSize, cursor = null } = {}) {
    const c = [FS.orderBy('createdAt', 'desc'), FS.limit(pageSize)];
    if (cursor) c.push(FS.startAfter(cursor));
    const snap = await FS.getDocs(FS.query(FS.collection(db, 'users'), ...c));
    return {
      items: listData(snap),
      cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      hasMore: snap.docs.length === pageSize,
    };
  },

  async setUserRole(userId, role) {
    try {
      await FS.updateDoc(FS.doc(db, 'users', userId), { role, updatedAt: FS.serverTimestamp() });
    } catch (error) { rethrow(error); }
  },

  async setUserDisabled(userId, disabled) {
    try {
      await FS.updateDoc(FS.doc(db, 'users', userId), { disabled, updatedAt: FS.serverTimestamp() });
    } catch (error) { rethrow(error); }
  },

  /* ---- статистика: агрегаты считает сервер ---- */

  async stats() {
    const col = (name) => FS.collection(db, name);
    const count = async (q) => (await FS.getCountFromServer(q)).data().count;

    const statuses = ['sent', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn'];
    const [jobs, openJobs, users, applications, reviews, hiddenReviews, ...byStatusCounts] = await Promise.all([
      count(col('jobs')),
      count(FS.query(col('jobs'), FS.where('status', '==', 'open'))),
      count(col('users')),
      count(col('applications')),
      count(col('reviews')),
      count(FS.query(col('reviews'), FS.where('hidden', '==', true))),
      ...statuses.map((s) => count(FS.query(col('applications'), FS.where('status', '==', s)))),
    ]);

    const byStatus = {};
    statuses.forEach((s, i) => { byStatus[s] = byStatusCounts[i]; });

    const topSnap = await FS.getDocs(FS.query(
      col('jobs'), FS.orderBy('applicationsCount', 'desc'), FS.limit(5),
    ));

    return {
      jobs, openJobs, users, applications, reviews, hiddenReviews,
      saved: null,
      byStatus,
      topJobs: listData(topSnap),
    };
  },

  /* ---- заливка тестовых данных ---- */

  async seedDatabase(adminUid) {
    const now = new Date();
    let written = 0;
    const chunks = [];
    for (let i = 0; i < SEED_JOBS.length; i += 100) chunks.push(SEED_JOBS.slice(i, i + 100));

    const createdIds = [];
    for (const chunk of chunks) {
      const batch = FS.writeBatch(db);
      for (const job of chunk) {
        const ref = FS.doc(FS.collection(db, 'jobs'));
        createdIds.push({ ref, job });
        const { id, ...rest } = job;
        batch.set(ref, {
          ...rest,
          ...buildJobIndex(job),
          createdBy: adminUid,
          createdAt: new Date(job.createdAt || now),
          updatedAt: new Date(job.createdAt || now),
          publishedAt: new Date(job.createdAt || now),
        });
        written += 1;
      }
      await batch.commit();
    }

    const reviewBatch = FS.writeBatch(db);
    for (const r of SEED_REVIEWS) {
      const target = createdIds[r.jobIndex];
      if (!target) continue;
      reviewBatch.set(FS.doc(FS.collection(db, 'reviews')), {
        jobId: target.ref.id,
        companyId: target.job.company.id,
        companyName: target.job.company.name,
        userId: adminUid,
        userName: r.userName,
        rating: r.rating,
        text: r.text,
        hidden: false,
        moderatedBy: null,
        createdAt: new Date(Date.now() - r.daysAgo * 86400000),
        updatedAt: new Date(Date.now() - r.daysAgo * 86400000),
      });
    }
    await reviewBatch.commit();

    return written;
  },
};
