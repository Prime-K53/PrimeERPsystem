import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url())) || ctx.pages()[0];

console.log('URL:', page.url());
const info = await page.evaluate(() => ({
  inputs: Array.from(document.querySelectorAll('input')).map((i) => ({ id: i.id, type: i.type, ph: i.placeholder })),
  buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
  body: document.body.innerText.slice(0, 500),
}));
console.log(JSON.stringify(info, null, 2));
// Do not close the browser (we didn't launch it).
process.exit(0);
