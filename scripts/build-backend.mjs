import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const distDir = path.join(projectRoot, 'dist');
const distDesktopDir = path.join(distDir, 'desktop');
const publicDir = path.join(projectRoot, 'public');
const bundledEntry = path.join(distDesktopDir, 'server-entry.js');

rmSync(distDir, { force: true, recursive: true });
mkdirSync(distDesktopDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: [path.join(projectRoot, 'desktop', 'server-entry.ts')],
  format: 'cjs',
  outfile: bundledEntry,
  platform: 'node',
  sourcemap: true,
  target: 'node20',
});

cpSync(publicDir, path.join(distDir, 'public'), { recursive: true });
