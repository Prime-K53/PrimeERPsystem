/**
 * atomicOperationBoundary.test.ts — Phase 6C §11E.
 *
 * Documents the exact rollback boundary of the REAL
 * `dbService.executeAtomicOperation` for the eventual Phase 6 reversal append.
 *
 * This intentionally imports the production `dbService` (not a mock) and spies
 * its write primitive, so the finding reflects actual production behavior:
 * `executeAtomicOperation` runs the operation body against a thin per-store
 * adapter; it is NOT a cross-store IndexedDB transaction and therefore does NOT
 * roll back earlier writes when a later write throws.
 *
 * No production behavior is modified; this is a characterization test.
 */
import { describe, it, expect, vi } from 'vitest';
import { dbService } from '../../services/db';

describe('dbService.executeAtomicOperation — rollback boundary', () => {
  it('does NOT roll back an earlier write when a later write throws', async () => {
    const persisted: string[] = [];
    const putSpy = vi
      .spyOn(dbService, 'put')
      .mockImplementation(async (store: unknown, item: unknown) => {
        const record = item as { id?: string };
        if (record?.id === 'FAIL') throw new Error('boom');
        persisted.push(`${String(store)}:${record?.id}`);
        return String(record?.id ?? '');
      });

    await expect(
      dbService.executeAtomicOperation(
        ['invoices', 'ledger'],
        async (tx: {
          objectStore: (name: string) => { put: (item: unknown) => Promise<unknown> };
        }) => {
          await tx.objectStore('invoices').put({ id: 'INV-1' });
          await tx.objectStore('ledger').put({ id: 'FAIL' });
        },
      ),
    ).rejects.toThrow('boom');

    // The invoices write already happened and was NOT undone by the later
    // failure — there is no shared rollback boundary across stores.
    expect(persisted).toEqual(['invoices:INV-1']);
    putSpy.mockRestore();
  });

  it('runs each put independently (sequential, no shared transaction)', async () => {
    const order: string[] = [];
    const putSpy = vi
      .spyOn(dbService, 'put')
      .mockImplementation(async (store: unknown) => {
        order.push(String(store));
        return 'ok';
      });

    await dbService.executeAtomicOperation(['invoices', 'ledger'], async (tx: {
      objectStore: (name: string) => { put: (item: unknown) => Promise<unknown> };
    }) => {
      await tx.objectStore('invoices').put({ id: 'INV-1' });
      await tx.objectStore('ledger').put({ id: 'LG-1' });
    });

    expect(order).toEqual(['invoices', 'ledger']);
    putSpy.mockRestore();
  });
});
