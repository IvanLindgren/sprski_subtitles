import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import ytdlpExec from 'yt-dlp-exec';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload as S3Upload } from '@aws-sdk/lib-storage';
import { notifyIndexNow } from './indexnow.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const clientPath = path.join(process.cwd(), 'dist');
const canonicalHost = 'serbiansubtitles.online';
const canonicalAliases = new Set([
  'www.serbiansubtitles.online',
  'serbiansubtitles.ru',
  'www.serbiansubtitles.ru',
]);
const maxVideoBytes = 2 * 1024 * 1024 * 1024;
const publicUploadChunkBytes = 8 * 1024 * 1024;
const publicUploadTtlMs = 6 * 60 * 60 * 1000;
const supabaseSingleObjectBytes = 45 * 1024 * 1024;
const localMediaRoot = path.resolve(process.env.PUBLIC_MEDIA_DIR || path.join(process.cwd(), '.public-media'));
const localUploadRoot = path.join(localMediaRoot, '.uploads');
const managedYtDlpPath = process.env.YOUTUBE_DL_PATH
  || path.join(process.cwd(), '.tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const managedYtDlpAvailable = existsSync(managedYtDlpPath);
const ytdlp = managedYtDlpAvailable ? ytdlpExec.create(managedYtDlpPath) : ytdlpExec;
const youtubePotProviderVersion = '1.3.1';
const requestedPotProviderPort = Number(process.env.YOUTUBE_POT_PROVIDER_PORT || 4416);
const youtubePotProviderPort = Number.isInteger(requestedPotProviderPort) && requestedPotProviderPort > 0
  ? requestedPotProviderPort
  : 4416;
const managedPotProviderEntry = path.join(
  process.cwd(),
  '.tools',
  'bgutil-ytdlp-pot-provider',
  'server',
  'build',
  'main.js',
);
const managedPotProviderServerDir = path.dirname(path.dirname(managedPotProviderEntry));
const managedYtDlpPluginDir = path.join(process.cwd(), '.tools', 'yt-dlp-plugins');
const managedPotPluginArchive = path.join(managedYtDlpPluginDir, 'bgutil-ytdlp-pot-provider.zip');
const externalPotProviderUrl = String(process.env.YOUTUBE_POT_PROVIDER_URL || '').replace(/\/$/, '');
const youtubePotProviderUrl = externalPotProviderUrl || `http://127.0.0.1:${youtubePotProviderPort}`;
const managedPotProviderAvailable = existsSync(managedPotProviderEntry);
const managedPotPluginAvailable = existsSync(managedPotPluginArchive);
const youtubePotProviderConfigured = process.env.YOUTUBE_POT_PROVIDER_ENABLED !== 'false'
  && managedYtDlpAvailable
  && managedPotPluginAvailable
  && Boolean(externalPotProviderUrl || managedPotProviderAvailable);
const youtubePotProviderState = {
  status: youtubePotProviderConfigured ? 'starting' : 'unavailable',
  version: null,
  error: null,
};
let youtubePotProviderProcess = null;
let youtubePotProviderStartPromise = null;
let youtubePotProviderStopping = false;
const publicCategories = new Set(['фильм', 'мультфильм', 'блог', 'интервью', 'новости', 'обучение', 'другое']);
const objectStorage = {
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'auto',
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  publicBaseUrl: String(process.env.PUBLIC_MEDIA_BASE_URL || '').replace(/\/$/, ''),
};
const publicLibraryConfigured = Boolean(
  objectStorage.endpoint
  && objectStorage.bucket
  && objectStorage.accessKeyId
  && objectStorage.secretAccessKey
  && objectStorage.publicBaseUrl,
);
const genericPublicThumbnailUrl = `https://${canonicalHost}/assets/citavuk-guide.webp`;
const objectStorageClient = publicLibraryConfigured ? new S3Client({
  endpoint: objectStorage.endpoint,
  region: objectStorage.region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: objectStorage.accessKeyId,
    secretAccessKey: objectStorage.secretAccessKey,
  },
}) : null;
const publicationAttempts = new Map();
const publicUploadSessions = new Map();
const transcriptionJobs = new Map();
const burnJobs = new Map();
const transcriptionAttempts = new Map();
const sharedTranscriptionAttempts = new Map();
const translationAttempts = new Map();
const translationCache = new Map();
const youtubeDownloadAttempts = new Map();
let activeTranscriptions = 0;
let activeSharedTranscriptions = 0;
const maxActiveTranscriptions = Math.max(1, Math.min(4, Number.parseInt(process.env.MAX_ACTIVE_TRANSCRIPTIONS || '2', 10) || 2));
const maxActiveSharedTranscriptions = Math.max(1, Math.min(maxActiveTranscriptions, Number.parseInt(process.env.MAX_ACTIVE_SHARED_TRANSCRIPTIONS || '2', 10) || 2));
const polzaAiKey = String(process.env.POLZA_AI_KEY || '').trim();
const polzaTranscriptionModel = String(process.env.POLZA_TRANSCRIPTION_MODEL || 'aiesa/transcribe').trim();
const transcriptionProviderPreference = String(process.env.TRANSCRIPTION_PROVIDER || 'polza').trim().toLowerCase();
const subtitleDelaySeconds = Math.max(0, Math.min(3, Number(process.env.SUBTITLE_DELAY_SECONDS) || 0));
const yandexTranslateConfigured = Boolean(
  process.env.YANDEX_TRANSLATE_API_KEY && process.env.YANDEX_FOLDER_ID,
);
const allowedOrigins = new Set([
  'https://sprskisubtitles.netlify.app',
  'https://serbiansubtitles.netlify.app',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  process.env.FRONTEND_ORIGIN,
].filter(Boolean).map((origin) => origin.replace(/\/$/, '')));

function resolveGroqCredentials(req) {
  const userKey = String(req.get('x-groq-api-key') || '').trim();
  const sharedKey = String(process.env.GROQ_API_KEY || '').trim();
  return {
    apiKey: userKey || sharedKey,
    usesSharedKey: !userKey && Boolean(sharedKey),
  };
}

function resolveTranscriptionCredentials(req) {
  const userGroqKey = String(req.get('x-groq-api-key') || '').trim();
  const sharedGroqKey = String(process.env.GROQ_API_KEY || '').trim();
  if (userGroqKey) {
    return {
      provider: 'groq',
      apiKey: userGroqKey,
      groqApiKey: userGroqKey,
      usesSharedKey: false,
    };
  }
  const preferGroq = transcriptionProviderPreference === 'groq';
  if (polzaAiKey && !preferGroq) {
    return {
      provider: 'polza',
      apiKey: polzaAiKey,
      groqApiKey: sharedGroqKey,
      usesSharedKey: true,
    };
  }
  if (sharedGroqKey) {
    return {
      provider: 'groq',
      apiKey: sharedGroqKey,
      groqApiKey: sharedGroqKey,
      usesSharedKey: true,
    };
  }
  if (polzaAiKey) {
    return {
      provider: 'polza',
      apiKey: polzaAiKey,
      groqApiKey: '',
      usesSharedKey: true,
    };
  }
  return { provider: '', apiKey: '', groqApiKey: '', usesSharedKey: false };
}

function resolveGroqApiKey(req) {
  return resolveGroqCredentials(req).apiKey;
}

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxVideoBytes, fieldSize: 5 * 1024 * 1024, fields: 10 },
});

app.use((req, res, next) => {
  const requestHost = String(req.hostname || '').toLowerCase();
  const isPageRequest = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/');
  if (isPageRequest && canonicalAliases.has(requestHost)) {
    return res.redirect(301, `https://${canonicalHost}${req.originalUrl}`);
  }
  return next();
});

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Groq-Api-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition,X-Video-Title');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ffmpeg: Boolean(ffmpegPath),
    ytDlpBinary: managedYtDlpAvailable,
    poTokenProvider: youtubePotProviderState.status === 'ready',
    poTokenProviderStatus: youtubePotProviderState.status,
    poTokenProviderVersion: youtubePotProviderState.version,
    provider: polzaAiKey && transcriptionProviderPreference !== 'groq' ? 'polza' : 'groq',
    sharedGroqKey: Boolean(String(process.env.GROQ_API_KEY || '').trim()),
    sharedPolzaKey: Boolean(polzaAiKey),
    polzaTranscriptionModel: polzaAiKey ? polzaTranscriptionModel : null,
    transcriptionConcurrency: maxActiveTranscriptions,
    publicLibrary: publicLibraryConfigured,
    yandexTranslate: yandexTranslateConfigured,
  });
});

function translationRateLimited(ip) {
  const now = Date.now();
  const recent = (translationAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 1000);
  if (recent.length >= 30) return true;
  recent.push(now);
  translationAttempts.set(ip, recent);
  return false;
}

function acquireTranscriptionProcessing(ipAddress) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const ip = String(ipAddress || 'unknown').slice(0, 120);
  const recent = (transcriptionAttempts.get(ip) || []).filter((timestamp) => timestamp > windowStart);
  transcriptionAttempts.set(ip, recent);
  if (activeTranscriptions >= maxActiveTranscriptions) {
    return {
      ok: false,
      code: 'TRANSCRIPTION_SERVER_BUSY',
      error: maxActiveTranscriptions === 1
        ? 'Сервер уже обрабатывает видео. Попробуйте немного позже.'
        : `Сервер уже обрабатывает ${maxActiveTranscriptions} видео. Попробуйте немного позже.`,
    };
  }
  if (recent.length >= 10) {
    return {
      ok: false,
      code: 'TRANSCRIPTION_RATE_LIMIT',
      error: 'С этого адреса уже запущено десять распознаваний за последний час. Попробуйте позже.',
    };
  }
  recent.push(now);
  transcriptionAttempts.set(ip, recent);
  if (transcriptionAttempts.size > 5000) {
    for (const [key, attempts] of transcriptionAttempts) {
      if (!attempts.some((timestamp) => timestamp > windowStart)) transcriptionAttempts.delete(key);
    }
  }
  activeTranscriptions += 1;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      activeTranscriptions = Math.max(0, activeTranscriptions - 1);
    },
  };
}

function acquireSharedTranscription(ipAddress) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const ip = String(ipAddress || 'unknown').slice(0, 120);
  const globalKey = '__all__';
  const recentFor = (key) => (sharedTranscriptionAttempts.get(key) || [])
    .filter((timestamp) => timestamp > windowStart);
  const perIp = recentFor(ip);
  const global = recentFor(globalKey);
  sharedTranscriptionAttempts.set(ip, perIp);
  sharedTranscriptionAttempts.set(globalKey, global);

  if (activeSharedTranscriptions >= maxActiveSharedTranscriptions) {
    return {
      ok: false,
      code: 'SHARED_TRANSCRIPTION_BUSY',
      error: 'Общий сервис сейчас занят распознаванием других видео. Попробуйте немного позже или временно добавьте свой ключ Groq.',
    };
  }
  if (perIp.length >= 6 || global.length >= 24) {
    return {
      ok: false,
      code: 'SHARED_TRANSCRIPTION_RATE_LIMIT',
      error: 'Часовой лимит общего сервиса распознавания исчерпан. Попробуйте позже или временно добавьте свой ключ Groq в настройках.',
    };
  }

  perIp.push(now);
  global.push(now);
  sharedTranscriptionAttempts.set(ip, perIp);
  sharedTranscriptionAttempts.set(globalKey, global);
  if (sharedTranscriptionAttempts.size > 5000) {
    for (const [key, attempts] of sharedTranscriptionAttempts) {
      if (key !== globalKey && !attempts.some((timestamp) => timestamp > windowStart)) {
        sharedTranscriptionAttempts.delete(key);
      }
    }
  }

  activeSharedTranscriptions += 1;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      activeSharedTranscriptions = Math.max(0, activeSharedTranscriptions - 1);
    },
  };
}

function admitTranscription(req, res, next) {
  const credentials = resolveTranscriptionCredentials(req);
  if (!credentials.apiKey) {
    return res.status(401).json({
      error: 'На сервере не настроен ключ сервиса распознавания. Добавьте POLZA_AI_KEY или GROQ_API_KEY либо временно используйте личный ключ Groq.',
      code: 'MISSING_API_KEY',
    });
  }

  const ipAddress = req.ip || req.socket.remoteAddress;
  const processingLease = acquireTranscriptionProcessing(ipAddress);
  if (!processingLease.ok) {
    return res.status(429).json({ error: processingLease.error, code: processingLease.code });
  }
  const sharedLease = credentials.usesSharedKey ? acquireSharedTranscription(ipAddress) : null;
  if (sharedLease && !sharedLease.ok) {
    processingLease.release();
    return res.status(429).json({ error: sharedLease.error, code: sharedLease.code });
  }

  let released = false;
  const admission = {
    credentials,
    transferred: false,
    release() {
      if (released) return;
      released = true;
      processingLease.release();
      sharedLease?.release?.();
    },
  };
  req.transcriptionAdmission = admission;
  const releaseIfNotTransferred = () => {
    if (!admission.transferred) admission.release();
  };
  res.once('finish', releaseIfNotTransferred);
  res.once('close', releaseIfNotTransferred);
  return next();
}

