import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  BellRing,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  Film,
  Gauge,
  Globe2,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  Mail,
  Maximize2,
  Pause,
  Play,
  Plus,
  Paperclip,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { deleteVideoBlob, getVideoBlob, saveVideoBlob } from './storage';
import {
  cleanWord,
  downloadText,
  formatClock,
  isSubtitleActive,
  makeSrt,
  makeVtt,
  subtitleTime,
} from './subtitles';

const PROJECTS_KEY = 'recnik-projects-v1';
const API_KEY_STORAGE_KEY = 'recnik-groq-key';
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const PUBLIC_CATEGORIES = ['все', 'фильм', 'мультфильм', 'блог', 'интервью', 'новости', 'обучение', 'другое'];
const PUBLIC_CATEGORY_EN = {
  все: 'all',
  фильм: 'film',
  мультфильм: 'animation',
  блог: 'blog',
  интервью: 'interview',
  новости: 'news',
  обучение: 'learning',
  другое: 'other',
};
const PUBLIC_CATEGORY_SR = {
  все: 'sve',
  фильм: 'film',
  мультфильм: 'crtani film',
  блог: 'blog',
  интервью: 'intervju',
  новости: 'vesti',
  обучение: 'učenje',
  другое: 'ostalo',
};
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const PUBLIC_UPLOAD_CONCURRENCY = 3;
const TELEGRAM_NOTICE_STORAGE_KEY = 'citavuk-telegram-notice-seen-at';
const TELEGRAM_NOTICE_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const LANGUAGE_STORAGE_KEY = 'citavuk-language';
const WELCOME_STORAGE_KEY = 'citavuk-welcome-completed-v3';
const PENDING_TRANSCRIPTION_KEY = 'citavuk-pending-transcription';
const DEFAULT_PAGE_TITLE = 'Сербские субтитры для видео онлайн — Читавук-речник';
const DEFAULT_PAGE_DESCRIPTION = 'Онлайн-сервис создаёт сербские субтитры из видео на русском, английском и других языках, экспортирует SRT, VTT и MP4 и помогает собирать личный словарь.';
const ENGLISH_PAGE_TITLE = 'Serbian subtitles for any video online — Čitavuk Dictionary';
const ENGLISH_PAGE_DESCRIPTION = 'Create synchronized Serbian subtitles from videos in English, Russian and other languages, export SRT, VTT or MP4, and build a personal vocabulary.';
const SERBIAN_PAGE_TITLE = 'Srpski titlovi za bilo koji video — Čitavuk-rečnik';
const SERBIAN_PAGE_DESCRIPTION = 'Napravite sinhronizovane srpske titlove za video na bilo kom jeziku, izvezite SRT, VTT ili MP4 i sačuvajte nove reči u ličnom rečniku.';
const SERBIAN_COPY = {
  'На главную': 'Na početnu',
  'сербские субтитры и видеословарь': 'srpski titlovi i video-rečnik',
  'Основная навигация': 'Glavna navigacija',
  'Мои видео': 'Moji video-snimci',
  'Создать субтитры': 'Napravi titlove',
  'Библиотека': 'Biblioteka',
  'Язык сайта': 'Jezik sajta',
  'Уведомления включены': 'Obaveštenja su uključena',
  'Включить уведомления': 'Uključi obaveštenja',
  'Настройки API': 'API podešavanja',
  'Перетащите видео сюда': 'Prevucite video ovde',
  'или нажмите, чтобы выбрать файл': 'ili kliknite da izaberete datoteku',
  'Поддерживаются MP4, MOV, WEBM и MKV. Максимальный размер исходного видео составляет 2 ГБ.': 'Podržani su MP4, MOV, WEBM i MKV. Najveća dozvoljena veličina izvornog videa je 2 GB.',
  'Вставьте полную ссылку youtube.com или youtu.be.': 'Unesite punu youtube.com ili youtu.be vezu.',
  'Взять видео с YouTube': 'Preuzmi video sa YouTube-a',
  'Вставьте ссылку — Читавук сам скачает ролик и начнёт распознавание. Используйте только видео, которое вам разрешено скачивать.': 'Unesite vezu — Čitavuk će preuzeti video i pokrenuti prepoznavanje. Koristite samo video-snimke koje smete da preuzmete.',
  'Ссылка на видео YouTube': 'Veza ka YouTube videu',
  'Скачиваем…': 'Preuzimamo…',
  'Скачать и распознать': 'Preuzmi i prepoznaj',
  'Не получилось? Скачать вручную через SaveFrom': 'Ne radi? Preuzmite ručno preko SaveFrom-a',
  'Удалить проект': 'Obriši projekat',
  'Сервис для создания сербских субтитров к видео на любом языке.': 'Servis za pravljenje srpskih titlova za video na bilo kom jeziku.',
  'Загрузите сербский, английский, русский или другой ролик, получите синхронный сербский текст и собирайте личный словарь прямо во время просмотра.': 'Otpremite video na srpskom, engleskom, ruskom ili drugom jeziku, dobijte sinhronizovan srpski tekst i pravite lični rečnik tokom gledanja.',
  'Читавук помогает разобраться с субтитрами': 'Čitavuk pomaže pri radu sa titlovima',
  'НОВОЕ ВИДЕО': 'NOVI VIDEO',
  'Начать разбор': 'Počni obradu',
  'Открыть пример проекта': 'Otvori primer projekta',
  'Видео остается в памяти вашего браузера': 'Video ostaje sačuvan u vašem pregledaču',
  'КАК ЭТО РАБОТАЕТ': 'KAKO RADI',
  'Сербские субтитры без ручной разметки': 'Srpski titlovi bez ručnog određivanja vremena',
  'Загрузите видео': 'Otpremite video',
  'Получите сербский текст': 'Dobijte srpski tekst',
  'Смотрите или скачивайте': 'Gledajte ili preuzmite',
  'ВАША ПОЛКА': 'VAŠA POLICA',
  'Недавние видео': 'Nedavni video-snimci',
  'Пауза': 'Pauza',
  'Воспроизвести': 'Pusti',
  'РАЗБОР ВИДЕО': 'OBRADA VIDEA',
  'пример проекта': 'primer projekta',
  'видео': 'video',
  'Исходное видео не найдено': 'Izvorni video nije pronađen',
  'Загрузите файл заново, чтобы продолжить.': 'Ponovo otpremite datoteku da biste nastavili.',
  'Видео готово к распознаванию': 'Video je spreman za prepoznavanje',
  'Слушаем речь…': 'Slušamo govor…',
  'Закрыть сообщение об ошибке': 'Zatvori poruku o grešci',
  'Уже в словаре': 'Već je u rečniku',
  'Добавить в словарь': 'Dodaj u rečnik',
  'ТРАНСКРИПТ': 'TRANSKRIPT',
  'Текст видео': 'Tekst videa',
  'Опубликовать анонимно': 'Objavi anonimno',
  'Опубликовать': 'Objavi',
  'Распознать заново': 'Ponovo prepoznaj',
  'Повторить': 'Ponovi',
  'Найти в тексте…': 'Pretraži tekst…',
  'Нажмите на слово, чтобы перевести и сохранить': 'Kliknite na reč da je prevedete i sačuvate',
  'Здесь появится текст': 'Ovde će se pojaviti tekst',
  'ЛИЧНЫЙ СЛОВАРЬ': 'LIČNI REČNIK',
  'Найти слово…': 'Pronađi reč…',
  'Подбираем русский и английский переводы…': 'Tražimo ruski i engleski prevod…',
  'Перевод временно недоступен. Нажмите на слово ещё раз.': 'Prevod trenutno nije dostupan. Kliknite na reč ponovo.',
  'Русский перевод': 'Ruski prevod',
  'Заметка или пример': 'Beleška ili primer',
  'Слово не найдено': 'Reč nije pronađena',
  'Словарь пока пуст': 'Rečnik je još prazan',
  'Попробуйте другой запрос.': 'Pokušajte drugu pretragu.',
  'Собираем MP4…': 'Pravimo MP4…',
  'MP4 с субтитрами': 'MP4 sa titlovima',
  'недоступно в демо': 'nije dostupno u demonstraciji',
  'титры вшиты в видео': 'titlovi su ugrađeni u video',
  'К проектам': 'Nazad na projekte',
  'сохранено локально': 'sačuvano lokalno',
  'ожидает обработки': 'čeka obradu',
  'Главная': 'Početna',
  'Хлебные крошки': 'Putanja stranice',
  'Ко всем публикациям': 'Sve publikacije',
  'СЕРБСКИЕ СУБТИТРЫ': 'SRPSKI TITLOVI',
  'АНОНИМНЫЕ ПУБЛИКАЦИИ': 'ANONIMNE PUBLIKACIJE',
  'Сербское видео с готовыми субтитрами': 'Video-snimci sa gotovim srpskim titlovima',
  'Фильтр по категории': 'Filtriranje po kategoriji',
  'Читавук открывает библиотеку…': 'Čitavuk otvara biblioteku…',
  'Публичное хранилище ещё не подключено.': 'Javno skladište još nije povezano.',
  'Назад': 'Nazad',
  'Далее': 'Dalje',
  'Дальше': 'Dalje',
  'Страницы библиотеки': 'Stranice biblioteke',
  'ПУБЛИЧНАЯ БИБЛИОТЕКА': 'JAVNA BIBLIOTEKA',
  'НАЗВАНИЕ': 'NASLOV',
  'КАТЕГОРИЯ': 'KATEGORIJA',
  'ОПИСАНИЕ': 'OPIS',
  'Коротко расскажите, что находится в видео': 'Ukratko opišite sadržaj videa',
  'Опубликовать видео': 'Objavi video',
  'Загружаем публикацию…': 'Otpremamo publikaciju…',
  'Закрыть настройки': 'Zatvori podešavanja',
  'НЕОБЯЗАТЕЛЬНО': 'NEOBAVEZNO',
  'Свой ключ Groq API': 'Sopstveni Groq API ključ',
  'ЛИЧНЫЙ GROQ API KEY': 'LIČNI GROQ API KLJUČ',
  'Оставьте пустым для общего сервера': 'Ostavite prazno da biste koristili zajednički server',
  'Получить личный ключ': 'Nabavi lični ključ',
  'Использовать свой ключ': 'Koristi moj ključ',
  'Использовать общий сервер': 'Koristi zajednički server',
  'Закрыть инструкцию': 'Zatvori uputstvo',
  'Шаги инструкции': 'Koraci uputstva',
  'Начать': 'Počni',
  'Создаём видео с субтитрами': 'Pravimo video sa titlovima',
  'Публикуем видео анонимно': 'Anonimno objavljujemo video',
  'Скачиваем видео с YouTube': 'Preuzimamo video sa YouTube-a',
  'Готовим сербские субтитры': 'Pravimo srpske titlove',
  'Это может занять несколько минут…': 'Ovo može potrajati nekoliko minuta…',
  'оцениваем оставшееся время': 'procenjujemo preostalo vreme',
  'Читавук в Telegram': 'Čitavuk na Telegramu',
  'Открыть канал': 'Otvori kanal',
  'Закрыть сообщение о Telegram-канале': 'Zatvori poruku o Telegram kanalu',
};
const LanguageContext = createContext({ locale: 'ru', setLocale: () => {} });

function useUiLanguage() {
  const { locale, setLocale } = useContext(LanguageContext);
  return {
    locale,
    setLocale,
    t: (russian, english, serbian) => {
      if (locale === 'en') return english;
      if (locale === 'sr') return serbian || SERBIAN_COPY[russian] || english;
      return russian;
    },
  };
}

function publicCategoryLabel(category, locale) {
  if (locale === 'en') return PUBLIC_CATEGORY_EN[category] || category;
  if (locale === 'sr') return PUBLIC_CATEGORY_SR[category] || category;
  return category;
}

function splitLocalizedPath(pathname = window.location.pathname) {
  const normalized = `/${String(pathname || '/').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '/');
  const match = normalized.match(/^\/(en|sr)(?=\/|$)(.*)$/i);
  const locale = match ? match[1].toLowerCase() : null;
  const routePath = match ? (match[2] || '/') : normalized;
  return { locale, routePath: routePath === '' ? '/' : routePath };
}

function localizedSitePath(value = '/', locale = 'ru') {
  const url = new URL(value, 'https://serbiansubtitles.online');
  const { routePath } = splitLocalizedPath(url.pathname);
  const pathname = locale === 'ru'
    ? routePath
    : `/${locale}${routePath === '/' ? '/' : routePath}`;
  return `${pathname}${url.search}${url.hash}`;
}

function initialLocale() {
  const queryLocale = new URLSearchParams(window.location.search).get('lang');
  if (['en', 'ru', 'sr'].includes(queryLocale)) return queryLocale;
  const pathLocale = splitLocalizedPath().locale;
  if (pathLocale) return pathLocale;
  const savedLocale = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return ['en', 'ru', 'sr'].includes(savedLocale) ? savedLocale : 'en';
}

function hasExplicitLocale() {
  const queryLocale = new URLSearchParams(window.location.search).get('lang');
  const savedLocale = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return Boolean(splitLocalizedPath().locale)
    || ['en', 'ru', 'sr'].includes(queryLocale)
    || ['en', 'ru', 'sr'].includes(savedLocale);
}

function shouldShowWelcome() {
  if (localStorage.getItem(WELCOME_STORAGE_KEY) === '1') return false;
  if (sessionStorage.getItem('recnik-welcome-seen') === '1') {
    localStorage.setItem(WELCOME_STORAGE_KEY, '1');
    return false;
  }
  return true;
}

function readBrowserRoute() {
  const { locale, routePath } = splitLocalizedPath();
  const pathname = routePath.replace(/\/+$/, '') || '/';
  const videoMatch = pathname.match(/^\/subtitles\/([a-z0-9-]+)$/i);
  if (videoMatch) return { page: 'library', videoSlug: videoMatch[1], locale };
  if (pathname === '/subtitles' || pathname === '/library') return { page: 'library', videoSlug: null, locale };
  return { page: 'landing', videoSlug: null, locale };
}

function PageMetadata({ title, description, path = '/' }) {
  const { locale } = useUiLanguage();
  const resolvedTitle = title || (locale === 'en' ? ENGLISH_PAGE_TITLE : locale === 'sr' ? SERBIAN_PAGE_TITLE : DEFAULT_PAGE_TITLE);
  const resolvedDescription = description || (locale === 'en' ? ENGLISH_PAGE_DESCRIPTION : locale === 'sr' ? SERBIAN_PAGE_DESCRIPTION : DEFAULT_PAGE_DESCRIPTION);
  const localizedPath = localizedSitePath(path, locale);
  useEffect(() => {
    document.title = resolvedTitle;
    document.documentElement.lang = locale;
    const descriptionTag = document.querySelector('meta[name="description"]');
    if (descriptionTag) descriptionTag.setAttribute('content', resolvedDescription);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', `https://serbiansubtitles.online${localizedPath}`);
    document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((link) => {
      const language = link.getAttribute('hreflang');
      const languagePath = language === 'x-default'
        ? localizedSitePath(path, 'en')
        : localizedSitePath(path, ['en', 'sr'].includes(language) ? language : 'ru');
      link.setAttribute('href', `https://serbiansubtitles.online${languagePath}`);
    });
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDescription = document.querySelector('meta[property="og:description"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    const ogLocale = document.querySelector('meta[property="og:locale"]');
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    const twitterDescription = document.querySelector('meta[name="twitter:description"]');
    if (ogTitle) ogTitle.setAttribute('content', resolvedTitle);
    if (ogDescription) ogDescription.setAttribute('content', resolvedDescription);
    if (ogUrl) ogUrl.setAttribute('content', `https://serbiansubtitles.online${localizedPath}`);
    if (ogLocale) ogLocale.setAttribute('content', locale === 'en' ? 'en_US' : locale === 'sr' ? 'sr_RS' : 'ru_RU');
    if (ogSiteName) ogSiteName.setAttribute('content', locale === 'en' ? 'Čitavuk Dictionary' : locale === 'sr' ? 'Čitavuk-rečnik' : 'Читавук-речник');
    if (twitterTitle) twitterTitle.setAttribute('content', resolvedTitle);
    if (twitterDescription) twitterDescription.setAttribute('content', resolvedDescription);
  }, [locale, localizedPath, path, resolvedDescription, resolvedTitle]);
  return null;
}

