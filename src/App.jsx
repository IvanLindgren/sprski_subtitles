import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
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
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Plus,
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
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const PUBLIC_UPLOAD_CONCURRENCY = 3;
const TELEGRAM_NOTICE_STORAGE_KEY = 'citavuk-telegram-notice-seen-at';
const TELEGRAM_NOTICE_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_TITLE = 'Сербские субтитры для видео онлайн — Читавук-речник';
const DEFAULT_PAGE_DESCRIPTION = 'Онлайн-сервис создаёт сербские субтитры из видео на русском, английском и других языках, экспортирует SRT, VTT и MP4 и помогает собирать личный словарь.';

function readBrowserRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const videoMatch = pathname.match(/^\/subtitles\/([a-z0-9-]+)$/i);
  if (videoMatch) return { page: 'library', videoSlug: videoMatch[1] };
  if (pathname === '/subtitles' || pathname === '/library') return { page: 'library', videoSlug: null };
  return { page: 'landing', videoSlug: null };
}

function PageMetadata({ title = DEFAULT_PAGE_TITLE, description = DEFAULT_PAGE_DESCRIPTION, path = '/' }) {
  useEffect(() => {
    document.title = title;
    const descriptionTag = document.querySelector('meta[name="description"]');
    if (descriptionTag) descriptionTag.setAttribute('content', description);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', `https://serbiansubtitles.online${path}`);
    document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((link) => link.setAttribute('href', `https://serbiansubtitles.online${path}`));
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDescription = document.querySelector('meta[property="og:description"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogTitle) ogTitle.setAttribute('content', title);
    if (ogDescription) ogDescription.setAttribute('content', description);
    if (ogUrl) ogUrl.setAttribute('content', `https://serbiansubtitles.online${path}`);
  }, [description, path, title]);
  return null;
}

function apiUrl(pathname) {
  return `${API_BASE_URL}${pathname}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function waitForTranscriptionJob(id, onProgress) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let failedPolls = 0;
  while (Date.now() < deadline) {
    await wait(1000);
    try {
      const response = await fetch(apiUrl(`/api/transcribe/jobs/${id}`), { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Не удалось получить состояние задачи: ${response.status}.`);
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

function Header({ inProject, inLibrary, onHome, onLibrary, onSettings }) {
  const follow = (event, action) => {
    event.preventDefault();
    action();
  };
  return (
    <header className="site-header">
      <a className="brand" href="/" onClick={(event) => follow(event, onHome)} aria-label="На главную">
        <BrandMark />
        <span className="brand-copy"><strong>ЧИТАВУК-РЕЧНИК</strong><small>сербские субтитры и видеословарь</small></span>
      </a>
      <div className="header-actions">
        <nav className="site-nav" aria-label="Основная навигация">
          <a className={!inLibrary ? 'is-active' : ''} href="/" onClick={(event) => follow(event, onHome)}><Upload size={17} /><span>{inProject ? 'Мои видео' : 'Создать субтитры'}</span></a>
          <a className={inLibrary ? 'is-active' : ''} href="/subtitles" onClick={(event) => follow(event, onLibrary)}><Globe2 size={17} /><span>Библиотека</span></a>
        </nav>
        <button className="icon-button" onClick={onSettings} aria-label="Настройки API">
          <Settings2 size={20} />
        </button>
      </div>
    </header>
  );
}

function UploadZone({ onFile }) {
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
      <strong>Перетащите видео сюда</strong>
      <span>или нажмите, чтобы выбрать файл</span>
      <p className="upload-formats">Поддерживаются MP4, MOV, WEBM и MKV. Максимальный размер исходного видео составляет 2 ГБ.</p>
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
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [message, setMessage] = useState('');

  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    const normalizedUrl = parseYoutubeUrlClient(youtubeUrl);
    if (!normalizedUrl) {
      setMessage('Вставьте полную ссылку youtube.com или youtu.be.');
      return;
    }
    setMessage('');
    onImport(normalizedUrl);
  };

  const openSaveFrom = () => {
    const normalizedUrl = parseYoutubeUrlClient(youtubeUrl);
    if (!normalizedUrl) {
      setMessage('Вставьте полную ссылку youtube.com или youtu.be.');
      return;
    }
    navigator.clipboard?.writeText(normalizedUrl).catch(() => {});
    window.open(`https://ru.savefrom.net/153kn/sf?url=${encodeURIComponent(normalizedUrl)}`, '_blank', 'noopener,noreferrer');
    setMessage('Ссылка скопирована. Скачайте MP4 в SaveFrom и загрузите файл выше.');
  };

  return (
    <div className="youtube-download">
      <div className="youtube-download-title"><Play size={18} fill="currentColor" /><strong>Взять видео с YouTube</strong></div>
      <p>Вставьте ссылку — Читавук сам скачает ролик и начнёт распознавание. Используйте только видео, которое вам разрешено скачивать.</p>
      <form onSubmit={submit} noValidate>
        <input
          type="url"
          value={youtubeUrl}
          onChange={(event) => { setYoutubeUrl(event.target.value); setMessage(''); }}
          placeholder="https://youtu.be/…"
          aria-label="Ссылка на видео YouTube"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>{busy ? 'Скачиваем…' : 'Скачать и распознать'}</button>
      </form>
      <button type="button" className="youtube-download-fallback" onClick={openSaveFrom} disabled={busy}>
        Не получилось? Скачать вручную через SaveFrom
      </button>
      {message && <span className="youtube-download-message">{message}</span>}
    </div>
  );
}

