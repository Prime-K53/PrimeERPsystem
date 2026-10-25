/**
 * examinationIntegrityConcurrency.integration.test.cjs
 *
 * LIVE-DATABASE integration proof for migration
 * 0050_examination_integrity_constraints.sql and the atomic status
 * precondition in backend/services/examinationSyncGuards.cjs.
 *
 * NOT EXECUTED in environments without a disposable PostgreSQL — it skips
 * cleanly there. Every scenario below uses INDEPENDENT CONNECTIONS and REAL
 * concurrent transactions, because the invariants being proven are race
 * invariants: a mocked sequential test cannot observe the interleaving that
 * these constraints exist to defeat.
 *
 * Run ONLY against a disposable database. NEVER production. The suite
 * fail-fasts unless TEST_DATABASE_URL names a database literally called
 * `pc_integration` on localhost/a test host.
 *
 *   createdb -h 127.0.0.1 -U postgres pc_integration
 *   npm i -g pg 2>/dev/null || NODE_PATH=/path/to/pg/parent
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/pc_integration \
 *     NODE_PATH=C:/pgt/node_modules \
 *     npx jest tests/examinationIntegrityConcurrency.integration.test.cjs --forceExit
 *
 * Scenarios (mapped to the repair brief §8):
 *   1  Two devices concurrently invoicing the same batch -> one winner.
 *   2  A stale device repricing an invoiced batch -> rejected atomically.
 *   3  A stale update arriving after a newer update -> rejected.
 *   5  A tombstone deleting a financially committed batch -> rejected.
 *   6  Duplicate invoice-number claim / batch-to-invoice uniqueness.
 *   13 Backfill compatibility for pre-existing JSONB envelope records.
 *   15 RLS: constraints hold for the service role; no new client policy.
 */
let pg;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  pg = require('pg');
} catch {
  pg = null;
}

const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const MIGRATION_0051 = fs.readFileSync(
  path.join(MIG_DIR, '0051_examination_posting_and_void.sql'),
  'utf8'
);
const MIGRATION_0050 = fs.readFileSync(
  path.join(MIG_DIR, '0050_examination_integrity_constraints.sql'),
  'utf8'
);

/**
 * Roles 0050/0051 REVOKE against. Supabase always has them; a plain disposable
 * PostgreSQL does not, and the missing role aborts the whole migration.
 */
const ensureSupabaseRoles = (client) => client.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
`);

const EXAM_ACCOUNTS = { ar: '11310', revenue: '41200' };

const ledgerEntry = (amount, extra = {}) => ({
  id: 'LG-INV-EXM-001/001',
  date: '2026-03-01',
  description: 'Invoice #EXM-001/001',
  debitAccountId: EXAM_ACCOUNTS.ar,
  creditAccountId: EXAM_ACCOUNTS.revenue,
  amount,
  referenceId: 'EXM-001/001',
  reconciled: false,
  ...extra,
});

const invoiceEnvelope = (total) => ({
  invoiceNumber: 'EXM-001/001',
  customerId: 'SCH-1',
  customerName: 'Test School',
  status: 'Unpaid',
  totalAmount: total,
  paidAmount: 0,
  items: [{ id: 'CLASS-1', itemId: 'CLASS-1', name: 'Form 1', type: 'Service', quantity: 80, price: 100, total: total }],
  verificationToken: 'a'.repeat(64),
});

/** A batch that is approved at a known total, exactly as approval leaves it. */
const seedApprovedBatch = async (client, { id = 'p1', total = 8000, version = 4 } = {}) => {
  await client.query(
    `INSERT INTO public.examination_batches (id, data, version)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
    [id, JSON.stringify({
      batch_number: 'BTC-POST/001',
      status: 'approved',
      invoice_id: null,
      pricing_snapshot: {
        engineVersion: 'EXAM-2026.1',
        provenance: 'CANONICAL',
        result: { totalAmount: total, materialTotal: 2000, classes: [{ classId: 'CLASS-1', learners: 80, finalFee: 100, liveTotal: total, bomCost: 2000 }] },
      },
    }), version]
  );
};

