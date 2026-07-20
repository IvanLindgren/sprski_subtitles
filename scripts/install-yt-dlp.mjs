import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NETLIFY === 'true') {
  console.log('[yt-dlp] Skipped for the frontend-only Netlify build');
  process.exit(0);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const toolsDir = path.join(projectRoot, '.tools');
const executableName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const destination = process.env.YOUTUBE_DL_PATH || path.join(toolsDir, executableName);

const assetByPlatform = {
  linux: {
    x64: 'yt-dlp_linux',
    arm64: 'yt-dlp_linux_aarch64',
  },
  win32: {
    x64: 'yt-dlp.exe',
    arm64: 'yt-dlp_arm64.exe',
  },
  darwin: {
    x64: 'yt-dlp_macos',
    arm64: 'yt-dlp_macos',
  },
};

const assetName = assetByPlatform[process.platform]?.[process.arch];
if (!assetName) throw new Error(`Unsupported platform for yt-dlp: ${process.platform}/${process.arch}`);

const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
const temporary = process.platform === 'win32' ? `${destination}.download.exe` : `${destination}.download`;

function readVersion(executable) {
  return execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

async function existingVersion() {
  try {
    const details = await stat(destination);
    if (details.size < 1024 * 1024) return '';
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    return readVersion(destination);
  } catch {
    return '';
  }
}

const installedVersion = await existingVersion();
if (installedVersion) {
  console.log(`[yt-dlp] Existing binary is ready: ${installedVersion}`);
  process.exit(0);
}

await mkdir(path.dirname(destination), { recursive: true });
await rm(destination, { force: true });

let lastError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    console.log(`[yt-dlp] Downloading ${assetName}, attempt ${attempt}/3`);
    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'citavuk-render-build' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

    const binary = Buffer.from(await response.arrayBuffer());
    if (binary.length < 1024 * 1024) throw new Error(`Downloaded file is unexpectedly small: ${binary.length} bytes`);

    await writeFile(temporary, binary);
    if (process.platform !== 'win32') await chmod(temporary, 0o755);
    await rename(temporary, destination);
    const version = readVersion(destination);
    console.log(`[yt-dlp] Installed and verified: ${version}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await rm(temporary, { force: true }).catch(() => {});
    await rm(destination, { force: true }).catch(() => {});
    console.error(`[yt-dlp] Attempt ${attempt} failed: ${error.message}`);
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
}

throw new Error(`Unable to install yt-dlp after 3 attempts: ${lastError?.message || 'unknown error'}`);