function RecentProject({ project, onOpen, onDelete }) {
  return (
    <article className="recent-card" onClick={() => onOpen(project.id)}>
      <div className="recent-thumb">
        <Film size={22} />
        <span>{project.transcript?.length ? 'SR' : '—'}</span>
      </div>
      <div className="recent-copy">
        <strong>{project.name}</strong>
        <span>{project.transcript?.length || 0} {pluralizeRu(project.transcript?.length || 0, 'фрагмент', 'фрагмента', 'фрагментов')}, {project.glossary?.length || 0} {pluralizeRu(project.glossary?.length || 0, 'слово', 'слова', 'слов')} в словаре</span>
      </div>
      <button
        className="subtle-icon"
        onClick={(event) => { event.stopPropagation(); onDelete(project.id); }}
        aria-label="Удалить проект"
      >
        <Trash2 size={16} />
      </button>
      <ChevronRight size={18} className="recent-arrow" />
    </article>
  );
}

function Landing({ onFile, onDemo, projects, onOpen, onDelete, onYoutubeImport, youtubeBusy }) {
  return (
    <main className="landing">
      <PageMetadata />
      <div className="side-ornament side-ornament--left"><PatternBand vertical /></div>
      <div className="side-ornament side-ornament--right"><PatternBand vertical /></div>

      <section className="hero">
        <div className="hero-copy">
          <h1>Сервис для создания сербских субтитров к видео на любом языке.</h1>
          <p>Загрузите сербский, английский, русский или другой ролик, получите синхронный сербский текст и собирайте личный словарь прямо во время просмотра.</p>
          <div className="hero-limits">
            <p>Сайт по умолчанию использует общий ключ Groq с сервера. Свой ключ можно добавить в настройках только при желании.</p>
          </div>
          <img className="hero-wolf" src="/assets/citavuk-guide.webp" alt="Читавук помогает разобраться с субтитрами" />
        </div>

        <div className="upload-card">
          <div className="card-title">
            <div><span>НОВОЕ ВИДЕО</span><h2>Начать разбор</h2></div>
            <div className="free-seal"><Sparkles size={14} /> FREE</div>
          </div>
          <UploadZone onFile={onFile} />
          <YoutubeDownload onImport={onYoutubeImport} busy={youtubeBusy} />
          <button className="demo-link" onClick={onDemo}><Play size={14} fill="currentColor" /> Открыть пример проекта</button>
          <div className="privacy-note"><KeyRound size={15} /> Видео остается в памяти вашего браузера</div>
        </div>
      </section>

      <PatternBand />

      <section className="process-story">
        <BookOpen size={25} />
        <p>Читавук определяет язык речи, переводит текст на сербский, синхронизирует его с видео и делает каждое слово интерактивным. Во время просмотра незнакомое слово можно добавить в личный словарь, а готовый результат сохранить как VTT, SRT или MP4 со встроенными субтитрами.</p>
      </section>

      <section className="seo-explainer" aria-labelledby="seo-explainer-title">
        <div className="section-heading"><div><span>КАК ЭТО РАБОТАЕТ</span><h2 id="seo-explainer-title">Сербские субтитры без ручной разметки</h2></div></div>
        <div className="seo-explainer-grid">
          <article><h3>Загрузите видео</h3><p>Подойдут MP4, MOV, WEBM, MKV и другие распространённые форматы с русской, английской, сербской или другой речью.</p></article>
          <article><h3>Получите сербский текст</h3><p>Сервис распознаёт речь, переводит реплики на естественный сербский язык и синхронизирует каждую фразу с видео.</p></article>
          <article><h3>Смотрите или скачивайте</h3><p>Используйте субтитры в плеере, сохраняйте SRT и VTT, создавайте MP4 или публикуйте разрешённое видео в открытой библиотеке.</p></article>
        </div>
      </section>

      {projects.length > 0 && (
        <section className="recent-section" id="my-videos">
          <div className="section-heading"><div><span>ВАША ПОЛКА</span><h2>Недавние видео</h2></div><small>{projects.length} {pluralizeRu(projects.length, 'проект', 'проекта', 'проектов')}</small></div>
          <div className="recent-list">
            {projects.slice(0, 4).map((project) => <RecentProject key={project.id} project={project} onOpen={onOpen} onDelete={onDelete} />)}
          </div>
        </section>
      )}
    </main>
  );
}