function cleanTranslation(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function translateWordWithGroq(word, context, apiKey) {
  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
  let lastError;
  for (const model of models) {
    try {
      const requestBody = {
        model,
        temperature: 0,
        max_completion_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a careful Serbian bilingual dictionary. Translate the supplied Serbian word as it is used in the supplied Serbian sentence. Do not interpret Serbian words as similarly spelled English words: for example, Serbian "paradajz" means tomato, not paradise. Return only a JSON object with two short string fields: ru for Russian and en for English. Prefer a dictionary form when helpful.',
          },
          {
            role: 'user',
            content: JSON.stringify({ word, context }),
          },
        ],
      };
      if (model.startsWith('openai/gpt-oss-')) requestBody.reasoning_effort = 'low';
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Groq returned ${response.status}`);
      const content = String(payload?.choices?.[0]?.message?.content || '');
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Groq did not return translation JSON');
      const parsed = JSON.parse(jsonMatch[0]);
      const ru = cleanTranslation(parsed.ru);
      const en = cleanTranslation(parsed.en);
      if (!ru || !en) throw new Error('Groq returned an incomplete translation');
      return { ru, en, provider: 'groq', model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Groq translation failed');
}

async function translateWordWithYandex(word, apiKey, folderId) {
  const translateTo = async (language) => {
    const response = await fetch('https://translate.api.cloud.yandex.net/translate/v2/translate', {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folderId,
        sourceLanguageCode: 'sr',
        targetLanguageCode: language,
        format: 'PLAIN_TEXT',
        texts: [word],
      }),
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => ({}));
    const translation = cleanTranslation(payload?.translations?.[0]?.text);
    if (!response.ok || !translation) {
      throw new Error(payload?.message || `Yandex Translate returned ${response.status}`);
    }
    return translation;
  };
  const [ru, en] = await Promise.all([translateTo('ru'), translateTo('en')]);
  return { ru, en, provider: 'yandex' };
}

app.post('/api/translate', async (req, res) => {
  const word = String(req.body?.word || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const context = String(req.body?.context || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!word || word.includes(' ')) return res.status(400).json({ error: 'Передайте одно сербское слово.' });

  const yandexApiKey = process.env.YANDEX_TRANSLATE_API_KEY;
  const yandexFolderId = process.env.YANDEX_FOLDER_ID;
  const apiKey = resolveGroqApiKey(req);
  const preferredProvider = yandexApiKey && yandexFolderId ? 'yandex' : 'groq';
  const cacheKey = `${preferredProvider}|${word.toLocaleLowerCase('sr')}|${context.toLocaleLowerCase('sr')}`;
  const cached = translationCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  if (translationRateLimited(req.ip || req.socket.remoteAddress || 'unknown')) {
    return res.status(429).json({ error: 'Слишком много переводов за одну минуту. Попробуйте немного позже.' });
  }

  let result;
  if (yandexApiKey && yandexFolderId) {
    try {
      result = await translateWordWithYandex(word, yandexApiKey, yandexFolderId);
    } catch (error) {
      console.warn(`[translate] Yandex unavailable, trying Groq: ${error.message}`);
    }
  }
  if (apiKey) {
    try {
      result ||= await translateWordWithGroq(word, context, apiKey);
    } catch (error) {
      console.warn(`[translate] Groq unavailable: ${error.message}`);
    }
  }

  try {
    if (!result) {
      return res.status(503).json({
        error: 'Перевод слов временно недоступен. Повторите попытку позже.',
      });
    }
    if (result.provider === preferredProvider) translationCache.set(cacheKey, result);
    if (translationCache.size > 2000) translationCache.delete(translationCache.keys().next().value);
    return res.json(result);
  } catch (error) {
    console.error('[translate] Translation failed:', error);
    return res.status(502).json({ error: 'Не удалось получить перевод. Попробуйте нажать на слово ещё раз.' });
  }
});

function publicObjectUrl(key) {
  return `${objectStorage.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function slugifyPublicTitle(value, fallback = 'video') {
  const cyrillicMap = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ђ: 'dj',
    ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ъ: '', ь: '',
  };
  const transliterated = String(value || '')
    .toLocaleLowerCase('ru')
    .split('')
    .map((character) => cyrillicMap[character] ?? character)
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 76)
    .replace(/-+$/g, '');
  return transliterated || fallback;
}

function safeFilename(filename = 'video.mp4') {
  const extension = path.extname(filename).slice(0, 12).replace(/[^a-z0-9.]/gi, '') || '.mp4';
  return `video${extension.toLowerCase()}`;
}

function publishedVideoType(filename) {
  const types = new Map([
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/mp4'],
    ['.mov', 'video/quicktime'],
    ['.webm', 'video/webm'],
    ['.mkv', 'video/x-matroska'],
    ['.avi', 'video/x-msvideo'],
  ]);
  return types.get(path.extname(filename).toLocaleLowerCase('en')) || null;
}

function resolvePublishedVideoType(filename, mimeType) {
  const fromFilename = publishedVideoType(filename);
  if (fromFilename) return fromFilename;
  const normalizedMimeType = String(mimeType || '').trim().toLocaleLowerCase('en');
  const supportedMimeTypes = new Set([
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/x-msvideo',
  ]);
  return supportedMimeTypes.has(normalizedMimeType) ? normalizedMimeType : null;
}

function normalizePublishedSegments(value) {
  let parsed;
  if (Array.isArray(value)) {
    parsed = value;
  } else {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 5000).map((segment, index) => ({
    id: String(segment.id || `s-${index}`).slice(0, 80),
    start: Math.max(0, Number(segment.start) || 0),
    end: Math.max(Number(segment.start) || 0, Number(segment.end) || Number(segment.start) + 3),
    text: String(segment.text || '').trim().slice(0, 1000),
  })).filter((segment) => segment.text);
}

function vttTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMillis = Math.round(safe * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':') + `.${String(millis).padStart(3, '0')}`;
}

function makePublicVtt(segments) {
  return `WEBVTT\n\n${segments.map((segment) => `${vttTime(segment.start + subtitleDelaySeconds)} --> ${vttTime(segment.end + subtitleDelaySeconds)}\n${segment.text}`).join('\n\n')}\n`;
}