function apiUrl(pathname) {
  return `${API_BASE_URL}${pathname}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function ensurePushSubscription(requestPermission = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  if (Notification.permission === 'denied') return null;
  if (requestPermission && Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return null;
  }
  if (Notification.permission !== 'granted') return null;
  const keyResponse = await fetch(apiUrl('/api/notifications/public-key'), { cache: 'no-store' });
  const keyPayload = await keyResponse.json().catch(() => ({}));
  if (!keyResponse.ok || !keyPayload.enabled || !keyPayload.publicKey) return null;
  const registration = await navigator.serviceWorker.register('/sw.js');
  const current = await registration.pushManager.getSubscription();
  return current || registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey),
  });
}

async function responsePayload(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Сервер вернул ошибку ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function publishVideoInChunks(file, metadata, onProgress) {
  onProgress({ percent: 1, stage: 'Готовим защищённую загрузку частями', etaSeconds: null });
  const startResponse = await fetch(apiUrl('/api/public/uploads'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...metadata,
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    }),
  });
  const session = await responsePayload(startResponse);
  const startedAt = performance.now();
  let uploadedBytes = 0;
  let completedParts = 0;
  let nextPartIndex = 0;
  const uploadController = new AbortController();

  const uploadPart = async (partIndex) => {
    const partNumber = partIndex + 1;
    const start = partIndex * session.chunkSize;
    const end = Math.min(file.size, start + session.chunkSize);
    const chunk = file.slice(start, end);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(apiUrl(`/api/public/uploads/${session.sessionId}/parts/${partNumber}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: uploadController.signal,
        });
        await responsePayload(response);
        uploadedBytes += chunk.size;
        completedParts += 1;
        const elapsedSeconds = Math.max(0.1, (performance.now() - startedAt) / 1000);
        const bytesPerSecond = uploadedBytes / elapsedSeconds;
        onProgress({
          percent: 3 + ((uploadedBytes / file.size) * 90),
          stage: `Передаём видео частями: ${completedParts} из ${session.totalParts}`,
          etaSeconds: bytesPerSecond > 0 ? (file.size - uploadedBytes) / bytesPerSecond : null,
        });
        return;
      } catch (error) {
        lastError = error;
        if (error.status === 507 || (error.status && error.status < 500 && error.status !== 408 && error.status !== 429)) break;
        if (attempt < 3) {
          onProgress({
            percent: 3 + ((uploadedBytes / file.size) * 90),
            stage: `Связь прервалась, повторяем часть ${partNumber}`,
            etaSeconds: null,
          });
          await wait(attempt * 1000);
        }
      }
    }
    throw lastError || new Error(`Не удалось передать часть ${partNumber}.`);
  };

  try {
    const workers = Array.from(
      { length: Math.min(PUBLIC_UPLOAD_CONCURRENCY, session.totalParts) },
      async () => {
        while (nextPartIndex < session.totalParts) {
          const partIndex = nextPartIndex;
          nextPartIndex += 1;
          await uploadPart(partIndex);
        }
      },
    );
    await Promise.all(workers);
    onProgress({ percent: 96, stage: 'Собираем видео и создаём обложку', etaSeconds: null });
    const completeResponse = await fetch(apiUrl(`/api/public/uploads/${session.sessionId}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await responsePayload(completeResponse);
    onProgress({ percent: 100, stage: 'Публикация готова', etaSeconds: 0 });
    return result;
  } catch (error) {
    uploadController.abort();
    fetch(apiUrl(`/api/public/uploads/${session.sessionId}`), { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

async function requestWordTranslation(word, context, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-groq-api-key'] = apiKey;
  const response = await fetch(apiUrl('/api/translate'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ word, context }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Не удалось получить перевод.');
  if (!payload.ru || !payload.en) throw new Error('Сервис вернул неполный перевод.');
  return payload;
}

function startTranscriptionJob(form, apiKey, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const startedAt = performance.now();
    request.open('POST', apiUrl('/api/transcribe/jobs'));
    if (apiKey) request.setRequestHeader('x-groq-api-key', apiKey);
    request.timeout = 60 * 60 * 1000;
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        onProgress({ percent: 5, stage: 'Загружаем видео на сервер', etaSeconds: null });
        return;
      }
      const elapsedSeconds = Math.max(0.1, (performance.now() - startedAt) / 1000);
      const bytesPerSecond = event.loaded / elapsedSeconds;
      const etaSeconds = bytesPerSecond > 0 ? (event.total - event.loaded) / bytesPerSecond : null;
      onProgress({ percent: Math.min(20, (event.loaded / event.total) * 20), stage: 'Загружаем видео на сервер', etaSeconds });
    };
    request.onload = () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText || '{}'); } catch { payload = {}; }
      if (request.status >= 200 && request.status < 300 && payload.id) return resolve(payload);
      const error = new Error(payload.error || `Сервер вернул ошибку ${request.status}.`);
      error.status = request.status;
      error.code = payload.code;
      return reject(error);
    };
    request.onerror = () => reject(new Error('Соединение с сервером прервалось во время загрузки видео.'));
    request.ontimeout = () => reject(new Error('Загрузка видео на сервер заняла больше часа и была остановлена.'));
    request.send(form);
  });
}

function downloadYoutubeVideo(url, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', apiUrl('/api/youtube/download'));
    request.setRequestHeader('Content-Type', 'application/json');
    request.responseType = 'blob';
    request.timeout = 60 * 60 * 1000;
    request.onprogress = (event) => {
      if (!event.lengthComputable) {
        onProgress({ percent: 5, stage: 'Скачиваем видео с YouTube на сервер', etaSeconds: null });
        return;
      }
      onProgress({
        percent: Math.round((event.loaded / event.total) * 100),
        stage: 'Передаём видео с сервера в браузер',
        etaSeconds: null,
      });
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const disposition = request.getResponseHeader('Content-Disposition') || '';
        const titleHeader = request.getResponseHeader('X-Video-Title');
        const nameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = nameMatch ? nameMatch[1] : 'youtube-video.mp4';
        let title = filename;
        try { if (titleHeader) title = decodeURIComponent(titleHeader); } catch { title = filename; }
        resolve({ blob: request.response, filename, title });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        let payload = {};
        try { payload = JSON.parse(reader.result || '{}'); } catch { payload = {}; }
        const diagnostic = [payload.code, payload.requestId && `запрос ${payload.requestId}`].filter(Boolean).join(' · ');
        const providerDetails = payload.diagnostic ? ` Причина yt-dlp: ${payload.diagnostic}` : '';
        const error = new Error(`${payload.error || `Сервер вернул ошибку ${request.status}.`}${diagnostic ? ` Код диагностики: ${diagnostic}.` : ''}${providerDetails}`);
        error.status = request.status;
        error.code = payload.code;
        error.requestId = payload.requestId;
        reject(error);
      };
      reader.onerror = () => reject(new Error(`Сервер вернул ошибку ${request.status}.`));
      reader.readAsText(request.response);
    };
    request.onerror = () => reject(new Error('Соединение с сервером прервалось во время скачивания видео.'));
    request.ontimeout = () => reject(new Error('Скачивание видео с YouTube заняло больше часа и было остановлено.'));
    request.send(JSON.stringify({ url }));
  });
}

function startBurnJob(form, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', apiUrl('/api/burn/jobs'));
    request.responseType = 'json';
    request.timeout = 30 * 60 * 1000;
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const fraction = event.loaded / event.total;
      onProgress({
        percent: Math.max(1, Math.round(fraction * 15)),
        stage: 'Передаём видео на сервер',
        etaSeconds: null,
      });
    };
    request.onload = () => {
      const payload = request.response || {};
      if (request.status >= 200 && request.status < 300 && payload.id) return resolve(payload);
      const error = new Error(payload.error || `Сервер вернул ошибку ${request.status}.`);
      error.status = request.status;
      return reject(error);
    };
    request.onerror = () => reject(new Error('Соединение с сервером прервалось во время загрузки видео.'));
    request.ontimeout = () => reject(new Error('Загрузка видео на сервер заняла слишком много времени.'));
    request.send(form);
  });
}

async function waitForBurnJob(id, onProgress) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let failedPolls = 0;
  while (Date.now() < deadline) {
    await wait(1000);
    try {
      const response = await fetch(apiUrl(`/api/burn/jobs/${encodeURIComponent(id)}`), { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Сервер вернул ошибку ${response.status}.`);
      failedPolls = 0;
      onProgress({
        percent: 15 + (Math.max(0, Math.min(100, Number(payload.progress) || 0)) * 0.77),
        stage: payload.stage || 'Встраиваем субтитры в видео',
        etaSeconds: payload.etaSeconds,
      });
      if (payload.status === 'done') return payload;
      if (payload.status === 'error') throw new Error(payload.error || 'Не удалось создать MP4 с субтитрами.');
    } catch (error) {
      failedPolls += 1;
      if (failedPolls >= 5) throw error;
    }
  }
  throw new Error('Создание MP4 заняло больше двух часов и было остановлено.');
}

function downloadBurnedVideo(id, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', apiUrl(`/api/burn/jobs/${encodeURIComponent(id)}/file`));
    request.responseType = 'blob';
    request.timeout = 60 * 60 * 1000;
    request.onprogress = (event) => {
      const fraction = event.lengthComputable ? event.loaded / event.total : 0;
      onProgress({
        percent: event.lengthComputable ? 92 + (fraction * 8) : 94,
        stage: 'Скачиваем готовый MP4',
        etaSeconds: null,
      });
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve(request.response);
      const reader = new FileReader();
      reader.onload = () => {
        let payload = {};
        try { payload = JSON.parse(reader.result || '{}'); } catch { payload = {}; }
        reject(new Error(payload.error || `Сервер вернул ошибку ${request.status}.`));
      };
      reader.onerror = () => reject(new Error(`Сервер вернул ошибку ${request.status}.`));
      reader.readAsText(request.response);
    };
    request.onerror = () => reject(new Error('Соединение прервалось при скачивании готового MP4.'));
    request.ontimeout = () => reject(new Error('Скачивание готового MP4 заняло слишком много времени.'));
    request.send();
  });
}

async function waitForTranscriptionJob(id, onProgress) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let failedPolls = 0;
  while (Date.now() < deadline) {
    await wait(1000);
    try {
      const response = await fetch(apiUrl(`/api/transcribe/jobs/${id}`), { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `Не удалось получить состояние задачи: ${response.status}.`);
        error.status = response.status;
        error.code = payload.code;
        throw error;
      }
      failedPolls = 0;
      onProgress({
        percent: Number(payload.progress) || 0,
        stage: payload.stage || 'Распознаём речь и готовим сербские субтитры',
        etaSeconds: Number.isFinite(payload.etaSeconds) ? payload.etaSeconds : null,
        elapsedSeconds: payload.elapsedSeconds,
      });
      if (payload.status === 'done') return payload.result;
      if (payload.status === 'error') {
        const error = new Error(payload.error || 'Распознавание остановлено.');
        error.code = payload.code;
        error.status = Number(payload.statusCode) || undefined;
        throw error;
      }
    } catch (error) {
      if (error.code || ++failedPolls >= 5) throw error;
      await wait(1000);
    }
  }
  throw new Error('Распознавание заняло больше тридцати минут и было остановлено.');
}

const DEMO_SEGMENTS = [
  { id: 'd1', start: 0, end: 4.4, text: 'Добро дошли у Београд, град који никада не мирује.' },
  { id: 'd2', start: 4.4, end: 8.8, text: 'Данас ћемо прошетати старим улицама Дорћола.' },
  { id: 'd3', start: 8.8, end: 13.2, text: 'Овде се традиција и савремени живот сусрећу на сваком кораку.' },
  { id: 'd4', start: 13.2, end: 17.8, text: 'Мирис свеже кафе стиже из малих породичних кафана.' },
  { id: 'd5', start: 17.8, end: 22.2, text: 'Људи разговарају, смеју се и уживају у сунчаном дану.' },
  { id: 'd6', start: 22.2, end: 27.4, text: 'На крају улице види се Дунав, широк и миран.' },
  { id: 'd7', start: 27.4, end: 32, text: 'Свака реч открива још један део овог града.' },
];

