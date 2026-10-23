#!/usr/bin/env node
/**
 * supabase/ops/run-sql.mjs — run SQL against a Supabase project through the
 * Management API.
 *
 * WHY: the SQL Editor needs a human; the Management API's
 * POST /v1/projects/{ref}/database/query endpoint accepts a personal access
 * token and executes one query string, which is enough to apply a migration
 * and read results back without a database password or an open 5432.
 *
 * AUTHENTICATION
 *   The token is read from, in order:
 *     1. the SUPABASE_ACCESS_TOKEN environment variable
 *     2. backend/.env.local          (gitignored)
 *     3. backend/.env               (gitignored)
 *   It is never printed, never written back to disk, and never sent anywhere
 *   except api.supabase.com.
 *
 * USAGE
 *   node supabase/ops/run-sql.mjs <file.sql>            run the file as one query
 *   node supabase/ops/run-sql.mjs <file.sql> --each     run it statement by statement
 *   node supabase/ops/run-sql.mjs <file.sql> --dry-run  print it, execute nothing
 *
 *   --each splits on top-level semicolons (dollar-quoted bodies are kept
 *   intact) and prints each result set. Use it for verification scripts.
 *   \echo lines are psql directives and are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: node supabase/ops/run-sql.mjs <file.sql> [--each] [--dry-run]');
  process.exit(2);
}
const sqlPath = path.resolve(ROOT, file);
if (!fs.existsSync(sqlPath)) {
  console.error(`not found: ${sqlPath}`);
  process.exit(2);
}

function readToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  for (const rel of ['backend/.env.local', 'backend/.env']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*SUPABASE_ACCESS_TOKEN\s*=\s*(.*)$/.exec(line);
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function readProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF.trim();
  for (const rel of ['backend/.env.local', 'backend/.env', 'frontend/.env']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:SUPABASE_URL|VITE_SUPABASE_URL)\s*=\s*(.*)$/.exec(line);
      if (m && m[1].trim()) {
        const ref = m[1].trim().replace(/^https?:\/\//, '').split('.')[0];
        if (ref) return ref;
      }
    }
  }
  return null;
}

/** Split a SQL script into top-level statements (dollar-quoted bodies intact). */
function splitStatements(sql) {
  const out = [];
  let stmt = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      stmt += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      stmt += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === q && sql[j + 1] === q) { j += 2; continue; }
        if (sql[j] === q) break;
        j++;
      }
      stmt += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar quote ${tag}`);
        stmt += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      stmt += ';';
      const t = stmt.trim();
      if (t) out.push(t);
      stmt = '';
      i++;
      continue;
    }
    stmt += c;
    i++;
  }
  const t = stmt.trim();
  if (t) out.push(t);
  return out;
}

async function query(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const print = (res) => {
  if (res.status >= 400) {
    console.log(`  HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 600)}`);
    return false;
  }
  const b = res.body;
  if (Array.isArray(b) && b.length) {
    const head = Object.keys(b[0]);
    console.log('  ' + head.join(' | '));
    for (const row of b) console.log('  ' + head.map((h) => String(row[h])).join(' | '));
  } else if (b && b.message) {
    console.log(`  ${b.message}`);
  } else {
    console.log(`  ${JSON.stringify(b).slice(0, 300)}`);
  }
  return true;
};

(async () => {
  const raw = fs.readFileSync(sqlPath, 'utf8');
  const ref = readProjectRef();
  const token = readToken();

  console.log(`file   : ${file}`);
  console.log(`project: ${ref || '(not found — set SUPABASE_PROJECT_REF)'}`);
  console.log(`token  : ${token ? 'present (not shown)' : 'MISSING'}`);

  if (has('--dry-run')) {
    const stmts = splitStatements(raw.split('\n').filter((l) => !/^\s*\\echo\b/i.test(l)).join('\n'));
    console.log(`\n--- ${stmts.length} statement(s), not executing ---`);
    stmts.forEach((s, i) => console.log(`\n[${i + 1}] ${s.slice(0, 400)}`));
    return;
  }
  if (!ref || !token) {
    console.error('\nCannot execute: need both a project ref and an access token.');
    process.exit(2);
  }

  const each = has('--each');
  // \echo is a psql directive, not SQL — strip it before splitting so it does
  // not glue itself onto the statement that follows it.
  const sqlOnly = raw.split('\n').filter((l) => !/^\s*\\echo\b/i.test(l)).join('\n');
  const statements = each ? splitStatements(sqlOnly) : [sqlOnly];

  console.log(`\n=== executing ${statements.length} statement(s) ===`);
  let failed = 0;
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const res = await query(ref, token, s);
    const label = each ? `[${i + 1}/${statements.length}]` : '[all]';
    console.log(`\n${label} ${s.replace(/\s+/g, ' ').slice(0, 110)}`);
    if (!print(res)) failed++;
  }
  console.log(`\n=== done: ${failed} failed statement(s) ===`);
  process.exit(failed ? 1 : 0);
})();