function DemoPlayer({ currentTime, onTime, activeSegment }) {
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
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>
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
  return (
    <section className="video-column">
      <div className="project-kicker"><span>РАЗБОР ВИДЕО</span><small>{project.isDemo ? 'пример проекта' : `${formatBytes(project.size)}, ${project.type || 'видео'}`}</small></div>
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
          <div className="missing-video"><Film size={32} /><strong>Исходное видео не найдено</strong><span>Загрузите файл заново, чтобы продолжить.</span></div>
        )}
      </div>
      {!project.transcript?.length && (
        <div className="transcribe-callout">
          <div className="callout-icon"><WandSparkles size={22} /></div>
          <div><strong>Видео готово к распознаванию</strong><span>Читавук определит исходный язык, создаст сербские субтитры и сохранит точные таймкоды.</span></div>
          <button className="primary-button" onClick={() => onTranscribe()} disabled={Boolean(processing)}>
            {processing === 'transcribe' ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={17} />}
            {processing === 'transcribe' ? 'Слушаем речь…' : 'Создать субтитры'}
          </button>
        </div>
      )}
      {transcriptionError && (
        <div className="transcription-error" role="alert">
          <p>{transcriptionError}</p>
          <button onClick={onDismissError} aria-label="Закрыть сообщение об ошибке"><X size={16} /></button>
        </div>
      )}
    </section>
  );
}

function WordToken({ value, added, onAdd }) {
  const cleaned = cleanWord(value);
  if (!cleaned) return <>{value} </>;
  const leading = value.match(/^[^\p{L}]+/u)?.[0] || '';
  const trailing = value.match(/[^\p{L}]+$/u)?.[0] || '';
  const token = value.slice(leading.length, trailing ? -trailing.length : undefined);
  return (
    <>
      {leading}
      <button className={`word-token ${added ? 'is-saved' : ''}`} onClick={() => onAdd(cleaned)} title={added ? 'Уже в словаре' : 'Добавить в словарь'}>
        {token}
      </button>
      {trailing}{' '}
    </>
  );
}

