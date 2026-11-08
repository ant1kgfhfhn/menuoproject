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
const mobileBillingGuard = `
<script id="menuo-mobile-billing-guard">
(() => {
  'use strict';
  window.MENUO_MOBILE_APP = true;

  const copy = {
    ru: 'В этой версии приложения оформление новых подписок и смена тарифа через оплату временно недоступны. Уже активная подписка продолжает действовать.',
    de: 'In dieser App-Version sind neue Abonnements und kostenpflichtige Tarifwechsel vorübergehend nicht verfügbar. Ein bestehendes Abonnement bleibt aktiv.',
    en: 'New subscriptions and paid plan changes are temporarily unavailable in this app version. Existing subscriptions remain active.',
    uk: 'У цій версії застосунку оформлення нових підписок і платна зміна тарифу тимчасово недоступні. Чинна підписка продовжує діяти.'
  };

  const selectedLanguage = typeof state !== 'undefined' && state?.language
    ? state.language
    : (document.documentElement.lang || navigator.language || 'ru');
  const language = String(selectedLanguage).slice(0, 2).toLowerCase();
  let note = document.getElementById('menuo-mobile-billing-note');
  if (!note) {
    const anchor = document.getElementById('subscriptionNotice');
    if (anchor) {
      note = document.createElement('div');
      note.id = 'menuo-mobile-billing-note';
      note.className = 'notice';
      note.setAttribute('role', 'status');
      anchor.insertAdjacentElement('afterend', note);
    }
  }
  if (note) {
    note.textContent = copy[language] || copy.en;
    note.hidden = false;
  }

  ['chooseProPlan', 'chooseBusinessPlan'].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = true;
    button.textContent = language === 'de' ? 'In der App nicht verfügbar'
      : language === 'en' ? 'Unavailable in app'
      : language === 'uk' ? 'Недоступно в застосунку'
      : 'Недоступно в приложении';
    button.setAttribute('aria-disabled', 'true');
    const planCard = button.closest('.menu-card');
    const price = planCard?.querySelector('.price-large');
    if (price) price.hidden = true;
  });

  const promo = document.getElementById('promoCode')?.closest('.menu-card');
  if (promo) promo.hidden = true;

  document.querySelectorAll('#subscription .notice').forEach((element) => {
    if (element.textContent.includes('Оплата проходит через Stripe')) {
      element.hidden = true;
    }
  });

  // Keep a runtime guard as well as disabled controls: inline handlers or
  // accidental future UI changes must not start a Stripe Checkout from Android.
  window.startCheckout = async function menuoBlockedMobileCheckout() {
    if (note) {
      note.hidden = false;
      note.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return false;
  };
})();
</script>`;

if (!indexHtml.includes('</body>')) {
  throw new Error('MENUO index.html has no closing </body> element.');
}
const mobileIndexHtml = indexHtml
  .replace('</head>', mobileNavigationStyles + String.fromCharCode(10) + '</head>')
  .replace('</body>', mobileBillingGuard + String.fromCharCode(10) + '</body>');
await writeFile(indexPath, mobileIndexHtml, 'utf8');

console.log(`MENUO mobile web assets prepared in ${out} (${files.length} files) with native navigation styles.`);