async function bodyToText(body) {
  if (typeof body?.transformToString === 'function') return body.transformToString('utf-8');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function getPublicMetadata(id) {
  const response = await objectStorageClient.send(new GetObjectCommand({
    Bucket: objectStorage.bucket,
    Key: `library/${id}.json`,
  }));
  return JSON.parse(await bodyToText(response.Body));
}

function withPublicPageFields(item) {
  const slug = String(item?.slug || '').trim() || slugifyPublicTitle(item?.title, `video-${String(item?.id || '').slice(0, 8)}`);
  return {
    ...item,
    slug,
    pageUrl: `https://${canonicalHost}/subtitles/${encodeURIComponent(slug)}`,
    thumbnailUrl: item?.thumbnailUrl || genericPublicThumbnailUrl,
  };
}

async function createPublicThumbnail(item) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-public-cover-'));
  const thumbnailPath = path.join(tempDir, `${item.id}.jpg`);
  try {
    await runFfmpeg([
      '-y',
      '-ss', '1',
      '-i', item.videoUrl,
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '3',
      thumbnailPath,
    ]);
    const thumbnailKey = `thumbnails/${item.id}.jpg`;
    const thumbnailUrl = publicObjectUrl(thumbnailKey);
    await objectStorageClient.send(new PutObjectCommand({
      Bucket: objectStorage.bucket,
      Key: thumbnailKey,
      Body: createReadStream(thumbnailPath),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    const updatedMetadata = { ...item, thumbnailUrl };
    await objectStorageClient.send(new PutObjectCommand({
      Bucket: objectStorage.bucket,
      Key: `library/${item.id}.json`,
      Body: JSON.stringify(updatedMetadata),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-cache',
    }));
    console.log(`[public-library] Создана обложка для «${item.title}»`);
    return updatedMetadata;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function backfillPublicThumbnails() {
  if (!publicLibraryConfigured) return;
  const items = await listPublicMetadata();
  const missingThumbnails = items.filter((item) => item.thumbnailUrl === genericPublicThumbnailUrl && item.videoUrl);
  for (const item of missingThumbnails) {
    try {
      await createPublicThumbnail(item);
    } catch (error) {
      console.warn(`[public-library] Не удалось создать обложку для «${item.title}»: ${error.message}`);
    }
  }
}

async function listPublicMetadata() {
  if (!publicLibraryConfigured) return [];
  const objects = [];
  let continuationToken;
  do {
    const listing = await objectStorageClient.send(new ListObjectsV2Command({
      Bucket: objectStorage.bucket,
      Prefix: 'library/',
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    objects.push(...(listing.Contents || []));
    continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
  } while (continuationToken);
  const keys = objects
    .filter((item) => item.Key?.endsWith('.json'))
    .sort((left, right) => new Date(right.LastModified || 0) - new Date(left.LastModified || 0))
    .map((item) => item.Key.slice('library/'.length, -'.json'.length));
  return (await Promise.all(keys.map((id) => getPublicMetadata(id).catch(() => null))))
    .filter(Boolean)
    .map(withPublicPageFields)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

async function resolvePublicMetadata(identifier) {
  if (/^[a-f0-9-]{36}$/i.test(identifier)) return withPublicPageFields(await getPublicMetadata(identifier));
  const normalizedSlug = slugifyPublicTitle(identifier, '');
  const items = await listPublicMetadata();
  return items.find((item) => item.slug === normalizedSlug) || null;
}

async function createUniquePublicSlug(title) {
  const base = slugifyPublicTitle(title);
  const existing = new Set((await listPublicMetadata()).map((item) => item.slug));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function publicListItem(item) {
  const { segments: _segments, ...summary } = item;
  return summary;
}

function publicationRateLimited(ip) {
  const now = Date.now();
  const recent = (publicationAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 3) return true;
  recent.push(now);
  publicationAttempts.set(ip, recent);
  return false;
}

function announcePublicPage(metadata) {
  notifyIndexNow([
    metadata.pageUrl,
    `https://${canonicalHost}/subtitles`,
    `https://${canonicalHost}/sitemap.xml`,
  ]).catch((error) => console.warn(`[indexnow] Не удалось отправить новую публикацию: ${error.message}`));
}

async function savePublicMetadata(metadata) {
  await objectStorageClient.send(new PutObjectCommand({
    Bucket: objectStorage.bucket,
    Key: `library/${metadata.id}.json`,
    Body: JSON.stringify(metadata),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache',
  }));
}

async function ensureLocalMediaCapacity(size) {
  await mkdir(localUploadRoot, { recursive: true });
  const disk = await statfs(localMediaRoot);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const requiredBytes = (size * 2) + (2 * 1024 * 1024 * 1024);
  if (availableBytes < requiredBytes) {
    const error = new Error('На сервере недостаточно свободного места для этого видео. Напишите владельцу сайта.');
    error.status = 507;
    throw error;
  }
}

async function assembleLocalPublicVideo(session) {
  const finalDirectory = path.join(localMediaRoot, 'videos', session.id);
  const finalPath = path.join(finalDirectory, session.filename);
  const assemblingPath = path.join(session.tempDirectory, `${session.filename}.assembling`);
  await mkdir(finalDirectory, { recursive: true });
  const output = await open(assemblingPath, 'w');
  try {
    let position = 0;
    for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
      const part = session.parts.get(partNumber);
      const buffer = await readFile(part.path);
      await output.write(buffer, 0, buffer.length, position);
      position += buffer.length;
    }
    await output.sync();
  } finally {
    await output.close();
  }
  await rm(finalPath, { force: true }).catch(() => {});
  await rename(assemblingPath, finalPath);
  session.finalPath = finalPath;
  return `https://${canonicalHost}/media/videos/${encodeURIComponent(session.id)}/${encodeURIComponent(session.filename)}`;
}

async function abortPublicUpload(session) {
  if (session?.storage === 'local') {
    if (session.tempDirectory) await rm(session.tempDirectory, { recursive: true, force: true }).catch(() => {});
    if (session.finalPath) await rm(session.finalPath, { force: true }).catch(() => {});
    return;
  }
  if (!session?.uploadId) return;
  await objectStorageClient.send(new AbortMultipartUploadCommand({
    Bucket: objectStorage.bucket,
    Key: session.videoKey,
    UploadId: session.uploadId,
  })).catch((error) => console.warn(`[public-upload] Не удалось отменить ${session.id}: ${error.message}`));
}

function getPublicUploadSession(req) {
  const session = publicUploadSessions.get(req.params.sessionId);
  if (!session) return null;
  const requestIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (session.ip !== requestIp || session.expiresAt < Date.now()) return null;
  return session;
}

app.post('/api/public/uploads', async (req, res) => {
  if (!publicLibraryConfigured) return res.status(503).json({ error: 'Публичная библиотека ещё не подключена.' });
  const requestIp = req.ip || req.socket.remoteAddress || 'unknown';
  const title = String(req.body.title || '').trim().slice(0, 100);
  const category = String(req.body.category || '').trim().toLocaleLowerCase('ru');
  const description = String(req.body.description || '').trim().slice(0, 600);
  const originalFilename = String(req.body.filename || '').trim().slice(0, 255);
  const size = Number(req.body.size);
  const segments = normalizePublishedSegments(req.body.transcript);
  const videoType = resolvePublishedVideoType(originalFilename, req.body.mimeType);

  if (req.body.rightsConfirmed !== true) return res.status(400).json({ error: 'Подтвердите право на публичное размещение видео.' });
  if (title.length < 2) return res.status(400).json({ error: 'Укажите название длиной не менее двух символов.' });
  if (!publicCategories.has(category)) return res.status(400).json({ error: 'Выберите доступную категорию видео.' });
  if (!segments.length) return res.status(400).json({ error: 'Сначала распознайте субтитры, затем публикуйте видео.' });
  if (!videoType) return res.status(400).json({ error: 'Для публикации поддерживаются MP4, MOV, WEBM, MKV, AVI и M4V.' });
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxVideoBytes) {
    return res.status(413).json({ error: 'Размер публикуемого видео должен быть не больше 2 ГБ.' });
  }
  if (publicationRateLimited(requestIp)) {
    return res.status(429).json({ error: 'С этого адреса уже опубликовано три видео за последний час. Попробуйте позже.' });
  }

  let session;
  try {
    const id = randomUUID();
    const slug = await createUniquePublicSlug(title);
    const filename = safeFilename(originalFilename);
    const videoKey = `videos/${id}/${filename}`;
    const subtitleKey = `subtitles/${id}.vtt`;
    const sessionId = randomUUID();
    const storage = size > supabaseSingleObjectBytes ? 'local' : 's3';
    let uploadId = null;
    let tempDirectory = null;
    if (storage === 'local') {
      await ensureLocalMediaCapacity(size);
      tempDirectory = path.join(localUploadRoot, sessionId);
      await mkdir(tempDirectory, { recursive: true });
    } else {
      const multipart = await objectStorageClient.send(new CreateMultipartUploadCommand({
        Bucket: objectStorage.bucket,
        Key: videoKey,
        ContentType: videoType,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      if (!multipart.UploadId) throw new Error('Хранилище не вернуло идентификатор загрузки.');
      uploadId = multipart.UploadId;
    }

    session = {
      sessionId,
      id,
      slug,
      title,
      category,
      description,
      size,
      segments,
      videoType,
      filename,
      videoKey,
      subtitleKey,
      storage,
      uploadId,
      tempDirectory,
      totalParts: Math.ceil(size / publicUploadChunkBytes),
      parts: new Map(),
      ip: requestIp,
      expiresAt: Date.now() + publicUploadTtlMs,
      completing: false,
    };
    publicUploadSessions.set(sessionId, session);
    console.log(`[public-upload] Начата загрузка ${id}: ${session.totalParts} частей, ${(size / 1024 / 1024).toFixed(1)} МБ, хранилище ${storage}`);
    return res.status(201).json({
      sessionId,
      chunkSize: publicUploadChunkBytes,
      totalParts: session.totalParts,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } catch (error) {
    if (session) await abortPublicUpload(session);
    console.error('Не удалось начать публикацию:', error);
    return res.status(error.status || 502).json({ error: error.message || 'Не удалось начать загрузку видео в хранилище.' });
  }
});

app.put(
  '/api/public/uploads/:sessionId/parts/:partNumber',
  express.raw({ type: 'application/octet-stream', limit: `${publicUploadChunkBytes + 1024}b` }),
  async (req, res) => {
    const session = getPublicUploadSession(req);
    if (!session) return res.status(404).json({ error: 'Сеанс загрузки не найден или уже завершён.' });
    if (session.completing) return res.status(409).json({ error: 'Публикация уже завершается.' });
    const partNumber = Number.parseInt(req.params.partNumber, 10);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) {
      return res.status(400).json({ error: 'Некорректный номер части видео.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Получена пустая часть видео.' });
    const expectedLength = partNumber === session.totalParts
      ? session.size - ((session.totalParts - 1) * publicUploadChunkBytes)
      : publicUploadChunkBytes;
    if (req.body.length !== expectedLength) {
      return res.status(400).json({ error: `Неверный размер части ${partNumber}. Ожидалось ${expectedLength} байт.` });
    }

    try {
      if (session.storage === 'local') {
        const partPath = path.join(session.tempDirectory, `${String(partNumber).padStart(5, '0')}.part`);
        await writeFile(partPath, req.body);
        session.parts.set(partNumber, { path: partPath, length: req.body.length, PartNumber: partNumber });
      } else {
        const uploaded = await objectStorageClient.send(new UploadPartCommand({
          Bucket: objectStorage.bucket,
          Key: session.videoKey,
          UploadId: session.uploadId,
          PartNumber: partNumber,
          Body: req.body,
          ContentLength: req.body.length,
        }));
        if (!uploaded.ETag) throw new Error('Хранилище не подтвердило загруженную часть.');
        session.parts.set(partNumber, { ETag: uploaded.ETag, PartNumber: partNumber });
      }
      session.expiresAt = Date.now() + publicUploadTtlMs;
      console.log(`[public-upload] ${session.id}: часть ${partNumber}/${session.totalParts}`);
      return res.json({ partNumber, uploadedParts: session.parts.size, totalParts: session.totalParts });
    } catch (error) {
      console.error(`[public-upload] Ошибка части ${partNumber} для ${session.id}:`, error);
      const noSpace = error?.code === 'ENOSPC';
      return res.status(noSpace ? 507 : 502).json({
        error: noSpace ? 'На сервере закончилось свободное место для видео.' : 'Не удалось сохранить часть видео. Браузер повторит попытку.',
      });
    }
  },
);

app.post('/api/public/uploads/:sessionId/complete', async (req, res) => {
  const session = getPublicUploadSession(req);
  if (!session) return res.status(404).json({ error: 'Сеанс загрузки не найден или уже завершён.' });
  if (session.completing) return res.status(409).json({ error: 'Публикация уже завершается.' });
  if (session.parts.size !== session.totalParts) {
    return res.status(409).json({ error: `Загружено ${session.parts.size} из ${session.totalParts} частей видео.` });
  }
  session.completing = true;

  try {
    let videoUrl;
    if (session.storage === 'local') {
      videoUrl = await assembleLocalPublicVideo(session);
    } else {
      await objectStorageClient.send(new CompleteMultipartUploadCommand({
        Bucket: objectStorage.bucket,
        Key: session.videoKey,
        UploadId: session.uploadId,
        MultipartUpload: {
          Parts: [...session.parts.values()].sort((left, right) => left.PartNumber - right.PartNumber),
        },
      }));
      videoUrl = publicObjectUrl(session.videoKey);
    }

    await objectStorageClient.send(new PutObjectCommand({
      Bucket: objectStorage.bucket,
      Key: session.subtitleKey,
      Body: makePublicVtt(session.segments),
      ContentType: 'text/vtt; charset=utf-8',
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    let metadata = {
      id: session.id,
      slug: session.slug,
      pageUrl: `https://${canonicalHost}/subtitles/${encodeURIComponent(session.slug)}`,
      title: session.title,
      category: session.category,
      description: session.description,
      language: 'sr',
      createdAt: new Date().toISOString(),
      size: session.size,
      mimeType: session.videoType,
      duration: Math.max(...session.segments.map((segment) => segment.end)),
      segmentsCount: session.segments.length,
      videoUrl,
      subtitleUrl: publicObjectUrl(session.subtitleKey),
      thumbnailUrl: genericPublicThumbnailUrl,
      segments: session.segments,
    };
    await savePublicMetadata(metadata);
    try {
      metadata = await createPublicThumbnail(metadata);
    } catch (thumbnailError) {
      console.warn('Не удалось создать превью публикации:', thumbnailError.message);
    }
    if (session.storage === 'local') await rm(session.tempDirectory, { recursive: true, force: true });
    publicUploadSessions.delete(session.sessionId);
    announcePublicPage(metadata);
    console.log(`[public-upload] Публикация ${session.id} завершена`);
    return res.status(201).json(metadata);
  } catch (error) {
    session.completing = false;
    console.error('Не удалось завершить публикацию:', error);
    return res.status(error?.code === 'ENOSPC' ? 507 : 502).json({ error: error.message || 'Не удалось завершить публикацию видео.' });
  }
});

app.delete('/api/public/uploads/:sessionId', async (req, res) => {
  const session = getPublicUploadSession(req);
  if (!session) return res.sendStatus(204);
  publicUploadSessions.delete(session.sessionId);
  await abortPublicUpload(session);
  return res.sendStatus(204);
});

const publicUploadCleanupTimer = setInterval(async () => {
  const expired = [...publicUploadSessions.values()].filter((session) => session.expiresAt < Date.now());
  for (const session of expired) {
    publicUploadSessions.delete(session.sessionId);
    await abortPublicUpload(session);
  }
}, 30 * 60 * 1000);
publicUploadCleanupTimer.unref();

app.get('/api/public/videos', async (req, res) => {
  if (!publicLibraryConfigured) return res.json({ configured: false, items: [] });
  try {
    const category = String(req.query.category || '').trim().toLocaleLowerCase('ru');
    const limit = Math.max(1, Math.min(24, Number.parseInt(req.query.limit || '8', 10) || 8));
    const requestedPage = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const allItems = await listPublicMetadata();
    const filteredItems = category && category !== 'все'
      ? allItems.filter((item) => item.category === category)
      : allItems;
    const totalItems = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const page = Math.min(requestedPage, totalPages);
    const items = filteredItems.slice((page - 1) * limit, page * limit).map(publicListItem);
    return res.json({ configured: true, items, page, totalPages, totalItems, limit, category: category || 'все' });
  } catch (error) {
    console.error('Не удалось загрузить публичную библиотеку:', error);
    return res.status(502).json({ error: 'Хранилище публичных видео временно недоступно.' });
  }
});

app.get('/api/public/videos/:id', async (req, res) => {
  if (!publicLibraryConfigured) return res.status(503).json({ error: 'Публичная библиотека ещё не подключена.' });
  if (!/^[a-z0-9-]{1,100}$/i.test(req.params.id)) return res.status(400).json({ error: 'Некорректный адрес публикации.' });
  try {
    const item = await resolvePublicMetadata(req.params.id);
    if (!item) return res.status(404).json({ error: 'Публикация не найдена.' });
    return res.json(item);
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: 'Публикация не найдена.' });
    console.error('Не удалось открыть публикацию:', error);
    return res.status(502).json({ error: 'Не удалось получить публикацию из хранилища.' });
  }
});

app.post(
  '/api/public/videos',
  (req, res, next) => publicLibraryConfigured
    ? next()
    : res.status(503).json({ error: 'Публичная библиотека не подключена. Добавьте параметры Cloudflare R2 в настройках Render.' }),
  upload.single('video'),
  async (req, res) => {
    const sourcePath = req.file?.path;
    const thumbnailPath = sourcePath ? `${sourcePath}-thumbnail.jpg` : null;
    try {
      if (!req.file) return res.status(400).json({ error: 'Для публикации нужен исходный видеофайл.' });
      if (req.body.rightsConfirmed !== 'true') return res.status(400).json({ error: 'Подтвердите право на публичное размещение видео.' });

      const title = String(req.body.title || '').trim().slice(0, 100);
      const category = String(req.body.category || '').trim().toLocaleLowerCase('ru');
      const description = String(req.body.description || '').trim().slice(0, 600);
      const segments = normalizePublishedSegments(req.body.transcript);
      const videoType = publishedVideoType(req.file.originalname);
      if (title.length < 2) return res.status(400).json({ error: 'Укажите название длиной не менее двух символов.' });
      if (!publicCategories.has(category)) return res.status(400).json({ error: 'Выберите доступную категорию видео.' });
      if (!segments.length) return res.status(400).json({ error: 'Сначала распознайте субтитры, затем публикуйте видео.' });
      if (!videoType) return res.status(400).json({ error: 'Для публикации поддерживаются MP4, MOV, WEBM, MKV, AVI и M4V.' });
      if (publicationRateLimited(req.ip || req.socket.remoteAddress || 'unknown')) {
        return res.status(429).json({ error: 'С этого адреса уже опубликовано три видео за последний час. Попробуйте позже.' });
      }

      const id = randomUUID();
      const slug = await createUniquePublicSlug(title);
      const filename = safeFilename(req.file.originalname);
      const videoKey = `videos/${id}/${filename}`;
      const subtitleKey = `subtitles/${id}.vtt`;
      const thumbnailKey = `thumbnails/${id}.jpg`;
      const videoUrl = publicObjectUrl(videoKey);
      const subtitleUrl = publicObjectUrl(subtitleKey);
      let thumbnailUrl = `https://${canonicalHost}/assets/citavuk-guide.webp`;

      try {
        await runFfmpeg([
          '-y',
          '-ss', '1',
          '-i', sourcePath,
          '-frames:v', '1',
          '-vf', 'scale=640:-2',
          '-q:v', '3',
          thumbnailPath,
        ]);
        await objectStorageClient.send(new PutObjectCommand({
          Bucket: objectStorage.bucket,
          Key: thumbnailKey,
          Body: createReadStream(thumbnailPath),
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }));
        thumbnailUrl = publicObjectUrl(thumbnailKey);
      } catch (thumbnailError) {
        console.warn('Не удалось создать превью публикации:', thumbnailError.message);
      }

      await new S3Upload({
        client: objectStorageClient,
        params: {
          Bucket: objectStorage.bucket,
          Key: videoKey,
          Body: createReadStream(sourcePath),
          ContentType: videoType,
          CacheControl: 'public, max-age=31536000, immutable',
        },
        leavePartsOnError: false,
      }).done();

      await objectStorageClient.send(new PutObjectCommand({
        Bucket: objectStorage.bucket,
        Key: subtitleKey,
        Body: makePublicVtt(segments),
        ContentType: 'text/vtt; charset=utf-8',
        CacheControl: 'public, max-age=31536000, immutable',
      }));

      const metadata = {
        id,
        slug,
        pageUrl: `https://${canonicalHost}/subtitles/${encodeURIComponent(slug)}`,
        title,
        category,
        description,
        language: 'sr',
        createdAt: new Date().toISOString(),
        size: req.file.size,
        mimeType: videoType,
        duration: Math.max(...segments.map((segment) => segment.end)),
        segmentsCount: segments.length,
        videoUrl,
        subtitleUrl,
        thumbnailUrl,
        segments,
      };
      await objectStorageClient.send(new PutObjectCommand({
        Bucket: objectStorage.bucket,
        Key: `library/${id}.json`,
        Body: JSON.stringify(metadata),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache',
      }));

      notifyIndexNow([
        metadata.pageUrl,
        `https://${canonicalHost}/subtitles`,
        `https://${canonicalHost}/sitemap.xml`,
      ]).catch((error) => console.warn(`[indexnow] Не удалось отправить новую публикацию: ${error.message}`));

      return res.status(201).json(metadata);
    } catch (error) {
      console.error('Не удалось опубликовать видео:', error);
      return res.status(502).json({ error: error.message || 'Не удалось сохранить видео в публичной библиотеке.' });
    } finally {
      if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
      if (thumbnailPath) await rm(thumbnailPath, { force: true }).catch(() => {});
    }
  },
);

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress, ...spawnOptions } = options;
    const process = spawn(ffmpegPath, args, {
      windowsHide: true,
      ...spawnOptions,
    });
    let stderr = '';
    let stdout = '';
    let durationSeconds = 0;
    let lastReportedFraction = -1;
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (durationMatch) {
        durationSeconds = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
      }
    });
    process.stdout.on('data', (chunk) => {
      if (!onProgress) return;
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const [key, value] = line.split('=');
        if ((key === 'out_time_us' || key === 'out_time_ms') && durationSeconds > 0) {
          const currentSeconds = Number(value) / 1_000_000;
          const fraction = Math.max(0, Math.min(1, currentSeconds / durationSeconds));
          if (fraction >= 1 || fraction - lastReportedFraction >= 0.01) {
            lastReportedFraction = fraction;
            onProgress({ fraction, currentSeconds, durationSeconds });
          }
        }
      }
    });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) {
        if (onProgress && durationSeconds > 0) onProgress({ fraction: 1, currentSeconds: durationSeconds, durationSeconds });
        resolve({ durationSeconds });
      }
      else reject(new Error(stderr || `FFmpeg завершился с кодом ${code}`));
    });
  });
}

async function requestGroqTranscription(audio, apiKey, filename = 'speech.ogg', options = {}) {
  const model = options.model || 'whisper-large-v3';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), filename);
  form.append('model', model);
  if (options.language) form.append('language', options.language);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('timestamp_granularities[]', 'segment');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Groq не смог обработать аудио.');
    error.status = response.status;
    error.provider = 'groq';
    error.model = model;
    throw error;
  }
  payload.model = model;
  return payload;
}

async function transcribeWithFallback(audio, apiKey, filename = 'speech.ogg', options = {}) {
  try {
    return await requestGroqTranscription(audio, apiKey, filename, options);
  } catch (error) {
    if (error.status !== 400 || error.model !== 'whisper-large-v3') throw error;
    const payload = await requestGroqTranscription(audio, apiKey, filename, {
      ...options,
      model: 'whisper-large-v3-turbo',
    });
    payload.used_fallback_model = true;
    return payload;
  }
}

function normalizePolzaTranscription(payload) {
  const segments = (Array.isArray(payload?.segments) ? payload.segments : [])
    .map((segment, id) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      const text = cleanSubtitleText(segment?.text);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return null;
      return {
        id,
        start,
        end,
        text,
        ...(segment?.speaker ? { speaker: String(segment.speaker) } : {}),
      };
    })
    .filter(Boolean);
  return {
    ...payload,
    text: cleanSubtitleText(payload?.text) || segments.map((segment) => segment.text).join(' '),
    duration: Number(payload?.duration) || 0,
    segments,
    language: String(payload?.language || '').trim(),
    model: String(payload?.model || polzaTranscriptionModel),
    provider: 'polza',
  };
}