function TranscriptPanel({ project, currentTime, onSeek, onAddWord, search, onSearch, onDownloadVtt, onDownloadSrt, onRetranscribe, onPublish, processing }) {
  const transcript = project.transcript || [];
  const saved = useMemo(() => new Set((project.glossary || []).map((item) => item.word)), [project.glossary]);
  const visible = transcript.filter((segment) => segment.text.toLocaleLowerCase('sr').includes(search.toLocaleLowerCase('sr')));

  return (
    <section className="transcript-panel">
      <div className="panel-header">
        <div><span className="panel-eyebrow">ТРАНСКРИПТ</span><h2>Текст видео</h2></div>
        {transcript.length > 0 && (
          <div className="panel-actions">
            <button className="publish-action" onClick={onPublish} disabled={processing === 'publish'} title="Опубликовать анонимно"><Globe2 size={15} /> Опубликовать</button>
            <button onClick={() => onRetranscribe()} disabled={processing === 'transcribe'} title="Распознать заново"><Sparkles size={15} /> Повторить</button>
            <button onClick={onDownloadVtt}><Download size={15} /> VTT</button>
            <button onClick={onDownloadSrt}><Download size={15} /> SRT</button>
          </div>
        )}
      </div>
      {transcript.length > 0 ? (
        <>
          <div className="transcript-tools">
            <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Найти в тексте…" /></div>
            <span><span className="click-dot" /> Нажмите на слово, чтобы перевести и сохранить</span>
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
            {!visible.length && <div className="empty-search">Ничего не найдено по запросу «{search}»</div>}
          </div>
        </>
      ) : (
        <div className="empty-transcript">
          <div><FileText size={29} /></div>
          <strong>Здесь появится текст</strong>
          <p>После распознавания фразы синхронизируются с видео. Каждое слово станет интерактивным.</p>
        </div>
      )}
    </section>
  );
}

function GlossaryPanel({ project, onChangeItem, onRemove, onSeek, onBurn, processing }) {
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
        <div><span>ЛИЧНЫЙ СЛОВАРЬ</span><h2>Читавук-речник <b>{project.glossary?.length || 0}</b></h2></div>
      </div>
      {(project.glossary?.length || 0) > 0 && (
        <div className="glossary-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти слово…" /></div>
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
                <div className="word-translation-status"><LoaderCircle size={13} className="spin" /> Подбираем русский и английский переводы…</div>
              )}
              {item.translationStatus === 'error' && (
                <div className="word-translation-status is-error">Перевод временно недоступен. Нажмите на слово ещё раз.</div>
              )}
              <label className="word-translation-field">
                <span>РУССКИЙ</span>
                <input
                  value={item.translationRu || item.translation || ''}
                  onChange={(event) => onChangeItem(item.id, { translationRu: event.target.value, translation: event.target.value })}
                  placeholder="Русский перевод"
                  aria-label={`Русский перевод слова ${item.word}`}
                />
              </label>
              <label className="word-translation-field">
                <span>ENGLISH</span>
                <input
                  value={item.translationEn || ''}
                  onChange={(event) => onChangeItem(item.id, { translationEn: event.target.value })}
                  placeholder="English translation"
                  aria-label={`Английский перевод слова ${item.word}`}
                />
              </label>
              <textarea
                value={item.note || ''}
                onChange={(event) => onChangeItem(item.id, { note: event.target.value })}
                placeholder="Заметка или пример"
                rows={1}
              />
            </div>
            <button className="remove-word" onClick={() => onRemove(item.id)} aria-label={`Удалить ${item.word}`}><X size={15} /></button>
          </article>
        ))}
        {!glossary.length && (
          <div className="empty-glossary">
            <div className="empty-book"><BookOpen size={27} /><Plus size={14} /></div>
            <strong>{query ? 'Слово не найдено' : 'Словарь пока пуст'}</strong>
            <p>{query ? 'Попробуйте другой запрос.' : 'Нажимайте на незнакомые слова в тексте — здесь появятся русский и английский переводы.'}</p>
          </div>
        )}
      </div>
      <div className="glossary-footer">
        <button className="burn-button" onClick={onBurn} disabled={!project.transcript?.length || processing === 'burn' || project.isDemo}>
          {processing === 'burn' ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
          <span><strong>{processing === 'burn' ? 'Собираем MP4…' : 'MP4 с субтитрами'}</strong><small>{project.isDemo ? 'недоступно в демо' : 'титры вшиты в видео'}</small></span>
        </button>
      </div>
    </aside>
  );
}

