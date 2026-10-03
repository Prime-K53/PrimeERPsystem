import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Truck, X, CheckCircle, AlertTriangle, RotateCcw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { dbService } from '../../services/db';
import {
  createTransportExpense,
  postTransportExpense,
  voidTransportExpense,
  TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
  type CreateTransportExpenseInput,
} from '../../services/transportExpenseService';
import type { TransportExpense } from '../../types';

interface DraftLine {
  description: string;
  amount: string;
  classification: 'OUTBOUND_TRANSPORT' | 'NON_TRANSPORT';
  supplierId: string;
  accountId: string;
}

const emptyLine = (supplierId: string): DraftLine => ({
  description: '',
  amount: '',
  classification: 'OUTBOUND_TRANSPORT',
  supplierId,
  accountId: '',
});

const TransportExpenses: React.FC = () => {
  const { notify } = useAuth();
  const [expenses, setExpenses] = useState<TransportExpense[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [settlementMode, setSettlementMode] = useState<'AP' | 'CASH'>('AP');
  const [settlementAccountId, setSettlementAccountId] = useState('11110');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine('')]);
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);

  const refresh = async () => {
    const [all, sups] = await Promise.all([
      dbService.getAll<TransportExpense>('transportExpenses' as never),
      dbService.getAll<any>('suppliers' as never),
    ]);
    setExpenses((all || []).filter((e) => !e.isReversal));
    setSuppliers(sups || []);
  };

  useEffect(() => {
    refresh().catch((err) => notify(`Failed to load transport expenses: ${String((err as Error)?.message || err)}`, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    const transport = lines
      .filter((l) => l.classification === 'OUTBOUND_TRANSPORT')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return { transport, total };
  }, [lines]);

  const handleCreateAndPost = async () => {
    setSaving(true);
    try {
      const input: CreateTransportExpenseInput = {
        supplierId: supplierId || null,
        settlementMode,
        settlementAccountId: settlementMode === 'CASH' ? settlementAccountId : null,
        businessDate,
        lines: lines.map((l) => ({
          description: l.description,
          amount: Number(l.amount),
          classification: l.classification,
          supplierId: l.supplierId,
          accountId: l.classification === 'NON_TRANSPORT' ? l.accountId || null : null,
        })),
      };
      const created = await createTransportExpense(input);
      const posted = await postTransportExpense(created.id);
      notify(`Transport expense posted (${posted.totalAmount.toFixed(2)}).`, 'success');
      setIsFormOpen(false);
      setLines([emptyLine('')]);
      await refresh();
    } catch (err) {
      notify(`Transport expense failed: ${String((err as Error)?.message || err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleVoid = async (id: string) => {
    try {
      await voidTransportExpense(id, 'Manual void from Transport Expenses');
      notify('Transport expense voided with reversal.', 'success');
      setConfirmVoidId(null);
      await refresh();
    } catch (err) {
      notify(`Void failed: ${String((err as Error)?.message || err)}`, 'error');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Truck size={24} />
          <div>
            <h1 className="text-2xl font-bold">Courier &amp; Delivery Transport Expenses</h1>
            <p className="text-sm text-gray-500">
              Authoritative outbound transport source. Debits {TRANSPORT_EXPENSE_DEBIT_ACCOUNT} only;
              never customer charges, never Landing Cost.
            </p>
          </div>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-teal-700 text-white rounded"
          onClick={() => setIsFormOpen(true)}
        >
          <Plus size={16} /> New transport expense
        </button>
      </div>

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="p-3">Date</th>
              <th className="p-3">Supplier</th>
              <th className="p-3">Transport</th>
              <th className="p-3">Total</th>
              <th className="p-3">Mode</th>
              <th className="p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => {
              const transportTotal = (e.lines || [])
                .filter((l) => l.classification === 'OUTBOUND_TRANSPORT')
                .reduce((s, l) => s + (Number(l.amount) || 0), 0);
              const supplierName =
                suppliers.find((s) => String(s.id) === String(e.supplierId))?.name ||
                e.supplierId ||
                '—';
              return (
                <tr key={e.id} className="border-b">
                  <td className="p-3">{e.businessDate}</td>
                  <td className="p-3">{supplierName}</td>
                  <td className="p-3">{transportTotal.toFixed(2)}</td>
                  <td className="p-3">{Number(e.totalAmount || 0).toFixed(2)}</td>
                  <td className="p-3">{e.settlementMode}</td>
                  <td className="p-3">
                    <span
                      className={
                        e.status === 'POSTED'
                          ? 'text-green-700 font-semibold'
                          : e.status === 'VOIDED'
                            ? 'text-red-700 font-semibold'
                            : 'text-gray-600'
                      }
                    >
                      {e.status}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    {e.status === 'POSTED' &&
                      (confirmVoidId === e.id ? (
                        <span className="inline-flex gap-2">
                          <button
                            className="px-3 py-1 bg-red-700 text-white rounded"
                            onClick={() => handleVoid(e.id)}
                          >
                            Confirm void
                          </button>
                          <button
                            className="px-3 py-1 border rounded"
                            onClick={() => setConfirmVoidId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="inline-flex items-center gap-1 px-3 py-1 border rounded"
                          onClick={() => setConfirmVoidId(e.id)}
                        >
                          <RotateCcw size={14} /> Void
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
            {expenses.length === 0 && (
              <tr>
                <td className="p-6 text-center text-gray-500" colSpan={7}>
                  No transport expenses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isFormOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">New transport expense</h2>
              <button onClick={() => setIsFormOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <label className="block text-sm">
                Supplier
                <select
                  className="mt-1 w-full border rounded p-2"
                  value={supplierId}
                  onChange={(e) => {
                    setSupplierId(e.target.value);
                    setLines((prev) =>
                      prev.map((l) => ({ ...l, supplierId: l.supplierId || e.target.value })),
                    );
                  }}
                >
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Business date
                <input
                  type="date"
                  className="mt-1 w-full border rounded p-2"
                  value={businessDate}
                  onChange={(e) => setBusinessDate(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                Settlement
                <select
                  className="mt-1 w-full border rounded p-2"
                  value={settlementMode}
                  onChange={(e) => setSettlementMode(e.target.value as 'AP' | 'CASH')}
                >
                  <option value="AP">Supplier AP (21110)</option>
                  <option value="CASH">Cash / bank now</option>
                </select>
              </label>
              {settlementMode === 'CASH' && (
                <label className="block text-sm">
                  Cash/bank account id
                  <input
                    className="mt-1 w-full border rounded p-2"
                    value={settlementAccountId}
                    onChange={(e) => setSettlementAccountId(e.target.value)}
                  />
                </label>
              )}
            </div>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-12 gap-2 mb-2 items-end">
                <input
                  className="col-span-4 border rounded p-2 text-sm"
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)))
                  }
                />
                <input
                  className="col-span-2 border rounded p-2 text-sm"
                  placeholder="Amount"
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, amount: e.target.value } : l)))
                  }
                />
                <select
                  className="col-span-3 border rounded p-2 text-sm"
                  value={line.classification}
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((l, i) =>
                        i === index ? { ...l, classification: e.target.value as DraftLine['classification'] } : l,
                      ),
                    )
                  }
                >
                  <option value="OUTBOUND_TRANSPORT">OUTBOUND_TRANSPORT</option>
                  <option value="NON_TRANSPORT">NON_TRANSPORT</option>
                </select>
                <input
                  className="col-span-2 border rounded p-2 text-sm"
                  placeholder={line.classification === 'NON_TRANSPORT' ? 'Acct id' : 'Auto 52610'}
                  value={line.classification === 'NON_TRANSPORT' ? line.accountId : ''}
                  disabled={line.classification !== 'NON_TRANSPORT'}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, accountId: e.target.value } : l)))
                  }
                />
                <button
                  className="col-span-1 text-red-700"
                  onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            <button
              className="text-sm text-teal-700 mb-4"
              onClick={() => setLines((prev) => [...prev, emptyLine(supplierId)])}
            >
              + Add line
            </button>
            <div className="flex items-center justify-between border-t pt-4">
              <div className="text-sm">
                Transport <strong>{totals.transport.toFixed(2)}</strong> · Total{' '}
                <strong>{totals.total.toFixed(2)}</strong>
              </div>
              <div className="flex gap-2">
                <button
                  className="px-4 py-2 border rounded"
                  disabled={saving}
                  onClick={() => setIsFormOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 bg-teal-700 text-white rounded inline-flex items-center gap-2"
                  disabled={saving}
                  onClick={handleCreateAndPost}
                >
                  <CheckCircle size={16} /> Create &amp; post
                </button>
              </div>
            </div>
            <p className="mt-3 text-xs text-amber-700 inline-flex items-center gap-1">
              <AlertTriangle size={12} /> Posting is immutable. Void creates a separate reversal.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default TransportExpenses;