async function requestPolzaTranscription(audio, apiKey, filename = 'speech.ogg') {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), filename);
  form.append('model', polzaTranscriptionModel);
  const createdResponse = await fetch('https://polza.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const created = await createdResponse.json().catch(() => ({}));
  if (!createdResponse.ok) {
    const error = new Error(created?.error?.message || 'Polza.ai не смогла принять аудиодорожку.');
    error.status = createdResponse.status;
    error.provider = 'polza';
    error.model = polzaTranscriptionModel;
    throw error;
  }
  if (Array.isArray(created?.segments)) return normalizePolzaTranscription(created);
  const jobId = String(created?.id || '').trim();
  if (!jobId) {
    const error = new Error('Polza.ai не вернула идентификатор задачи распознавания.');
    error.status = 502;
    error.provider = 'polza';
    throw error;
  }

  const timeoutMs = Math.max(60_000, Number(process.env.POLZA_TRANSCRIPTION_TIMEOUT_MS) || 30 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const statusResponse = await fetch(`https://polza.ai/api/v1/audio/transcriptions/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      const error = new Error(payload?.error?.message || 'Polza.ai не смогла вернуть состояние распознавания.');
      error.status = statusResponse.status;
      error.provider = 'polza';
      error.model = polzaTranscriptionModel;
      throw error;
    }
    const status = String(payload?.status || '').toLowerCase();
    if (status === 'completed') return normalizePolzaTranscription(payload);
    if (status === 'failed' || status === 'cancelled') {
      const error = new Error(payload?.error?.message || 'Aiesa не смогла распознать аудиодорожку.');
      error.status = 502;
      error.provider = 'polza';
      error.model = polzaTranscriptionModel;
      throw error;
    }
  }
  const error = new Error('Aiesa слишком долго обрабатывает аудио. Попробуйте ещё раз позднее.');
  error.status = 504;
  error.provider = 'polza';
  error.model = polzaTranscriptionModel;
  throw error;
}

async function transcribePolzaAudio(audioPath, tempDir, apiKey, totalDuration, originalAudio) {
  const maxChunkSeconds = 4 * 60;
  if (!Number.isFinite(totalDuration) || totalDuration <= maxChunkSeconds) {
    return requestPolzaTranscription(originalAudio || await readFile(audioPath), apiKey);
  }

  const chunkCount = Math.ceil(totalDuration / maxChunkSeconds);
  const combinedSegments = [];
  let firstPayload = null;
  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * maxChunkSeconds;
    const chunkDuration = Math.min(maxChunkSeconds, totalDuration - offset);
    const chunkPath = path.join(tempDir, `polza-${index}.ogg`);
    await runFfmpeg([
      '-y',
      '-ss', String(offset),
      '-t', String(chunkDuration),
      '-i', audioPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:a', 'libopus',
      '-b:a', '32k',
      chunkPath,
    ]);
    const payload = await requestPolzaTranscription(
      await readFile(chunkPath),
      apiKey,
      `speech-${index + 1}-of-${chunkCount}.ogg`,
    );
    firstPayload ||= payload;
    for (const segment of payload.segments || []) {
      combinedSegments.push({
        ...segment,
        start: offset + Number(segment.start || 0),
        end: offset + Number(segment.end || 0),
      });
    }
  }
  return {
    ...(firstPayload || {}),
    text: combinedSegments.map((segment) => segment.text).join(' ').trim(),
    duration: totalDuration,
    segments: combinedSegments,
    chunks: chunkCount,
    provider: 'polza',
    model: polzaTranscriptionModel,
  };
}

function retimePolzaTranscript(polzaPayload, timingPayload) {
  const timingSegments = (timingPayload?.segments || [])
    .map((segment, id) => ({
      id,
      start: Number(segment?.start),
      end: Number(segment?.end),
      text: cleanSubtitleText(segment?.text),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
  const referenceTranscript = (polzaPayload?.segments || [])
    .map((segment) => cleanSubtitleText(segment?.text))
    .filter(Boolean)
    .join(' ');
  if (!timingSegments.length || !referenceTranscript) return polzaPayload;

  return {
    ...polzaPayload,
    text: timingSegments.map((segment) => segment.text).join(' '),
    duration: Number(timingPayload?.duration) || Number(polzaPayload?.duration) || 0,
    language: String(timingPayload?.language || polzaPayload?.language || '').trim(),
    segments: timingSegments,
    provider: 'polza',
    model: polzaPayload?.model || polzaTranscriptionModel,
    recognition_reference: referenceTranscript,
    timing_provider: 'groq',
    timing_model: timingPayload?.model || 'whisper-large-v3',
  };
}

const whisperLanguageCodes = new Map([
  ['afrikaans', 'af'], ['albanian', 'sq'], ['amharic', 'am'], ['arabic', 'ar'],
  ['armenian', 'hy'], ['assamese', 'as'], ['azerbaijani', 'az'], ['bashkir', 'ba'],
  ['basque', 'eu'], ['belarusian', 'be'], ['bengali', 'bn'], ['bosnian', 'bs'],
  ['breton', 'br'], ['bulgarian', 'bg'], ['burmese', 'my'], ['cantonese', 'yue'],
  ['castilian', 'es'], ['catalan', 'ca'], ['chinese', 'zh'], ['croatian', 'hr'],
  ['czech', 'cs'], ['danish', 'da'], ['dutch', 'nl'], ['english', 'en'],
  ['estonian', 'et'], ['faroese', 'fo'], ['finnish', 'fi'], ['flemish', 'nl'],
  ['french', 'fr'], ['galician', 'gl'], ['georgian', 'ka'], ['german', 'de'],
  ['greek', 'el'], ['gujarati', 'gu'], ['haitian', 'ht'], ['haitian creole', 'ht'],
  ['hausa', 'ha'], ['hawaiian', 'haw'], ['hebrew', 'he'], ['hindi', 'hi'],
  ['hungarian', 'hu'], ['icelandic', 'is'], ['indonesian', 'id'], ['italian', 'it'],
  ['japanese', 'ja'], ['javanese', 'jw'], ['kannada', 'kn'], ['kazakh', 'kk'],
  ['khmer', 'km'], ['korean', 'ko'], ['lao', 'lo'], ['latin', 'la'],
  ['latvian', 'lv'], ['lingala', 'ln'], ['lithuanian', 'lt'], ['luxembourgish', 'lb'],
  ['macedonian', 'mk'], ['malagasy', 'mg'], ['malay', 'ms'], ['malayalam', 'ml'],
  ['maltese', 'mt'], ['maori', 'mi'], ['marathi', 'mr'], ['moldavian', 'ro'],
  ['moldovan', 'ro'], ['mongolian', 'mn'], ['myanmar', 'my'], ['nepali', 'ne'],
  ['norwegian', 'no'], ['nynorsk', 'nn'], ['occitan', 'oc'], ['panjabi', 'pa'],
  ['pashto', 'ps'], ['persian', 'fa'], ['polish', 'pl'], ['portuguese', 'pt'],
  ['punjabi', 'pa'], ['pushto', 'ps'], ['romanian', 'ro'], ['russian', 'ru'],
  ['sanskrit', 'sa'], ['serbian', 'sr'], ['shona', 'sn'], ['sindhi', 'sd'],
  ['sinhala', 'si'], ['sinhalese', 'si'], ['slovak', 'sk'], ['slovenian', 'sl'],
  ['somali', 'so'], ['spanish', 'es'], ['sundanese', 'su'], ['swahili', 'sw'],
  ['swedish', 'sv'], ['tagalog', 'tl'], ['tajik', 'tg'], ['tamil', 'ta'],
  ['tatar', 'tt'], ['telugu', 'te'], ['thai', 'th'], ['tibetan', 'bo'],
  ['turkish', 'tr'], ['turkmen', 'tk'], ['ukrainian', 'uk'], ['urdu', 'ur'],
  ['uzbek', 'uz'], ['valencian', 'ca'], ['vietnamese', 'vi'], ['welsh', 'cy'],
  ['yiddish', 'yi'], ['yoruba', 'yo'],
]);

function normalizeWhisperLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(language)) return language;
  return whisperLanguageCodes.get(language) || '';
}

function isSerbianLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return normalizeWhisperLanguage(language) === 'sr' || language.startsWith('serb') || language.startsWith('srp');
}

function cleanSubtitleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
}

function makeTranslationBatches(items, maxItems = 40, maxCharacters = 5000) {
  const batches = [];
  let batch = [];
  let characters = 0;
  for (const item of items) {
    const itemCharacters = item.text.length;
    if (batch.length && (batch.length >= maxItems || characters + itemCharacters > maxCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(item);
    characters += itemCharacters;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function groqRetryDelayMs(response) {
  const retryAfter = String(response.headers.get('retry-after') || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.min(65_000, Math.max(1_000, Math.ceil(Number(retryAfter) * 1000)));
  }
  const retryDate = Date.parse(retryAfter);
  if (Number.isFinite(retryDate)) return Math.min(65_000, Math.max(1_000, retryDate - Date.now()));
  return 30_000;
}

async function requestSerbianTranslationBatch(segments, apiKey, onRetry = () => {}, referenceTranscript = '') {
  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  let lastError;
  for (let round = 0; round < 3; round += 1) {
    let retryDelayMs = 0;
    for (const model of models) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(120_000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            reasoning_effort: 'low',
            max_completion_tokens: 4096,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'serbian_subtitles',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    segments: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer' },
                          text: { type: 'string' },
                        },
                        required: ['id', 'text'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['segments'],
                  additionalProperties: false,
                },
              },
            },
            messages: [
              {
                role: 'system',
                content: 'You are a professional Serbian subtitle editor. Translate every supplied segment into natural Serbian Latin (sr-Latn). The optional Aiesa reference transcript is authoritative for correcting recognition mistakes, names and wording, but it may omit some speech. Keep any timed speech missing from the reference. Preserve the supplied segment ids and timing structure. Return exactly one non-empty text for every input id. Never merge, split, omit, renumber or explain segments.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  target_language: 'Serbian',
                  target_script: 'Latin',
                  segments,
                  ...(referenceTranscript ? { aiesa_reference_transcript: referenceTranscript } : {}),
                }),
              },
            ],
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(payload?.error?.message || `Groq returned ${response.status} while translating subtitles.`);
          error.status = response.status;
          if (response.status === 429) error.retryDelayMs = groqRetryDelayMs(response);
          throw error;
        }
        const parsed = JSON.parse(String(payload?.choices?.[0]?.message?.content || ''));
        const translated = Array.isArray(parsed?.segments) ? parsed.segments : [];
        const expectedIds = new Set(segments.map((segment) => segment.id));
        const translations = new Map();
        for (const segment of translated) {
          const id = Number(segment?.id);
          const text = cleanSubtitleText(segment?.text);
          if (!Number.isInteger(id) || !expectedIds.has(id) || translations.has(id) || !text) {
            throw new Error('Groq returned invalid Serbian subtitle segments.');
          }
          translations.set(id, text);
        }
        if (translations.size !== expectedIds.size) {
          throw new Error('Groq omitted one or more Serbian subtitle segments.');
        }
        return { translations, model };
      } catch (error) {
        lastError = error;
        if (error.status === 429) retryDelayMs = Math.max(retryDelayMs, error.retryDelayMs || 30_000);
      }
    }
    if (!retryDelayMs || round === 2) break;
    onRetry(retryDelayMs);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  const error = new Error(lastError?.message || 'Groq не смог перевести субтитры на сербский язык.');
  error.status = lastError?.status || 502;
  error.provider = 'groq';
  error.code = 'GROQ_TRANSLATION_ERROR';
  throw error;
}

async function translatePayloadToSerbian(payload, apiKey, onUpdate = () => {}) {
  const detectedLanguage = String(payload?.language || '').trim();
  const sourceLanguage = normalizeWhisperLanguage(detectedLanguage) || detectedLanguage.toLowerCase() || 'unknown';
  const recognitionReference = String(payload?.recognition_reference || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  payload.source_language = sourceLanguage;
  if (isSerbianLanguage(detectedLanguage) && !recognitionReference) {
    payload.language = 'sr';
    payload.translated = false;
    return payload;
  }

  const sourceSegments = (payload.segments || [])
    .map((segment, id) => ({ id, text: cleanSubtitleText(segment?.text) }))
    .filter((segment) => segment.text);
  if (!sourceSegments.length) return payload;

  const batches = makeTranslationBatches(sourceSegments);
  const translations = new Map();
  const models = new Set();
  for (let index = 0; index < batches.length; index += 1) {
    onUpdate({
      progress: 91 + ((index / batches.length) * 8),
      stage: `Переводим субтитры на сербский (${index + 1}/${batches.length})`,
      etaSeconds: Math.max(8, (batches.length - index) * 15),
    });
    const translatedBatch = await requestSerbianTranslationBatch(batches[index], apiKey, (delayMs) => {
      onUpdate({
        progress: 91 + ((index / batches.length) * 8),
        stage: 'Ждём обновления лимита Groq для перевода',
        etaSeconds: Math.ceil(delayMs / 1000),
      });
    }, recognitionReference);
    translatedBatch.translations.forEach((text, id) => translations.set(id, text));
    models.add(translatedBatch.model);
  }

  payload.segments = (payload.segments || []).map((segment, id) => (
    translations.has(id) ? { ...segment, text: translations.get(id) } : segment
  ));
  payload.text = payload.segments.map((segment) => cleanSubtitleText(segment.text)).filter(Boolean).join(' ');
  payload.language = 'sr';
  payload.translated = true;
  payload.translation_model = [...models].join(',');
  payload.target_script = 'Latn';
  delete payload.recognition_reference;
  return payload;
}

function probeDuration(sourcePath) {
  return new Promise((resolve) => {
    const process = spawn(ffmpegPath, ['-hide_banner', '-i', sourcePath], { windowsHide: true });
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', () => resolve(0));
    process.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0);
    });
  });
}

function pickAudioBitrateKbps(durationSeconds) {
  const targetBytes = 23 * 1024 * 1024; // stay safely under Groq's ~24.5 MB request limit
  const steps = [24, 32, 40, 48, 64, 80, 96, 128];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return steps[0];
  const affordableKbps = Math.floor((targetBytes * 8) / durationSeconds / 1000);
  return steps.filter((step) => step <= affordableKbps).at(-1) || steps[0];
}

function secondsLabel(value) {
  if (!Number.isFinite(value) || value < 0) return 'неизвестно';
  if (value < 60) return `${Math.max(1, Math.round(value))} с`;
  return `${Math.floor(value / 60)} мин ${Math.round(value % 60)} с`;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    etaSeconds: Number.isFinite(job.etaSeconds) ? Math.max(0, Math.round(job.etaSeconds)) : null,
    elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
    createdAt: new Date(job.startedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    result: job.status === 'done' ? job.result : undefined,
    error: job.status === 'error' ? job.error : undefined,
    code: job.status === 'error' ? job.code : undefined,
    statusCode: job.status === 'error' ? job.statusCode : undefined,
  };
}

function updateTranscriptionJob(id, patch) {
  const job = transcriptionJobs.get(id);
  if (!job) return;
  const nextProgress = Number.isFinite(patch.progress)
    ? Math.max(job.progress, Math.min(100, patch.progress))
    : job.progress;
  Object.assign(job, patch, { progress: nextProgress, updatedAt: Date.now() });
  const logBucket = Math.floor(nextProgress / 5) * 5;
  const stageChanged = patch.stage && patch.stage !== job.lastLoggedStage;
  if (stageChanged || logBucket > job.lastLoggedBucket || patch.status === 'done' || patch.status === 'error') {
    job.lastLoggedBucket = Math.max(job.lastLoggedBucket, logBucket);
    job.lastLoggedStage = job.stage;
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const eta = Number.isFinite(job.etaSeconds)
      ? secondsLabel(job.etaSeconds)
      : nextProgress >= 60 ? 'дольше обычного' : 'уточняется';
    const level = patch.status === 'error' ? 'error' : 'log';
    console[level](`[transcribe:${id}] ${Math.round(nextProgress)}% · ${job.stage} · прошло ${secondsLabel(elapsed)} · осталось ${eta}`);
  }
}

function runEstimatedStage(task, { from, to, expectedSeconds, onUpdate, stage }) {
  const startedAt = Date.now();
  onUpdate({ progress: from, stage, etaSeconds: expectedSeconds });
  const timer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const ratio = Math.min(0.94, elapsed / Math.max(1, expectedSeconds));
    onUpdate({
      progress: from + (to - from) * ratio,
      stage,
      etaSeconds: elapsed < expectedSeconds * 1.25 ? Math.max(1, expectedSeconds - elapsed) : null,
    });
  }, 1000);
  timer.unref?.();
  return Promise.resolve(task)
    .then((result) => {
      onUpdate({ progress: to, stage, etaSeconds: 0 });
      return result;
    })
    .finally(() => clearInterval(timer));
}

// Whisper occasionally decides a stretch of real speech is silence/noise and skips it entirely,
// which shows up as subtitles starting late (e.g. 0:30 into the video) or long silent gaps in the
// middle. We detect those gaps against the known audio duration and re-transcribe just those
// windows on their own — short, isolated clips are much less likely to be misjudged as silence.
async function fillTranscriptionGaps(payload, audioPath, tempDir, apiKey, totalDuration, sourceLanguage, onUpdate = () => {}) {
  const GAP_THRESHOLD_SECONDS = 12;
  const MAX_GAPS = 6;
  const MAX_GAP_CLIP_SECONDS = 90;
  const PADDING_SECONDS = 1;

  const segments = (payload.segments || []).slice().sort((left, right) => Number(left.start) - Number(right.start));
  const gaps = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = Number(segment.start) || 0;
    if (start - cursor >= GAP_THRESHOLD_SECONDS) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Number(segment.end) || start);
  }
  if (totalDuration && totalDuration - cursor >= GAP_THRESHOLD_SECONDS) {
    gaps.push({ start: cursor, end: totalDuration });
  }
  if (!gaps.length) return payload;

  const gapsToCheck = gaps
    .slice()
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))
    .slice(0, MAX_GAPS);

  const recovered = [];
  for (let index = 0; index < gapsToCheck.length; index += 1) {
    const gap = gapsToCheck[index];
    onUpdate({
      stage: `Проверяем пропуск в субтитрах (${index + 1}/${gapsToCheck.length})`,
      etaSeconds: (gapsToCheck.length - index) * 12,
    });
    const clipStart = Math.max(0, gap.start - PADDING_SECONDS);
    const clipDuration = Math.min(MAX_GAP_CLIP_SECONDS, gap.end - clipStart + PADDING_SECONDS);
    try {
      const clipPath = path.join(tempDir, `gap-${index}.ogg`);
      await runFfmpeg([
        '-y',
        '-ss', String(clipStart),
        '-t', String(clipDuration),
        '-i', audioPath,
        '-af', 'asetpts=PTS-STARTPTS',
        '-c:a', 'libopus',
        '-b:a', '32k',
        clipPath,
      ]);
      const clipPayload = await transcribeWithFallback(await readFile(clipPath), apiKey, `gap-${index}.ogg`, {
        language: sourceLanguage || undefined,
      });
      for (const segment of clipPayload.segments || []) {
        const start = clipStart + (Number(segment.start) || 0);
        const end = clipStart + (Number(segment.end) || 0);
        // Ignore anything that lands back on audio we already had a (correct) transcript for.
        if (end <= gap.start + 0.3 || start >= gap.end - 0.3) continue;
        recovered.push({ ...segment, start, end });
      }
    } catch (error) {
      console.warn(`Не удалось восстановить пропуск ${gap.start.toFixed(1)}–${gap.end.toFixed(1)}с:`, error.message);
    }
  }

  if (!recovered.length) return payload;
  const merged = [...segments, ...recovered].sort((left, right) => Number(left.start) - Number(right.start));
  payload.segments = merged;
  payload.text = merged.map((segment) => segment.text).join(' ').trim();
  payload.recovered_gap_segments = recovered.length;
  return payload;
}

async function processVideoTranscription(sourcePath, credentials, onUpdate = () => {}) {
  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-audio-'));
    const audioPath = path.join(tempDir, 'speech.ogg');
    const usesPolza = credentials.provider === 'polza';
    const extractionStartedAt = Date.now();
    let videoDuration = await probeDuration(sourcePath);
    const audioBitrateKbps = usesPolza ? 32 : pickAudioBitrateKbps(videoDuration);
    onUpdate({ progress: 22, stage: 'Извлекаем и сжимаем аудио', etaSeconds: null });

    const extraction = await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-vn',
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:a', 'libopus',
      '-b:a', `${audioBitrateKbps}k`,
      '-progress', 'pipe:1',
      '-nostats',
      audioPath,
    ], {
      onProgress: ({ fraction, durationSeconds }) => {
        videoDuration = durationSeconds || videoDuration;
        const elapsed = (Date.now() - extractionStartedAt) / 1000;
        const etaSeconds = fraction > 0.02 ? Math.max(0, elapsed / fraction - elapsed) : null;
        onUpdate({ progress: 22 + fraction * 34, stage: 'Извлекаем и сжимаем аудио', etaSeconds });
      },
    });
    videoDuration = extraction.durationSeconds || videoDuration;

    onUpdate({ progress: 58, stage: 'Проверяем аудиодорожку', etaSeconds: 3 });
    const audio = await readFile(audioPath);
    if (!usesPolza && audio.byteLength > 24.5 * 1024 * 1024) {
      const limitError = new Error('Аудиодорожка длиннее лимита бесплатного тарифа Groq. Разделите видео на части короче двух часов.');
      limitError.status = 413;
      throw limitError;
    }

    const transcriptionEstimate = usesPolza
      ? Math.max(35, Math.min(15 * 60, (videoDuration || 600) * 0.8))
      : Math.max(25, Math.min(180, (videoDuration || 600) * 0.08));
    const transcriptionStage = usesPolza
      ? 'Aiesa распознаёт речь, Whisper синхронизирует таймкоды'
      : 'Groq определяет язык и распознаёт речь';
    const payload = await runEstimatedStage(
      usesPolza
        ? Promise.all([
          transcribePolzaAudio(audioPath, tempDir, credentials.apiKey, videoDuration, audio),
          credentials.groqApiKey
            ? transcribeWithFallback(audio, credentials.groqApiKey).catch((error) => {
              console.warn('Whisper не смог синхронизировать таймкоды Aiesa:', error.message);
              return null;
            })
            : Promise.resolve(null),
        ]).then(([polzaPayload, timingPayload]) => (
          timingPayload ? retimePolzaTranscript(polzaPayload, timingPayload) : polzaPayload
        ))
        : transcribeWithFallback(audio, credentials.apiKey),
      { from: 60, to: 82, expectedSeconds: transcriptionEstimate, onUpdate, stage: transcriptionStage },
    );

    const sourceLanguage = normalizeWhisperLanguage(payload.language);
    onUpdate({ progress: 83, stage: 'Проверяем видео на пропуски в субтитрах', etaSeconds: 20 });
    let gapProgress = 83;
    const completePayload = credentials.groqApiKey
      ? await fillTranscriptionGaps(
        payload,
        audioPath,
        tempDir,
        credentials.groqApiKey,
        videoDuration,
        sourceLanguage,
        (patch) => onUpdate({ ...patch, progress: (gapProgress = Math.min(90, gapProgress + 1)) }),
      )
      : payload;

    if (!credentials.groqApiKey && !isSerbianLanguage(completePayload.language)) {
      const error = new Error('Для перевода распознанной речи на сербский нужен GROQ_API_KEY на сервере или личный ключ Groq.');
      error.status = 503;
      error.code = 'MISSING_TRANSLATION_API_KEY';
      throw error;
    }
    const serbianPayload = credentials.groqApiKey
      ? await translatePayloadToSerbian(completePayload, credentials.groqApiKey, onUpdate)
      : completePayload;
    onUpdate({ progress: 99, stage: 'Сохраняем фрагменты и таймкоды', etaSeconds: 1 });
    return serbianPayload;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runTranscriptionJob(
  id,
  sourcePath,
  credentials,
  releaseAdmission = () => {},
) {
  try {
    const result = await processVideoTranscription(sourcePath, credentials, (patch) => updateTranscriptionJob(id, patch));
    updateTranscriptionJob(id, {
      status: 'done',
      progress: 100,
      stage: 'Субтитры готовы',
      etaSeconds: 0,
      result,
    });
  } catch (error) {
    updateTranscriptionJob(id, {
      status: 'error',
      stage: 'Распознавание остановлено',
      etaSeconds: null,
      error: error.message || 'Ошибка обработки видео.',
      code: error.code || (error.provider === 'groq' ? 'GROQ_TRANSCRIPTION_ERROR' : error.provider === 'polza' ? 'POLZA_TRANSCRIPTION_ERROR' : 'VIDEO_PROCESSING_ERROR'),
      statusCode: Number.isInteger(error.status) ? error.status : 500,
    });
    console.error(`[transcribe:${id}]`, error);
  } finally {
    await rm(sourcePath, { force: true }).catch(() => {});
    releaseAdmission();
  }
}

function potProviderErrorMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function pingYoutubePotProvider() {
  const response = await fetch(`${youtubePotProviderUrl}/ping`, {
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${youtubePotProviderUrl}/ping`);
  const result = await response.json();
  if (String(result?.version || '') !== youtubePotProviderVersion) {
    throw new Error(`provider version ${result?.version || 'unknown'} does not match plugin ${youtubePotProviderVersion}`);
  }
  youtubePotProviderState.version = String(result.version);
  return true;
}

function spawnYoutubePotProvider() {
  if (externalPotProviderUrl || youtubePotProviderStopping) return;
  if (youtubePotProviderProcess && youtubePotProviderProcess.exitCode === null) return;

  youtubePotProviderProcess = spawn(
    process.execPath,
    [managedPotProviderEntry, '--port', String(youtubePotProviderPort)],
    {
      cwd: managedPotProviderServerDir,
      env: process.env,
      windowsHide: true,
      // The provider prints generated tokens to stdout, so neither output stream may reach Render Logs.
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  youtubePotProviderProcess.on('error', (error) => {
    youtubePotProviderState.status = 'error';
    youtubePotProviderState.error = potProviderErrorMessage(error);
    console.error(`[youtube-pot] Provider process error: ${youtubePotProviderState.error}`);
  });
  youtubePotProviderProcess.on('exit', (code, signal) => {
    youtubePotProviderProcess = null;
    if (youtubePotProviderStopping) return;
    youtubePotProviderState.status = 'error';
    youtubePotProviderState.error = `provider exited with code ${code ?? 'none'}, signal ${signal || 'none'}`;
    console.error(`[youtube-pot] ${youtubePotProviderState.error}`);
  });
}

async function startYoutubePotProvider() {
  if (!youtubePotProviderConfigured || youtubePotProviderStopping) return false;
  if (youtubePotProviderState.status === 'ready') {
    if (!externalPotProviderUrl && youtubePotProviderProcess?.exitCode === null) return true;
    try {
      return await pingYoutubePotProvider();
    } catch {
      youtubePotProviderState.status = 'starting';
    }
  }
  if (youtubePotProviderStartPromise) return youtubePotProviderStartPromise;

  youtubePotProviderStartPromise = (async () => {
    youtubePotProviderState.status = 'starting';
    youtubePotProviderState.error = null;
    spawnYoutubePotProvider();
    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await pingYoutubePotProvider();
        youtubePotProviderState.status = 'ready';
        youtubePotProviderState.error = null;
        console.log(`[youtube-pot] Provider ${youtubePotProviderState.version} is ready at ${youtubePotProviderUrl}`);
        return true;
      } catch (error) {
        lastError = error;
        if (!externalPotProviderUrl && !youtubePotProviderProcess) spawnYoutubePotProvider();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    youtubePotProviderState.status = 'error';
    youtubePotProviderState.error = potProviderErrorMessage(lastError);
    console.error(`[youtube-pot] Provider did not become ready: ${youtubePotProviderState.error}`);
    return false;
  })().finally(() => {
    youtubePotProviderStartPromise = null;
  });

  return youtubePotProviderStartPromise;
}

function stopYoutubePotProvider() {
  youtubePotProviderStopping = true;
  if (youtubePotProviderProcess?.exitCode === null) youtubePotProviderProcess.kill('SIGTERM');
}

const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);

function parseYoutubeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!youtubeHosts.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function youtubeDownloadRateLimited(ip) {
  const now = Date.now();
  const recent = (youtubeDownloadAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 8) return true;
  recent.push(now);
  youtubeDownloadAttempts.set(ip, recent);
  return false;
}

const youtubeExtractorArgsOverride = String(process.env.YOUTUBE_EXTRACTOR_ARGS || '')
  .split(/\r?\n|\s*\|\|\s*/)
  .map((value) => value.trim())
  .filter(Boolean);
const youtubeCookiesFile = process.env.YOUTUBE_COOKIES_FILE || '';

function withYoutubeAuth(flags) {
  const poTokenReady = youtubePotProviderState.status === 'ready';
  const extractorArgs = youtubeExtractorArgsOverride.length
    ? [...youtubeExtractorArgsOverride]
    : poTokenReady
      ? [
        // Render IPs may be rejected while fetching the public watch page. Ask the provider for
        // a Player token before the InnerTube request and avoid that page, while keeping the
        // client-config request so yt-dlp can obtain the Visitor Data required for GVS tokens.
        'youtube:player_client=mweb;fetch_pot=always;player_skip=webpage',
      ]
      : ['youtube:player_client=default,web_embedded'];
  if (poTokenReady && !extractorArgs.some((value) => value.startsWith('youtubepot-bgutilhttp:'))) {
    extractorArgs.push(`youtubepot-bgutilhttp:base_url=${youtubePotProviderUrl}`);
  }
  const merged = {
    extractorArgs,
    jsRuntimes: [`node:${process.execPath}`],
    ...flags,
  };
  if (managedPotPluginAvailable) merged.pluginDirs = [managedYtDlpPluginDir];
  if (youtubeCookiesFile) merged.cookies = youtubeCookiesFile;
  return merged;
}

function youtubeErrorDetails(error) {
  const values = [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return [...new Set(values)].join('\n');
}

function diagnoseYoutubeError(error) {
  const details = youtubeErrorDetails(error);
  if (/spawn[\s\S]*enoent|yt-dlp[\s\S]*(?:not found|no such file or directory)/i.test(details)) {
    return {
      code: 'YOUTUBE_BINARY_MISSING',
      status: 500,
      message: 'На Render не установлен исполняемый файл yt-dlp. Его загрузка во время сборки не завершилась, поэтому сервер не может запустить скачивание.',
    };
  }
  if (/spawn[\s\S]*eacces|permission denied/i.test(details)) {
    return {
      code: 'YOUTUBE_BINARY_NOT_EXECUTABLE',
      status: 500,
      message: 'Render нашёл yt-dlp, но не может запустить файл из-за отсутствия права на выполнение.',
    };
  }
  if (/\[pot:bgutil:http\][^\n]*(?:error|failed)|error reaching (?:get|post)[^\n]*\/(?:ping|get_pot)|provider[^\n]*not (?:available|reachable)/i.test(details)) {
    return {
      code: 'YOUTUBE_PO_PROVIDER_UNAVAILABLE',
      status: 502,
      message: 'PO Token Provider запущен, но не смог получить токен от YouTube. Попробуйте ещё раз через минуту.',
    };
  }
  if (/sign in to confirm(?:.*)(?:not a bot|you.?re not a bot)|confirm your age.*bot|not a bot/i.test(details)) {
    return {
      code: 'YOUTUBE_BOT_CHECK',
      status: 502,
      message: youtubePotProviderState.status === 'ready'
        ? 'PO Token Provider подключён, но YouTube всё равно отклонил IP-адрес Render как автоматический. Для этого видео серверная загрузка недоступна.'
        : 'YouTube отклонил запрос с IP-адреса Render как автоматический, а PO Token Provider сейчас недоступен. Попробуйте ещё раз после перезапуска сервера.',
    };
  }
  if (/private video/i.test(details)) return { code: 'YOUTUBE_PRIVATE', status: 403, message: 'Это приватное видео — его нельзя скачать.' };
  if (/sign in to confirm your age|age[- ]restricted/i.test(details)) {
    return { code: 'YOUTUBE_AGE_RESTRICTED', status: 403, message: 'Видео имеет возрастное ограничение и недоступно без входа в аккаунт.' };
  }
  if (/video unavailable|has been removed|no longer available|not available/i.test(details)) {
    return { code: 'YOUTUBE_UNAVAILABLE', status: 404, message: 'Видео недоступно, удалено или заблокировано в регионе сервера.' };
  }
  if (/this live event|premieres in|is a live stream/i.test(details)) {
    return { code: 'YOUTUBE_LIVE_UNSUPPORTED', status: 400, message: 'Скачивание прямых трансляций пока не поддерживается.' };
  }
  if (/timed out|timeout/i.test(details)) {
    return { code: 'YOUTUBE_TIMEOUT', status: 504, message: 'YouTube отвечал слишком долго. Попробуйте ещё раз.' };
  }
  if (/requires?(?: a)? po[_ -]?token|po[_ -]?token (?:is )?(?:required|missing|not provided)|no po[_ -]?token (?:was )?provided|without (?:a )?po[_ -]?token/i.test(details)) {
    return {
      code: 'YOUTUBE_PO_TOKEN_REQUIRED',
      status: 502,
      message: youtubePotProviderState.status === 'ready'
        ? 'PO Token Provider подключён, но не смог выдать подходящий токен для этого видео.'
        : 'YouTube потребовал Proof of Origin Token, но локальный провайдер сейчас недоступен. Попробуйте ещё раз после перезапуска сервера.',
    };
  }
  if (/skipping unsupported client|unsupported client/i.test(details)) {
    return {
      code: 'YOUTUBE_UNSUPPORTED_CLIENT',
      status: 500,
      message: 'Установленная версия yt-dlp не поддерживает выбранный профиль YouTube-клиента.',
    };
  }
  if (/http error 403|forbidden/i.test(details)) {
    return {
      code: 'YOUTUBE_FORBIDDEN',
      status: 502,
      message: 'YouTube запретил загрузку с сервера Render (HTTP 403). Вероятна блокировка IP-адреса или отсутствие PO Token.',
    };
  }
  return {
    code: 'YOUTUBE_EXTRACTOR_ERROR',
    status: 502,
    message: 'yt-dlp не смог получить данные видео. Точная причина записана в Render Logs по номеру запроса.',
  };
}

function safeYoutubeDiagnostic(error) {
  const cleaned = youtubeErrorDetails(error)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const parsed = new URL(value);
        const videoId = parsed.searchParams.get('v');
        const port = parsed.port ? `:${parsed.port}` : '';
        return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}${videoId ? `?v=${videoId}` : ''}`;
      } catch {
        return '[url removed]';
      }
    })
    .replace(/(['"]?--cookies['"]?\s*,?\s*)['"][^'"]+['"]/gi, '$1[removed]')
    .replace(/\b(?:gsk_|AQVN)[A-Za-z0-9_-]+\b/g, '[secret removed]')
    .replace(/(cookie|authorization|po[_ -]?token|signature|sig)\s*[:=]\s*[^\s,;]+/gi, '$1=[removed]');
  if (cleaned.length <= 6000) return cleaned;
  return `${cleaned.slice(0, 1500)}\n...[diagnostic truncated]...\n${cleaned.slice(-4300)}`;
}

function publicYoutubeDiagnostic(error) {
  const lines = safeYoutubeDiagnostic(error).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.filter((line) => /^ERROR:/i.test(line)).at(-1);
  const warningLine = lines.filter((line) => /^WARNING:/i.test(line)).at(-1);
  const processLine = lines.filter((line) => /sign in|not a bot|http error|forbidden|unavailable|po[_ -]?token|spawn|enoent|eacces|permission denied|command failed|exit code|timed out|timeout|failed/i.test(line)).at(-1);
  const selected = errorLine || warningLine || processLine || '';
  return selected
    .replace(/^ERROR:\s*/i, '')
    .replace(/^WARNING:\s*/i, '')
    .replace(/[/\\](?:opt|tmp|var|home|workspace)[/\\][^\s]+/gi, '[server path]')
    .slice(0, 500);
}

function youtubeFailure(error, stage, requestId) {
  const diagnosis = diagnoseYoutubeError(error);
  const diagnostic = safeYoutubeDiagnostic(error);
  console.error(`[youtube:${requestId}] stage=${stage} code=${diagnosis.code} status=${diagnosis.status}`);
  if (diagnostic) console.error(`[youtube:${requestId}] yt-dlp diagnostic:\n${diagnostic}`);
  const wrapped = new Error(diagnosis.message, { cause: error });
  wrapped.status = diagnosis.status;
  wrapped.code = diagnosis.code;
  wrapped.requestId = requestId;
  wrapped.diagnostic = publicYoutubeDiagnostic(error);
  wrapped.youtubeLogged = true;
  return wrapped;
}

function asciiFallbackFilename(title, extension) {
  const cleaned = String(title || 'video').replace(/[^\x20-\x7e]/g, '').replace(/[/\\?%*:|"<>]/g, '').trim();
  return `${(cleaned || 'video').slice(0, 60)}${extension}`;
}

app.post('/api/youtube/download', async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const url = parseYoutubeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Вставьте полную ссылку на видео youtube.com или youtu.be.' });
  if (youtubeDownloadRateLimited(req.ip || req.socket.remoteAddress || 'unknown')) {
    return res.status(429).json({ error: 'Слишком много загрузок с YouTube за последний час. Попробуйте позже.' });
  }

  const poTokenReady = await startYoutubePotProvider();
  console.log(`[youtube:${requestId}] po-token-provider=${poTokenReady ? 'ready' : youtubePotProviderState.status}`);

  let tempDir;
  try {
    let info;
    try {
      info = await ytdlp(url, withYoutubeAuth({
        dumpSingleJson: true,
        verbose: true,
        noPlaylist: true,
        skipDownload: true,
      }), { timeout: 40_000 });
    } catch (error) {
      throw youtubeFailure(error, 'metadata', requestId);
    }
    if (info?.is_live) {
      const liveError = new Error('Скачивание прямых трансляций пока не поддерживается.');
      liveError.status = 400;
      throw liveError;
    }
    if (Number(info?.duration) > 3 * 60 * 60) {
      const tooLongError = new Error('Видео длиннее трёх часов. Выберите ролик покороче.');
      tooLongError.status = 413;
      throw tooLongError;
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-yt-'));
    const outputTemplate = path.join(tempDir, 'video.%(ext)s');
    try {
      await ytdlp(url, withYoutubeAuth({
        output: outputTemplate,
        // Prefer a ready progressive MP4 when YouTube exposes one. It avoids downloading and
        // merging two separate streams on a small one-core server.
        format: 'best[ext=mp4][vcodec^=avc1][height<=720][acodec!=none]/bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/best[vcodec^=avc1][height<=720]/best[height<=720]/best',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: ffmpegPath,
        noPlaylist: true,
        verbose: true,
        noCheckCertificates: true,
        concurrentFragments: 4,
        socketTimeout: 20,
        retries: 3,
        fragmentRetries: 3,
        abortOnUnavailableFragment: true,
      }), { timeout: 15 * 60 * 1000 });
    } catch (error) {
      throw youtubeFailure(error, 'download', requestId);
    }

    const files = await readdir(tempDir);
    const resultFile = files.find((name) => name.startsWith('video.') && /\.(mp4|webm|mkv)$/i.test(name));
    if (!resultFile) throw new Error('Не удалось найти скачанный файл видео.');
    const resultPath = path.join(tempDir, resultFile);
    const stats = await stat(resultPath);
    if (stats.size > maxVideoBytes) {
      const tooBigError = new Error('Видео с YouTube больше 2 ГБ.');
      tooBigError.status = 413;
      throw tooBigError;
    }

    const extension = path.extname(resultFile) || '.mp4';
    const title = String(info?.title || 'video').trim();
    const videoType = publishedVideoType(resultFile) || 'video/mp4';
    res.setHeader('Content-Type', videoType);
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('X-Video-Title', encodeURIComponent(title.slice(0, 200)));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallbackFilename(title, extension)}"; filename*=UTF-8''${encodeURIComponent(`${title}${extension}`)}`,
    );
    const stream = createReadStream(resultPath);
    stream.on('close', () => { rm(tempDir, { recursive: true, force: true }).catch(() => {}); });
    stream.on('error', (error) => {
      console.error('Ошибка передачи скачанного видео:', error);
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });
    stream.pipe(res);
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (!error.youtubeLogged) {
      console.error(`[youtube:${requestId}] stage=server code=${error.code || 'YOUTUBE_SERVER_ERROR'} status=${error.status || 502}`);
      console.error(`[youtube:${requestId}] diagnostic:\n${safeYoutubeDiagnostic(error)}`);
    }
    if (res.headersSent) return res.end();
    return res.status(error.status || 502).json({
      error: error.message || 'Не удалось скачать видео с YouTube.',
      code: error.code || 'YOUTUBE_SERVER_ERROR',
      requestId,
      diagnostic: error.diagnostic || '',
    });
  }
});

