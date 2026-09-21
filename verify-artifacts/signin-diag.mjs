import { chromium } from '@playwright/test';
import fs from 'node:fs';

const LOG = 'verify-artifacts/signin-diag.log';
const t0 = Date.now();
const log = (s) => fs.appendFileSync(LOG, `${Date.now() - t0}\t${s}\n`);
fs.writeFileSync(LOG, '');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url())) || ctx.pages()[0];

// Redact any secret-bearing fields before logging.
function redactBody(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object') {
      const c = { ...o };
      for (const k of Object.keys(c)) if (/token|secret|password/i.test(k)) c[k] = `<redacted len=${String(c[k]).length}>`;
      return JSON.stringify(c).slice(0, 400);
    }
  } catch {}
  return text.slice(0, 400);
}

// Node-side network capture (survives reloads).
page.on('response', async (r) => {
  const u = r.url();
  if (/supabase\.co\/auth\/v1\//.test(u)) {
    let body = '';
    try { body = await r.text(); } catch {}
    const host = (u.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || '?';
    log(`AUTH_NET status=${r.status()} project=${host} path=${u.replace(/https:\/\/[a-z0-9]+\.supabase\.co/, '')} body=${redactBody(body)}`);
  }
});
ctx.on('page', (p) => p.on('response', async (r) => {
  if (/supabase\.co\/auth\/v1\//.test(r.url())) {
    let body = ''; try { body = await r.text(); } catch {}
    log(`AUTH_NET status=${r.status()} url=${r.url().replace(/https:\/\/[a-z0-9]+\.supabase\.co/, '')} body=${redactBody(body)}`);
  }
}));

// In-page instrumentation of supabase.auth.signInWithPassword (re-applied periodically).
const PATCH = async () => {
  try {
    const mod = await import('/services/supabaseClient.ts');
    const sb = mod.supabase;
    window.__sbHost = sb?.auth?.storageKey || null;
    if (!window.__signInPatched && sb && sb.auth && typeof sb.auth.signInWithPassword === 'function') {
      const orig = sb.auth.signInWithPassword.bind(sb.auth);
      sb.auth.signInWithPassword = async (...a) => {
        const email = (a[0] && a[0].email) || null;
        let res;
        try {
          res = await orig(...a);
        } catch (thrown) {
          window.__signInResult = { thrown: String(thrown && thrown.message || thrown), email };
          throw thrown;
        }
        window.__signInResult = {
          email,
          hasError: Boolean(res && res.error),
          error: res && res.error ? { message: res.error.message, code: res.error.code, status: res.error.status, name: res.error.name } : null,
          sessionNull: !(res && res.data && res.data.session),
          userNull: !(res && res.data && res.data.user),
        };
        return res;
      };
      window.__signInPatched = true;
    }
  } catch (e) { window.__patchErr = String(e); }
};

// Sign out via the ERP's normal UI.
log('SIGNING_OUT');
await page.bringToFront();
try {
  await page.getByRole('button', { name: /account menu for/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^log out$/i }).first().click({ timeout: 8000 });
  log('LOGOUT_CLICKED');
} catch (e) {
  log('LOGOUT_UI_ERR ' + String(e).slice(0, 160));
}

// Wait for the login screen, then re-apply the patch on the login page.
let onLogin = false;
for (let i = 0; i < 20 && !onLogin; i++) {
  await page.waitForTimeout(1000);
  onLogin = await page.evaluate(() => document.querySelectorAll('#login-email').length > 0).catch(() => false);
  await page.evaluate(PATCH).catch(() => {});
}
log('ON_LOGIN_PAGE=' + onLogin + ' url=' + page.url());

// Poll for the login attempt and its outcome.
const deadline = Date.now() + 12 * 60 * 1000;
let finished = false;
while (!finished && Date.now() < deadline) {
  await page.evaluate(PATCH).catch(() => {});
  const snap = await page.evaluate(async () => {
    const out = { signIn: window.__signInResult || null, patchErr: window.__patchErr || null };
    try {
      const { supabase } = await import('/services/supabaseClient.ts');
      const { data } = await supabase.auth.getSession();
      out.getSessionHas = Boolean(data.session);
      out.getSessionUser = data.session?.user?.id || null;
    } catch (e) { out.getSessionErr = String(e); }
    out.hasErpAuth = Boolean(localStorage.getItem('prime-erp-supabase-auth'));
    out.nexusUserAuthMode = (() => { try { return JSON.parse(sessionStorage.getItem('nexus_user') || 'null')?.authMode || null; } catch { return null; } })();
    return out;
  }).catch((e) => ({ evalErr: String(e).slice(0, 120) }));
  if (snap && (snap.signIn || snap.getSessionHas)) {
    log('RESULT ' + JSON.stringify(snap));
    if (snap.getSessionHas) finished = true;
  }
  await page.waitForTimeout(3000);
}
log('DIAG_END');
process.exit(0);
