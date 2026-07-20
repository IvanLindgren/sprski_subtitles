import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NETLIFY === 'true') {
  console.log('[youtube-pot] Skipped for the frontend-only Netlify build');
  process.exit(0);
}

const providerVersion = '1.3.1';
const pluginSha256 = 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const toolsDir = path.join(projectRoot, '.tools');
const providerRoot = path.join(toolsDir, 'bgutil-ytdlp-pot-provider');
const providerServerDir = path.join(providerRoot, 'server');
const providerEntry = path.join(providerServerDir, 'build', 'main.js');
const providerPackage = path.join(providerServerDir, 'package.json');
const providerRuntimeDependency = path.join(providerServerDir, 'node_modules', 'express', 'package.json');
const pluginDir = path.join(toolsDir, 'yt-dlp-plugins');
const pluginPath = path.join(pluginDir, 'bgutil-ytdlp-pot-provider.zip');
const temporaryPluginPath = `${pluginPath}.download`;
const repositoryUrl = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git';
const pluginUrl = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${providerVersion}/bgutil-ytdlp-pot-provider.zip`;

function assertManagedPath(target) {
  const relative = path.relative(path.resolve(toolsDir), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify a path outside .tools: ${target}`);
  }
}

function run(command, args, cwd) {
  const useShell = process.platform === 'win32' && /\.cmd$/i.test(command);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: useShell,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function runNpm(args, cwd) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args], cwd);
    return;
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function providerIsReady() {
  try {
    const packageJson = JSON.parse(await readFile(providerPackage, 'utf8'));
    const details = await stat(providerEntry);
    const runtimeDependencyDetails = await stat(providerRuntimeDependency);
    return packageJson.version === providerVersion
      && details.size > 500
      && runtimeDependencyDetails.size > 100;
  } catch {
    return false;
  }
}

async function pluginIsReady() {
  try {
    const details = await stat(pluginPath);
    return details.size > 4_000 && await sha256(pluginPath) === pluginSha256;
  } catch {
    return false;
  }
}

async function installPlugin() {
  if (await pluginIsReady()) {
    console.log(`[youtube-pot] yt-dlp plugin ${providerVersion} is ready`);
    return;
  }

  assertManagedPath(pluginPath);
  await mkdir(pluginDir, { recursive: true });
  await rm(pluginPath, { force: true });
  await rm(temporaryPluginPath, { force: true });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`[youtube-pot] Downloading yt-dlp plugin ${providerVersion}, attempt ${attempt}/3`);
      const response = await fetch(pluginUrl, {
        headers: { 'User-Agent': 'citavuk-render-build' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      await writeFile(temporaryPluginPath, archive);
      const digest = await sha256(temporaryPluginPath);
      if (digest !== pluginSha256) throw new Error(`Unexpected plugin SHA-256: ${digest}`);
      await rename(temporaryPluginPath, pluginPath);
      console.log(`[youtube-pot] yt-dlp plugin ${providerVersion} installed and verified`);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPluginPath, { force: true }).catch(() => {});
      console.error(`[youtube-pot] Plugin attempt ${attempt} failed: ${error.message}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }
  throw new Error(`Unable to install the yt-dlp PO Token plugin: ${lastError?.message || 'unknown error'}`);
}

async function installProvider() {
  if (await providerIsReady()) {
    console.log(`[youtube-pot] HTTP provider ${providerVersion} is ready`);
    return;
  }

  assertManagedPath(providerRoot);
  await rm(providerRoot, { recursive: true, force: true });
  await mkdir(toolsDir, { recursive: true });

  console.log(`[youtube-pot] Cloning HTTP provider ${providerVersion}`);
  run('git', [
    'clone',
    '--depth', '1',
    '--single-branch',
    '--branch', providerVersion,
    repositoryUrl,
    providerRoot,
  ], projectRoot);

  console.log('[youtube-pot] Installing provider dependencies');
  runNpm(['ci'], providerServerDir);

  const typescriptCompiler = path.join(providerServerDir, 'node_modules', 'typescript', 'bin', 'tsc');
  console.log('[youtube-pot] Compiling provider');
  run(process.execPath, [typescriptCompiler, '--project', path.join(providerServerDir, 'tsconfig.json')], providerServerDir);

  console.log('[youtube-pot] Removing build-only dependencies');
  runNpm(['prune', '--omit=dev'], providerServerDir);
  await rm(path.join(providerRoot, '.git'), { recursive: true, force: true });

  if (!await providerIsReady()) throw new Error('The PO Token HTTP provider build did not produce build/main.js');
  console.log(`[youtube-pot] HTTP provider ${providerVersion} installed and verified`);
}

await installPlugin();
await installProvider();
