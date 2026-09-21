/**
 * Watch for session establishment after the user logs in on the live page.
 * READ-ONLY: never touches credentials; just polls supabase.auth.getSession()
 * through the app's own supabaseClient module until a session exists.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const LOG = 'verify-artifacts/dl-auth-watch.log';
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()}\t${s}\n`);
fs.writeFileSync(LOG, '');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

const deadline = Date.now() + 15 * 60 * 1000;
let established = false;

while (!established && Date.now() < deadline) {
  const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
  if (!page) { log('NO_ERP_PAGE'); await new Promise((r) => setTimeout(r, 3000)); continue; }
  try {
    const s = await page.evaluate(async () => {
      try {
        const { supabase } = await import('/services/supabaseClient.ts');
        const { data, error } = await supabase.auth.getSession();
        return {
          has: Boolean(data?.session),
          userId: data?.session?.user?.id ?? null,
          expiresAt: data?.session?.expires_at ?? null,
          error: error?.message ?? null,
          nexusAuthMode: (() => { try { return JSON.parse(sessionStorage.getItem('nexus_user') || 'null')?.authMode ?? null; } catch { return null; } })(),
          url: location.hash || location.pathname,
        };
      } catch (e) { return { err: String(e).slice(0, 160) }; }
    });
    log(`state ${JSON.stringify(s)}`);
    if (s && s.has === true) {
      established = true;
      log(`SESSION_ESTABLISHED userId=${s.userId} expiresAt=${s.expiresAt} authMode=${s.nexusAuthMode}`);
    }
  } catch (e) {
    log(`EVAL_ERR ${String(e).slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

log(established ? 'DONE' : 'TIMEOUT_NO_SESSION');
console.log(established ? 'SESSION_ESTABLISHED' : 'TIMEOUT_NO_SESSION');
process.exit(established ? 0 : 3);