const TEST_URL = process.env.TEST_DATABASE_URL || '';
const urlOk = (() => {
  if (!TEST_URL) return false;
  try {
    const u = new URL(TEST_URL);
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const host = (u.hostname || '').toLowerCase();
    const testHost = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.test') || host.endsWith('.local');
    return db === 'pc_integration' && testHost;
  } catch {
    return false;
  }
})();
if (TEST_URL && !urlOk) {
  throw new Error(
    'REFUSED: TEST_DATABASE_URL must target database `pc_integration` on localhost/a .test/.local host. '
    + 'Running integration tests against any other database (especially production) is forbidden.',
  );
}
const describeLive = urlOk && pg ? describe : describe.skip;

const LOCKED = ['approved', 'invoiced', 'completed', 'paid'];

const withClient = async (fn) => {
  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

/** Minimal envelope schema standing in for the live 0001 baseline. */
const ensureSchema = (client) => client.query(`
  CREATE TABLE IF NOT EXISTS public.examination_batches (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS public.invoices (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS public.ledger_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
  );
`);

const clearRows = (client) => client.query(`
  DELETE FROM public.examination_batches;
  DELETE FROM public.invoices;
  DELETE FROM public.ledger_entries;
`);

const putBatch = (client, { id, status, version = 1, batchNumber }) => client.query(
  `INSERT INTO public.examination_batches (id, data, version)
   VALUES ($1, $2::jsonb, $3)
   ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
  [id, JSON.stringify({ batch_number: batchNumber, status, invoice_id: null }), version],
);

const putExamInvoice = (client, { id, batchRef, status = 'Unpaid', version = 1 }) => client.query(
  `INSERT INTO public.invoices (id, data, version)
   VALUES ($1, $2::jsonb, $3)
   ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
  [id, JSON.stringify({
    id, invoiceNumber: id, origin_module: 'examination', batchId: batchRef, status,
  }), version],
);

/**
 * The exact conditional PATCH the gateway issues, expressed as SQL so the
 * precondition is evaluated by PostgreSQL inside the write's transaction.
 */
const guardedBatchUpdate = (client, { id, fromVersion, allowedStatuses, patchData }) => client.query(
  `UPDATE public.examination_batches
     SET data = data || $4::jsonb, version = $5, updated_at = NOW()
   WHERE id = $1
     AND version = $2
     AND lower(btrim(COALESCE(data->>'status',''))) = ANY($3::text[])
   RETURNING id, version, data->>'status' AS status`,
  [id, fromVersion, allowedStatuses, JSON.stringify(patchData), fromVersion + 1],
);

describeLive('examination integrity — real PostgreSQL concurrency (0050)', () => {
  beforeAll(async () => {
    await withClient(async (client) => {
      await ensureSchema(client);
      await ensureSupabaseRoles(client);
      // 0050 owns the unique indexes, the status trigger and the findings views
      // that the scenarios below assert against.
      await client.query(MIGRATION_0050);
    });
  });

  beforeEach(async () => {
    await withClient(async (client) => {
      await clearRows(client);
    });
  });

  afterAll(async () => {
    await withClient(async (client) => {
      await clearRows(client);
    });
  });

  describe('§8.1 two devices concurrently invoicing the same batch', () => {
    it('admits exactly one invoice for a batch even under a true race', async () => {
      await withClient((c) => putBatch(c, { id: 'b1', status: 'approved', batchNumber: 'BTC-1' }));

      // Both devices read the same approved batch and both try to invoice it.
      const attempt = async (invoiceId) => {
        try {
          await withClient(async (c) => {
            // Device first advances the batch approved -> invoiced (CAS on status).
            const moved = await guardedBatchUpdate(c, {
              id: 'b1', fromVersion: 1, allowedStatuses: ['approved', 'invoiced'],
              patchData: { status: 'invoiced' },
            });
            if (moved.rowCount !== 1) throw new Error('batch-status-precondition-failed');
            // Only the device that won the batch transition may write the invoice.
            await putExamInvoice(c, { id: invoiceId, batchRef: 'BTC-1' });
          });
          return 'ok';
        } catch (err) {
          return err.message;
        }
      };

      const [a, b] = await Promise.all([attempt('EXM-001/001'), attempt('EXM-001/002')]);

      expect([a, b].filter((r) => r === 'ok')).toHaveLength(1);
      expect([a, b].filter((r) => r === 'batch-status-precondition-failed')).toHaveLength(1);
    });

    it('refuses a second active invoice for the same batch at the index level', async () => {
      await withClient(async (c) => {
        await putExamInvoice(c, { id: 'EXM-002/001', batchRef: 'BTC-2' });
      });

      await expect(withClient((c) => putExamInvoice(c, { id: 'EXM-002/002', batchRef: 'BTC-2' })))
        .rejects.toThrow(/idx_invoices_exam_one_active_per_batch|duplicate key/i);
    });

    it('permits a replacement invoice once the original is cancelled', async () => {
      await withClient(async (c) => {
        await putExamInvoice(c, { id: 'EXM-003/001', batchRef: 'BTC-3', status: 'Cancelled' });
        await putExamInvoice(c, { id: 'EXM-003/002', batchRef: 'BTC-3' });
      });

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.invoices WHERE data->>'batchId' = 'BTC-3'`,
      ));
      expect(rows[0].n).toBe(2);
    });
  });

  describe('§8.2 a stale device repricing an invoiced batch', () => {
    it('rejects the stale write atomically while the batch is frozen', async () => {
      await withClient((c) => putBatch(c, { id: 'b2', status: 'invoiced', version: 4, batchNumber: 'BTC-4' }));

      // The stale device still believes the batch is Calculated and sends its
      // repriced class payload. The precondition excludes every frozen status.
      const result = await withClient((c) => guardedBatchUpdate(c, {
        id: 'b2', fromVersion: 4, allowedStatuses: ['draft', 'calculated'],
        patchData: { status: 'Calculated', classes: [{ id: 'c1', live_total_preview: 1 }] },
      }));

      expect(result.rowCount).toBe(0);

      const { rows } = await withClient((c) => c.query(
        `SELECT version, data->>'status' AS status FROM public.examination_batches WHERE id = 'b2'`,
      ));
      expect(rows[0].version).toBe(4);
      expect(rows[0].status).toBe('invoiced');
    });

    it.each(LOCKED)('refuses repricing of a %s batch', async (status) => {
      await withClient((c) => putBatch(c, { id: `blk-${status}`, status, batchNumber: `BTC-${status}` }));
      const result = await withClient((c) => guardedBatchUpdate(c, {
        id: `blk-${status}`, fromVersion: 1, allowedStatuses: ['draft', 'calculated'],
        patchData: { status: 'Calculated' },
      }));
      expect(result.rowCount).toBe(0);
    });
  });

  describe('§8.3 a stale update arriving after a newer update', () => {
    it('rejects the stale version and leaves the newer value intact', async () => {
      await withClient((c) => putBatch(c, { id: 'b3', status: 'calculated', batchNumber: 'BTC-5' }));

      const newer = await withClient((c) => guardedBatchUpdate(c, {
        id: 'b3', fromVersion: 1, allowedStatuses: ['draft', 'calculated'],
        patchData: { name: 'newer' },
      }));
      expect(newer.rowCount).toBe(1);

      const stale = await withClient((c) => guardedBatchUpdate(c, {
        id: 'b3', fromVersion: 1, allowedStatuses: ['draft', 'calculated'],
        patchData: { name: 'stale' },
      }));
      expect(stale.rowCount).toBe(0);

      const { rows } = await withClient((c) => c.query(
        `SELECT data->>'name' AS name FROM public.examination_batches WHERE id = 'b3'`,
      ));
      expect(rows[0].name).toBe('newer');
    });
  });

  describe('§8.5 a tombstone deleting a financially committed batch', () => {
    it.each(LOCKED)('refuses to tombstone a %s batch', async (status) => {
      await withClient((c) => putBatch(c, { id: `del-${status}`, status, batchNumber: `DEL-${status}` }));

      const result = await withClient((c) => c.query(
        `UPDATE public.examination_batches
            SET data = data || '{"deleted": true}'::jsonb, version = version + 1
          WHERE id = $1
            AND lower(btrim(COALESCE(data->>'status',''))) = ANY($2::text[])`,
        [`del-${status}`, ['draft', 'calculated']],
      ));

      expect(result.rowCount).toBe(0);
      const { rows } = await withClient((c) => c.query(
        `SELECT data->>'deleted' AS deleted FROM public.examination_batches WHERE id = $1`,
        [`del-${status}`],
      ));
      expect(rows[0].deleted).toBeNull();
    });

    it('still permits a tombstone on a draft batch', async () => {
      await withClient((c) => putBatch(c, { id: 'del-draft', status: 'draft', batchNumber: 'DEL-DRAFT' }));
      const result = await withClient((c) => c.query(
        `UPDATE public.examination_batches
            SET data = data || '{"deleted": true}'::jsonb, version = version + 1
          WHERE id = 'del-draft'
            AND lower(btrim(COALESCE(data->>'status',''))) = ANY($1::text[])`,
        [['draft', 'calculated']],
      ));
      expect(result.rowCount).toBe(1);
    });
  });

  describe('§8.6 duplicate invoice-number claims and batch uniqueness', () => {
    it('rejects a duplicate batch_number across live batches', async () => {
      await withClient((c) => putBatch(c, { id: 'dup-a', status: 'draft', batchNumber: 'BTC-DUP' }));
      await expect(withClient((c) => putBatch(c, { id: 'dup-b', status: 'draft', batchNumber: 'BTC-DUP' })))
        .rejects.toThrow(/idx_examination_batches_batch_number_unique|duplicate key/i);
    });

    it('allows a tombstoned batch to surrender its batch_number', async () => {
      await withClient(async (c) => {
        await putBatch(c, { id: 'free-a', status: 'draft', batchNumber: 'BTC-FREE' });
        await c.query(
          `UPDATE public.examination_batches SET data = data || '{"deleted": true, "deletedAt": "2026-03-01T00:00:00Z"}'::jsonb WHERE id = 'free-a'`,
        );
      });
      await withClient((c) => putBatch(c, { id: 'free-b', status: 'draft', batchNumber: 'BTC-FREE' }));
    });

    it('rejects an unknown status through the trigger', async () => {
      await expect(withClient((c) => putBatch(c, { id: 'bad-status', status: 'approvedd', batchNumber: 'BTC-BAD' })))
        .rejects.toThrow(/EXAMINATION_STATUS_INVALID|not a valid examination batch status/i);
    });

    it('reports orphan examination ledger references', async () => {
      await withClient((c) => c.query(
        `INSERT INTO public.ledger_entries (id, data) VALUES ('LG-1', $1::jsonb)`,
        [JSON.stringify({ invoiceNumber: 'EXM-009/001' })],
      ));

      const { rows } = await withClient((c) => c.query('SELECT * FROM public.examination_integrity_findings'));
      expect(rows.some((r) => r.finding === 'orphan_ledger_exam_invoice' && r.subject === 'EXM-009/001')).toBe(true);

      await expect(withClient((c) => c.query('SELECT public.assert_examination_invoice_number_unique($1)', ['EXM-009/001'])))
        .rejects.toThrow(/EXAMINATION_INVOICE_ORPHAN_LEDGER|has .* ledger row/i);
    });
  });

  describe('§8.13 migration and backfill of existing JSONB records', () => {
    it('leaves pre-existing envelope rows valid and backfillable', async () => {
      await withClient(async (c) => {
        // A row written by the legacy shape: no status key at all.
        await c.query(
          `INSERT INTO public.examination_batches (id, data) VALUES ('legacy-1', $1::jsonb)`,
          [JSON.stringify({ batch_number: 'BTC-LEGACY', classes: [{ id: 'c1' }] })],
        );
      });

      const { rows } = await withClient((c) => c.query(
        `SELECT data->>'batch_number' AS bn FROM public.examination_batches WHERE id = 'legacy-1'`,
      ));
      expect(rows[0].bn).toBe('BTC-LEGACY');

      // Absent status must not trip the trigger, and the row remains writable.
      const updated = await withClient((c) => c.query(
        `UPDATE public.examination_batches SET data = data || '{"status": "draft"}'::jsonb WHERE id = 'legacy-1' RETURNING id`,
      ));
      expect(updated.rowCount).toBe(1);
    });

    it('tolerates both batch_number spellings in the uniqueness index', async () => {
      await withClient((c) => c.query(
        `INSERT INTO public.examination_batches (id, data) VALUES ('camel-1', $1::jsonb)`,
        [JSON.stringify({ batchNumber: 'BTC-CAMEL' })],
      ));
      await expect(withClient((c) => c.query(
        `INSERT INTO public.examination_batches (id, data) VALUES ('camel-2', $1::jsonb)`,
        [JSON.stringify({ batch_number: 'BTC-CAMEL' })],
      ))).rejects.toThrow(/idx_examination_batches_batch_number_unique|duplicate key/i);
    });
  });

  describe('§8.15 RLS and authorization posture', () => {
    it('keeps the integrity function unavailable to PUBLIC', async () => {
      const { rows } = await withClient((c) => c.query(
        `SELECT has_function_privilege('public', 'public.assert_examination_invoice_number_unique(text)', 'EXECUTE') AS granted`,
      ));
      expect(rows[0].granted).toBe(false);
    });

    it('grants the integrity function to service_role', async () => {
      const { rows } = await withClient((c) => c.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'service_role'
        ) AS has_service_role,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
          THEN has_function_privilege('service_role', 'public.assert_examination_invoice_number_unique(text)', 'EXECUTE')
          ELSE NULL END AS granted
      `));
      if (rows[0].has_service_role) expect(rows[0].granted).toBe(true);
    });
  });

  describe('§8.12 two-device convergence after reconnection', () => {
    it('converges both devices on the committed state after a rejected stale write', async () => {
      await withClient((c) => putBatch(c, { id: 'conv', status: 'calculated', version: 1, batchNumber: 'BTC-CONV' }));

      // Device A commits the invoice transition.
      await withClient((c) => guardedBatchUpdate(c, {
        id: 'conv', fromVersion: 1, allowedStatuses: ['draft', 'calculated', 'approved'],
        patchData: { status: 'approved' },
      }));
      const a = await withClient((c) => guardedBatchUpdate(c, {
        id: 'conv', fromVersion: 2, allowedStatuses: ['draft', 'calculated', 'approved'],
        patchData: { status: 'approved' },
      }));
      expect(a.rowCount).toBe(1);

      // Device B, still holding version 1, attempts its own transition.
      const b = await withClient((c) => guardedBatchUpdate(c, {
        id: 'conv', fromVersion: 1, allowedStatuses: ['draft', 'calculated', 'approved'],
        patchData: { status: 'approved', classes: [{ id: 'stale' }] },
      }));
      expect(b.rowCount).toBe(0);

      // Both devices read back the identical committed row.
      const read = async () => {
        const { rows } = await withClient((c) => c.query(
          `SELECT version, data->>'status' AS status FROM public.examination_batches WHERE id = 'conv'`,
        ));
        return rows[0];
      };
      expect(await read()).toEqual(await read());
      expect((await read()).status).toBe('approved');
    });
  });
});

