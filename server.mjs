import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const clientPath = path.join(process.cwd(), 'dist');

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: Boolean(ffmpegPath), provider: 'groq' });
});

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, {
      windowsHide: true,
      ...options,
    });
    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `FFmpeg завершился с кодом ${code}`));
    });
  });
}

async function requestGroqTranscription(audio, apiKey, filename = 'speech.ogg') {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), filename);
  form.append('model', 'whisper-large-v3');
  form.append('language', 'sr');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('prompt', 'Ово је видео на српском језику. Транскрибуј све изговорене речи од самог почетка, без прескакања увода. Задржи српску ћирилицу или латиницу како је изговорено.');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Groq не смог обработать аудио.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  const sourcePath = req.file?.path;
  const apiKey = process.env.GROQ_API_KEY || req.get('x-groq-api-key');
  let tempDir;

  try {
    if (!req.file) return res.status(400).json({ error: 'Видео не получено.' });
    if (!apiKey) {
      return res.status(401).json({
        error: 'Добавьте GROQ_API_KEY на сервере или укажите ключ в настройках сайта.',
        code: 'MISSING_API_KEY',
      });
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'recnik-audio-'));
    const audioPath = path.join(tempDir, 'speech.ogg');

    await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-vn',
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:a', 'libopus',
      '-b:a', '24k',
      audioPath,
    ]);

    const audio = await readFile(audioPath);
    if (audio.byteLength > 24.5 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Аудиодорожка длиннее лимита бесплатного тарифа Groq. Разделите видео на части короче двух часов.',
      });
    }

    const payload = await requestGroqTranscription(audio, apiKey);

    const firstStart = Number(payload.segments?.[0]?.start);
    if (Number.isFinite(firstStart) && firstStart > 2.5) {
      try {
        const introPath = path.join(tempDir, 'intro.ogg');
        const introDuration = Math.min(65, Math.ceil(firstStart + 6));
        await runFfmpeg([
          '-y',
          '-i', audioPath,
          '-t', String(introDuration),
          '-af', 'asetpts=PTS-STARTPTS',
          '-c:a', 'libopus',
          '-b:a', '24k',
          introPath,
        ]);
        const introPayload = await requestGroqTranscription(await readFile(introPath), apiKey, 'intro.ogg');
        const recovered = (introPayload.segments || []).filter((segment) => (
          Number(segment.start) < firstStart - 0.2 && Number(segment.end) <= firstStart + 0.5
        ));
        if (recovered.length) {
          payload.segments = [...recovered, ...payload.segments];
          payload.text = payload.segments.map((segment) => segment.text).join(' ').trim();
          payload.recovered_intro_segments = recovered.length;
        }
      } catch (introError) {
        console.warn('Не удалось отдельно проверить начало аудио:', introError.message);
      }
    }

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ error: error.message || 'Ошибка обработки видео.' });
  } finally {
    if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
  console.error(error);
  res.status(500).json({ error: 'Непредвиденная ошибка сервера.' });
});

app.listen(port, host, () => {
  console.log(`Сайт запущен: http://${host}:${port}`);
});
