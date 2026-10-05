/**
 * repairFixedAssetOrphanLedger.ts
 *
 * One-time, idempotent data-repair for the 11200 Bank Accounts
 * distortion (K-3,413,300 investigation).
 *
 * Background
 * ------------
 * Fixed-asset acquisitions post a Dr Fixed Asset / Cr Bank journal entry
 * (entryType = "FA_ACQUISITION", reference = "FA-ACQ-<asset_code>").
 * Assets deleted by older versions of fixedAssetService.delete() never
 * reversed that entry, leaving orphaned bank-side credits that
 * permanently depressed the 11200 Bank Accounts balance.
 *
 * This script:
 *   1. Scans the `ledger` store for FA_ACQUISITION entries that credit
 *      a BANK-subtype account (resolved from the accounts store — no
 *      hardcoded account codes).
 *   2. For each, checks whether the asset still exists in `fixedAssets`.
 *      If it does, the entry is NOT orphaned — skipped.
 *   3. Checks whether a reversal already exists (FA_ACQUISITION_REVERSAL
 *      with referenceId "FA-ACQ-REV-<asset_code>") — idempotency guard.
 *   4. Reverses ONLY the orphans through the app's existing reversal
 *      mechanism (fixedAssetService.reverseAcquisitionJournal ->
 *      ledgerService.createJournalEntry), which validates double-entry
 *      balance and resolves accounts exactly like a live posting.
 *
 * SAFETY:
 *   - Idempotent: already-reversed entries are skipped on re-run.
 *   - Does NOT delete or modify any original ledger row.
 *   - Does NOT touch non-FA_ACQUISITION rows (legitimate bank
 *     transactions are preserved byte-for-byte).
 *   - Never writes Account.balance — the 11200 total is derived by
 *     hierarchical rollup, never patched.
 *
 * HOW TO RUN:
 *   Open the application in the browser, open DevTools -> Console, then
 *   paste and execute the contents of this file.
 */

import { dbService } from '../services/db';
import { fixedAssetService } from '../services/fixedAssetService';
import { loadAccountsFromStore } from '../services/transactions/_internal';
import { FixedAsset } from '../types';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export async function repairFixedAssetOrphanLedger(): Promise<{
  reversed: number;
  skipped: number;
  assetStillExists: number;
  failed: number;
  details: string[];
}> {
  const details: string[] = [];
  console.group('[DATA REPAIR] repairFixedAssetOrphanLedger');

  // 1. Load accounts and resolve the BANK-subtype account identifiers.
  const accounts = await loadAccountsFromStore();
  const bankAccountIds = new Set(
    accounts
      .filter((a: any) => String(a.subtype || '').toUpperCase() === 'BANK')
      .flatMap((a: any) => [String(a.id || ''), String(a.code || ''), String(a.account_number || '')])
      .filter(Boolean)
  );
  console.log(`Resolved ${bankAccountIds.size} bank account identifier(s) from the chart of accounts.`);

  // 2. Load all ledger entries.
  let allEntries: any[] = [];
  try {
    allEntries = await dbService.getAll('ledger');
  } catch (err) {
    console.error('Failed to load ledger from dbService:', err);
    console.groupEnd();
    return { reversed: 0, skipped: 0, assetStillExists: 0, failed: 0, details };
  }

  // 3. Find FA_ACQUISITION entries that credit a bank account.
  const faAcquisitions = allEntries.filter(
    (e: any) =>
      e.entryType === 'FA_ACQUISITION' &&
      bankAccountIds.has(String(e.creditAccountId || ''))
  );

  if (faAcquisitions.length === 0) {
    console.log('No FA_ACQUISITION entries crediting bank accounts found. Nothing to repair.');
    console.groupEnd();
    return { reversed: 0, skipped: 0, assetStillExists: 0, failed: 0, details };
  }

  console.warn(`Found ${faAcquisitions.length} FA_ACQUISITION entry/entries crediting bank accounts.`);

  // 4. Build the set of already-reversed asset codes (idempotency guard).
  const alreadyReversedCodes = new Set(
    allEntries
      .filter((e: any) =>
        (e.entryType === 'FA_ACQUISITION_REVERSAL' || e.entryType === 'Reversal') &&
        String(e.referenceId || '').startsWith('FA-ACQ-REV-')
      )
      .map((e: any) => String(e.referenceId || '').replace('FA-ACQ-REV-', ''))
  );

  let reversed = 0;
  let skipped = 0;
  let assetStillExists = 0;
  let failed = 0;

  for (const original of faAcquisitions) {
    const assetCode = String(original.referenceId || '').replace('FA-ACQ-', '');
    if (!assetCode || assetCode === String(original.referenceId || '')) {
      console.log(`  SKIP (no asset code): ${original.id}`);
      skipped++;
      continue;
    }

    if (alreadyReversedCodes.has(assetCode)) {
      console.log(`  SKIP (already reversed): ${original.id} — asset ${assetCode}`);
      skipped++;
      continue;
    }

    // 5. Check whether the asset still exists — if so the entry is not
    //    orphaned and must be left alone. Match by asset_code (the
    //    asset's id and asset_code are distinct in live data), and
    //    note that getAll() already filters soft-deleted (tombstoned)
    //    rows, so a deleted asset is simply not found here.
    let asset: any = null;
    try {
      const allAssets = await fixedAssetService.getAll();
      asset = allAssets.find((a: any) => String(a.asset_code || '') === assetCode) || null;
    } catch (err) {
      console.warn(`  Could not look up asset ${assetCode}:`, err);
    }

    if (asset) {
      console.log(`  SKIP (asset still exists): ${original.id} — asset ${assetCode}`);
      assetStillExists++;
      continue;
    }

    // 6. Orphan found — reverse it through the standard reversal
    //    mechanism. Rebuild a minimal asset record from the original
    //    entry so the reversal restores the EXACT legs that were posted.
    const syntheticAsset: FixedAsset = {
      id: assetCode,
      asset_code: assetCode,
      name: String(original.description || '').replace(/^Asset:\s*/i, '') || assetCode,
      acquisition_cost: Number(original.amount),
      acquisition_date: String(original.date || '').slice(0, 10),
      fixed_asset_account_id: String(original.debitAccountId || ''),
      accumulated_depreciation_account_id: '',
      depreciation_expense_account_id: '',
      status: 'active',
      created_at: '',
      updated_at: '',
    } as any;

    try {
      const reversalId = await fixedAssetService.reverseAcquisitionJournal(
        syntheticAsset,
        accounts,
        original
      );
      if (reversalId) {
        console.log(
          `  REVERSED: ${original.id} (K${original.amount}) ` +
          `DR ${original.creditAccountId} / CR ${original.debitAccountId} ` +
          `— orphan from deleted asset ${assetCode}`
        );
        details.push(`Reversed ${original.id} (K${original.amount}) for deleted asset ${assetCode} -> ${reversalId}`);
        reversed++;
      } else {
        console.log(`  SKIP (reversal declined — likely already reversed): ${original.id}`);
        skipped++;
      }
    } catch (err) {
      console.error(`  FAILED to reverse ${original.id}:`, err);
      failed++;
    }
  }

  console.log(`Done. Reversed: ${reversed}, Skipped: ${skipped}, Asset still exists: ${assetStillExists}, Failed: ${failed}.`);
  console.groupEnd();
  return { reversed, skipped, assetStillExists, failed, details };
}

// Auto-invoke when run as a one-off script.
repairFixedAssetOrphanLedger().catch(console.error);
