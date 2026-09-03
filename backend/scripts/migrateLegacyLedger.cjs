/**
 * Phase 2.5 Legacy Ledger Migration
 * 
 * Migrates old-format ledger entries (data.debitAccountId/data.creditAccountId)
 * to canonical format (data.account_id + data.entry_type) using canonical UUIDs.
 * 
 * Important: ledger_entries is a JSONB-envelope table. All domain fields live
 * inside `data`, not as top-level columns.
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

const LEGACY_TO_CANONICAL = {
  '1000': '11110',
  '1050': '11210',
  '1060': '11210',
  '1100': '11310',
  '1200': '11410',
  '2200': '21110',
  '3000': '34000',
  '4000': '41100',
  '4900': '42100',
  '5000': '51200',
};

const ACCOUNT_UUIDS = {
  '11110': '112b22a6-131b-4c3e-a829-6ad90eba3bd8',
  '11210': 'c15f0081-f0a5-469f-bec0-090636a89ec5',
  '11220': '52cc508f-065c-46bd-9f3b-aee2775b9ecd',
  '11230': '7b313a1e-386c-4bd4-b3c6-5bf6c3ffa871',
  '11310': 'e08a37a7-85d8-45e4-a5b0-8da4b332bcde',
  '11410': '11e9078b-677a-44c2-bb33-b52b33be096f',
  '21110': '7bbf134f-d020-41be-8b56-4a9fa3adf8b7',
  '41100': 'a81b5578-68af-4116-a18d-1e5dbe824360',
  '42100': '2b1c748b-fc82-462b-87be-36f1cf2c0a9f',
  '51200': 'e87fad8a-8088-4a6d-a134-635f7256db68',
  '12500': 'b9dcfc83-2036-4a8f-b6b6-e1138dd012f5',
  '34000': '70ee2511-485b-46ec-bad3-e47f28c033cb',
};

const DRY_RUN = process.argv.includes('--dry-run');

function isoDate(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function buildCanonicalData(oldData, accountId, entryType) {
  return {
    id: oldData.id,
    amount: Number(oldData.amount) || 0,
    currency: oldData.currency || 'USD',
    account_id: accountId,
    entry_type: entryType,
    description: oldData.description || null,
    reference_type: oldData.referenceType || null,
    reference_id: oldData.referenceId || null,
    entry_date: isoDate(oldData.date),
    created_by: 'migration',
    journal_id: null,
    account_code: null,
    account_name: null,
  };
}

async function migrateLegacyEntries() {
  console.log(`=== LEGACY LEDGER MIGRATION ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  const r = await axios.get(`${SUPABASE_URL}/rest/v1/ledger_entries`, {
    params: { select: 'id,data' },
    headers: HEADERS,
    timeout: 30000,
  });

  const rows = r.data || [];
  const oldFormat = rows.filter(
    (row) => row.data && row.data.debitAccountId && row.data.creditAccountId
  );
  console.log(`Total entries: ${rows.length}`);
  console.log(`Old format entries: ${oldFormat.length}`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const plans = [];

  for (const row of oldFormat) {
    const d = row.data;
    const debitCode = String(d.debitAccountId || '');
    const creditCode = String(d.creditAccountId || '');

    if (debitCode.startsWith('ACC-') || creditCode.startsWith('ACC-')) {
      console.log(
        `SKIP ${row.id}: customer/supplier ID instead of account code (${debitCode}, ${creditCode})`
      );
      skipped++;
      continue;
    }

    const debitCanonical = LEGACY_TO_CANONICAL[debitCode];
    const creditCanonical = LEGACY_TO_CANONICAL[creditCode];

    if (!debitCanonical || !creditCanonical) {
      console.log(`SKIP ${row.id}: unmapped legacy codes (${debitCode}, ${creditCode})`);
      skipped++;
      continue;
    }

    const debitUuid = ACCOUNT_UUIDS[debitCanonical];
    const creditUuid = ACCOUNT_UUIDS[creditCanonical];

    if (!debitUuid || !creditUuid) {
      console.log(`SKIP ${row.id}: missing canonical UUID for (${debitCanonical}, ${creditCanonical})`);
      skipped++;
      continue;
    }

    const plan = {
      oldId: row.id,
      debitEntryId: `MIGR-${row.id}-DEBIT`,
      creditEntryId: `MIGR-${row.id}-CREDIT`,
      debitCode,
      creditCode,
      debitCanonical,
      creditCanonical,
      debitUuid,
      creditUuid,
      amount: Number(d.amount) || 0,
      currency: d.currency || 'USD',
      description: d.description || null,
      referenceType: d.referenceType || null,
      referenceId: d.referenceId || null,
      entryDate: isoDate(d.date),
    };
    plans.push(plan);

    if (!DRY_RUN) {
      try {
        await axios.post(
          `${SUPABASE_URL}/rest/v1/ledger_entries`,
          {
            id: plan.debitEntryId,
            data: buildCanonicalData(d, debitUuid, 'debit'),
            updated_at: new Date().toISOString(),
            version: 1,
          },
          { headers: HEADERS }
        );

        await axios.post(
          `${SUPABASE_URL}/rest/v1/ledger_entries`,
          {
            id: plan.creditEntryId,
            data: buildCanonicalData(d, creditUuid, 'credit'),
            updated_at: new Date().toISOString(),
            version: 1,
          },
          { headers: HEADERS }
        );

        await axios.delete(`${SUPABASE_URL}/rest/v1/ledger_entries`, {
          params: { id: `eq.${row.id}` },
          headers: HEADERS,
        });

        migrated++;
        if (migrated % 50 === 0) {
          console.log(`Migrated ${migrated} entries...`);
        }
      } catch (e) {
        console.error(`ERROR ${row.id}: ${e.message}`);
        errors++;
      }
    } else {
      migrated++;
    }
  }

  console.log(`\n=== ${DRY_RUN ? 'DRY RUN' : 'MIGRATION'} COMPLETE ===`);
  console.log(`Would ${DRY_RUN ? 'change' : 'migrate'}: ${migrated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  if (DRY_RUN && plans.length > 0) {
    console.log('\nSample plans (first 10):');
    plans.slice(0, 10).forEach((p) => {
      console.log(JSON.stringify(p, null, 2));
    });
  }
}

migrateLegacyEntries().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