app.post(
  '/api/transcribe/jobs',
  admitTranscription,
  (req, _res, next) => {
    const id = randomUUID();
    req.transcriptionJobId = id;
    transcriptionJobs.set(id, {
      id,
      status: 'uploading',
      progress: 0,
      stage: 'Получаем видео от пользователя',
      etaSeconds: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastLoggedBucket: -1,
      lastLoggedStage: '',
    });
    updateTranscriptionJob(id, { progress: 0, stage: 'Получаем видео от пользователя', etaSeconds: null });
    next();
  },
  upload.single('video'),
  async (req, res) => {
    const id = req.transcriptionJobId;
    const sourcePath = req.file?.path;
    if (!req.file) {
      updateTranscriptionJob(id, { status: 'error', stage: 'Видео не получено', error: 'Сервер не получил видеофайл.' });
      return res.status(400).json({ error: 'Сервер не получил видеофайл.', code: 'MISSING_VIDEO_FILE' });
    }

    req.transcriptionAdmission.transferred = true;
    updateTranscriptionJob(id, { status: 'processing', progress: 20, stage: 'Видео загружено на сервер', etaSeconds: null });
    res.status(202).json({ id });
    setImmediate(() => runTranscriptionJob(
      id,
      sourcePath,
      req.transcriptionAdmission.credentials,
      req.transcriptionAdmission.release,
    ));
  },
);

