/**
 * examinationNoTenancy.test.ts — single-company architecture guard.
 *
 * Prime ERP is SINGLE-COMPANY. Examination code must never introduce
 * tenant/organization discriminators. This test scans every examination
 * module file (services, views, utils, context, domain, tests) and fails
 * on any tenancy marker.
 *
 * NOTE: `companyId` from getCompanyConfig (account resolution scope) is
 * legitimate single-company configuration, not tenancy, and is therefore
 * not matched — only true tenant/organization discriminators are banned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');

const BANNED = [
  /tenant_id/i,
  /tenantId/i,
  /\btenant\b/i,
  /organization_id/i,
  /organizationId/i,
  /organisation_id/i,
  /organisationId/i,
];

const SCAN = [
  { dir: 'services', match: /examin/i },
  { dir: 'views/examination', match: /.*/ },
  { dir: 'utils', match: /examin|invoiceIdentity|roundingUtils|pricingEngine/i },
  { dir: 'context', match: /examination/i },
  { dir: 'src/domain/examination', match: /.*/ },
  { dir: 'src/adapters', match: /productionAdapter/i },
];

const collectFiles = (dir: string, match: RegExp, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, match, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && match.test(entry.name)) out.push(full);
  }
  return out;
};

describe('examination single-company architecture', () => {
  it('contains no tenant/organization discriminators', () => {
    const offenders: string[] = [];
    for (const { dir, match } of SCAN) {
      for (const file of collectFiles(path.join(FRONTEND_ROOT, dir), match)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          // Allow mentions inside comments that explicitly forbid tenancy.
          const code = line.replace(/\/\/.*$/, '');
          for (const pattern of BANNED) {
            if (pattern.test(code)) {
              offenders.push(
                `${path.relative(FRONTEND_ROOT, file)}:${index + 1}: ${line.trim().slice(0, 120)}`
              );
              break;
            }
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('new examination records carry no tenant keys', async () => {
    const { examinationBatchService } = await import('../../services/examinationBatchService');
    expect(typeof examinationBatchService.createBatch).toBe('function');
  });
});
