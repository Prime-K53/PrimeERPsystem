import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
const out = await page.evaluate(async () => {
  const redact = (v) => {
    if (v == null) return null;
    try { const o = JSON.parse(v); if (o && typeof o === 'object') {
      const c = { ...o };
      for (const k of ['access_token', 'refresh_token', 'apiKey', 'accessToken']) if (c[k]) c[k] = `<redacted len=${String(c[k]).length}>`;
      return c;
    } } catch {}
    return v.length > 60 ? `<str len=${v.length}>` : v;
  };
  const lsKeys = Object.keys(localStorage);
  const ssKeys = Object.keys(sessionStorage);
  const erpAuth = localStorage.getItem('prime-erp-supabase-auth');
  let session = null;
  try {
    const { supabase } = await import('/services/supabaseClient.ts');
    const { data } = await supabase.auth.getSession();
    session = { has: Boolean(data.session), exp: data.session?.expires_at, now: Math.floor(Date.now() / 1000) };
  } catch (e) { session = { err: e.message }; }
  return {
    url: location.href,
    lsKeys, ssKeys,
    hasErpAuth: Boolean(erpAuth),
    erpAuth: redact(erpAuth),
    nexusUser: redact(sessionStorage.getItem('nexus_user')),
    cachedUser: redact(localStorage.getItem('nexus_cached_user_session')),
    session,
  };
});
console.log(JSON.stringify(out, null, 2));
process.exit(0);
