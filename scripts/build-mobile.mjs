import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  'account-deletion.html',
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

const indexPath = resolve(out, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
const mobileNavigationStyles = `
<style id="menuo-capacitor-overrides">
.global-nav{position:fixed!important;z-index:99999;left:0;right:0;transform:none;width:min(100%,520px);margin-left:auto;margin-right:auto;bottom:0!important;background:rgba(255,255,255,.98);backdrop-filter:blur(12px);border-top:1px solid var(--line);display:flex;justify-content:space-around;padding:10px 7px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -6px 22px rgba(23,32,28,.10);min-height:64px;isolation:isolate}
</style>`;
if (!indexHtml.includes('</head>')) {
  throw new Error('MENUO index.html has no closing </head> element.');
}
await writeFile(indexPath, indexHtml.replace('</head>', mobileNavigationStyles + '\n</head>'), 'utf8');

console.log(`MENUO mobile web assets prepared in ${out} (${files.length} files) with native navigation styles.`);
