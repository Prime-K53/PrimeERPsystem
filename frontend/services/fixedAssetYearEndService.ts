/**
 * Fixed Asset Year-End Check.
 *
 * Surfaces asset accounting issues that should be reviewed before
 * closing a financial year:
 *   - Pending capitalisations
 *   - Missing GL account mappings
 *   - Disposals missing journal linkage
 *   - Depreciation not posted for FY
 *
 * Read-only; the actual year-end close is performed by
 * `incomeSummaryService.closeYear`.
 */

import { dbService } from './db';
import { logger } from './logger';
import { roundFinancial } from '../utils/helpers';
import { DepreciationEntry, FixedAsset, AssetDisposal } from '../types';

export interface FixedAssetYearEndIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'pending-capitalisation' | 'missing-mapping' | 'disposal-no-journal' | 'no-depreciation' | 'unposted-acquisition';
  message: string;
  count?: number;
  amount?: number;
}

export interface FixedAssetYearEndReport {
  fiscalYear: number;
  generatedAt: string;
  issues: FixedAssetYearEndIssue[];
  summary: {
    totalAssets: number;
    activeAssets: number;
    pendingCapitalisation: number;
    fullyDepreciated: number;
    disposed: number;
    missingMapping: number;
    depreciationPosted: boolean;
    totalCost: number;
    totalNbv: number;
  };
}

export async function checkFixedAssetYearEnd(fiscalYear: number): Promise<FixedAssetYearEndReport> {
  const generatedAt = new Date().toISOString();
  const issues: FixedAssetYearEndIssue[] = [];

  try {
    const assets: FixedAsset[] = (await dbService.getAll<FixedAsset>('fixedAssets')) || [];
    const depEntries: DepreciationEntry[] = (await dbService.getAll<DepreciationEntry>('depreciationEntries')) || [];
    const disposals: AssetDisposal[] = (await dbService.getAll<AssetDisposal>('assetDisposals')) || [];

    const fyStart = `${fiscalYear}-01-01`;
    const fyEnd = `${fiscalYear}-12-31`;

    const active = assets.filter((a) => a.status !== 'disposed');
    const pendingCap = active.filter((a) => a.lifecycle_status === 'PendingCapitalisation' || a.lifecycle_status === 'Acquired');
    if (pendingCap.length > 0) {
      issues.push({
        severity: 'error',
        category: 'pending-capitalisation',
        message: `${pendingCap.length} asset(s) pending capitalisation`,
        count: pendingCap.length,
      });
    }

    const missing = active.filter((a) => !a.fixed_asset_account_id || !a.accumulated_depreciation_account_id || !a.depreciation_expense_account_id);
    if (missing.length > 0) {
      issues.push({
        severity: 'warning',
        category: 'missing-mapping',
        message: `${missing.length} asset(s) missing required GL account mapping`,
        count: missing.length,
      });
    }

    const fyDisposals = disposals.filter((d) => (d.disposal_date || '').slice(0, 10) >= fyStart && (d.disposal_date || '').slice(0, 10) <= fyEnd);
    const disposalsNoJournal = fyDisposals.filter((d) => !d.journal_entry_id);
    if (disposalsNoJournal.length > 0) {
      issues.push({
        severity: 'error',
        category: 'disposal-no-journal',
        message: `${disposalsNoJournal.length} disposal(s) in FY ${fiscalYear} are missing journal linkage`,
        count: disposalsNoJournal.length,
      });
    }

    const fyDepPosted = depEntries.some((d) => d.period_year === fiscalYear);
    const hasActive = active.length > 0;
    if (!fyDepPosted && hasActive) {
      issues.push({
        severity: 'warning',
        category: 'no-depreciation',
        message: `No depreciation posted for FY ${fiscalYear}`,
      });
    }

    const fyAcquisitions = active.filter((a) => (a.acquisition_date || '') >= fyStart && (a.acquisition_date || '') <= fyEnd);
    const totalCost = active.reduce((s, a) => s + roundFinancial(a.acquisition_cost || 0), 0);
    const totalNbv = active.reduce((s, a) => s + roundFinancial((a.acquisition_cost || 0) - (a.accumulated_depreciation_account_id ? 0 : 0)), 0); // NBV approximation

    return {
      fiscalYear,
      generatedAt,
      issues,
      summary: {
        totalAssets: assets.length,
        activeAssets: active.length,
        pendingCapitalisation: pendingCap.length,
        fullyDepreciated: active.filter((a) => a.status === 'fully_depreciated').length,
        disposed: assets.filter((a) => a.status === 'disposed').length,
        missingMapping: missing.length,
        depreciationPosted: fyDepPosted,
        totalCost,
        totalNbv,
      },
    };
  } catch (err) {
    logger.error('[FA YearEnd] check failed', err);
    return { fiscalYear, generatedAt, issues: [{ severity: 'error', category: 'missing-mapping', message: 'FA year-end check failed — see logs.' }], summary: { totalAssets: 0, activeAssets: 0, pendingCapitalisation: 0, fullyDepreciated: 0, disposed: 0, missingMapping: 0, depreciationPosted: false, totalCost: 0, totalNbv: 0 } };
  }
}
