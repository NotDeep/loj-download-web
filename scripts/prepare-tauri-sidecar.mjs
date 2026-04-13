import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');

function resolveRustHostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const hostLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('host: '));

  if (!hostLine) {
    throw new Error(`Unable to determine Rust host triple from:\n${output}`);
  }

  return hostLine.slice('host: '.length);
}

const hostTriple = resolveRustHostTriple();
const sidecarBaseName = 'loj-download-node';
const targetTriples = new Set([hostTriple]);

if (process.platform === 'darwin') {
  targetTriples.add('aarch64-apple-darwin');
  targetTriples.add('x86_64-apple-darwin');
}

mkdirSync(binariesDir, { recursive: true });

for (const entry of readdirSync(binariesDir)) {
  if (!entry.startsWith(`${sidecarBaseName}-`)) continue;
  rmSync(path.join(binariesDir, entry), { force: true, recursive: true });
}

if (!existsSync(process.execPath)) {
  throw new Error(`Current Node executable does not exist: ${process.execPath}`);
}

for (const triple of targetTriples) {
  const extension = triple.includes('windows') ? '.exe' : '';
  const targetPath = path.join(binariesDir, `${sidecarBaseName}-${triple}${extension}`);
  copyFileSync(process.execPath, targetPath);
  chmodSync(targetPath, 0o755);
  console.log(`Prepared Tauri sidecar: ${targetPath}`);
}