app.get('/api/transcribe/jobs/:id', (req, res) => {
  const job = transcriptionJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача распознавания не найдена или уже удалена.' });
  return res.json(publicJob(job));
});

const jobCleanupTimer = setInterval(() => {
  const expiry = Date.now() - 30 * 60 * 1000;
  const abandonedExpiry = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of transcriptionJobs) {
    if (((job.status === 'done' || job.status === 'error') && job.updatedAt < expiry) || job.startedAt < abandonedExpiry) {
      transcriptionJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);
jobCleanupTimer.unref?.();

app.post('/api/transcribe', admitTranscription, upload.single('video'), async (req, res) => {
  const sourcePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'Сервер не получил видеофайл. Проверьте, что сайт развёрнут как Web Service, а не как Static Site.', code: 'MISSING_VIDEO_FILE' });
    req.transcriptionAdmission.transferred = true;
    return res.json(await processVideoTranscription(sourcePath, req.transcriptionAdmission.credentials));
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({
      error: error.message || 'Ошибка обработки видео.',
      code: error.code || (error.provider === 'groq' ? 'GROQ_TRANSCRIPTION_ERROR' : error.provider === 'polza' ? 'POLZA_TRANSCRIPTION_ERROR' : 'VIDEO_PROCESSING_ERROR'),
      provider: error.provider,
      model: error.model,
    });
  } finally {
    if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
    if (req.transcriptionAdmission.transferred) req.transcriptionAdmission.release();
  }
});

function publicBurnJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    etaSeconds: Number.isFinite(job.etaSeconds) ? Math.max(0, Math.round(job.etaSeconds)) : null,
    error: job.status === 'error' ? job.error : undefined,
    downloadUrl: job.status === 'done' ? `/api/burn/jobs/${job.id}/file` : undefined,
  };
}

async function runBurnJob(id) {
  const job = burnJobs.get(id);
  if (!job) return;
  job.status = 'processing';
  job.stage = 'Подготавливаем видео';
  job.progress = 1;
  job.updatedAt = Date.now();

  try {
    job.tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-render-'));
    job.outputPath = path.join(job.tempDir, 'video-sa-titlovima.mp4');
    const safeSubtitlePath = job.subtitlePath
      .replaceAll('\\', '/')
      .replace(':', '\\:')
      .replaceAll("'", "\\'");
    const renderStartedAt = Date.now();

    await runFfmpeg([
      '-y',
      '-i', job.videoPath,
      '-vf', `subtitles='${safeSubtitlePath}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00130E0C,BorderStyle=1,Outline=2,Shadow=0,MarginV=28'`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      job.outputPath,
    ], {
      onProgress: ({ fraction }) => {
        const elapsedSeconds = Math.max(1, (Date.now() - renderStartedAt) / 1000);
        job.progress = Math.min(99, 2 + (fraction * 97));
        job.stage = `Встраиваем субтитры в видео — ${Math.round(fraction * 100)}%`;
        job.etaSeconds = fraction > 0.01 ? (elapsedSeconds / fraction) * (1 - fraction) : null;
        job.updatedAt = Date.now();
      },
    });

    const stats = await stat(job.outputPath);
    job.size = stats.size;
    job.status = 'done';
    job.progress = 100;
    job.stage = 'MP4 готов к скачиванию';
    job.etaSeconds = 0;
    job.updatedAt = Date.now();
    console.log(`[burn:${id}] Готово за ${Math.round((Date.now() - job.startedAt) / 1000)} с, ${Math.round(stats.size / 1024 / 1024)} МБ`);
  } catch (error) {
    console.error(`[burn:${id}] Ошибка создания MP4:`, error);
    job.status = 'error';
    job.error = 'Не удалось создать MP4 с субтитрами. Попробуйте видео покороче или в формате MP4.';
    job.stage = 'Создание MP4 остановлено';
    job.updatedAt = Date.now();
    if (job.tempDir) await rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
  } finally {
    await rm(job.videoPath, { force: true }).catch(() => {});
    await rm(job.subtitlePath, { force: true }).catch(() => {});
  }
}

app.post(
  '/api/burn/jobs',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'subtitles', maxCount: 1 },
  ]),
  async (req, res) => {
    const videoPath = req.files?.video?.[0]?.path;
    const subtitlePath = req.files?.subtitles?.[0]?.path;
    if (!videoPath || !subtitlePath) {
      if (videoPath) await rm(videoPath, { force: true }).catch(() => {});
      if (subtitlePath) await rm(subtitlePath, { force: true }).catch(() => {});
      return res.status(400).json({ error: 'Нужны видео и файл с субтитрами.' });
    }

    const id = randomUUID();
    const now = Date.now();
    burnJobs.set(id, {
      id,
      status: 'queued',
      progress: 0,
      stage: 'Видео загружено, запускаем обработку',
      etaSeconds: null,
      startedAt: now,
      updatedAt: now,
      videoPath,
      subtitlePath,
      tempDir: null,
      outputPath: null,
      error: null,
    });
    res.status(202).json({ id });
    setImmediate(() => runBurnJob(id));
  },
);

