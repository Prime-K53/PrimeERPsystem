/**
 * repairMarginLedgerEntries.ts
 *
 * One-time data-repair script.
 *
 * The removed "SmartPricing Revenue Analytics" block in processSale() was
 * creating ledger entries with entryType="ProfitMargin" that debited Cash
 * Drawer and credited Interest Income for the gross-profit amount.
 *
 * This script scans the IndexedDB `ledger` store, identifies all such entries,
 * and creates offsetting reversal entries following the existing immutable-
 * ledger / reversal policy (no mutation of original records).
 *
 * HOW TO RUN:
 *   Open the application in the browser, open DevTools → Console, then paste
 *   and execute the contents of this file. Alternatively, import and call
 *   repairMarginLedgerEntries() from a one-time admin route.
 *
 * SAFETY:
 *   - Idempotent: already-reversed entries are skipped (checks for existing
 *     reversal by referenceId + entryType="Reversal").
 *   - Does NOT delete any original entries.
 *   - Logs every action to the console.
 */

import { dbService } from '../services/db';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export async function repairMarginLedgerEntries(): Promise<void> {
  console.group('[DATA REPAIR] repairMarginLedgerEntries');

  let allEntries: any[] = [];
  try {
    allEntries = await dbService.getAll('ledger');
  } catch (err) {
    console.error('Failed to load ledger from dbService:', err);
    console.groupEnd();
    return;
  }

  // Find all spurious profit-margin entries
  const marginEntries = allEntries.filter(
    (e) =>
      e.entryType === 'ProfitMargin' ||
      (typeof e.description === 'string' &&
        e.description.startsWith('Profit Margin - Sale #'))
  );

  if (marginEntries.length === 0) {
    console.log('No ProfitMargin entries found. Nothing to repair.');
    console.groupEnd();
    await tx.done;
    return;
  }

  console.warn(`Found ${marginEntries.length} ProfitMargin ledger entries to reverse.`);

  // Build a set of already-reversed referenceIds to avoid double-reversals
  const alreadyReversed = new Set(
    allEntries
      .filter(
        (e) =>
          e.entryType === 'Reversal' &&
          typeof e.description === 'string' &&
          e.description.includes('REVERSAL: Incorrect Profit Margin')
      )
      .map((e) => e.referenceId)
  );

  let reversed = 0;
  let skipped  = 0;

  for (const original of marginEntries) {
    if (alreadyReversed.has(original.referenceId)) {
      console.log(`  SKIP (already reversed): ${original.id} — sale ${original.referenceId}`);
      skipped++;
      continue;
    }

    const reversal = {
      id:              generateId('LG-REV-MARGIN'),
      date:            new Date().toISOString(),
      description:     `REVERSAL: Incorrect Profit Margin entry — ${original.description}`,
      debitAccountId:  original.creditAccountId,   // swap DR/CR to zero out
      creditAccountId: original.debitAccountId,
      amount:          original.amount,
      referenceId:     original.referenceId,
      reconciled:      false,
      entryType:       'Reversal',
      customerId:      original.customerId,
      customerName:    original.customerName,
      reversalOf:      original.id,
    };

    await dbService.put('ledger', reversal);
    console.log(
      `  REVERSED: ${original.id} (K${original.amount}) ` +
      `DR ${reversal.debitAccountId} / CR ${reversal.creditAccountId}`
    );
    reversed++;
  }

  console.log(`Done. Reversed: ${reversed}, Skipped (already done): ${skipped}.`);
  console.groupEnd();
}

// Auto-invoke when run as a one-off script
repairMarginLedgerEntries().catch(console.error);
