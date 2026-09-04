/**
 * Phase 2.6.1 — Controlled Test Artifact Cleanup
 *
 * Removes test-generated ledger entries and expenses/income/transfers
 * created by Phase 2.5 acceptance tests.
 *
 * Dry-run:  node scripts/cleanupTestArtifacts.cjs --dry-run
 * Execute:   node scripts/cleanupTestArtifacts.cjs
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const repo = require('../services/supabaseRepository.cjs');
const FinanceService = require('../services/financeService.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const PREFIX = 'PH25-TEST-';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const finance = new FinanceService();

function log(msg) { console.log(msg); }
function logError(msg) { console.error(msg); }

async function cleanup() {
  log(`=== TEST ARTIFACT CLEANUP ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // ========================================================================
  // 1. PH25-TEST ledger entries
  // ========================================================================
  log('--- PH25-TEST ledger entries ---');
  const allEntries = await repo.getAll('ledger_entries', {});
  const testEntries = allEntries.filter(e =>
    e.id && e.id.startsWith(PREFIX) ||
    (e.reference_id && e.reference_id.startsWith(PREFIX)) ||
    (e.referenceId && e.referenceId.startsWith(PREFIX))
  );
  log(`Found ${testEntries.length} PH25-TEST ledger entries`);

  if (!DRY_RUN && testEntries.length > 0) {
    for (const entry of testEntries) {
      try {
        await repo.softDelete('ledger_entries', entry.id);
      } catch (e) {
        logError(`Failed to delete ${entry.id}: ${e.message}`);
      }
    }
    log(`Soft-deleted ${testEntries.length} ledger entries`);
  }

  // ========================================================================
  // 2. PH25-TEST expenses
  // ========================================================================
  log('\n--- PH25-TEST expenses ---');
  const expenses = await repo.getAll('expenses', {});
  const testExpenses = expenses.filter(e => e.id && e.id.startsWith(PREFIX));
  log(`Found ${testExpenses.length} PH25-TEST expenses`);

  if (!DRY_RUN && testExpenses.length > 0) {
    for (const exp of testExpenses) {
      try {
        await repo.softDelete('expenses', exp.id);
      } catch (e) {
        logError(`Failed to delete expense ${exp.id}: ${e.message}`);
      }
    }
    log(`Soft-deleted ${testExpenses.length} expenses`);
  }

  // ========================================================================
  // 3. PH25-TEST income
  // ========================================================================
  log('\n--- PH25-TEST income ---');
  const incomes = await repo.getAll('income', {});
  const testIncomes = incomes.filter(e => e.id && e.id.startsWith(PREFIX));
  log(`Found ${testIncomes.length} PH25-TEST incomes`);

  if (!DRY_RUN && testIncomes.length > 0) {
    for (const inc of testIncomes) {
      try {
        await repo.softDelete('income', inc.id);
      } catch (e) {
        logError(`Failed to delete income ${inc.id}: ${e.message}`);
      }
    }
    log(`Soft-deleted ${testIncomes.length} incomes`);
  }

  // ========================================================================
  // 4. PH25-TEST transfers
  // ========================================================================
  log('\n--- PH25-TEST transfers ---');
  const transfers = await repo.getAll('transfers', {});
  const testTransfers = transfers.filter(e => e.id && e.id.startsWith(PREFIX));
  log(`Found ${testTransfers.length} PH25-TEST transfers`);

  if (!DRY_RUN && testTransfers.length > 0) {
    for (const tr of testTransfers) {
      try {
        await repo.softDelete('transfers', tr.id);
      } catch (e) {
        logError(`Failed to delete transfer ${tr.id}: ${e.message}`);
      }
    }
    log(`Soft-deleted ${testTransfers.length} transfers`);
  }

  // ========================================================================
  // 5. Zero-UUID test artifacts
  // ========================================================================
  log('\n--- Zero-UUID test artifacts ---');
  const zeroUuidEntries = allEntries.filter(e => e.account_id === ZERO_UUID);
  log(`Found ${zeroUuidEntries.length} zero-UUID ledger entries`);

  if (!DRY_RUN && zeroUuidEntries.length > 0) {
    for (const entry of zeroUuidEntries) {
      try {
        await repo.softDelete('ledger_entries', entry.id);
      } catch (e) {
        logError(`Failed to delete zero-UUID entry ${entry.id}: ${e.message}`);
      }
    }
    log(`Soft-deleted ${zeroUuidEntries.length} zero-UUID entries`);
  }

  log(`\n=== CLEANUP ${DRY_RUN ? 'DRY RUN' : 'COMPLETE'} ===`);
}

cleanup().catch((e) => {
  logError('Cleanup failed:', e);
  process.exit(1);
});