function loadProjects() {
  try {
    const projects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
    return projects.map((project) => ({
      ...project,
      glossary: (project.glossary || []).map((item) => (
        item.translationStatus === 'loading' ? { ...item, translationStatus: 'idle' } : item
      )),
    }));
  } catch {
    return [];
  }
}

function loadApiKey() {
  const persistentKey = localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  if (persistentKey) return persistentKey;
  const previousSessionKey = sessionStorage.getItem(API_KEY_STORAGE_KEY) || '';
  if (previousSessionKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, previousSessionKey);
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  }
  return previousSessionKey;
}

function fileStem(filename = 'video') {
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-zа-я0-9_-]+/giu, '-').replace(/^-|-$/g, '') || 'video';
}

function normalizeTranscription(payload) {
  if (Array.isArray(payload.segments) && payload.segments.length) {
    return payload.segments.map((segment, index) => ({
      id: `s-${index}-${Math.round(Number(segment.start || 0) * 100)}`,
      start: Number(segment.start || 0),
      end: Number(segment.end ?? Number(segment.start || 0) + 3),
      text: String(segment.text || '').trim(),
    })).filter((segment) => segment.text);
  }

  if (Array.isArray(payload.words) && payload.words.length) {
    const groups = [];
    for (let index = 0; index < payload.words.length; index += 9) {
      const words = payload.words.slice(index, index + 9);
      groups.push({
        id: `w-${index}`,
        start: Number(words[0]?.start || 0),
        end: Number(words.at(-1)?.end || Number(words[0]?.start || 0) + 4),
        text: words.map((word) => word.word).join(' ').trim(),
      });
    }
    return groups;
  }

  if (payload.text) return [{ id: 'full', start: 0, end: 99999, text: payload.text.trim() }];
  return [];
}

function formatBytes(size = 0) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

function pluralizeRu(number, one, few, many) {
  const mod100 = Math.abs(number) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function PatternBand({ vertical = false }) {
  return <div className={`pattern-band ${vertical ? 'pattern-band--vertical' : ''}`} aria-hidden="true" />;
}

function BrandMark() {
  return (
    <img className="brand-wolf" src="/assets/citavuk-logo.webp" alt="" aria-hidden="true" />
  );
}

function Header({ inProject, inLibrary, onHome, onLibrary, onSettings, onNotifications, notificationsEnabled }) {
  const { locale, setLocale, t } = useUiLanguage();
  const follow = (event, action) => {
    event.preventDefault();
    action();
  };
  return (
    <header className="site-header">
      <a className="brand" href={localizedSitePath('/', locale)} onClick={(event) => follow(event, onHome)} aria-label={t('На главную', 'Home')}>
        <BrandMark />
        <span className="brand-copy"><strong>{t('ЧИТАВУК-РЕЧНИК', 'ČITAVUK DICTIONARY', 'ČITAVUK-REČNIK')}</strong><small>{t('сербские субтитры и видеословарь', 'Serbian subtitles and video dictionary')}</small></span>
      </a>
      <div className="header-actions">
        <nav className="site-nav" aria-label={t('Основная навигация', 'Main navigation')}>
          <a className={!inLibrary ? 'is-active' : ''} href={localizedSitePath('/', locale)} onClick={(event) => follow(event, onHome)}><Upload size={17} /><span>{inProject ? t('Мои видео', 'My videos') : t('Создать субтитры', 'Create subtitles')}</span></a>
          <a className={inLibrary ? 'is-active' : ''} href={localizedSitePath('/subtitles', locale)} onClick={(event) => follow(event, onLibrary)}><Globe2 size={17} /><span>{t('Библиотека', 'Library')}</span></a>
        </nav>
        <div className="language-switch" role="group" aria-label={t('Язык сайта', 'Site language')}>
          <button className={locale === 'ru' ? 'is-active' : ''} onClick={() => setLocale('ru')} lang="ru">RU</button>
          <button className={locale === 'en' ? 'is-active' : ''} onClick={() => setLocale('en')} lang="en">EN</button>
          <button className={locale === 'sr' ? 'is-active' : ''} onClick={() => setLocale('sr')} lang="sr">SR</button>
        </div>
        <button className={`icon-button ${notificationsEnabled ? 'is-enabled' : ''}`} onClick={onNotifications} aria-label={notificationsEnabled ? t('Уведомления включены', 'Notifications enabled') : t('Включить уведомления', 'Enable notifications')}>
          {notificationsEnabled ? <BellRing size={20} /> : <Bell size={20} />}
        </button>
        <button className="icon-button" onClick={onSettings} aria-label={t('Настройки API', 'API settings')}>
          <Settings2 size={20} />
        </button>
      </div>
    </header>
  );
}

function UploadZone({ onFile }) {
  const { t } = useUiLanguage();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const takeFile = (files) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      className={`upload-zone ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); takeFile(event.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mkv,.avi,.mov,.m4v"
        hidden
        onChange={(event) => takeFile(event.target.files)}
      />
      <div className="upload-icon"><Upload size={27} strokeWidth={1.7} /></div>
      <strong>{t('Перетащите видео сюда', 'Drop your video here')}</strong>
      <span>{t('или нажмите, чтобы выбрать файл', 'or click to choose a file')}</span>
      <p className="upload-formats">{t('Поддерживаются MP4, MOV, WEBM и MKV. Максимальный размер исходного видео составляет 2 ГБ.', 'MP4, MOV, WEBM and MKV are supported. The maximum source video size is 2 GB.')}</p>
    </div>
  );
}

function parseYoutubeUrlClient(value) {
  try {
    const parsedUrl = new URL(value.trim());
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'].includes(hostname)) return null;
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function YoutubeDownload({ onImport, busy }) {
  const { t } = useUiLanguage();
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [message, setMessage] = useState('');

  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    const normalizedUrl = parseYoutubeUrlClient(youtubeUrl);
    if (!normalizedUrl) {
      setMessage(t('Вставьте полную ссылку youtube.com или youtu.be.', 'Paste a full youtube.com or youtu.be URL.'));
      return;
    }
    setMessage('');
    onImport(normalizedUrl);
  };

  const openSaveFrom = () => {
    const normalizedUrl = parseYoutubeUrlClient(youtubeUrl);
    if (!normalizedUrl) {
      setMessage(t('Вставьте полную ссылку youtube.com или youtu.be.', 'Paste a full youtube.com or youtu.be URL.'));
      return;
    }
    navigator.clipboard?.writeText(normalizedUrl).catch(() => {});
    window.open(`https://ru.savefrom.net/153kn/sf?url=${encodeURIComponent(normalizedUrl)}`, '_blank', 'noopener,noreferrer');
    setMessage(t('Ссылка скопирована. Скачайте MP4 в SaveFrom и загрузите файл выше.', 'The link was copied. Download the MP4 with SaveFrom and upload it above.'));
  };

  return (
    <div className="youtube-download">
      <div className="youtube-download-title"><Play size={18} fill="currentColor" /><strong>{t('Взять видео с YouTube', 'Import a YouTube video')}</strong></div>
      <p>{t('Вставьте ссылку — Читавук сам скачает ролик и начнёт распознавание. Используйте только видео, которое вам разрешено скачивать.', 'Paste a link and Čitavuk will download the video and start transcription. Only use videos you are allowed to download.')}</p>
      <form onSubmit={submit} noValidate>
        <input
          type="url"
          value={youtubeUrl}
          onChange={(event) => { setYoutubeUrl(event.target.value); setMessage(''); }}
          placeholder="https://youtu.be/…"
          aria-label={t('Ссылка на видео YouTube', 'YouTube video URL')}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>{busy ? t('Скачиваем…', 'Downloading…') : t('Скачать и распознать', 'Download and transcribe')}</button>
      </form>
      <button type="button" className="youtube-download-fallback" onClick={openSaveFrom} disabled={busy}>
        {t('Не получилось? Скачать вручную через SaveFrom', 'Not working? Download manually with SaveFrom')}
      </button>
      {message && <span className="youtube-download-message">{message}</span>}
    </div>
  );
}

function RecentProject({ project, onOpen, onDelete }) {
  const { locale, t } = useUiLanguage();
  return (
    <article className="recent-card" onClick={() => onOpen(project.id)}>
      <div className="recent-thumb">
        <Film size={22} />
        <span>{project.transcript?.length ? 'SR' : '—'}</span>
      </div>
      <div className="recent-copy">
        <strong>{project.name}</strong>
        <span>{locale === 'en' ? `${project.transcript?.length || 0} segments, ${project.glossary?.length || 0} saved words` : locale === 'sr' ? `${project.transcript?.length || 0} segmenata, ${project.glossary?.length || 0} sačuvanih reči` : `${project.transcript?.length || 0} ${pluralizeRu(project.transcript?.length || 0, 'фрагмент', 'фрагмента', 'фрагментов')}, ${project.glossary?.length || 0} ${pluralizeRu(project.glossary?.length || 0, 'слово', 'слова', 'слов')} в словаре`}</span>
      </div>
      <button
        className="subtle-icon"
        onClick={(event) => { event.stopPropagation(); onDelete(project.id); }}
        aria-label={t('Удалить проект', 'Delete project')}
      >
        <Trash2 size={16} />
      </button>
      <ChevronRight size={18} className="recent-arrow" />
    </article>
  );
}

function Landing({ onFile, onDemo, projects, onOpen, onDelete, onYoutubeImport, youtubeBusy }) {
  const { locale, t } = useUiLanguage();
  return (
    <main className="landing">
      <PageMetadata />
      <div className="side-ornament side-ornament--left"><PatternBand vertical /></div>
      <div className="side-ornament side-ornament--right"><PatternBand vertical /></div>

      <section className="hero">
        <div className="hero-copy">
          <h1>{t('Сервис для создания сербских субтитров к видео на любом языке.', 'Create Serbian subtitles for videos in any language.')}</h1>
          <p>{t('Загрузите сербский, английский, русский или другой ролик, получите синхронный сербский текст и собирайте личный словарь прямо во время просмотра.', 'Upload a Serbian, English, Russian or any other video, get synchronized Serbian text, and build your personal vocabulary while watching.')}</p>
          <img className="hero-wolf" src="/assets/citavuk-guide.webp" alt={t('Читавук помогает разобраться с субтитрами', 'Čitavuk helps you learn with subtitles')} />
        </div>

        <div className="upload-card">
          <div className="card-title">
            <div><span>{t('НОВОЕ ВИДЕО', 'NEW VIDEO')}</span><h2>{t('Начать разбор', 'Start learning')}</h2></div>
          </div>
          <UploadZone onFile={onFile} />
          <YoutubeDownload onImport={onYoutubeImport} busy={youtubeBusy} />
          <button className="demo-link" onClick={onDemo}><Play size={14} fill="currentColor" /> {t('Открыть пример проекта', 'Open a demo project')}</button>
          <div className="privacy-note"><KeyRound size={15} /> {t('Видео остается в памяти вашего браузера', 'Your video stays in this browser')}</div>
        </div>
      </section>

      <PatternBand />

      <section className="process-story">
        <BookOpen size={25} />
        <p>{t('Читавук определяет язык речи, переводит текст на сербский, синхронизирует его с видео и делает каждое слово интерактивным. Во время просмотра незнакомое слово можно добавить в личный словарь, а готовый результат сохранить как VTT, SRT или MP4 со встроенными субтитрами.', 'Čitavuk detects the spoken language, translates the text into Serbian, synchronizes it with the video and makes every word interactive. Save unfamiliar words to your personal dictionary and export the result as VTT, SRT or an MP4 with embedded subtitles.', 'Čitavuk prepoznaje jezik govora, prevodi tekst na srpski, usklađuje ga sa videom i svaku reč čini interaktivnom. Nepoznate reči možete sačuvati u ličnom rečniku, a gotov rezultat izvesti kao VTT, SRT ili MP4 sa ugrađenim titlovima.')}</p>
      </section>

      <section className="seo-explainer" aria-labelledby="seo-explainer-title">
        <div className="section-heading"><div><span>{t('КАК ЭТО РАБОТАЕТ', 'HOW IT WORKS')}</span><h2 id="seo-explainer-title">{t('Сербские субтитры без ручной разметки', 'Serbian subtitles without manual timing')}</h2></div></div>
        <div className="seo-explainer-grid">
          <article><h3>{t('Загрузите видео', 'Upload a video')}</h3><p>{t('Подойдут MP4, MOV, WEBM, MKV и другие распространённые форматы с русской, английской, сербской или другой речью.', 'Use MP4, MOV, WEBM, MKV and other common formats with English, Russian, Serbian or any other speech.', 'Podržani su MP4, MOV, WEBM, MKV i drugi uobičajeni formati sa ruskim, engleskim, srpskim ili drugim govorom.')}</p></article>
          <article><h3>{t('Получите сербский текст', 'Get Serbian text')}</h3><p>{t('Сервис распознаёт речь, переводит реплики на естественный сербский язык и синхронизирует каждую фразу с видео.', 'The service recognizes speech, translates it into natural Serbian and synchronizes every line with the video.', 'Servis prepoznaje govor, prevodi replike na prirodan srpski jezik i usklađuje svaku rečenicu sa videom.')}</p></article>
          <article><h3>{t('Смотрите или скачивайте', 'Watch or download')}</h3><p>{t('Используйте субтитры в плеере, сохраняйте SRT и VTT, создавайте MP4 или публикуйте разрешённое видео в открытой библиотеке.', 'Use subtitles in the player, save SRT or VTT, create an MP4, or publish permitted videos in the public library.', 'Koristite titlove u plejeru, sačuvajte SRT ili VTT, napravite MP4 ili objavite dozvoljeni video u javnoj biblioteci.')}</p></article>
        </div>
      </section>

      {projects.length > 0 && (
        <section className="recent-section" id="my-videos">
          <div className="section-heading"><div><span>{t('ВАША ПОЛКА', 'YOUR SHELF')}</span><h2>{t('Недавние видео', 'Recent videos')}</h2></div><small>{locale === 'en' ? `${projects.length} projects` : locale === 'sr' ? `${projects.length} projekata` : `${projects.length} ${pluralizeRu(projects.length, 'проект', 'проекта', 'проектов')}`}</small></div>
          <div className="recent-list">
            {projects.slice(0, 4).map((project) => <RecentProject key={project.id} project={project} onOpen={onOpen} onDelete={onDelete} />)}
          </div>
        </section>
      )}
    </main>
  );
}

function DemoPlayer({ currentTime, onTime, activeSegment }) {
  const { t } = useUiLanguage();
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => onTime((currentTime + 0.1) % 32), 100);
    return () => clearInterval(timer);
  }, [playing, currentTime, onTime]);

  return (
    <div className="demo-player">
      <div className="demo-sun" />
      <div className="demo-city"><i /><i /><i /><i /><i /><i /></div>
      <div className="demo-grain" />
      <div className="demo-label"><span>ДОРЋОЛ</span><small>Београд, 2026</small></div>
      {activeSegment && <div className="subtitle-overlay">{activeSegment.text}</div>}
      <div className="demo-controls">
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? t('Пауза', 'Pause') : t('Воспроизвести', 'Play')}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <div className="demo-progress" onClick={(event) => onTime((event.nativeEvent.offsetX / event.currentTarget.clientWidth) * 32)}>
          <span style={{ width: `${(currentTime / 32) * 100}%` }} />
        </div>
        <small>{formatClock(currentTime)} / 0:32</small>
        <Maximize2 size={16} />
      </div>
    </div>
  );
}