app.get('/api/burn/jobs/:id', (req, res) => {
  const job = burnJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача создания MP4 не найдена или уже удалена.' });
  return res.json(publicBurnJob(job));
});

app.get('/api/burn/jobs/:id/file', (req, res) => {
  const job = burnJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Готовый MP4 уже удалён с сервера.' });
  if (job.status !== 'done' || !job.outputPath) return res.status(409).json({ error: 'MP4 ещё не готов.' });
  return res.download(job.outputPath, 'video-sa-srpskim-titlovima.mp4');
});

const burnCleanupTimer = setInterval(async () => {
  const completedExpiry = Date.now() - 30 * 60 * 1000;
  const abandonedExpiry = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of burnJobs) {
    const expired = (job.status === 'done' || job.status === 'error')
      ? job.updatedAt < completedExpiry
      : job.startedAt < abandonedExpiry;
    if (!expired) continue;
    if (job.tempDir) await rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
    await rm(job.videoPath, { force: true }).catch(() => {});
    await rm(job.subtitlePath, { force: true }).catch(() => {});
    burnJobs.delete(id);
  }
}, 5 * 60 * 1000);
burnCleanupTimer.unref?.();

app.post(
  '/api/burn',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'subtitles', maxCount: 1 },
  ]),
  async (req, res) => {
    const videoPath = req.files?.video?.[0]?.path;
    const subtitlePath = req.files?.subtitles?.[0]?.path;
    let tempDir;

    try {
      if (!videoPath || !subtitlePath) {
        return res.status(400).json({ error: 'Нужны видео и файл субтитров.' });
      }

      tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-render-'));
      const outputPath = path.join(tempDir, 'video-sa-titlovima.mp4');
      const safeSubtitlePath = subtitlePath
        .replaceAll('\\', '/')
        .replace(':', '\\:')
        .replaceAll("'", "\\'");

      await runFfmpeg([
        '-y',
        '-i', videoPath,
        '-vf', `subtitles='${safeSubtitlePath}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00130E0C,BorderStyle=1,Outline=2,Shadow=0,MarginV=28'`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ]);

      res.download(outputPath, 'video-sa-srpskim-titlovima.mp4', async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message || 'Не удалось создать MP4.' });
    } finally {
      if (videoPath) await rm(videoPath, { force: true }).catch(() => {});
      if (subtitlePath) await rm(subtitlePath, { force: true }).catch(() => {});
    }
  },
);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function isoDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${remainder || (!hours && !minutes) ? `${remainder}S` : ''}`;
}

function jsonLdScript(value) {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}

async function renderSeoHtml({ title, description, canonicalPath, type = 'website', image, video, structuredData, content, robots = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' }) {
  const canonicalUrl = `https://${canonicalHost}${canonicalPath}`;
  let html = await readFile(path.join(clientPath, 'index.html'), 'utf8');
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${safeDescription}" />`)
    .replace(/<meta name="robots"[^>]*>/i, `<meta name="robots" content="${escapeHtml(robots)}" />`)
    .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<link rel="alternate" hreflang="ru"[^>]*>/i, `<link rel="alternate" hreflang="ru" href="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<link rel="alternate" hreflang="x-default"[^>]*>/i, `<link rel="alternate" hreflang="x-default" href="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<meta property="og:type"[^>]*>/i, `<meta property="og:type" content="${escapeHtml(type)}" />`)
    .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${safeTitle}" />`)
    .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${safeDescription}" />`)
    .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<meta name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${safeTitle}" />`)
    .replace(/<meta name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${safeDescription}" />`);

  if (image) {
    html = html
      .replace(/<meta property="og:image"[^>]*>/i, `<meta property="og:image" content="${escapeHtml(image)}" />`)
      .replace(/<meta name="twitter:image"[^>]*>/i, `<meta name="twitter:image" content="${escapeHtml(image)}" />`);
  }

  const extraMeta = [
    video ? `<meta property="og:video" content="${escapeHtml(video)}" /><meta property="og:video:type" content="video/mp4" />` : '',
    structuredData ? jsonLdScript(structuredData) : '',
  ].filter(Boolean).join('\n    ');
  html = html.replace('</head>', `    ${extraMeta}\n  </head>`);
  html = html.replace(/<div id="root">[\s\S]*?<\/div>\s*<script type="module"/i, `<div id="root">${content}</div>\n    <script type="module"`);
  return html;
}

function publicVideoDescription(item) {
  return String(item.description || `${item.title} — видео с синхронными сербскими субтитрами и полным текстом реплик.`).trim().slice(0, 260);
}

app.get('/library', (_req, res) => res.redirect(301, '/subtitles'));

app.get('/subtitles', async (req, res) => {
  try {
    const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const requestedCategory = String(req.query.category || '').trim().toLocaleLowerCase('ru');
    const category = publicCategories.has(requestedCategory) ? requestedCategory : '';
    const allItems = await listPublicMetadata();
    const filteredItems = category ? allItems.filter((item) => item.category === category) : allItems;
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / 8));
    const page = Math.min(requestedPage, totalPages);
    const items = filteredItems.slice((page - 1) * 8, page * 8);
    const pageHref = (targetPage) => {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      if (targetPage > 1) params.set('page', String(targetPage));
      return `/subtitles${params.size ? `?${params}` : ''}`;
    };
    const links = items.map((item) => `
      <article>
        <h2><a href="/subtitles/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a></h2>
        <p>${escapeHtml(publicVideoDescription(item))}</p>
      </article>`).join('');
    const pageLinks = Array.from({ length: totalPages }, (_, index) => index + 1)
      .map((number) => number === page ? `<strong>${number}</strong>` : `<a href="${escapeHtml(pageHref(number))}">${number}</a>`)
      .join(' · ');
    const pagination = totalPages > 1 ? `<nav aria-label="Страницы библиотеки">${page > 1 ? `<a href="${escapeHtml(pageHref(page - 1))}">Назад</a> · ` : ''}${pageLinks}${page < totalPages ? ` · <a href="${escapeHtml(pageHref(page + 1))}">Дальше</a>` : ''}</nav>` : '';
    const heading = category ? `${category[0].toLocaleUpperCase('ru')}${category.slice(1)} с сербскими субтитрами` : 'Публичная библиотека видео с сербскими субтитрами';
    const title = `${heading}${page > 1 ? ` — страница ${page}` : ''}`;
    const canonicalPath = pageHref(page);
    const content = `<main class="seo-fallback"><nav aria-label="Хлебные крошки"><a href="/">Главная</a> → <a href="/subtitles">Библиотека субтитров</a>${category ? ` → ${escapeHtml(category)}` : ''}</nav><h1>${escapeHtml(heading)}</h1><p>Смотрите фильмы, мультфильмы, блоги и учебные видео с синхронными сербскими субтитрами. Каждая публикация открывается на отдельной странице вместе с полным текстом реплик.</p>${links || '<p>Новые публикации скоро появятся.</p>'}${pagination}</main>`;
    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: heading,
      url: `https://${canonicalHost}${canonicalPath}`,
      description: 'Открытая библиотека видео с синхронными сербскими субтитрами и текстом реплик.',
      hasPart: items.map((item) => ({ '@type': 'VideoObject', name: item.title, url: item.pageUrl })),
    };
    const linkHeaders = [];
    if (page > 1) linkHeaders.push(`<https://${canonicalHost}${pageHref(page - 1)}>; rel="prev"`);
    if (page < totalPages) linkHeaders.push(`<https://${canonicalHost}${pageHref(page + 1)}>; rel="next"`);
    if (linkHeaders.length) res.set('Link', linkHeaders.join(', '));
    return res.type('html').send(await renderSeoHtml({
      title,
      description: 'Публичная библиотека фильмов, мультфильмов, блогов и учебных видео с синхронными сербскими субтитрами и текстом реплик.',
      canonicalPath,
      image: `https://${canonicalHost}/assets/citavuk-guide.webp`,
      structuredData,
      content,
    }));
  } catch (error) {
    console.error('Не удалось подготовить SEO-страницу библиотеки:', error);
    return res.sendFile(path.join(clientPath, 'index.html'));
  }
});

app.get('/subtitles/:slug', async (req, res) => {
  try {
    const item = await resolvePublicMetadata(req.params.slug);
    if (!item) {
      const content = '<main class="seo-fallback"><h1>Видео не найдено</h1><p>Возможно, публикация была удалена. Вернитесь в <a href="/subtitles">библиотеку сербских субтитров</a>.</p></main>';
      return res.status(404).type('html').send(await renderSeoHtml({
        title: 'Видео не найдено — Читавук-речник',
        description: 'Публикация не найдена.',
        canonicalPath: req.path,
        robots: 'noindex, follow',
        content,
      }));
    }
    if (/^[a-f0-9-]{36}$/i.test(req.params.slug)) return res.redirect(301, `/subtitles/${encodeURIComponent(item.slug)}`);

    const description = publicVideoDescription(item);
    const shortTitle = item.title.length > 58 ? `${item.title.slice(0, 57).trim()}…` : item.title;
    const transcript = (item.segments || []).map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
    const canonicalPath = `/subtitles/${encodeURIComponent(item.slug)}`;
    const content = `<main class="seo-fallback seo-video-page"><nav aria-label="Хлебные крошки"><a href="/">Главная</a> → <a href="/subtitles">Библиотека</a> → ${escapeHtml(item.title)}</nav><h1>${escapeHtml(item.title)} — сербские субтитры</h1><p>${escapeHtml(description)}</p><p><strong>Категория:</strong> ${escapeHtml(item.category)}. <strong>Продолжительность:</strong> ${escapeHtml(Math.ceil((Number(item.duration) || 0) / 60))} мин.</p><h2>Текст видео на сербском языке</h2><p>${escapeHtml(transcript.slice(0, 5000))}</p></main>`;
    const structuredData = [
      {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: item.title,
        description,
        thumbnailUrl: [item.thumbnailUrl],
        uploadDate: item.createdAt,
        duration: isoDuration(item.duration),
        contentUrl: item.videoUrl,
        url: item.pageUrl,
        inLanguage: 'sr',
        transcript: transcript.slice(0, 5000),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Главная', item: `https://${canonicalHost}/` },
          { '@type': 'ListItem', position: 2, name: 'Библиотека', item: `https://${canonicalHost}/subtitles` },
          { '@type': 'ListItem', position: 3, name: item.title, item: item.pageUrl },
        ],
      },
    ];
    return res.type('html').send(await renderSeoHtml({
      title: `${shortTitle} — сербские субтитры`,
      description,
      canonicalPath,
      type: 'video.other',
      image: item.thumbnailUrl,
      video: item.videoUrl,
      structuredData,
      content,
    }));
  } catch (error) {
    console.error('Не удалось подготовить SEO-страницу видео:', error);
    return res.status(502).sendFile(path.join(clientPath, 'index.html'));
  }
});

app.get('/sitemap.xml', async (_req, res) => {
  try {
    const items = await listPublicMetadata();
    const urls = [
      `<url><loc>https://${canonicalHost}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
      `<url><loc>https://${canonicalHost}/subtitles</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
      ...items.map((item) => `<url><loc>${escapeXml(item.pageUrl)}</loc><lastmod>${escapeXml(String(item.createdAt || '').slice(0, 10))}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority><video:video><video:thumbnail_loc>${escapeXml(item.thumbnailUrl)}</video:thumbnail_loc><video:title>${escapeXml(item.title)}</video:title><video:description>${escapeXml(publicVideoDescription(item))}</video:description><video:content_loc>${escapeXml(item.videoUrl)}</video:content_loc></video:video></url>`),
    ].join('');
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${urls}</urlset>\n`);
  } catch (error) {
    console.error('Не удалось построить Sitemap:', error);
    return res.status(503).type('text/plain').send('Sitemap temporarily unavailable');
  }
});

app.use('/media', express.static(localMediaRoot, {
  dotfiles: 'deny',
  immutable: true,
  maxAge: '365d',
  index: false,
}));
app.use(express.static(clientPath, { index: false }));
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(clientPath, 'index.html'));
  }
  return next();
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Файл больше 2 ГБ.' });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: `Не удалось принять видеофайл: ${error.message}`,
      code: error.code || 'MULTIPART_UPLOAD_ERROR',
    });
  }
  console.error(error);
  res.status(500).json({ error: 'Непредвиденная ошибка сервера.' });
});

const httpServer = app.listen(port, host, () => {
  console.log(`Сайт запущен: http://${host}:${port}`);
});

backfillPublicThumbnails().catch((error) => {
  console.warn(`[public-library] Не удалось проверить обложки: ${error.message}`);
});

startYoutubePotProvider().catch((error) => {
  youtubePotProviderState.status = 'error';
  youtubePotProviderState.error = potProviderErrorMessage(error);
  console.error(`[youtube-pot] Startup failed: ${youtubePotProviderState.error}`);
});

function shutdown(signal) {
  console.log(`[server] ${signal}: stopping HTTP server and PO Token Provider`);
  stopYoutubePotProvider();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