function Workspace({ project, videoUrl, videoFile, apiKey, onBack, onUpdate, onTranscribe, onBurn, onPublish, processing, notify, transcriptionError, onDismissError }) {
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
        <button onClick={onBack}><ArrowLeft size={17} /> К проектам</button>
        <div className="project-title"><span className="status-dot" /><strong>{project.name}</strong><span>сохранено локально</span></div>
        <div className="project-meta"><Gauge size={15} /><span>{project.transcript?.length ? `${project.transcript.length} фрагментов` : 'ожидает обработки'}</span></div>
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
    const pageDescription = selected.description || `${selected.title} — видео с синхронными сербскими субтитрами и текстом реплик.`;
    const shortTitle = selected.title.length > 58 ? `${selected.title.slice(0, 57).trim()}…` : selected.title;
    return (
      <main className="public-library public-viewer">
        <PageMetadata title={`${shortTitle} — сербские субтитры`} description={pageDescription} path={pagePath} />
        <div className="library-heading">
          <nav className="breadcrumbs" aria-label="Хлебные крошки"><a href="/" onClick={(event) => follow(event, '/')}>Главная</a><span>›</span><a href="/subtitles" onClick={(event) => follow(event, '/subtitles')}>Библиотека</a><span>›</span><strong>{selected.title}</strong></nav>
          <a className="library-back" href="/subtitles" onClick={(event) => follow(event, '/subtitles')}><ArrowLeft size={17} /> Ко всем публикациям</a>
          <span className="category-badge"><Tag size={13} /> {selected.category}</span>
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
            <div className="public-transcript-heading"><span>СЕРБСКИЕ СУБТИТРЫ</span><h2>Текст видео</h2></div>
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
      <PageMetadata title={`${category !== 'все' ? `${category[0].toLocaleUpperCase('ru')}${category.slice(1)} с сербскими субтитрами` : 'Видео с сербскими субтитрами — публичная библиотека'}${currentPage > 1 ? ` — страница ${currentPage}` : ''}`} description="Публичная библиотека фильмов, мультфильмов, блогов и учебных видео с синхронными сербскими субтитрами и текстом реплик." path={libraryHref(currentPage, category)} />
      <PatternBand />
      <section className="library-intro">
        <div>
          <span className="panel-eyebrow">АНОНИМНЫЕ ПУБЛИКАЦИИ</span>
          <h1>Сербское видео с готовыми субтитрами</h1>
          <p>Здесь собраны видео, которыми пользователи решили поделиться после распознавания речи. Имя автора не запрашивается и не публикуется, а категория помогает быстро найти фильм, мультфильм, блог или учебный материал.</p>
        </div>
        <img src="/assets/citavuk-guide.webp" alt="Читавук показывает публичную библиотеку" />
      </section>
      <nav className="category-filter" aria-label="Фильтр по категории">
        {PUBLIC_CATEGORIES.map((item) => <a href={libraryHref(1, item)} key={item} className={category === item ? 'is-active' : ''} onClick={(event) => follow(event, libraryHref(1, item))}>{item}</a>)}
      </nav>
      {loading && <div className="library-state"><LoaderCircle className="spin" size={24} /><p>Читавук открывает библиотеку…</p></div>}
      {!loading && error && <div className="library-state library-state--error"><Globe2 size={28} /><p>{error}</p></div>}
      {!loading && !error && !configured && <div className="library-state"><Globe2 size={28} /><p>Публичное хранилище ещё не подключено. После добавления параметров Cloudflare R2 в Render здесь появятся анонимные публикации.</p></div>}
      {!loading && !error && configured && visibleItems.length === 0 && <div className="library-state"><Film size={28} /><p>{category === 'все' ? 'Пока здесь нет видео. Первую публикацию можно создать из проекта с готовыми субтитрами.' : `В категории «${category}» пока нет видео.`}</p></div>}
      {!loading && !error && visibleItems.length > 0 && (
        <section className="publication-grid">
          {visibleItems.map((item) => (
            <a className="publication-card" href={`/subtitles/${item.slug}`} key={item.id} onClick={(event) => follow(event, `/subtitles/${item.slug}`)}>
              <div className={`publication-cover ${item.thumbnailUrl ? 'publication-cover--image' : ''}`}>
                {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt={`Кадр из видео «${item.title}»`} loading="lazy" /> : <Film size={32} />}
                <span>{item.category}</span>
              </div>
              <div className="publication-copy">
                <h2>{item.title}</h2>
                <p>{item.description || 'Сербское видео с распознанными субтитрами.'}</p>
                <small>{item.segmentsCount} {pluralizeRu(item.segmentsCount, 'фрагмент', 'фрагмента', 'фрагментов')}, {formatClock(item.duration)}</small>
              </div>
              <ChevronRight size={19} />
            </a>
          ))}
        </section>
      )}
      {!loading && !error && totalItems > 0 && (
        <nav className="pagination" aria-label="Страницы библиотеки">
          <a className={currentPage <= 1 ? 'is-disabled' : ''} href={libraryHref(Math.max(1, currentPage - 1))} onClick={(event) => currentPage > 1 && follow(event, libraryHref(currentPage - 1))}>Назад</a>
          <span>Страница {currentPage} из {totalPages}</span>
          <div>
            {Array.from({ length: totalPages }, (_, index) => index + 1).slice(Math.max(0, currentPage - 3), Math.max(5, currentPage + 2)).map((page) => (
              <a key={page} className={page === currentPage ? 'is-active' : ''} href={libraryHref(page)} onClick={(event) => follow(event, libraryHref(page))}>{page}</a>
            ))}
          </div>
          <a className={currentPage >= totalPages ? 'is-disabled' : ''} href={libraryHref(Math.min(totalPages, currentPage + 1))} onClick={(event) => currentPage < totalPages && follow(event, libraryHref(currentPage + 1))}>Дальше</a>
        </nav>
      )}
    </main>
  );
}

