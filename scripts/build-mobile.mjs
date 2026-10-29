import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const out = resolve(root, 'www');
const files = [
  'index.html',
  'favicon.svg',
  'menuo-bimi.svg',
  'impressum.html',
  'privacy.html',
  'terms.html',
  'widerruf.html',
  'account-persistence-v2.js',
  'account-persistence.js',
  'account-ui-guard.js',
  'menuo-auth.js',
  'menuo-backend.js',
  'menuo-remote.js',
  'menuo-visitor-fix.js'
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of files) {
  const source = resolve(root, file);
  try {
    await stat(source);
  } catch {
    throw new Error(`Required MENUO web file is missing: ${file}`);
  }
  await cp(source, resolve(out, file));
}

console.log(`MENUO mobile web assets prepared in ${out} (${files.length} files).`);