/**
 * §8 scenarios 1-8 for the server-authoritative posting and void boundary
 * installed by 0051. These drive the REAL plpgsql functions over INDEPENDENT
 * connections, because the property under test (one invoice per batch, one
 * reversal per entry) is only observable under genuine interleaving.
 */
describeLive('authoritative Examination posting and void (0051)', () => {
  beforeAll(async () => {
    await withClient(async (client) => {
      await ensureSupabaseRoles(client);
      await ensureSchema(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.examination_inventory_deductions (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          version INTEGER NOT NULL DEFAULT 0
        );
      `);
      // Both migrations are idempotent; 0051 also depends on 0050's indexes.
      await client.query(MIGRATION_0050);
      await client.query(MIGRATION_0051);
    });
  });

  beforeEach(async () => {
    await withClient(async (client) => {
      await clearRows(client);
      await client.query('DELETE FROM public.examination_postings');
      await client.query('DELETE FROM public.examination_inventory_deductions');
      await seedApprovedBatch(client);
    });
  });

  const post = (overrides = {}) => withClient((c) => c.query(
    `SELECT public.post_examination_invoice_atomic(
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7
     ) AS result`,
    [
      overrides.batchId ?? 'p1',
      overrides.invoiceNumber ?? 'EXM-001/001',
      overrides.idempotencyKey ?? 'key-1',
      overrides.expectedVersion ?? 4,
      JSON.stringify(overrides.invoice ?? invoiceEnvelope(8000)),
      JSON.stringify(overrides.ledger ?? ledgerEntry(8000)),
      overrides.businessDate ?? '2026-03-01',
    ]
  ));

  describe('§8.1 two simultaneous invoice requests for one batch', () => {
    it('admits exactly one canonical invoice', async () => {
      const attempt = (key, number) => post({ idempotencyKey: key, invoiceNumber: number })
        .then(() => 'ok')
        .catch((err) => err.message);

      const [a, b] = await Promise.all([
        attempt('key-A', 'EXM-001/001'),
        attempt('key-B', 'EXM-001/002'),
      ]);

      expect([a, b].filter((r) => r === 'ok')).toHaveLength(1);
      expect([a, b].filter((r) => /EXAM_POST_ALREADY_INVOICED/.test(r))).toHaveLength(1);

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.invoices WHERE data->>'origin_module' = 'examination'`,
      ));
      expect(rows[0].n).toBe(1);
    });

    it('creates exactly one ledger entry for the winning request', async () => {
      await post();
      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.ledger_entries WHERE data->>'originModule' = 'examination'`,
      ));
      expect(rows[0].n).toBe(1);
    });
  });

  describe('§8.2 timeout after commit followed by a retry', () => {
    it('returns the first committed result instead of posting twice', async () => {
      const first = await post({ idempotencyKey: 'stable-key' });
      expect(first.rows[0].result.replayed).toBe(false);

      // The client never saw the response and retries with the same key.
      const retry = await post({ idempotencyKey: 'stable-key' });
      expect(retry.rows[0].result.replayed).toBe(true);
      expect(retry.rows[0].result.invoiceNumber).toBe(first.rows[0].result.invoiceNumber);

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.invoices WHERE data->>'origin_module' = 'examination'`,
      ));
      expect(rows[0].n).toBe(1);
    });
  });

  describe('§8.3 a stale pricing snapshot cannot be posted', () => {
    it('refuses an invoice whose total differs from the approved snapshot', async () => {
      await expect(post({ invoice: invoiceEnvelope(999_999), ledger: ledgerEntry(999_999) }))
        .rejects.toThrow(/EXAM_POST_SNAPSHOT_MISMATCH/);
    });

    it('refuses a request carrying a stale batch version', async () => {
      await expect(post({ expectedVersion: 1 })).rejects.toThrow(/EXAM_POST_VERSION_CONFLICT/);
    });

    it('refuses to post a batch that was never approved', async () => {
      await withClient((c) => c.query(
        `UPDATE public.examination_batches SET data = data || '{"status":"calculated"}'::jsonb WHERE id = 'p1'`,
      ));
      await expect(post()).rejects.toThrow(/EXAM_POST_STATUS_INVALID/);
    });
  });

  describe('§8.4 a duplicate sync operation cannot duplicate effects', () => {
    it('refuses an unbalanced ledger entry', async () => {
      await expect(post({ ledger: ledgerEntry(4000) })).rejects.toThrow(/EXAM_POST_LEDGER_UNBALANCED/);
    });

    it('refuses a ledger entry missing an account', async () => {
      await expect(post({ ledger: ledgerEntry(8000, { creditAccountId: null }) }))
        .rejects.toThrow(/EXAM_POST_LEDGER_UNBALANCED/);
    });
  });

  describe('§8.5 two simultaneous void requests', () => {
    const seedVoided = async (client) => {
      await seedApprovedBatch(client);
      await post();
    };

    it('produces exactly one reversal', async () => {
      await withClient(seedVoided);
      await withClient((c) => c.query(`DELETE FROM public.examination_postings`));

      const voidOnce = (key) => withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic(
           $1, $2, $3, $4, $5, NULL, $6
         ) AS result`,
        ['p1', 'EXM-001/001', key, 'test void', 'tester', '2026-03-02'],
      )).then(() => 'ok').catch((err) => err.message);

      const [a, b] = await Promise.all([voidOnce('void-1'), voidOnce('void-2')]);

      expect([a, b].filter((r) => r === 'ok')).toHaveLength(1);
      expect([a, b].filter((r) => /EXAM_VOID_ALREADY_VOID/.test(r))).toHaveLength(1);

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.ledger_entries WHERE data->>'originModule' = 'examination_reversal'`,
      ));
      expect(rows[0].n).toBe(1);
    });

    it('is idempotent for a repeated void with the same key', async () => {
      await withClient(seedVoided);
      const again = await withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,NULL,$6) AS result`,
        ['p1', 'EXM-001/001', 'void-same', 'test', 'tester', '2026-03-02'],
      ));
      expect(again.rows[0].result.replayed).toBe(true);

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.ledger_entries WHERE data->>'originModule' = 'examination_reversal'`,
      ));
      expect(rows[0].n).toBe(1);
    });
  });

  describe('§8.6 void reverses real ledger and recorded inventory only', () => {
    it('mirrors the ledger entry and balances it', async () => {
      await withClient(async (client) => { await seedApprovedBatch(client); await post(); });
      await withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,NULL,$6)`,
        ['p1', 'EXM-001/001', 'v1', 'test', 'tester', '2026-03-02'],
      ));

      const { rows } = await withClient((c) => c.query(
        `SELECT data->>'debitAccountId' AS dr, data->>'creditAccountId' AS cr, data->>'amount' AS amt
           FROM public.ledger_entries WHERE data->>'originModule' = 'examination_reversal'`,
      ));
      expect(rows).toHaveLength(1);
      // Reversal must swap the accounts and preserve the amount exactly.
      expect(rows[0].dr).toBe(EXAM_ACCOUNTS.revenue);
      expect(rows[0].cr).toBe(EXAM_ACCOUNTS.ar);
      expect(Number(rows[0].amt)).toBe(8000);
    });

    it('credits only recorded deductions, and never the invoice service lines', async () => {
      await withClient(async (client) => {
        await seedApprovedBatch(client);
        await client.query(
          `INSERT INTO public.examination_inventory_deductions (id, data) VALUES ($1, $2::jsonb)`,
          ['EXAM-DED-1', JSON.stringify({
            examination_job_id: 'JOB-1',
            lines: [{ item_id: 'PAPER-1', item_name: 'A4 Paper', quantity: 12, unit_cost: 10, total_cost: 120 }],
            reference: 'INVOICE-JOB-1',
          })],
        );
      });
      await withClient((c) => c.query(
        `SELECT public.post_examination_invoice_atomic($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        ['p1', 'EXM-001/001', 'k1', 4, JSON.stringify(invoiceEnvelope(8000)), JSON.stringify(ledgerEntry(8000)), '2026-03-01'],
      ));

      const { rows } = await withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,$6::text[],$7) AS result`,
        ['p1', 'EXM-001/001', 'v1', 'test', 'tester', ['EXAM-DED-1'], '2026-03-02'],
      ));

      expect(rows[0].result.inventoryMovementsReversed).toBe(1);

      const { rows: deduction } = await withClient((c) => c.query(
        `SELECT data->>'voidedBy' AS voided FROM public.examination_inventory_deductions WHERE id = 'EXAM-DED-1'`,
      ));
      expect(deduction[0].voided).toBe('EXM-001/001');
    });

    it('reverses nothing when no deductions are named', async () => {
      await withClient(async (client) => { await seedApprovedBatch(client); await post(); });
      const { rows } = await withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,NULL,$6) AS result`,
        ['p1', 'EXM-001/001', 'v1', 'test', 'tester', '2026-03-02'],
      ));
      expect(rows[0].result.inventoryMovementsReversed).toBe(0);
    });

    it('keeps the batch closed and retains the original invoice identity', async () => {
      await withClient(async (client) => { await seedApprovedBatch(client); await post(); });
      await withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,NULL,$6)`,
        ['p1', 'EXM-001/001', 'v1', 'test', 'tester', '2026-03-02'],
      ));

      const { rows } = await withClient((c) => c.query(
        `SELECT data->>'status' AS status, data->>'invoice_id' AS invoice, data->>'voided_invoice_id' AS voided
           FROM public.examination_batches WHERE id = 'p1'`,
      ));
      // The batch must NOT be reset to approved and must NOT lose its identity.
      expect(rows[0].status).toBe('invoiced');
      expect(rows[0].invoice).toBe('EXM-001/001');
      expect(rows[0].voided).toBe('EXM-001/001');

      const { rows: invoice } = await withClient((c) => c.query(
        `SELECT id, data->>'status' AS status FROM public.invoices WHERE id = 'EXM-001/001'`,
      ));
      expect(invoice).toHaveLength(1);
      expect(invoice[0].status).toBe('cancelled');
    });
  });

  describe('§8.7 failure during posting or reversal recovers safely', () => {
    it('leaves no partial posting when the snapshot check fails', async () => {
      await expect(post({ invoice: invoiceEnvelope(1), ledger: ledgerEntry(1) }))
        .rejects.toThrow(/EXAM_POST_SNAPSHOT_MISMATCH/);

      const { rows } = await withClient((c) => c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM public.invoices) AS invoices,
           (SELECT COUNT(*)::int FROM public.ledger_entries) AS ledger,
           (SELECT state FROM public.examination_postings LIMIT 1) AS posting_state`,
      ));
      expect(rows[0].invoices).toBe(0);
      expect(rows[0].ledger).toBe(0);
    });

    it('refuses to void an invoice that has payments against it', async () => {
      await withClient(async (client) => {
        await seedApprovedBatch(client);
        await post();
        await client.query(
          `UPDATE public.invoices SET data = data || '{"paidAmount": 1000}'::jsonb WHERE id = 'EXM-001/001'`,
        );
      });

      await expect(withClient((c) => c.query(
        `SELECT public.void_examination_invoice_atomic($1,$2,$3,$4,$5,NULL,$6)`,
        ['p1', 'EXM-001/001', 'v1', 'test', 'tester', '2026-03-02'],
      ))).rejects.toThrow(/EXAM_VOID_HAS_PAYMENTS/);
    });
  });

  describe('§8.8 a disconnected device cannot overwrite a committed invoice', () => {
    it('rejects a stale reconnect carrying the pre-invoice batch version', async () => {
      await withClient(async (client) => { await seedApprovedBatch(client); await post(); });

      // The disconnected device still believes the batch is at version 4 and
      // unread, and tries to post its own invoice.
      await expect(post({
        expectedVersion: 4,
        idempotencyKey: 'stale-device',
        invoiceNumber: 'EXM-001/777',
      })).rejects.toThrow(/EXAM_POST_VERSION_CONFLICT|EXAM_POST_ALREADY_INVOICED/);

      const { rows } = await withClient((c) => c.query(
        `SELECT COUNT(*)::int AS n FROM public.invoices WHERE id = 'EXM-001/777'`,
      ));
      expect(rows[0].n).toBe(0);
    });
  });

  describe('privileges', () => {
    it('keeps the posting functions unavailable to PUBLIC and anon', async () => {
      const { rows } = await withClient((c) => c.query(`
        SELECT
          has_function_privilege('public', 'public.post_examination_invoice_atomic(text,text,text,integer,jsonb,jsonb,date)', 'EXECUTE') AS pub_exec,
          has_function_privilege('anon', 'public.void_examination_invoice_atomic(text,text,text,text,text,text[],date)', 'EXECUTE') AS anon_exec,
          has_function_privilege('service_role', 'public.post_examination_invoice_atomic(text,text,text,integer,jsonb,jsonb,date)', 'EXECUTE') AS svc_exec
      `));
      expect(rows[0].pub_exec).toBe(false);
      expect(rows[0].anon_exec).toBe(false);
      expect(rows[0].svc_exec).toBe(true);
    });
  });
});