function PublishModal({ project, processing, onSubmit, onClose }) {
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
        <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть публикацию"><X size={20} /></button>
        <div className="modal-icon"><Globe2 size={24} /></div>
        <span className="modal-kicker">ПУБЛИЧНАЯ БИБЛИОТЕКА</span>
        <h2>Опубликовать анонимно</h2>
        <p>Видео и уже распознанные сербские субтитры станут доступны всем посетителям. Имя, ключ Groq и данные личного словаря не передаются и не публикуются.</p>
        <label>НАЗВАНИЕ
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required />
        </label>
        <label>КАТЕГОРИЯ
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {PUBLIC_CATEGORIES.slice(1).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>ОПИСАНИЕ
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} rows={3} placeholder="Коротко расскажите, что находится в видео" />
        </label>
        <label className="rights-confirmation">
          <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
          <span><ShieldCheck size={18} /> Я подтверждаю, что имею право публично разместить это видео и понимаю, что публикация будет доступна по всему интернету.</span>
        </label>
        <button className="primary-button publish-submit" disabled={processing === 'publish' || !rightsConfirmed || title.trim().length < 2}>
          {processing === 'publish' ? <LoaderCircle className="spin" size={18} /> : <Globe2 size={18} />}
          {processing === 'publish' ? 'Загружаем публикацию…' : 'Опубликовать видео'}
        </button>
      </form>
    </div>
  );
}

