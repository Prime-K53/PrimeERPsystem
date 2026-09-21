import { chromium } from '@playwright/test';
import fs from 'node:fs';

const LOG = 'verify-artifacts/login-capture.log';
const t0 = Date.now();
const log = (s) => fs.appendFileSync(LOG, `${Date.now() - t0}\t${s}\n`);
fs.writeFileSync(LOG, '');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

const attach = (p) => {
  p.on('console', (m) => {
    const t = m.text();
    if (/auth|supabase|session|login|sign|token|refresh|sync/i.test(t)) log(`CONSOLE[${m.type()}] ${t.slice(0, 300)}`);
  });
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) log(`NAV ${f.url()}`); });
  p.on('response', async (r) => {
    const u = r.url();
    if (/supabase\.co\/auth\/v1\/(token|signup|user)/.test(u)) {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch {}
      log(`AUTH ${r.status()} ${u.replace(/https:\/\/[a-z0-9]+\.supabase\.co/, '')} :: ${body.replace(/\s+/g, ' ')}`);
    }
  });
};
ctx.pages().forEach(attach);
ctx.on('page', attach);

const deadline = Date.now() + 9 * 60 * 1000;
let stopped = false;
while (!stopped && Date.now() < deadline) {
  const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
  if (page) {
    try {
      const s = await page.evaluate(async () => {
        let has = null;
        try {
          const { supabase } = await import('/services/supabaseClient.ts');
          const { data } = await supabase.auth.getSession();
          has = Boolean(data.session);
        } catch (e) { has = 'err'; }
        return { url: location.href.split('/#')[0] + (location.hash || ''), has, lsKeys: Object.keys(localStorage) };
      });
      log(`STATE session=${s.has} keys=[${s.lsKeys.join(',')}] url=${s.url}`);
      if (s.has === true) { log('SESSION_ESTABLISHED'); stopped = true; }
    } catch (e) { log('STATE_ERR ' + String(e).slice(0, 120)); }
  }
  await new Promise((r) => setTimeout(r, 3000));
}
log('CAPTURE_END');
process.exit(0);