function SubtitleTrack({ segments }) {
  const trackRef = useRef(null);
  const trackUrl = useMemo(() => {
    if (!segments?.length) return '';
    return URL.createObjectURL(new Blob([makeVtt(segments)], { type: 'text/vtt;charset=utf-8' }));
  }, [segments]);

  useEffect(() => () => {
    if (trackUrl) URL.revokeObjectURL(trackUrl);
  }, [trackUrl]);

  if (!trackUrl) return null;

  return (
    <track
      ref={trackRef}
      kind="subtitles"
      src={trackUrl}
      srcLang="sr"
      label="Srpski"
      default
      onLoad={() => {
        if (trackRef.current?.track) trackRef.current.track.mode = 'showing';
      }}
    />
  );
}

function VideoPanel({ project, videoUrl, videoRef, currentTime, onTime, activeSegment, onTranscribe, processing, transcriptionError, onDismissError }) {
  const { t } = useUiLanguage();
  return (
    <section className="video-column">
      <div className="project-kicker"><span>{t('РАЗБОР ВИДЕО', 'VIDEO WORKSPACE')}</span><small>{project.isDemo ? t('пример проекта', 'demo project') : `${formatBytes(project.size)}, ${project.type || t('видео', 'video')}`}</small></div>
      <div className="video-shell">
        {project.isDemo ? (
          <DemoPlayer currentTime={currentTime} onTime={onTime} activeSegment={activeSegment} />
        ) : videoUrl ? (
          <div className="real-player">
            <video ref={videoRef} src={videoUrl} controls playsInline onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}>
              <SubtitleTrack segments={project.transcript} />
            </video>
          </div>
        ) : (
          <div className="missing-video"><Film size={32} /><strong>{t('Исходное видео не найдено', 'Source video not found')}</strong><span>{t('Загрузите файл заново, чтобы продолжить.', 'Upload the file again to continue.')}</span></div>
        )}
      </div>
      {!project.transcript?.length && (
        <div className="transcribe-callout">
          <div className="callout-icon"><WandSparkles size={22} /></div>
          <div><strong>{t('Видео готово к распознаванию', 'Video is ready for transcription')}</strong><span>{t('Читавук определит исходный язык, создаст сербские субтитры и сохранит точные таймкоды.', 'Čitavuk will detect the source language, create Serbian subtitles and preserve precise timestamps.', 'Čitavuk će prepoznati izvorni jezik, napraviti srpske titlove i sačuvati precizne vremenske oznake.')}</span></div>
          <button className="primary-button" onClick={() => onTranscribe()} disabled={Boolean(processing)}>
            {processing === 'transcribe' ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={17} />}
            {processing === 'transcribe' ? t('Слушаем речь…', 'Listening…') : t('Создать субтитры', 'Create subtitles')}
          </button>
        </div>
      )}
      {transcriptionError && (
        <div className="transcription-error" role="alert">
          <p>{transcriptionError}</p>
          <button onClick={onDismissError} aria-label={t('Закрыть сообщение об ошибке', 'Close error message')}><X size={16} /></button>
        </div>
      )}
    </section>
  );
}

function WordToken({ value, added, onAdd }) {
  const { t } = useUiLanguage();
  const cleaned = cleanWord(value);
  if (!cleaned) return <>{value} </>;
  const leading = value.match(/^[^\p{L}]+/u)?.[0] || '';
  const trailing = value.match(/[^\p{L}]+$/u)?.[0] || '';
  const token = value.slice(leading.length, trailing ? -trailing.length : undefined);
  return (
    <>
      {leading}
      <button className={`word-token ${added ? 'is-saved' : ''}`} onClick={() => onAdd(cleaned)} title={added ? t('Уже в словаре', 'Already saved') : t('Добавить в словарь', 'Add to dictionary')}>
        {token}
      </button>
      {trailing}{' '}
    </>
  );
}

function TranscriptPanel({ project, currentTime, onSeek, onAddWord, search, onSearch, onDownloadVtt, onDownloadSrt, onRetranscribe, onPublish, processing }) {
  const { t } = useUiLanguage();
  const transcript = project.transcript || [];
  const saved = useMemo(() => new Set((project.glossary || []).map((item) => item.word)), [project.glossary]);
  const visible = transcript.filter((segment) => segment.text.toLocaleLowerCase('sr').includes(search.toLocaleLowerCase('sr')));

  return (
    <section className="transcript-panel">
      <div className="panel-header">
        <div><span className="panel-eyebrow">{t('ТРАНСКРИПТ', 'TRANSCRIPT')}</span><h2>{t('Текст видео', 'Video text')}</h2></div>
        {transcript.length > 0 && (
          <div className="panel-actions">
            <button className="publish-action" onClick={onPublish} disabled={processing === 'publish'} title={t('Опубликовать анонимно', 'Publish anonymously')}><Globe2 size={15} /> {t('Опубликовать', 'Publish')}</button>
            <button onClick={() => onRetranscribe()} disabled={processing === 'transcribe'} title={t('Распознать заново', 'Transcribe again')}><Sparkles size={15} /> {t('Повторить', 'Retry')}</button>
            <button onClick={onDownloadVtt}><Download size={15} /> VTT</button>
            <button onClick={onDownloadSrt}><Download size={15} /> SRT</button>
          </div>
        )}
      </div>
      {transcript.length > 0 ? (
        <>
          <div className="transcript-tools">
            <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t('Найти в тексте…', 'Search the transcript…')} /></div>
            <span><span className="click-dot" /> {t('Нажмите на слово, чтобы перевести и сохранить', 'Select a word to translate and save it')}</span>
          </div>
          <div className="segments">
            {visible.map((segment) => {
              const delaySeconds = project.isDemo ? 0 : undefined;
              const active = isSubtitleActive(segment, currentTime, delaySeconds);
              return (
                <article key={segment.id} className={`segment ${active ? 'is-active' : ''}`}>
                  <button className="segment-time" onClick={() => onSeek(subtitleTime(segment.start, delaySeconds))}>{formatClock(subtitleTime(segment.start, delaySeconds))}</button>
                  <p>{segment.text.split(/\s+/).map((word, index) => (
                    <WordToken key={`${word}-${index}`} value={word} added={saved.has(cleanWord(word))} onAdd={(cleaned) => onAddWord(cleaned, subtitleTime(segment.start, delaySeconds), segment.text)} />
                  ))}</p>
                  {active && <span className="playing-bars"><i /><i /><i /></span>}
                </article>
              );
            })}
            {!visible.length && <div className="empty-search">{t(`Ничего не найдено по запросу «${search}»`, `Nothing found for “${search}”`)}</div>}
          </div>
        </>
      ) : (
        <div className="empty-transcript">
          <div><FileText size={29} /></div>
          <strong>{t('Здесь появится текст', 'The transcript will appear here')}</strong>
          <p>{t('После распознавания фразы синхронизируются с видео. Каждое слово станет интерактивным.', 'After transcription, every line will be synchronized with the video and every word will become interactive.', 'Posle prepoznavanja svaka rečenica će biti usklađena sa videom, a svaka reč će postati interaktivna.')}</p>
        </div>
      )}
    </section>
  );
}

