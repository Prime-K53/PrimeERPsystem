/**
 * supabaseWritePathGuard.test.ts — RLS/write-path regression guard.
 *
 * The sync architecture's single write path is:
 * IndexedDB -> durableSyncQueue -> POST /api/sync/ops (Admin-gated) ->
 * service-role gateway. The browser anon key must NEVER issue business
 * writes directly (migration 0040 rejects them at RLS). This test scans
 * the frontend source tree and fails if any direct
 * supabase.from('<table>').insert/update/upsert/delete call appears,
 * except the explicitly allow-listed legacy idempotency probe.
 *
 * Legitimate direct anon-key uses (kept): pull SELECT, realtime, Storage,
 * auth, and the legacy idempotency_keys probe (different table, backend
 * remains authoritative).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['services', 'utils', 'views', 'components', 'stores', 'context', 'hooks', 'src'];

// Explicitly allow-listed legacy exception (different table, backend
// remains authoritative for idempotency).
const ALLOW_LISTED_PATTERNS = [/idempotency_keys/];

// Tables whose rows are authoritative financial/operational state.
const GUARDED_TABLES = [
  'invoices',
  'examination_batches',
  'examination_classes',
  'examination_subjects',
  'documents',
  'ledger_entries',
  'sales_orders',
  'customers',
  'inventory',
];

const collectFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
};

describe('supabase write-path guard', () => {
  it('has no direct anon-key business writes outside the sync gateway', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      const root = path.join(FRONTEND_ROOT, dir);
      if (!fs.existsSync(root)) continue;
      for (const file of collectFiles(root)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!/supabase\s*\.\s*from\s*\(/.test(line)) return;
          if (!/\.(insert|update|upsert|delete)\s*\(/.test(line)) return;
          if (ALLOW_LISTED_PATTERNS.some((pattern) => pattern.test(line))) return;
          const tableHit = GUARDED_TABLES.find((table) => line.includes(`'${table}'`) || line.includes(`"${table}"`));
          // Dynamic table names (pull SELECT path) carry no write call on the
          // same line; anything else with a guarded table is a violation.
          if (tableHit || !/from\s*\(\s*[a-zA-Z_$]/.test(line)) {
            offenders.push(`${path.relative(FRONTEND_ROOT, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
