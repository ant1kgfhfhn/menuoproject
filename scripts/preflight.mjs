import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import vm from 'node:vm';
const root = process.cwd();
const failures = [];
const checks = [];
const ok = (name) => checks.push(name);
const fail = (name, detail) => failures.push({ name, detail });
async function read(path) {
  try { return await readFile(resolve(root, path), 'utf8'); }
  catch (error) { fail(path, error.message); return ''; }
}
function syntaxCheck(path, source) {
  try { new vm.Script(source, { filename: path }); ok('JavaScript syntax: ' + path); }
  catch (error) { fail('JavaScript syntax: ' + path, error.message); }
}
const html = await read('index.html');
if (html) {
  if (!/<html\b[^>]*lang=["']en["']/i.test(html)) fail('Default document language', 'Expected <html lang="en">');
  else ok('Document language is English');
  const langs = html.match(/const LANGS\s*=\s*(\[[\s\S]*?\]);/);
  if (!langs || !/^\s*\[\s*\[['"]en['"]/.test(langs[1])) fail('Default language selector', 'English must be first in LANGS');
  else ok('English is first in language selector');
  if (!html.includes('menuo-default-language-v2')) fail('English migration', 'Missing one-time English default migration');
  else ok('English default migration exists');
  if (html.includes('logo.innerHTML=') && html.includes('<svg viewBox=\\\"0 0 112 32\\\"')) ok('MENUO wordmark is SVG');
  else fail('MENUO SVG wordmark', 'SVG wordmark source was not found');
  const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!inlineScripts.length) fail('Inline app script', 'No inline application script found');
  inlineScripts.forEach((match, index) => syntaxCheck('index.html inline script ' + (index + 1), match[1]));
  const localScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]).filter((src) => !/^https?:\/\//i.test(src));
  for (const src of localScripts) {
    const path = src.split('?')[0].replace(/^\//, '');
    const content = await read(path);
    if (content) syntaxCheck(path, content);
  }
  if (/langpair=[^'"]*auto\|/i.test(html)) fail('Translation provider language pair', 'MyMemory must never receive auto as a source language');
  else ok('No invalid auto source language pair');
  if (!html.includes('async function translateApplicationUI')) fail('UI translation runtime', 'Missing UI translation function');
  else ok('UI translation runtime present');
}
const build = await read('scripts/build-mobile.mjs');
const buildList = build.match(/const files = \[([\s\S]*?)\n\];/);
if (!buildList) fail('Mobile asset manifest', 'Could not read required files array');
else {
  const required = [...buildList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const path of required) {
    try { await access(resolve(root, path)); ok('Mobile asset exists: ' + path); }
    catch { fail('Mobile asset exists: ' + path, 'Required by build-mobile.mjs but missing'); }
  }
  if (!required.includes('index.html')) fail('Mobile entrypoint', 'index.html is not copied to www');
  if (!required.includes('menuo-visitor-fix.js')) fail('Mobile scanner runtime', 'menuo-visitor-fix.js is not copied to www');
}
for (const path of ['scripts/build-mobile.mjs', 'scripts/ensure-camera-permission.mjs']) {
  const result = spawnSync(process.execPath, ['--check', path], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) ok('Node module syntax: ' + path);
  else fail('Node module syntax: ' + path, result.stderr || result.stdout || 'exit ' + result.status);
}
if (failures.length) {
  console.error('MENUO release preflight FAILED');
  for (const item of failures) console.error('- ' + item.name + ': ' + item.detail);
  process.exitCode = 1;
} else console.log('MENUO release preflight passed: ' + checks.length + ' checks.');