function GlossaryPanel({ project, onChangeItem, onRemove, onSeek, onBurn, processing }) {
  const { t } = useUiLanguage();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.toLocaleLowerCase('sr');
  const glossary = (project.glossary || []).filter((item) => (
    item.word.includes(normalizedQuery)
    || (item.translationRu || item.translation || '').toLocaleLowerCase('ru').includes(normalizedQuery)
    || (item.translationEn || '').toLocaleLowerCase('en').includes(normalizedQuery)
  ));

  return (
    <aside className="glossary-panel">
      <div className="glossary-top">
        <div className="dictionary-icon"><BookOpen size={21} /></div>
        <div><span>{t('ЛИЧНЫЙ СЛОВАРЬ', 'PERSONAL DICTIONARY')}</span><h2>{t('Читавук-речник', 'Čitavuk Dictionary', 'Čitavuk-rečnik')} <b>{project.glossary?.length || 0}</b></h2></div>
      </div>
      {(project.glossary?.length || 0) > 0 && (
        <div className="glossary-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Найти слово…', 'Find a word…')} /></div>
      )}
      <div className="glossary-list">
        {glossary.map((item, index) => (
          <article className="word-card" key={item.id}>
            <span className="word-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="word-card-main">
              <div className="word-card-title">
                <strong>{item.word}</strong>
                <button onClick={() => onSeek(item.time)}><Clock3 size={13} /> {formatClock(item.time)}</button>
              </div>
              {item.translationStatus === 'loading' && (
                <div className="word-translation-status"><LoaderCircle size={13} className="spin" /> {t('Подбираем русский и английский переводы…', 'Finding Russian and English translations…')}</div>
              )}
              {item.translationStatus === 'error' && (
                <div className="word-translation-status is-error">{t('Перевод временно недоступен. Нажмите на слово ещё раз.', 'Translation is temporarily unavailable. Select the word again.')}</div>
              )}
              <label className="word-translation-field">
                <span>{t('РУССКИЙ', 'RUSSIAN', 'RUSKI')}</span>
                <input
                  value={item.translationRu || item.translation || ''}
                  onChange={(event) => onChangeItem(item.id, { translationRu: event.target.value, translation: event.target.value })}
                  placeholder={t('Русский перевод', 'Russian translation')}
                  aria-label={t(`Русский перевод слова ${item.word}`, `Russian translation of ${item.word}`)}
                />
              </label>
              <label className="word-translation-field">
                <span>{t('АНГЛИЙСКИЙ', 'ENGLISH', 'ENGLESKI')}</span>
                <input
                  value={item.translationEn || ''}
                  onChange={(event) => onChangeItem(item.id, { translationEn: event.target.value })}
                  placeholder={t('Английский перевод', 'English translation', 'Engleski prevod')}
                  aria-label={t(`Английский перевод слова ${item.word}`, `English translation of ${item.word}`, `Engleski prevod reči ${item.word}`)}
                />
              </label>
              <textarea
                value={item.note || ''}
                onChange={(event) => onChangeItem(item.id, { note: event.target.value })}
                placeholder={t('Заметка или пример', 'Note or example')}
                rows={1}
              />
            </div>
            <button className="remove-word" onClick={() => onRemove(item.id)} aria-label={t(`Удалить ${item.word}`, `Remove ${item.word}`, `Ukloni ${item.word}`)}><X size={15} /></button>
          </article>
        ))}
        {!glossary.length && (
          <div className="empty-glossary">
            <div className="empty-book"><BookOpen size={27} /><Plus size={14} /></div>
            <strong>{query ? t('Слово не найдено', 'Word not found') : t('Словарь пока пуст', 'The dictionary is empty')}</strong>
            <p>{query ? t('Попробуйте другой запрос.', 'Try another search.') : t('Нажимайте на незнакомые слова в тексте — здесь появятся русский и английский переводы.', 'Select unfamiliar words in the transcript to see Russian and English translations here.', 'Izaberite nepoznate reči u transkriptu da biste ovde videli ruski i engleski prevod.')}</p>
          </div>
        )}
      </div>
      <div className="glossary-footer">
        <button className="burn-button" onClick={onBurn} disabled={!project.transcript?.length || processing === 'burn' || project.isDemo}>
          {processing === 'burn' ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
          <span><strong>{processing === 'burn' ? t('Собираем MP4…', 'Creating MP4…') : t('MP4 с субтитрами', 'MP4 with subtitles')}</strong><small>{project.isDemo ? t('недоступно в демо', 'unavailable in demo') : t('титры вшиты в видео', 'subtitles embedded in video')}</small></span>
        </button>
      </div>
    </aside>
  );
}

function Workspace({ project, videoUrl, videoFile, apiKey, onBack, onUpdate, onTranscribe, onBurn, onPublish, processing, notify, transcriptionError, onDismissError }) {
  const { t } = useUiLanguage();
  const [currentTime, setCurrentTime] = useState(0);
  const [search, setSearch] = useState('');
  const videoRef = useRef(null);
  const activeSegment = project.transcript?.find((segment) => isSubtitleActive(segment, currentTime, project.isDemo ? 0 : undefined));

  const seek = (time) => {
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  };

  const translateGlossaryItem = async (id, word, context, markLoading = true) => {
    if (markLoading) {
      onUpdate((currentProject) => ({
        glossary: (currentProject.glossary || []).map((item) => (
          item.id === id ? { ...item, translationStatus: 'loading' } : item
        )),
      }));
    }
    try {
      const translated = await requestWordTranslation(word, context, apiKey);
      onUpdate((currentProject) => ({
        glossary: (currentProject.glossary || []).map((item) => (
          item.id === id ? {
            ...item,
            translation: translated.ru,
            translationRu: translated.ru,
            translationEn: translated.en,
            translationStatus: 'ready',
            translationProvider: translated.provider,
          } : item
        )),
      }));
      notify(`«${word}»: ${translated.ru} · ${translated.en}`);
    } catch (error) {
      onUpdate((currentProject) => ({
        glossary: (currentProject.glossary || []).map((item) => (
          item.id === id ? { ...item, translationStatus: 'error' } : item
        )),
      }));
      notify(error.message);
    }
  };

  const addWord = (word, time, context) => {
    if (!word) return;
    const existing = project.glossary?.find((item) => item.word === word);
    if (existing) {
      if (existing.translationStatus === 'loading') return;
      const trustedProvider = ['yandex', 'groq', 'demo'].includes(existing.translationProvider);
      if ((existing.translationRu || existing.translation) && existing.translationEn && trustedProvider) {
        notify(`«${word}»: ${existing.translationRu || existing.translation} · ${existing.translationEn}`);
        return;
      }
      translateGlossaryItem(existing.id, word, context);
      return;
    }
    const id = crypto.randomUUID();
    onUpdate((currentProject) => ({
      glossary: [...(currentProject.glossary || []), {
        id,
        word,
        translation: '',
        translationRu: '',
        translationEn: '',
        translationStatus: 'loading',
        note: '',
        time,
      }],
    }));
    translateGlossaryItem(id, word, context, false);
  };

  const changeItem = (id, patch) => onUpdate({
    glossary: project.glossary.map((item) => item.id === id ? { ...item, ...patch } : item),
  });

  const removeItem = (id) => onUpdate({ glossary: project.glossary.filter((item) => item.id !== id) });
  const filename = fileStem(project.name);

  return (
    <main className="workspace">
      <div className="project-bar">
        <button onClick={onBack}><ArrowLeft size={17} /> {t('К проектам', 'Back to projects')}</button>
        <div className="project-title"><span className="status-dot" /><strong>{project.name}</strong><span>{t('сохранено локально', 'saved locally')}</span></div>
        <div className="project-meta"><Gauge size={15} /><span>{project.transcript?.length ? t(`${project.transcript.length} фрагментов`, `${project.transcript.length} segments`, `${project.transcript.length} segmenata`) : t('ожидает обработки', 'waiting to be processed')}</span></div>
      </div>
      <div className="workspace-grid">
        <div className="workspace-main">
          <VideoPanel
            project={project}
            videoUrl={videoUrl}
            videoRef={videoRef}
            currentTime={currentTime}
            onTime={setCurrentTime}
            activeSegment={activeSegment}
            onTranscribe={onTranscribe}
            processing={processing}
            transcriptionError={transcriptionError}
            onDismissError={onDismissError}
          />
          <TranscriptPanel
            project={project}
            currentTime={currentTime}
            onSeek={seek}
            onAddWord={addWord}
            search={search}
            onSearch={setSearch}
            onDownloadVtt={() => downloadText(makeVtt(project.transcript), `${filename}-sr.vtt`, 'text/vtt;charset=utf-8')}
            onDownloadSrt={() => downloadText(makeSrt(project.transcript), `${filename}-sr.srt`)}
            onRetranscribe={onTranscribe}
            onPublish={onPublish}
            processing={processing}
          />
        </div>
        <GlossaryPanel
          project={project}
          onChangeItem={changeItem}
          onRemove={removeItem}
          onSeek={seek}
          onBurn={() => onBurn(videoFile)}
          processing={processing}
        />
      </div>
    </main>
  );
}

function PublicLibrary({ refreshToken, notify, videoSlug, locationKey, onNavigate }) {
  const { locale, t } = useUiLanguage();
  const [items, setItems] = useState([]);
  const [category, setCategory] = useState(() => new URLSearchParams(window.location.search).get('category') || 'все');
  const [currentPage, setCurrentPage] = useState(() => Math.max(1, Number.parseInt(new URLSearchParams(window.location.search).get('page') || '1', 10) || 1));
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [selected, setSelected] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState('');
  const videoRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextCategory = params.get('category') || 'все';
    setCategory(PUBLIC_CATEGORIES.includes(nextCategory) ? nextCategory : 'все');
    setCurrentPage(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
  }, [locationKey]);

  useEffect(() => {
    if (videoSlug) return undefined;
    let cancelled = false;
    const load = async () => {
      if (!API_BASE_URL && window.location.hostname.endsWith('.netlify.app')) {
        if (!cancelled) {
          setError('Публичная библиотека станет доступна после подключения Render через переменную VITE_API_BASE_URL в Netlify.');
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ page: String(currentPage), limit: '8' });
        if (category !== 'все') params.set('category', category);
        const response = await fetch(apiUrl(`/api/public/videos?${params}`));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Не удалось открыть публичную библиотеку.');
        if (!cancelled) {
          setConfigured(payload.configured !== false);
          setItems(Array.isArray(payload.items) ? payload.items : []);
          setCurrentPage(Number(payload.page) || 1);
          setTotalPages(Number(payload.totalPages) || 1);
          setTotalItems(Number(payload.totalItems) || 0);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [category, currentPage, refreshToken, videoSlug]);

  useEffect(() => {
    if (!videoSlug) {
      setSelected(null);
      setCurrentTime(0);
      return undefined;
    }
    let cancelled = false;
    const openPublication = async () => {
      setSelected(null);
      setLoading(true);
      setError('');
      try {
        const response = await fetch(apiUrl(`/api/public/videos/${encodeURIComponent(videoSlug)}`));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Не удалось открыть видео.');
        if (!cancelled) {
          setSelected(payload);
          setCurrentTime(0);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } catch (openError) {
        if (!cancelled) {
          setError(openError.message);
          notify(openError.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    openPublication();
    return () => { cancelled = true; };
  }, [videoSlug]);

  const libraryHref = (page = 1, nextCategory = category) => {
    const params = new URLSearchParams();
    if (nextCategory !== 'все') params.set('category', nextCategory);
    if (page > 1) params.set('page', String(page));
    return `/subtitles${params.size ? `?${params}` : ''}`;
  };

  const follow = (event, href) => {
    event.preventDefault();
    onNavigate(href);
  };

  const seek = (time) => {
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  };

  if (selected) {
    const pagePath = `/subtitles/${selected.slug || videoSlug}`;
    const pageDescription = selected.description || t(`${selected.title} — видео с синхронными сербскими субтитрами и текстом реплик.`, `${selected.title} — a video with synchronized Serbian subtitles and a full transcript.`, `${selected.title} — video sa sinhronizovanim srpskim titlovima i potpunim transkriptom.`);
    const shortTitle = selected.title.length > 58 ? `${selected.title.slice(0, 57).trim()}…` : selected.title;
    return (
      <main className="public-library public-viewer">
        <PageMetadata title={t(`${shortTitle} — сербские субтитры`, `${shortTitle} — Serbian subtitles`, `${shortTitle} — srpski titlovi`)} description={pageDescription} path={pagePath} />
        <div className="library-heading">
          <nav className="breadcrumbs" aria-label={t('Хлебные крошки', 'Breadcrumbs')}><a href={localizedSitePath('/', locale)} onClick={(event) => follow(event, '/')}>{t('Главная', 'Home')}</a><span>›</span><a href={localizedSitePath('/subtitles', locale)} onClick={(event) => follow(event, '/subtitles')}>{t('Библиотека', 'Library')}</a><span>›</span><strong>{selected.title}</strong></nav>
          <a className="library-back" href={localizedSitePath('/subtitles', locale)} onClick={(event) => follow(event, '/subtitles')}><ArrowLeft size={17} /> {t('Ко всем публикациям', 'All publications')}</a>
          <span className="category-badge"><Tag size={13} /> {publicCategoryLabel(selected.category, locale)}</span>
          <h1>{selected.title}</h1>
          <p>{pageDescription}</p>
        </div>
        <section className="public-player-layout">
          <div className="public-video-shell">
            <video ref={videoRef} src={selected.videoUrl} controls playsInline onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}>
              <SubtitleTrack segments={selected.segments} />
            </video>
          </div>
          <div className="public-transcript">
            <div className="public-transcript-heading"><span>{t('СЕРБСКИЕ СУБТИТРЫ', 'SERBIAN SUBTITLES')}</span><h2>{t('Текст видео', 'Video transcript')}</h2></div>
            <div className="public-segments">
              {(selected.segments || []).map((segment) => (
                <button key={segment.id} className={isSubtitleActive(segment, currentTime) ? 'is-active' : ''} onClick={() => seek(subtitleTime(segment.start))}>
                  <time>{formatClock(subtitleTime(segment.start))}</time><span>{segment.text}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>
    );
  }

  const visibleItems = items;
  return (
    <main className="public-library">
      <PageMetadata title={locale === 'en' ? `Videos with Serbian subtitles — public library${currentPage > 1 ? ` — page ${currentPage}` : ''}` : locale === 'sr' ? `Video-snimci sa srpskim titlovima — javna biblioteka${currentPage > 1 ? ` — stranica ${currentPage}` : ''}` : `${category !== 'все' ? `${category[0].toLocaleUpperCase('ru')}${category.slice(1)} с сербскими субтитрами` : 'Видео с сербскими субтитрами — публичная библиотека'}${currentPage > 1 ? ` — страница ${currentPage}` : ''}`} description={t('Публичная библиотека фильмов, мультфильмов, блогов и учебных видео с синхронными сербскими субтитрами и текстом реплик.', 'A public library of films, animation, blogs and learning videos with synchronized Serbian subtitles and full transcripts.', 'Javna biblioteka filmova, crtanih filmova, blogova i obrazovnih video-snimaka sa sinhronizovanim srpskim titlovima i transkriptima.')} path={libraryHref(currentPage, category)} />
      <PatternBand />
      <section className="library-intro">
        <div>
          <span className="panel-eyebrow">{t('АНОНИМНЫЕ ПУБЛИКАЦИИ', 'ANONYMOUS PUBLICATIONS')}</span>
          <h1>{t('Сербское видео с готовыми субтитрами', 'Videos with ready-made Serbian subtitles')}</h1>
          <p>{t('Здесь собраны видео, которыми пользователи решили поделиться после распознавания речи. Имя автора не запрашивается и не публикуется, а категория помогает быстро найти фильм, мультфильм, блог или учебный материал.', 'These are videos users chose to share after transcription. Author names are not requested or published, and categories make films, animation, blogs and learning materials easy to find.', 'Ovde su video-snimci koje su korisnici odlučili da podele posle prepoznavanja govora. Ime autora se ne traži niti objavljuje, a kategorije pomažu da brzo pronađete film, crtani film, blog ili obrazovni sadržaj.')}</p>
        </div>
        <img src="/assets/citavuk-guide.webp" alt={t('Читавук показывает публичную библиотеку', 'Čitavuk presents the public library', 'Čitavuk predstavlja javnu biblioteku')} />
      </section>
      <nav className="category-filter" aria-label={t('Фильтр по категории', 'Filter by category')}>
        {PUBLIC_CATEGORIES.map((item) => <a href={localizedSitePath(libraryHref(1, item), locale)} key={item} className={category === item ? 'is-active' : ''} onClick={(event) => follow(event, libraryHref(1, item))}>{publicCategoryLabel(item, locale)}</a>)}
      </nav>
      {loading && <div className="library-state"><LoaderCircle className="spin" size={24} /><p>{t('Читавук открывает библиотеку…', 'Čitavuk is opening the library…')}</p></div>}
      {!loading && error && <div className="library-state library-state--error"><Globe2 size={28} /><p>{error}</p></div>}
      {!loading && !error && !configured && <div className="library-state"><Globe2 size={28} /><p>{t('Публичное хранилище ещё не подключено.', 'Public storage is not connected yet.')}</p></div>}
      {!loading && !error && configured && visibleItems.length === 0 && <div className="library-state"><Film size={28} /><p>{category === 'все' ? t('Пока здесь нет видео. Первую публикацию можно создать из проекта с готовыми субтитрами.', 'There are no videos yet. You can publish the first one from a project with completed subtitles.', 'Ovde još nema video-snimaka. Prvi možete objaviti iz projekta sa gotovim titlovima.') : t(`В категории «${category}» пока нет видео.`, `There are no videos in “${PUBLIC_CATEGORY_EN[category] || category}” yet.`, `U kategoriji „${PUBLIC_CATEGORY_SR[category] || category}“ još nema video-snimaka.`)}</p></div>}
      {!loading && !error && visibleItems.length > 0 && (
        <section className="publication-grid">
          {visibleItems.map((item) => (
            <a className="publication-card" href={localizedSitePath(`/subtitles/${item.slug}`, locale)} key={item.id} onClick={(event) => follow(event, `/subtitles/${item.slug}`)}>
              <div className={`publication-cover ${item.thumbnailUrl ? 'publication-cover--image' : ''}`}>
                {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt={t(`Кадр из видео «${item.title}»`, `Frame from “${item.title}”`, `Kadar iz videa „${item.title}“`)} loading="lazy" /> : <Film size={32} />}
                <span>{publicCategoryLabel(item.category, locale)}</span>
              </div>
              <div className="publication-copy">
                <h2>{item.title}</h2>
                <p>{item.description || t('Сербское видео с распознанными субтитрами.', 'A video with recognized Serbian subtitles.', 'Video sa prepoznatim srpskim titlovima.')}</p>
                <small>{locale === 'en' ? `${item.segmentsCount} segments` : locale === 'sr' ? `${item.segmentsCount} segmenata` : `${item.segmentsCount} ${pluralizeRu(item.segmentsCount, 'фрагмент', 'фрагмента', 'фрагментов')}`}, {formatClock(item.duration)}</small>
              </div>
              <ChevronRight size={19} />
            </a>
          ))}
        </section>
      )}
      {!loading && !error && totalItems > 0 && (
        <nav className="pagination" aria-label={t('Страницы библиотеки', 'Library pages')}>
          <a className={currentPage <= 1 ? 'is-disabled' : ''} href={localizedSitePath(libraryHref(Math.max(1, currentPage - 1)), locale)} onClick={(event) => currentPage > 1 && follow(event, libraryHref(currentPage - 1))}>{t('Назад', 'Previous')}</a>
          <span>{t(`Страница ${currentPage} из ${totalPages}`, `Page ${currentPage} of ${totalPages}`, `Stranica ${currentPage} od ${totalPages}`)}</span>
          <div>
            {Array.from({ length: totalPages }, (_, index) => index + 1).slice(Math.max(0, currentPage - 3), Math.max(5, currentPage + 2)).map((page) => (
              <a key={page} className={page === currentPage ? 'is-active' : ''} href={localizedSitePath(libraryHref(page), locale)} onClick={(event) => follow(event, libraryHref(page))}>{page}</a>
            ))}
          </div>
          <a className={currentPage >= totalPages ? 'is-disabled' : ''} href={localizedSitePath(libraryHref(Math.min(totalPages, currentPage + 1)), locale)} onClick={(event) => currentPage < totalPages && follow(event, libraryHref(currentPage + 1))}>{t('Дальше', 'Next')}</a>
        </nav>
      )}
    </main>
  );
}

function PublishModal({ project, processing, onSubmit, onClose }) {
  const { locale, t } = useUiLanguage();
  const [title, setTitle] = useState(project.name.replace(/\.[^.]+$/, ''));
  const [category, setCategory] = useState('фильм');
  const [description, setDescription] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="publish-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ title: title.trim(), category, description: description.trim(), rightsConfirmed });
      }}>
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('Закрыть публикацию', 'Close publication form')}><X size={20} /></button>
        <div className="modal-icon"><Globe2 size={24} /></div>
        <span className="modal-kicker">{t('ПУБЛИЧНАЯ БИБЛИОТЕКА', 'PUBLIC LIBRARY')}</span>
        <h2>{t('Опубликовать анонимно', 'Publish anonymously')}</h2>
        <p>{t('Видео и уже распознанные сербские субтитры станут доступны всем посетителям. Личные настройки и данные словаря не передаются и не публикуются.', 'The video and completed Serbian subtitles will become public. Personal settings and dictionary data are never uploaded or published.', 'Video i gotovi srpski titlovi postaće dostupni svim posetiocima. Lična podešavanja i podaci iz rečnika se ne prenose niti objavljuju.')}</p>
        <label>{t('НАЗВАНИЕ', 'TITLE')}
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required />
        </label>
        <label>{t('КАТЕГОРИЯ', 'CATEGORY')}
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {PUBLIC_CATEGORIES.slice(1).map((item) => <option key={item} value={item}>{publicCategoryLabel(item, locale)}</option>)}
          </select>
        </label>
        <label>{t('ОПИСАНИЕ', 'DESCRIPTION')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} rows={3} placeholder={t('Коротко расскажите, что находится в видео', 'Briefly describe the video')} />
        </label>
        <label className="rights-confirmation">
          <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
          <span><ShieldCheck size={18} /> {t('Я подтверждаю, что имею право публично разместить это видео и понимаю, что публикация будет доступна по всему интернету.', 'I confirm that I have the right to publish this video and understand that it will be publicly available online.', 'Potvrđujem da imam pravo da javno objavim ovaj video i razumem da će publikacija biti dostupna na internetu.')}</span>
        </label>
        <button className="primary-button publish-submit" disabled={processing === 'publish' || !rightsConfirmed || title.trim().length < 2}>
          {processing === 'publish' ? <LoaderCircle className="spin" size={18} /> : <Globe2 size={18} />}
          {processing === 'publish' ? t('Загружаем публикацию…', 'Uploading…') : t('Опубликовать видео', 'Publish video')}
        </button>
      </form>
    </div>
  );
}

function SettingsModal({ value, onSave, onClose }) {
  const { t } = useUiLanguage();
  const [key, setKey] = useState(value);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('Закрыть настройки', 'Close settings')}><X size={20} /></button>
        <div className="modal-icon"><KeyRound size={24} /></div>
        <span className="modal-kicker">{t('НЕОБЯЗАТЕЛЬНО', 'OPTIONAL')}</span>
        <h2>{t('Свой ключ Groq API', 'Your Groq API key')}</h2>
        <p>{t('По умолчанию распознавание и перевод работают на общих серверных моделях Polza. Личный Groq-ключ нужен только для использования собственных лимитов распознавания.', 'By default, transcription and translation use the shared Polza models on the server. A personal Groq key is only needed if you want to use your own transcription limits.', 'Prepoznavanje i prevođenje podrazumevano rade preko zajedničkih Polza modela na serveru. Lični Groq ključ je potreban samo ako želite da koristite sopstvene limite.')}</p>
        <p className="key-guide-copy">{t('Чтобы подключить свой ключ, откройте Groq Console, нажмите Create API Key и вставьте сюда значение, которое начинается с gsk_. Ключ останется только в локальном хранилище этого браузера.', 'To connect your key, open Groq Console, select Create API Key, and paste the value starting with gsk_. It will stay in this browser’s local storage.', 'Da biste povezali svoj ključ, otvorite Groq Console, izaberite Create API Key i ovde unesite vrednost koja počinje sa gsk_. Ključ će ostati samo u lokalnom skladištu ovog pregledača.')}</p>
        <label>{t('ЛИЧНЫЙ GROQ API KEY', 'PERSONAL GROQ API KEY')}
          <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={t('Оставьте пустым для общего сервера', 'Leave empty to use the shared server')} autoFocus />
        </label>
        <div className="free-info"><Sparkles size={18} /><p>{t('Если удалить значение из поля и сохранить настройки, сайт снова автоматически переключится на общий сервер.', 'Clear the field and save to switch back to the shared server automatically.', 'Obrišite vrednost iz polja i sačuvajte podešavanja da biste se automatski vratili na zajednički server.')}</p></div>
        <div className="modal-actions">
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">{t('Получить личный ключ', 'Get a personal key')} <ChevronRight size={15} /></a>
          <button className="primary-button" onClick={() => onSave(key.trim())}>{key.trim() ? t('Использовать свой ключ', 'Use my key') : t('Использовать общий сервер', 'Use shared server')}</button>
        </div>
      </section>
    </div>
  );
}

const WELCOME_STEPS = [
  {
    title: ['Загрузите видео', 'Upload a video', 'Otpremite video'],
    text: ['Перетащите видео в область загрузки, выберите файл на устройстве или вставьте ссылку на YouTube.', 'Drop a video into the upload area, choose a file from your device, or paste a YouTube URL.', 'Prevucite video u polje za otpremanje, izaberite datoteku sa uređaja ili unesite YouTube vezu.'],
    images: {
      ru: '/assets/onboarding-upload.png',
      en: '/assets/onboarding-upload-en.png',
      sr: '/assets/onboarding-upload-sr.png',
    },
    alt: ['Загрузка видео на главной странице Читавука', 'Video upload on the Čitavuk home page', 'Otpremanje videa na početnoj stranici Čitavuka'],
  },
  {
    title: ['Создайте субтитры', 'Create subtitles', 'Napravite titlove'],
    text: ['Откройте загруженное видео и нажмите «Создать субтитры». Читавук распознает речь и подготовит сербский текст.', 'Open the uploaded video and select “Create subtitles”. Čitavuk will recognize the speech and prepare Serbian text.', 'Otvorite otpremljeni video i izaberite „Napravi titlove“. Čitavuk će prepoznati govor i pripremiti srpski tekst.'],
    images: {
      ru: '/assets/onboarding-transcribe.png',
      en: '/assets/onboarding-transcribe-en.png',
      sr: '/assets/onboarding-transcribe-sr.png',
    },
    alt: ['Кнопка создания сербских субтитров в проекте', 'Create Serbian subtitles button', 'Dugme za pravljenje srpskih titlova'],
  },
  {
    title: ['Смотрите и сохраняйте', 'Watch and save', 'Gledajte i sačuvajte'],
    text: ['Смотрите видео с субтитрами, нажимайте на незнакомые слова и сохраняйте результат в VTT, SRT или MP4.', 'Watch with subtitles, select unfamiliar words, and save the result as VTT, SRT or MP4.', 'Gledajte video sa titlovima, birajte nepoznate reči i sačuvajte rezultat kao VTT, SRT ili MP4.'],
    images: {
      ru: '/assets/onboarding-result.png',
      en: '/assets/onboarding-result-en.png',
      sr: '/assets/onboarding-result-sr.png',
    },
    alt: ['Готовые субтитры и личный словарь в Читавуке', 'Completed subtitles and personal vocabulary in Čitavuk', 'Gotovi titlovi i lični rečnik u Čitavuku'],
  },
];

function WelcomeModal({ onClose }) {
  const { locale, t } = useUiLanguage();
  const [step, setStep] = useState(0);
  const current = WELCOME_STEPS[step];
  const isLast = step === WELCOME_STEPS.length - 1;
  const localeIndex = locale === 'en' ? 1 : locale === 'sr' ? 2 : 0;
  const currentImage = current.images[locale] || current.images.en;

  return (
    <div className="modal-backdrop welcome-backdrop" onMouseDown={onClose}>
      <section className="welcome-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('Закрыть инструкцию', 'Close guide')}><X size={20} /></button>
        <div className="welcome-shot-wrap">
          <img key={currentImage} src={currentImage} alt={current.alt[localeIndex]} />
          <span className="welcome-shot-counter">{step + 1} / {WELCOME_STEPS.length}</span>
        </div>
        <div className="welcome-content">
          <span className="modal-kicker">{t('КАК ЭТО РАБОТАЕТ', 'HOW IT WORKS')}</span>
          <h2>{current.title[localeIndex]}</h2>
          <p>{current.text[localeIndex]}</p>
          <div className="welcome-step-nav" aria-label={t('Шаги инструкции', 'Guide steps')}>
            {WELCOME_STEPS.map((item, index) => (
              <button
                key={item.title[0]}
                type="button"
                className={index === step ? 'active' : ''}
                onClick={() => setStep(index)}
                aria-label={locale === 'sr' ? `Korak ${index + 1}: ${item.title[2]}` : t(`Шаг ${index + 1}: ${item.title[0]}`, `Step ${index + 1}: ${item.title[1]}`)}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                {item.title[localeIndex]}
              </button>
            ))}
          </div>
          <div className="welcome-actions">
            {step > 0 && <button className="secondary-button" onClick={() => setStep((value) => value - 1)}>{t('Назад', 'Back')}</button>}
            <button className="primary-button" onClick={() => isLast ? onClose() : setStep((value) => value + 1)}>
              {isLast ? t('Начать', 'Start') : t('Далее', 'Next')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SupportModal({ onClose, notify }) {
  const { locale, t } = useUiLanguage();
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (message.trim().length < 10) {
      setError(t('Опишите проблему чуть подробнее.', 'Please describe the issue in a little more detail.', 'Opišite problem malo detaljnije.'));
      return;
    }
    if (attachment && attachment.size > 8 * 1024 * 1024) {
      setError(t('Скриншот должен быть меньше 8 МБ.', 'The screenshot must be smaller than 8 MB.', 'Snimak ekrana mora biti manji od 8 MB.'));
      return;
    }
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('_subject', `Čitavuk support · ${window.location.hostname}`);
      formData.append('_template', 'table');
      formData.append('_captcha', 'false');
      formData.append('_honey', website);
      formData.append('message', message.trim());
      formData.append('reply_to', contact.trim() || 'not provided');
      formData.append('page', window.location.href);
      formData.append('interface_language', locale);
      formData.append('browser', navigator.userAgent);
      if (attachment) formData.append('attachment', attachment, attachment.name);
      const response = await fetch('https://formsubmit.co/ajax/deniskornilov12@gmail.com', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) {
        throw new Error(payload.message || t('Не удалось отправить сообщение.', 'The message could not be sent.', 'Poruka nije poslata.'));
      }
      notify(t('Сообщение отправлено в техническую поддержку', 'Your message was sent to technical support', 'Poruka je poslata tehničkoj podršci'));
      onClose();
    } catch (submissionError) {
      setError(submissionError.message || t('Не удалось отправить сообщение.', 'The message could not be sent.', 'Poruka nije poslata.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop support-backdrop" onMouseDown={onClose}>
      <section className="support-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('Закрыть техническую поддержку', 'Close technical support', 'Zatvori tehničku podršku')}><X size={20} /></button>
        <span className="modal-kicker">{t('ТЕХНИЧЕСКАЯ ПОДДЕРЖКА', 'TECHNICAL SUPPORT', 'TEHNIČKA PODRŠKA')}</span>
        <h2>{t('Сообщить о проблеме', 'Report a problem', 'Prijavite problem')}</h2>
        <p>{t('Опишите, что произошло. Адрес страницы и сведения о браузере добавятся автоматически.', 'Tell us what happened. The page address and browser details will be included automatically.', 'Opišite šta se dogodilo. Adresa stranice i podaci o pregledaču biće dodati automatski.')}</p>
        <form onSubmit={submit}>
          <label>
            {t('Что произошло', 'What happened', 'Šta se dogodilo')}
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={6} placeholder={t('Опишите действия и текст ошибки', 'Describe what you did and include any error message', 'Opišite svoje radnje i tekst greške')} autoFocus required />
          </label>
          <label>
            {t('Ваш email или Telegram для ответа', 'Your email or Telegram for a reply', 'Vaš email ili Telegram za odgovor')}
            <input value={contact} onChange={(event) => setContact(event.target.value)} placeholder={t('Необязательно', 'Optional', 'Neobavezno')} />
          </label>
          <label className="support-file">
            <span><Paperclip size={17} /> {t('Приложить скриншот', 'Attach a screenshot', 'Priložite snimak ekrana')}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setAttachment(event.target.files?.[0] || null)}
            />
            <small>{attachment ? attachment.name : t('PNG, JPG или WEBP до 8 МБ', 'PNG, JPG or WEBP up to 8 MB', 'PNG, JPG ili WEBP do 8 MB')}</small>
          </label>
          <input className="support-honeypot" value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" />
          {error && <div className="support-error" role="alert">{error}</div>}
          <button className="primary-button support-submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={18} /> : <Mail size={18} />}
            {submitting ? t('Отправляем…', 'Sending…', 'Šaljemo…') : t('Отправить в поддержку', 'Send to support', 'Pošalji podršci')}
          </button>
        </form>
      </section>
    </div>
  );
}

function remainingLabel(seconds, locale = 'ru') {
  if (!Number.isFinite(seconds)) return null;
  if (locale === 'sr') {
    if (seconds < 60) return `preostalo je oko ${Math.max(1, Math.round(seconds))} sek`;
    return `preostalo je oko ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sek`;
  }
  if (seconds < 60) return locale === 'en' ? `about ${Math.max(1, Math.round(seconds))} sec left` : `осталось примерно ${Math.max(1, Math.round(seconds))} сек`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return locale === 'en' ? `about ${minutes} min ${remainder} sec left` : `осталось примерно ${minutes} мин ${remainder} сек`;
}

function localizedProgressStage(stage, locale) {
  if (!stage || locale === 'ru') return stage;
  if (locale === 'sr') {
    const dynamicTranslations = [
      [/^Переводим субтитры на сербский \((.+)\)$/, 'Prevodimo titlove na srpski ($1)'],
      [/^Проверяем пропуск в субтитрах \((.+)\)$/, 'Proveravamo prazninu u titlovima ($1)'],
      [/^Передаём видео частями: (.+)$/, 'Otpremamo video u delovima: $1'],
    ];
    for (const [pattern, translation] of dynamicTranslations) {
      if (pattern.test(stage)) return stage.replace(pattern, translation);
    }
    return {
      'Подготавливаем видео к загрузке': 'Pripremamo video za otpremanje',
      'Загружаем видео на сервер': 'Otpremamo video na server',
      'Получаем видео от пользователя': 'Primamo video',
      'Видео загружено на сервер': 'Video je otpremljen',
      'Извлекаем и сжимаем аудио': 'Izdvajamo i sažimamo zvuk',
      'Проверяем аудиодорожку': 'Proveravamo audio-zapis',
      'Aiesa распознаёт речь, Whisper синхронизирует таймкоды': 'Aiesa prepoznaje govor, Whisper usklađuje vreme',
      'Groq определяет язык и распознаёт речь': 'Groq prepoznaje jezik i govor',
      'Проверяем видео на пропуски в субтитрах': 'Proveravamo da li nedostaju titlovi',
      'Ждём доступности модели перевода': 'Čekamo model za prevođenje',
      'Сохраняем фрагменты и таймкоды': 'Čuvamo segmente i vremenske oznake',
      'Субтитры готовы': 'Titlovi su spremni',
      'Распознавание остановлено': 'Obrada je zaustavljena',
      'Восстанавливаем фоновую задачу': 'Obnavljamo pozadinski zadatak',
    }[stage] || stage;
  }
  const dynamicTranslations = [
    [/^Переводим субтитры на сербский \((.+)\)$/, 'Translating subtitles into Serbian ($1)'],
    [/^Проверяем пропуск в субтитрах \((.+)\)$/, 'Checking a subtitle gap ($1)'],
    [/^Передаём видео частями: (.+)$/, 'Uploading video in chunks: $1'],
  ];
  for (const [pattern, translation] of dynamicTranslations) {
    if (pattern.test(stage)) return stage.replace(pattern, translation);
  }
  return {
    'Подготавливаем видео к загрузке': 'Preparing the video for upload',
    'Загружаем видео на сервер': 'Uploading the video',
    'Получаем видео от пользователя': 'Receiving the video',
    'Видео загружено на сервер': 'Video uploaded',
    'Извлекаем и сжимаем аудио': 'Extracting and compressing audio',
    'Проверяем аудиодорожку': 'Checking the audio track',
    'Aiesa распознаёт речь, Whisper синхронизирует таймкоды': 'Aiesa is recognizing speech and Whisper is aligning timestamps',
    'Groq определяет язык и распознаёт речь': 'Groq is detecting the language and recognizing speech',
    'Проверяем видео на пропуски в субтитрах': 'Checking the video for missing subtitles',
    'Ждём доступности модели перевода': 'Waiting for the translation model',
    'Сохраняем фрагменты и таймкоды': 'Saving segments and timestamps',
    'Субтитры готовы': 'Subtitles are ready',
    'Распознавание остановлено': 'Processing stopped',
    'Восстанавливаем фоновую задачу': 'Restoring the background job',
  }[stage] || stage;
}

function ProcessingBanner({ kind, progress }) {
  const { locale, t } = useUiLanguage();
  if (!kind) return null;
  const title = kind === 'burn' ? t('Создаём видео с субтитрами', 'Creating a subtitled video') : kind === 'publish' ? t('Публикуем видео анонимно', 'Publishing anonymously') : kind === 'youtube' ? t('Скачиваем видео с YouTube', 'Downloading from YouTube') : t('Готовим сербские субтитры', 'Creating Serbian subtitles');
  const copy = kind === 'burn' ? t('Это может занять несколько минут…', 'This may take a few minutes…') : kind === 'publish' ? t('Передаём видео и готовые субтитры в публичное хранилище…', 'Uploading the video and subtitles to public storage…', 'Otpremamo video i gotove titlove u javno skladište…') : kind === 'youtube' ? t('Загружаем ролик на сервер и передаём его в браузер…', 'Downloading the video on the server…', 'Preuzimamo video na server i šaljemo ga pregledaču…') : t('Извлекаем звук и расставляем таймкоды…', 'Extracting audio and aligning timestamps…', 'Izdvajamo zvuk i usklađujemo vremenske oznake…');
  if ((kind === 'transcribe' || kind === 'youtube' || kind === 'publish' || kind === 'burn') && progress) {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    const remaining = remainingLabel(progress.etaSeconds, locale);
    return (
      <div className="processing-banner processing-banner--progress" role="status" aria-live="polite">
        <div className="processing-progress-heading">
          <div><LoaderCircle size={18} className="spin" /><strong>{title}</strong></div>
          <b>{percent}%</b>
        </div>
        <div className="processing-progress-track"><span style={{ width: `${percent}%` }} /></div>
        <div className="processing-progress-copy">
          <span>{localizedProgressStage(progress.stage, locale) || copy}</span>
          <small>{remaining || (percent >= 60 && percent < 99 ? t('Сервис отвечает дольше обычного, задача продолжает выполняться', 'The service is taking longer than usual, but the job is still running', 'Servisu je potrebno više vremena nego obično, ali obrada se nastavlja') : t('оцениваем оставшееся время', 'estimating the remaining time'))}</small>
        </div>
      </div>
    );
  }
  return (
    <div className="processing-banner">
      <LoaderCircle size={18} className="spin" />
      <div><strong>{title}</strong><span>{copy}</span></div>
    </div>
  );
}

function TelegramNotice({ onClose }) {
  const { t } = useUiLanguage();
  return (
    <aside className="telegram-notice" role="status" aria-live="polite">
      <div className="telegram-notice-icon"><Send size={19} strokeWidth={1.8} /></div>
      <div className="telegram-notice-copy">
        <strong>{t('Читавук в Telegram', 'Čitavuk on Telegram')}</strong>
        <p>{t('Следите за обновлениями сайта и находите новые материалы для изучения сербского и хорватского.', 'Follow site updates and discover new materials for learning Serbian and Croatian.', 'Pratite novosti na sajtu i pronađite nove materijale za učenje srpskog i hrvatskog jezika.')}</p>
        <a href="https://t.me/citavuk" target="_blank" rel="noreferrer">{t('Открыть канал', 'Open the channel')} <ChevronRight size={14} /></a>
      </div>
      <button type="button" onClick={onClose} aria-label={t('Закрыть сообщение о Telegram-канале', 'Close Telegram notice')}><X size={16} /></button>
      <span className="telegram-notice-timer" aria-hidden="true" />
    </aside>
  );
}

export default function App() {
  const [locale, setLocaleState] = useState(initialLocale);
  const [projects, setProjects] = useState(loadProjects);
  const [activeId, setActiveId] = useState(null);
  const [page, setPage] = useState(() => readBrowserRoute().page);
  const [publicVideoSlug, setPublicVideoSlug] = useState(() => readBrowserRoute().videoSlug);
  const [locationKey, setLocationKey] = useState(() => `${window.location.pathname}${window.location.search}`);
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(shouldShowWelcome);
  const [supportOpen, setSupportOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [processing, setProcessing] = useState(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState(null);
  const [transcriptionError, setTranscriptionError] = useState('');
  const [toast, setToast] = useState('');
  const [telegramNoticeOpen, setTelegramNoticeOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => (
    'Notification' in window && Notification.permission === 'granted'
  ));
  const activeProject = projects.find((project) => project.id === activeId);

  const setLocale = (nextLocale) => {
    if (!['en', 'ru', 'sr'].includes(nextLocale)) return;
    localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
    setLocaleState(nextLocale);
  };

  useEffect(() => {
    if (hasExplicitLocale()) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    fetch(apiUrl('/api/locale'), { signal: controller.signal, cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('locale lookup failed')))
      .then((payload) => {
        if (!cancelled && ['en', 'ru', 'sr'].includes(payload.locale)) setLocaleState(payload.locale);
      })
      .catch(() => {
        if (cancelled) return;
        const browserLanguage = String(navigator.language || '').toLowerCase();
        setLocaleState(/^(sr|hr|bs)/.test(browserLanguage) ? 'sr' : browserLanguage.startsWith('ru') ? 'ru' : 'en');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    const url = new URL(window.location.href);
    url.searchParams.delete('lang');
    const logicalPath = `${splitLocalizedPath(url.pathname).routePath}${url.search}${url.hash}`;
    window.history.replaceState({}, '', localizedSitePath(logicalPath, locale));
    setLocationKey(`${window.location.pathname}${window.location.search}`);
  }, [locale]);

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (welcomeOpen) return undefined;
    const lastShownAt = Number(localStorage.getItem(TELEGRAM_NOTICE_STORAGE_KEY) || 0);
    if (Date.now() - lastShownAt < TELEGRAM_NOTICE_INTERVAL) return undefined;
    const showTimer = setTimeout(() => {
      localStorage.setItem(TELEGRAM_NOTICE_STORAGE_KEY, String(Date.now()));
      setTelegramNoticeOpen(true);
    }, 700);
    return () => clearTimeout(showTimer);
  }, [welcomeOpen]);

  useEffect(() => {
    if (!telegramNoticeOpen) return undefined;
    const closeTimer = setTimeout(() => setTelegramNoticeOpen(false), 5000);
    return () => clearTimeout(closeTimer);
  }, [telegramNoticeOpen]);

  const notify = (message) => setToast(message);

  const enableNotifications = async () => {
    try {
      const subscription = await ensurePushSubscription(true);
      const enabled = Boolean(subscription);
      setNotificationsEnabled(enabled);
      notify(enabled
        ? (locale === 'en' ? 'Notifications are enabled' : locale === 'sr' ? 'Obaveštenja su uključena' : 'Уведомления включены')
        : (locale === 'en' ? 'Notifications were not enabled' : locale === 'sr' ? 'Obaveštenja nisu uključena' : 'Уведомления не включены'));
    } catch {
      notify(locale === 'en' ? 'The browser could not enable notifications' : locale === 'sr' ? 'Pregledač nije mogao da uključi obaveštenja' : 'Браузер не смог включить уведомления');
    }
  };

  const setCurrentMedia = (file) => {
    setVideoFile(file || null);
    setVideoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  const applyBrowserLocation = () => {
    const route = readBrowserRoute();
    if (route.locale) setLocaleState(route.locale);
    setPage(route.page);
    setPublicVideoSlug(route.videoSlug);
    setLocationKey(`${window.location.pathname}${window.location.search}`);
  };

  const navigate = (href, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', localizedSitePath(href, locale));
    applyBrowserLocation();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const handlePopState = () => {
      setActiveId(null);
      setCurrentMedia(null);
      applyBrowserLocation();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const createProject = async (file, nameOverride) => {
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file.name)) {
      notify('Выберите видеофайл');
      return null;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      notify('Файл больше 2 ГБ');
      return null;
    }
    const id = crypto.randomUUID();
    const project = {
      id,
      name: nameOverride || file.name,
      size: file.size,
      type: file.type || 'video',
      createdAt: Date.now(),
      transcript: [],
      glossary: [],
    };
    setProjects((current) => [project, ...current]);
    setActiveId(id);
    navigate('/');
    setCurrentMedia(file);
    try {
      await saveVideoBlob(id, file);
    } catch {
      notify('Видео открыто, но браузер не смог сохранить его надолго');
    }
    return id;
  };

  const openDemo = () => {
    const existing = projects.find((project) => project.isDemo);
    if (existing) {
      setActiveId(existing.id);
      navigate('/');
      setCurrentMedia(null);
      return;
    }
    const project = {
      id: `demo-${Date.now()}`,
      name: 'Прогулка по Дорчолу.mp4',
      size: 0,
      type: 'video/mp4',
      isDemo: true,
      createdAt: Date.now(),
      transcript: DEMO_SEGMENTS,
      glossary: [
        { id: 'g1', word: 'прошетати', translation: 'прогуляться', translationRu: 'прогуляться', translationEn: 'take a walk', translationStatus: 'ready', translationProvider: 'demo', note: '', time: 4.4 },
        { id: 'g2', word: 'кораку', translation: 'шагу', translationRu: 'шагу', translationEn: 'step', translationStatus: 'ready', translationProvider: 'demo', note: 'на сваком кораку — на каждом шагу', time: 8.8 },
      ],
    };
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    navigate('/');
    setCurrentMedia(null);
  };

  const openProject = async (id) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    setActiveId(id);
    navigate('/');
    if (project.isDemo) return setCurrentMedia(null);
    try {
      const blob = await getVideoBlob(id);
      setCurrentMedia(blob ? new File([blob], project.name, { type: project.type }) : null);
      if (!blob) notify('Исходное видео не найдено в памяти браузера');
    } catch {
      setCurrentMedia(null);
      notify('Не удалось открыть сохранённое видео');
    }
  };

  const deleteProject = async (id) => {
    setProjects((current) => current.filter((project) => project.id !== id));
    await deleteVideoBlob(id).catch(() => {});
    if (activeId === id) {
      setActiveId(null);
      setCurrentMedia(null);
    }
  };

  const updateProject = (patchOrUpdater, id = activeId) => setProjects((current) => current.map((project) => {
    if (project.id !== id) return project;
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(project) : patchOrUpdater;
    return { ...project, ...patch, updatedAt: Date.now() };
  }));

  useEffect(() => {
    let pending;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_TRANSCRIPTION_KEY) || 'null');
    } catch {
      pending = null;
    }
    if (!pending?.jobId || !pending?.projectId) return undefined;
    if (!projects.some((project) => project.id === pending.projectId)) {
      localStorage.removeItem(PENDING_TRANSCRIPTION_KEY);
      return undefined;
    }
    let cancelled = false;
    setProcessing('transcribe');
    setTranscriptionProgress({ percent: 20, stage: locale === 'en' ? 'Restoring the background job' : locale === 'sr' ? 'Obnavljamo pozadinski zadatak' : 'Восстанавливаем фоновую задачу', etaSeconds: null });
    waitForTranscriptionJob(pending.jobId, setTranscriptionProgress)
      .then((payload) => {
        if (cancelled) return;
        const transcript = normalizeTranscription(payload);
        if (!transcript.length) throw new Error(locale === 'en' ? 'No speech was found in the video.' : locale === 'sr' ? 'U videu nije pronađen govor.' : 'Речь в видео не найдена.');
        updateProject({ transcript }, pending.projectId);
        localStorage.removeItem(PENDING_TRANSCRIPTION_KEY);
        notify(locale === 'en' ? `Ready: ${transcript.length} segments` : locale === 'sr' ? `Spremno: ${transcript.length} segmenata` : `Готово: ${transcript.length} фрагментов`);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error.code || error.status === 404) localStorage.removeItem(PENDING_TRANSCRIPTION_KEY);
        setTranscriptionError(error.message);
        notify(error.message);
      })
      .finally(() => {
        if (cancelled) return;
        setProcessing(null);
        setTranscriptionProgress(null);
      });
    return () => { cancelled = true; };
  }, []);

  const transcribe = async (fileOverride, projectId = activeId) => {
    const pushSubscriptionPromise = ensurePushSubscription(true).catch(() => null);
    const target = projects.find((project) => project.id === projectId);
    let file = fileOverride instanceof Blob ? fileOverride : videoFile;
    if (!file && projectId) {
      const blob = await getVideoBlob(projectId).catch(() => null);
      if (blob && target) file = new File([blob], target.name, { type: target.type });
    }
    if (!(file instanceof Blob)) {
      const message = 'Исходное видео не найдено. Загрузите файл заново.';
      setTranscriptionError(message);
      return notify(message);
    }

    if (!API_BASE_URL && window.location.hostname.endsWith('.netlify.app')) {
      const message = 'Для Netlify не указан адрес backend-сервера. Добавьте переменную VITE_API_BASE_URL с адресом Render Web Service и запустите новый deploy.';
      setTranscriptionError(message);
      return notify(message);
    }

    setTranscriptionError('');
    setProcessing('transcribe');
    setTranscriptionProgress({ percent: 0, stage: 'Подготавливаем видео к загрузке', etaSeconds: null });
    try {
      const form = new FormData();
      form.append('video', file, file.name || target?.name || 'video.mp4');
      form.append('projectId', projectId || '');
      form.append('locale', locale);
      const pushSubscription = await pushSubscriptionPromise;
      if (pushSubscription) {
        form.append('pushSubscription', JSON.stringify(pushSubscription.toJSON()));
        setNotificationsEnabled(true);
      }
      const job = await startTranscriptionJob(form, apiKey, setTranscriptionProgress);
      localStorage.setItem(PENDING_TRANSCRIPTION_KEY, JSON.stringify({
        jobId: job.id,
        projectId,
        startedAt: Date.now(),
      }));
      const payload = await waitForTranscriptionJob(job.id, setTranscriptionProgress);
      const transcript = normalizeTranscription(payload);
      if (!transcript.length) throw new Error('Речь не найдена. Проверьте громкость аудиодорожки.');
      setTranscriptionProgress({ percent: 100, stage: 'Субтитры готовы', etaSeconds: 0 });
      updateProject({ transcript }, projectId);
      localStorage.removeItem(PENDING_TRANSCRIPTION_KEY);
      notify(locale === 'en' ? `Ready: ${transcript.length} segments` : locale === 'sr' ? `Spremno: ${transcript.length} segmenata` : `Готово: ${transcript.length} фрагментов`);
      await wait(700);
    } catch (error) {
      if (error.code || error.status === 404) localStorage.removeItem(PENDING_TRANSCRIPTION_KEY);
      if (error.status === 401 || error.code === 'MISSING_API_KEY') setSettingsOpen(true);
      setTranscriptionError(error.message);
      notify(error.message);
    } finally {
      setProcessing(null);
      setTranscriptionProgress(null);
    }
  };

  const importFromYoutube = async (url) => {
    if (!API_BASE_URL && window.location.hostname.endsWith('.netlify.app')) {
      const message = 'Для Netlify не указан адрес backend-сервера. Добавьте переменную VITE_API_BASE_URL с адресом Render Web Service и запустите новый deploy.';
      notify(message);
      return;
    }
    setTranscriptionError('');
    setProcessing('youtube');
    setTranscriptionProgress({ percent: 0, stage: 'Скачиваем видео с YouTube на сервер', etaSeconds: null });
    let downloaded;
    try {
      downloaded = await downloadYoutubeVideo(url, setTranscriptionProgress);
    } catch (error) {
      setProcessing(null);
      setTranscriptionProgress(null);
      setTranscriptionError(error.message);
      notify(error.message);
      return;
    }
    setProcessing(null);
    setTranscriptionProgress(null);
    const file = new File([downloaded.blob], downloaded.filename, { type: downloaded.blob.type || 'video/mp4' });
    const id = await createProject(file, downloaded.title);
    if (!id) return;
    await transcribe(file, id);
  };

  const burnVideo = async (currentFile) => {
    let file = currentFile;
    if (!file) {
      const blob = await getVideoBlob(activeId).catch(() => null);
      if (blob) file = new File([blob], activeProject.name, { type: activeProject.type });
    }
    if (!file) return notify('Исходное видео не найдено');

    setProcessing('burn');
    setTranscriptionProgress({ percent: 0, stage: 'Подготавливаем видео к загрузке', etaSeconds: null });
    try {
      const form = new FormData();
      form.append('video', file, file.name);
      form.append('subtitles', new Blob([makeSrt(activeProject.transcript)], { type: 'application/x-subrip' }), 'subtitles.srt');
      const job = await startBurnJob(form, setTranscriptionProgress);
      await waitForBurnJob(job.id, setTranscriptionProgress);
      const blob = await downloadBurnedVideo(job.id, setTranscriptionProgress);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${fileStem(activeProject.name)}-sa-titlovima.mp4`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify('MP4 с субтитрами готов');
    } catch (error) {
      notify(error.message);
    } finally {
      setProcessing(null);
      setTranscriptionProgress(null);
    }
  };

  const openPublish = () => {
    if (activeProject?.isDemo) return notify('Пример проекта нельзя публиковать');
    if (!activeProject?.transcript?.length) return notify('Сначала создайте субтитры');
    setPublishOpen(true);
  };

  const publishVideo = async ({ title, category, description, rightsConfirmed }) => {
    if (!rightsConfirmed) return notify('Подтвердите право на публичное размещение видео');
    let file = videoFile;
    if (!file && activeId) {
      const blob = await getVideoBlob(activeId).catch(() => null);
      if (blob) file = new File([blob], activeProject.name, { type: activeProject.type });
    }
    if (!file) return notify('Исходное видео не найдено в памяти браузера');
    if (!API_BASE_URL && window.location.hostname.endsWith('.netlify.app')) return notify('Сначала подключите Render через VITE_API_BASE_URL в Netlify');

    setProcessing('publish');
    setTranscriptionProgress({ percent: 1, stage: 'Готовим публикацию', etaSeconds: null });
    try {
      const payload = await publishVideoInChunks(file, {
        title,
        category,
        description,
        rightsConfirmed,
        transcript: activeProject.transcript,
      }, setTranscriptionProgress);
      setPublishOpen(false);
      setLibraryRefresh((value) => value + 1);
      setActiveId(null);
      setCurrentMedia(null);
      navigate(`/subtitles/${payload.slug}`);
      notify('Видео анонимно опубликовано в общей библиотеке');
    } catch (error) {
      notify(error.message);
    } finally {
      setProcessing(null);
      setTranscriptionProgress(null);
    }
  };

  const saveKey = (key) => {
    setApiKey(key);
    if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
    navigator.storage?.persist?.().catch(() => {});
    setSettingsOpen(false);
    setWelcomeOpen(false);
    sessionStorage.setItem('recnik-welcome-seen', '1');
    localStorage.setItem(WELCOME_STORAGE_KEY, '1');
    notify(key
      ? (locale === 'en' ? 'Your Groq key is active' : locale === 'sr' ? 'Koristi se vaš Groq ključ' : 'Используется ваш ключ Groq')
      : (locale === 'en' ? 'The shared server is active' : locale === 'sr' ? 'Koristi se zajednički server' : 'Используется общий сервер'));
  };

  const closeWelcome = () => {
    setWelcomeOpen(false);
    sessionStorage.setItem('recnik-welcome-seen', '1');
    localStorage.setItem(WELCOME_STORAGE_KEY, '1');
  };

  const goHome = () => {
    setActiveId(null);
    setCurrentMedia(null);
    navigate('/');
  };

  const openLibrary = () => {
    setActiveId(null);
    setCurrentMedia(null);
    navigate('/subtitles');
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale }}>
    <div className="app-shell">
      <Header
        inProject={Boolean(activeProject)}
        inLibrary={page === 'library'}
        onHome={goHome}
        onLibrary={openLibrary}
        onNotifications={enableNotifications}
        notificationsEnabled={notificationsEnabled}
        onSettings={() => setSettingsOpen(true)}
      />
      {activeProject ? (
        <Workspace
          project={activeProject}
          videoUrl={videoUrl}
          videoFile={videoFile}
          apiKey={apiKey}
          onBack={goHome}
          onUpdate={updateProject}
          onTranscribe={transcribe}
          onBurn={burnVideo}
          onPublish={openPublish}
          processing={processing}
          notify={notify}
          transcriptionError={transcriptionError}
          onDismissError={() => setTranscriptionError('')}
        />
      ) : page === 'library' ? (
        <PublicLibrary refreshToken={libraryRefresh} notify={notify} videoSlug={publicVideoSlug} locationKey={locationKey} onNavigate={navigate} />
      ) : (
        <Landing
          projects={projects}
          onFile={createProject}
          onDemo={openDemo}
          onOpen={openProject}
          onDelete={deleteProject}
          onYoutubeImport={importFromYoutube}
          youtubeBusy={processing === 'youtube'}
        />
      )}
      <footer>
        <span>{locale === 'en' ? 'ČITAVUK DICTIONARY, 2026' : locale === 'sr' ? 'ČITAVUK-REČNIK, 2026' : 'ЧИТАВУК-РЕЧНИК, 2026'}</span>
        <span>{locale === 'en' ? 'Created by Denis Kornilov with Gpt Sol 5.6' : locale === 'sr' ? 'Autor sajta: Denis Kornilov uz Gpt Sol 5.6' : 'Автор сайта: Денис Корнилов (вместе с Gpt Sol 5.6)'}</span>
        <nav aria-label={locale === 'en' ? 'Footer navigation' : locale === 'sr' ? 'Navigacija u podnožju' : 'Навигация в подвале'}><a href={localizedSitePath('/', locale)} onClick={(event) => { event.preventDefault(); goHome(); }}>{locale === 'en' ? 'Create subtitles' : locale === 'sr' ? 'Napravi titlove' : 'Создать субтитры'}</a><a href={localizedSitePath('/subtitles', locale)} onClick={(event) => { event.preventDefault(); openLibrary(); }}>{locale === 'en' ? 'Library' : locale === 'sr' ? 'Biblioteka' : 'Библиотека'}</a><a href="/sitemap.xml">{locale === 'en' ? 'Sitemap' : locale === 'sr' ? 'Mapa sajta' : 'Карта сайта'}</a></nav>
        <a href="https://t.me/ivanlindgren" target="_blank" rel="noreferrer">{locale === 'en' ? 'Questions: @ivanlindgren' : locale === 'sr' ? 'Pitanja: @ivanlindgren' : 'По вопросам: @ivanlindgren'}</a>
        <button onClick={() => setWelcomeOpen(true)}><CircleHelp size={14} /> {locale === 'en' ? 'How it works' : locale === 'sr' ? 'Kako radi' : 'Как это работает'}</button>
        <button onClick={() => setSupportOpen(true)}><LifeBuoy size={14} /> {locale === 'en' ? 'Technical support' : locale === 'sr' ? 'Tehnička podrška' : 'Техническая поддержка'}</button>
      </footer>
      <button className="support-fab" type="button" onClick={() => setSupportOpen(true)} aria-label={locale === 'en' ? 'Open technical support' : locale === 'sr' ? 'Otvorite tehničku podršku' : 'Открыть техническую поддержку'}>
        <LifeBuoy size={19} />
        <span>{locale === 'en' ? 'Support' : locale === 'sr' ? 'Podrška' : 'Поддержка'}</span>
      </button>
      {settingsOpen && <SettingsModal value={apiKey} onSave={saveKey} onClose={() => setSettingsOpen(false)} />}
      {welcomeOpen && <WelcomeModal onClose={closeWelcome} />}
      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} notify={notify} />}
      {publishOpen && activeProject && <PublishModal project={activeProject} processing={processing} onSubmit={publishVideo} onClose={() => setPublishOpen(false)} />}
      <ProcessingBanner kind={processing} progress={transcriptionProgress} />
      {telegramNoticeOpen && <TelegramNotice onClose={() => setTelegramNoticeOpen(false)} />}
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
    </LanguageContext.Provider>
  );
}
