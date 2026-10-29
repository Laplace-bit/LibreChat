import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const shellDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(shellDirectory, '../..');
const require = createRequire(import.meta.url);
const envFile = path.join(repositoryRoot, '.env');

function parseEnv(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^(?:"([^"]*)"|'([^']*)').*$/, '$1$2')]),
  );
}

let fileEnv = {};
try {
  fileEnv = parseEnv(await readFile(envFile, 'utf8'));
} catch {
  // The local .env file is optional; use the documented local defaults.
}

const backendHost =
  process.env.BACKEND_HOST ||
  fileEnv.BACKEND_HOST ||
  process.env.HOST ||
  fileEnv.HOST ||
  'localhost';
const backendPort = process.env.BACKEND_PORT || fileEnv.BACKEND_PORT || '3080';
const rendererPort = process.env.AGENT_PLATFORM_RENDERER_PORT || '3091';
const formattedHost =
  backendHost.includes(':') && !backendHost.startsWith('[') ? `[${backendHost}]` : backendHost;
const serverUrl = process.env.AGENT_PLATFORM_SERVER_URL || `http://${formattedHost}:${backendPort}`;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

const viteBin = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const electronCli = require.resolve('electron/cli.js', { paths: [shellDirectory] });
const debugPort = process.env.AGENT_PLATFORM_REMOTE_DEBUG_PORT;

const vite = spawn(
  process.execPath,
  [viteBin, '--host', '127.0.0.1', '--port', rendererPort, '--strictPort'],
  {
    cwd: path.join(repositoryRoot, 'desktop'),
    env: {
      ...process.env,
      AGENT_PLATFORM_ELECTRON: '1',
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
  },
);

let shuttingDown = false;
const stop = (signal = 'SIGTERM') => {
  if (shuttingDown) return;
  shuttingDown = true;
  vite.kill(signal);
  if (electron && !electron.killed) electron.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

let electron;
try {
  await import('./build.mjs');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited with code ${vite.exitCode}.`);
    }
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(1200) });
      if (response.ok) break;
    } catch {
      await delay(300);
    }
  }
  const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) throw new Error(`Vite returned HTTP ${response.status}.`);

  const electronArguments = [electronCli];
  if (debugPort && /^\d{4,5}$/.test(debugPort)) {
    electronArguments.push(`--remote-debugging-port=${debugPort}`);
  }
  electronArguments.push(shellDirectory);
  electron = spawn(process.execPath, electronArguments, {
    cwd: shellDirectory,
    env: {
      ...process.env,
      AGENT_PLATFORM_ELECTRON: '1',
      AGENT_PLATFORM_RENDERER_URL: rendererUrl,
      AGENT_PLATFORM_SERVER_URL: serverUrl,
    },
    stdio: 'inherit',
  });
  electron.on('exit', (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
} catch (error) {
  stop();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