function SettingsModal({ value, onSave, onClose }) {
  const [key, setKey] = useState(value);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть настройки"><X size={20} /></button>
        <div className="modal-icon"><KeyRound size={24} /></div>
        <span className="modal-kicker">НЕОБЯЗАТЕЛЬНО</span>
        <h2>Свой ключ Groq API</h2>
        <p>По умолчанию сайт уже использует общий ключ Groq с сервера. Личный ключ нужен только если вы хотите пользоваться собственными лимитами.</p>
        <p className="key-guide-copy">Чтобы подключить свой ключ, откройте Groq Console, нажмите Create API Key и вставьте сюда значение, которое начинается с gsk_. Ключ останется только в локальном хранилище этого браузера.</p>
        <label>ЛИЧНЫЙ GROQ API KEY
          <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Оставьте пустым для общего ключа" autoFocus />
        </label>
        <div className="free-info"><Sparkles size={18} /><p>Если удалить значение из поля и сохранить настройки, сайт снова автоматически переключится на общий ключ.</p></div>
        <div className="modal-actions">
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Получить личный ключ <ChevronRight size={15} /></a>
          <button className="primary-button" onClick={() => onSave(key.trim())}>{key.trim() ? 'Использовать свой ключ' : 'Использовать общий ключ'}</button>
        </div>
      </section>
    </div>
  );
}

