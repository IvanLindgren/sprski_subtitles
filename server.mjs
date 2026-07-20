import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import ytdlpExec from 'yt-dlp-exec';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload as S3Upload } from '@aws-sdk/lib-storage';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const clientPath = path.join(process.cwd(), 'dist');
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
const transcriptionJobs = new Map();
const translationAttempts = new Map();
const translationCache = new Map();
const youtubeDownloadAttempts = new Map();
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

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024, fieldSize: 5 * 1024 * 1024, fields: 10 },
});

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Groq-Api-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition,X-Video-Title');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ffmpeg: Boolean(ffmpegPath),
    ytDlpBinary: managedYtDlpAvailable,
    poTokenProvider: youtubePotProviderState.status === 'ready',
    poTokenProviderStatus: youtubePotProviderState.status,
    poTokenProviderVersion: youtubePotProviderState.version,
    provider: 'groq',
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
  const apiKey = process.env.GROQ_API_KEY || req.get('x-groq-api-key');
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

function normalizePublishedSegments(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
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
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':') + `.${String(millis).padStart(3, '0')}`;
}

function makePublicVtt(segments) {
  return `WEBVTT\n\n${segments.map((segment) => `${vttTime(segment.start)} --> ${vttTime(segment.end)}\n${segment.text}`).join('\n\n')}\n`;
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

app.get('/api/public/videos', async (_req, res) => {
  if (!publicLibraryConfigured) return res.json({ configured: false, items: [] });
  try {
    const listing = await objectStorageClient.send(new ListObjectsV2Command({
      Bucket: objectStorage.bucket,
      Prefix: 'library/',
      MaxKeys: 60,
    }));
    const keys = (listing.Contents || [])
      .filter((item) => item.Key?.endsWith('.json'))
      .sort((left, right) => new Date(right.LastModified || 0) - new Date(left.LastModified || 0))
      .map((item) => item.Key.slice('library/'.length, -'.json'.length));
    const items = (await Promise.all(keys.map((id) => getPublicMetadata(id).catch(() => null))))
      .filter(Boolean)
      .map(publicListItem)
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return res.json({ configured: true, items });
  } catch (error) {
    console.error('Не удалось загрузить публичную библиотеку:', error);
    return res.status(502).json({ error: 'Хранилище публичных видео временно недоступно.' });
  }
});

app.get('/api/public/videos/:id', async (req, res) => {
  if (!publicLibraryConfigured) return res.status(503).json({ error: 'Публичная библиотека ещё не подключена.' });
  if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Некорректный адрес публикации.' });
  try {
    return res.json(await getPublicMetadata(req.params.id));
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
      const filename = safeFilename(req.file.originalname);
      const videoKey = `videos/${id}/${filename}`;
      const subtitleKey = `subtitles/${id}.vtt`;
      const videoUrl = publicObjectUrl(videoKey);
      const subtitleUrl = publicObjectUrl(subtitleKey);

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
        segments,
      };
      await objectStorageClient.send(new PutObjectCommand({
        Bucket: objectStorage.bucket,
        Key: `library/${id}.json`,
        Body: JSON.stringify(metadata),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache',
      }));

      return res.status(201).json(metadata);
    } catch (error) {
      console.error('Не удалось опубликовать видео:', error);
      return res.status(502).json({ error: error.message || 'Не удалось сохранить видео в публичной библиотеке.' });
    } finally {
      if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
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
  form.append('language', 'sr');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (options.withPrompt !== false) {
    form.append('prompt', 'Српски видео-садржај од самог почетка. Српска ћирилица или latinica.');
  }
  form.append('timestamp_granularities[]', 'segment');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
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

async function transcribeWithFallback(audio, apiKey, filename = 'speech.ogg') {
  try {
    return await requestGroqTranscription(audio, apiKey, filename);
  } catch (error) {
    if (error.status !== 400 || error.model !== 'whisper-large-v3') throw error;
    const payload = await requestGroqTranscription(audio, apiKey, filename, {
      model: 'whisper-large-v3-turbo',
      withPrompt: false,
    });
    payload.used_fallback_model = true;
    return payload;
  }
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
async function fillTranscriptionGaps(payload, audioPath, tempDir, apiKey, totalDuration, onUpdate = () => {}) {
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
      const clipPayload = await transcribeWithFallback(await readFile(clipPath), apiKey, `gap-${index}.ogg`);
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

async function processVideoTranscription(sourcePath, apiKey, onUpdate = () => {}) {
  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-audio-'));
    const audioPath = path.join(tempDir, 'speech.ogg');
    const extractionStartedAt = Date.now();
    let videoDuration = await probeDuration(sourcePath);
    const audioBitrateKbps = pickAudioBitrateKbps(videoDuration);
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
    if (audio.byteLength > 24.5 * 1024 * 1024) {
      const limitError = new Error('Аудиодорожка длиннее лимита бесплатного тарифа Groq. Разделите видео на части короче двух часов.');
      limitError.status = 413;
      throw limitError;
    }

    const groqEstimate = Math.max(25, Math.min(180, (videoDuration || 600) * 0.08));
    const payload = await runEstimatedStage(
      transcribeWithFallback(audio, apiKey),
      { from: 60, to: 92, expectedSeconds: groqEstimate, onUpdate, stage: 'Groq распознаёт сербскую речь' },
    );

    onUpdate({ progress: 93, stage: 'Проверяем видео на пропуски в субтитрах', etaSeconds: 20 });
    let gapProgress = 93;
    const completePayload = await fillTranscriptionGaps(
      payload,
      audioPath,
      tempDir,
      apiKey,
      videoDuration,
      (patch) => onUpdate({ ...patch, progress: (gapProgress = Math.min(98, gapProgress + 1)) }),
    );

    onUpdate({ progress: 99, stage: 'Сохраняем фрагменты и таймкоды', etaSeconds: 1 });
    return completePayload;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runTranscriptionJob(id, sourcePath, apiKey) {
  try {
    const result = await processVideoTranscription(sourcePath, apiKey, (patch) => updateTranscriptionJob(id, patch));
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
      code: error.provider === 'groq' ? 'GROQ_TRANSCRIPTION_ERROR' : 'VIDEO_PROCESSING_ERROR',
    });
    console.error(`[transcribe:${id}]`, error);
  } finally {
    await rm(sourcePath, { force: true }).catch(() => {});
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
        // Prefer H.264/AAC explicitly: YouTube's mp4 streams are sometimes AV1, which not every
        // browser can play natively in a <video> element. H.264 is universally supported.
        format: 'bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/best[vcodec^=avc1][height<=720]/best[ext=mp4][height<=720]/best[height<=720]/best',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: ffmpegPath,
        noPlaylist: true,
        verbose: true,
        noCheckCertificates: true,
      }), { timeout: 8 * 60 * 1000 });
    } catch (error) {
      throw youtubeFailure(error, 'download', requestId);
    }

    const files = await readdir(tempDir);
    const resultFile = files.find((name) => name.startsWith('video.') && /\.(mp4|webm|mkv)$/i.test(name));
    if (!resultFile) throw new Error('Не удалось найти скачанный файл видео.');
    const resultPath = path.join(tempDir, resultFile);
    const stats = await stat(resultPath);
    if (stats.size > 500 * 1024 * 1024) {
      const tooBigError = new Error('Видео с YouTube больше 500 МБ.');
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
    const apiKey = process.env.GROQ_API_KEY || req.get('x-groq-api-key');
    if (!req.file) {
      updateTranscriptionJob(id, { status: 'error', stage: 'Видео не получено', error: 'Сервер не получил видеофайл.' });
      return res.status(400).json({ error: 'Сервер не получил видеофайл.', code: 'MISSING_VIDEO_FILE' });
    }
    if (!apiKey) {
      await rm(sourcePath, { force: true }).catch(() => {});
      updateTranscriptionJob(id, { status: 'error', stage: 'Не указан ключ Groq', error: 'Добавьте ключ Groq в настройках сайта.' });
      return res.status(401).json({ error: 'Добавьте GROQ_API_KEY на сервере или укажите ключ в настройках сайта.', code: 'MISSING_API_KEY' });
    }

    updateTranscriptionJob(id, { status: 'processing', progress: 20, stage: 'Видео загружено на сервер', etaSeconds: null });
    res.status(202).json({ id });
    setImmediate(() => runTranscriptionJob(id, sourcePath, apiKey));
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

app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  const sourcePath = req.file?.path;
  const apiKey = process.env.GROQ_API_KEY || req.get('x-groq-api-key');
  try {
    if (!req.file) return res.status(400).json({ error: 'Сервер не получил видеофайл. Проверьте, что сайт развёрнут как Web Service, а не как Static Site.', code: 'MISSING_VIDEO_FILE' });
    if (!apiKey) return res.status(401).json({ error: 'Добавьте GROQ_API_KEY на сервере или укажите ключ в настройках сайта.', code: 'MISSING_API_KEY' });
    return res.json(await processVideoTranscription(sourcePath, apiKey));
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({
      error: error.message || 'Ошибка обработки видео.',
      code: error.provider === 'groq' ? 'GROQ_TRANSCRIPTION_ERROR' : 'VIDEO_PROCESSING_ERROR',
      provider: error.provider,
      model: error.model,
    });
  } finally {
    if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
  }
});

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

app.use(express.static(clientPath, { index: false }));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(clientPath, 'index.html'));
  }
  return next();
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Файл больше 500 МБ.' });
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
