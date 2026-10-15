import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = resolve(repositoryRoot, 'dist');
if (relative(repositoryRoot, outputRoot) !== 'dist') {
  throw new Error('Build output must be the repository dist directory.');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, 'app/public'), { recursive: true });
await mkdir(resolve(outputRoot, 'contracts'), { recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ['app/server/index.ts'],
  outfile: resolve(outputRoot, 'app/server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ['app/public/app.ts'],
  outfile: resolve(outputRoot, 'app/public/app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'info',
});

const copiedFiles = ['app/public/index.html', 'app/public/style.css', 'contracts/openapi.yaml'];
for (const file of copiedFiles) {
  await copyFile(resolve(repositoryRoot, file), resolve(outputRoot, file));
}

const expectedFiles = ['app/server/index.js', 'app/public/app.js', ...copiedFiles];
for (const file of expectedFiles) {
  const details = await stat(resolve(outputRoot, file));
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Build artifact is missing or empty: ${file}`);
  }
}
console.log(
  'Production artifact built in dist/; runtime dependencies must be installed separately.',
);
