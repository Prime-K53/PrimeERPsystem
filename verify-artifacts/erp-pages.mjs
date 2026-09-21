import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('pages:', pages.length);
for (const p of pages) {
  const url = p.url();
  if (!/localhost:5173/.test(url)) { console.log(' - (skip)', url.slice(0, 70)); continue; }
  const info = await p.evaluate(async () => {
    const loginInputs = document.querySelectorAll('#login-email, #login-password').length;
    let session = null;
    try {
      const { supabase } = await import('/services/supabaseClient.ts');
      const { data } = await supabase.auth.getSession();
      session = Boolean(data.session);
    } catch (e) { session = 'err:' + e.message; }
    return { loginInputs, session, bodyStart: document.body.innerText.slice(0, 80).replace(/\n/g, ' ') };
  });
  console.log(' *', url, JSON.stringify(info));
}
process.exit(0);
