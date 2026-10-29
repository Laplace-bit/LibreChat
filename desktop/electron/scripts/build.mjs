import { build } from 'esbuild';
import { cp, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const shellDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(shellDirectory, '../..');
const outputDirectory = path.join(shellDirectory, 'dist');
const desktopRendererDirectory = path.join(repositoryRoot, 'desktop', 'dist');

await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(shellDirectory, 'src', 'main.ts')],
    outfile: path.join(outputDirectory, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(shellDirectory, 'src', 'preload.ts')],
    outfile: path.join(outputDirectory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(shellDirectory, 'src', 'setup.ts')],
    outfile: path.join(outputDirectory, 'setup.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    sourcemap: true,
  }),
]);

await cp(path.join(shellDirectory, 'src', 'setup.html'), path.join(outputDirectory, 'setup.html'));
await cp(path.join(shellDirectory, 'src', 'setup.css'), path.join(outputDirectory, 'setup.css'));

try {
  const rendererOutputDirectory = path.join(outputDirectory, 'renderer');
  await cp(desktopRendererDirectory, rendererOutputDirectory, { recursive: true });
  for (const name of await readdir(rendererOutputDirectory)) {
    if (name === 'sw.js' || name === 'sw-heal.js' || name === 'manifest.webmanifest' || /^workbox-.*\.js$/.test(name)) {
      await unlink(path.join(rendererOutputDirectory, name));
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
  console.info('Renderer build is not present yet; the packaged app will need desktop/dist.');
}

console.info(`Electron shell built at ${outputDirectory}`);