function WelcomeModal({ onClose }) {
  return (
    <div className="modal-backdrop welcome-backdrop" onMouseDown={onClose}>
      <section className="welcome-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть инструкцию"><X size={20} /></button>
        <div className="welcome-wolf-wrap">
          <img src="/assets/citavuk-welcome.webp" alt="Читавук приветствует вас" />
        </div>
        <div className="welcome-content">
          <span className="modal-kicker">ПЕРЕД НАЧАЛОМ</span>
          <h2>Познакомьтесь: Читавук</h2>
          <p>Он распознает речь на исходном языке и превратит её в синхронные сербские субтитры.</p>
          <p className="welcome-guide">Сервис уже подключён к общему ключу Groq, поэтому перед началом ничего вводить не нужно. При желании собственный ключ можно добавить позже в настройках.</p>
          <div className="welcome-limits">
            <p>Загрузите видео на любом языке. Читавук определит речь, сохранит таймкоды и переведёт готовые фрагменты на естественный сербский.</p>
          </div>
          <div className="welcome-actions">
            <button className="primary-button" onClick={onClose}>Начать</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function remainingLabel(seconds) {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return `осталось примерно ${Math.max(1, Math.round(seconds))} сек`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `осталось примерно ${minutes} мин ${remainder} сек`;
}

function ProcessingBanner({ kind, progress }) {
  if (!kind) return null;
  const title = kind === 'burn' ? 'Создаём видео с субтитрами' : kind === 'publish' ? 'Публикуем видео анонимно' : kind === 'youtube' ? 'Скачиваем видео с YouTube' : 'Готовим сербские субтитры';
  const copy = kind === 'burn' ? 'Это может занять несколько минут…' : kind === 'publish' ? 'Передаём видео и готовые субтитры в публичное хранилище…' : kind === 'youtube' ? 'Загружаем ролик на сервер и передаём его в браузер…' : 'Извлекаем звук и расставляем таймкоды…';
  if ((kind === 'transcribe' || kind === 'youtube' || kind === 'publish') && progress) {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    const remaining = remainingLabel(progress.etaSeconds);
    return (
      <div className="processing-banner processing-banner--progress" role="status" aria-live="polite">
        <div className="processing-progress-heading">
          <div><LoaderCircle size={18} className="spin" /><strong>{title}</strong></div>
          <b>{percent}%</b>
        </div>
        <div className="processing-progress-track"><span style={{ width: `${percent}%` }} /></div>
        <div className="processing-progress-copy">
          <span>{progress.stage || copy}</span>
          <small>{remaining || (percent >= 60 && percent < 99 ? 'Groq отвечает дольше обычного, задача продолжает выполняться' : 'оцениваем оставшееся время')}</small>
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
  return (
    <aside className="telegram-notice" role="status" aria-live="polite">
      <div className="telegram-notice-icon"><Send size={19} strokeWidth={1.8} /></div>
      <div className="telegram-notice-copy">
        <strong>Читавук в Telegram</strong>
        <p>Следите за обновлениями сайта и находите новые материалы для изучения сербского и хорватского.</p>
        <a href="https://t.me/citavuk" target="_blank" rel="noreferrer">Открыть канал <ChevronRight size={14} /></a>
      </div>
      <button type="button" onClick={onClose} aria-label="Закрыть сообщение о Telegram-канале"><X size={16} /></button>
      <span className="telegram-notice-timer" aria-hidden="true" />
    </aside>
  );
}

export default function App() {
  const [projects, setProjects] = useState(loadProjects);
  const [activeId, setActiveId] = useState(null);
  const [page, setPage] = useState(() => readBrowserRoute().page);
  const [publicVideoSlug, setPublicVideoSlug] = useState(() => readBrowserRoute().videoSlug);
  const [locationKey, setLocationKey] = useState(() => `${window.location.pathname}${window.location.search}`);
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => sessionStorage.getItem('recnik-welcome-seen') !== '1');
  const [publishOpen, setPublishOpen] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [processing, setProcessing] = useState(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState(null);
  const [transcriptionError, setTranscriptionError] = useState('');
  const [toast, setToast] = useState('');
  const [telegramNoticeOpen, setTelegramNoticeOpen] = useState(false);
  const activeProject = projects.find((project) => project.id === activeId);

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

  const setCurrentMedia = (file) => {
    setVideoFile(file || null);
    setVideoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  const applyBrowserLocation = () => {
    const route = readBrowserRoute();
    setPage(route.page);
    setPublicVideoSlug(route.videoSlug);
    setLocationKey(`${window.location.pathname}${window.location.search}`);
  };

  const navigate = (href, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
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

  const transcribe = async (fileOverride, projectId = activeId) => {
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
      const job = await startTranscriptionJob(form, apiKey, setTranscriptionProgress);
      const payload = await waitForTranscriptionJob(job.id, setTranscriptionProgress);
      const transcript = normalizeTranscription(payload);
      if (!transcript.length) throw new Error('Речь не найдена. Проверьте громкость аудиодорожки.');
      setTranscriptionProgress({ percent: 100, stage: 'Субтитры готовы', etaSeconds: 0 });
      updateProject({ transcript }, projectId);
      notify(`Готово: ${transcript.length} фрагментов`);
      await wait(700);
    } catch (error) {
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
    try {
      const form = new FormData();
      form.append('video', file, file.name);
      form.append('subtitles', new Blob([makeSrt(activeProject.transcript)], { type: 'application/x-subrip' }), 'subtitles.srt');
      const response = await fetch(apiUrl('/api/burn'), { method: 'POST', body: form });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Не удалось собрать MP4');
      }
      const blob = await response.blob();
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
    notify(key ? 'Используется ваш ключ Groq' : 'Используется общий ключ Groq');
  };

  const closeWelcome = () => {
    setWelcomeOpen(false);
    sessionStorage.setItem('recnik-welcome-seen', '1');
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
    <div className="app-shell">
      <Header inProject={Boolean(activeProject)} inLibrary={page === 'library'} onHome={goHome} onLibrary={openLibrary} onSettings={() => setSettingsOpen(true)} />
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
        <span>ЧИТАВУК-РЕЧНИК, 2026</span>
        <span>Автор сайта: Денис Корнилов (вместе с Gpt Sol 5.6)</span>
        <nav aria-label="Навигация в подвале"><a href="/" onClick={(event) => { event.preventDefault(); goHome(); }}>Создать субтитры</a><a href="/subtitles" onClick={(event) => { event.preventDefault(); openLibrary(); }}>Библиотека</a><a href="/sitemap.xml">Карта сайта</a></nav>
        <a href="https://t.me/ivanlindgren" target="_blank" rel="noreferrer">По вопросам: @ivanlindgren</a>
        <button onClick={() => setWelcomeOpen(true)}><CircleHelp size={14} /> Как это работает</button>
      </footer>
      {settingsOpen && <SettingsModal value={apiKey} onSave={saveKey} onClose={() => setSettingsOpen(false)} />}
      {welcomeOpen && <WelcomeModal onClose={closeWelcome} />}
      {publishOpen && activeProject && <PublishModal project={activeProject} processing={processing} onSubmit={publishVideo} onClose={() => setPublishOpen(false)} />}
      <ProcessingBanner kind={processing} progress={transcriptionProgress} />
      {telegramNoticeOpen && <TelegramNotice onClose={() => setTelegramNoticeOpen(false)} />}
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
  );
}
