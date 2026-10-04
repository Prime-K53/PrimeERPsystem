import React, { useState, useMemo } from 'react';
import {
  Plus, Trash2,
  ShieldCheck, AlertCircle, Info, Landmark,
  TrendingUp, Scaling, FileCheck,
  PieChart, Activity, Truck,
  RotateCcw, Save, Loader2, Printer
} from 'lucide-react';
import { Purchase, LandingCostItem } from '../../../types';
import { transactionService } from '../../../services/transactionService';
import { allocateLandingCosts, sumSharesForReceiptLine, getLandingLineState, type LandingAllocationMethod } from '../../../services/landingAllocation';
import { isInventoryBearingItem } from '../../../utils/inventoryNormalization';
import { useAuth } from '../../../context/AuthContext';
import { useInventory } from '../../../context/InventoryContext';
import { useProcurement } from '../../../context/ProcurementContext';

interface LandingCostAllocationProps {
    purchase: Purchase;
    onUpdate: (costs: LandingCostItem[], method?: LandingAllocationMethod) => void;
}

const LandingCostAllocation: React.FC<LandingCostAllocationProps> = ({ purchase, onUpdate }) => {
    const { companyConfig, notify } = useAuth(); const { purchases = [] } = useProcurement();
    const { inventory = [], updatePurchase } = useInventory();
    const currency = companyConfig.currencySymbol;

    const supplierNames = useMemo(() => {
        const names = new Set<string>();
        purchases?.forEach((p: any) => {
            if (p.supplierId) names.add(p.supplierId);
        });
        return Array.from(names).sort();
    }, [purchases]);
    
    const [costs, setCosts] = useState<LandingCostItem[]>(purchase.landingCosts || []);
    // Persisted allocation method (PO-owned). The toggle below is the only
    // writer besides initial load; posting always uses the persisted value.
    const [allocationMethod, setAllocationMethod] = useState<'Value' | 'Quantity'>(
        (purchase as any).landingAllocationMethod === 'QUANTITY' ? 'Quantity' : 'Value'
    );
    const canonicalMethod: LandingAllocationMethod = allocationMethod === 'Quantity' ? 'QUANTITY' : 'VALUE';
    const [isSaving, setIsSaving] = useState(false);
    // Financial immutability reflection (no redesign): lines with any
    // bill/capitalization consumption event are locked — amount, provider,
    // category and removal are disabled, and billing them again is blocked.
    // The transaction boundary (processPurchaseOrder / bill / GRN) enforces
    // the same rule; this only surfaces it.
    const consumedLandingIds = useMemo(
        () => new Set((((purchase as any).landingConsumption || []) as any[]).map((e: any) => String(e?.landingCostId))),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [purchase.id, JSON.stringify((purchase as any).landingConsumption || [])]
    );
    const isLineLocked = (id: string) => consumedLandingIds.has(String(id));
    const isMethodLocked = consumedLandingIds.size > 0;

    const totalLandingCost = useMemo(() => (costs || []).reduce((sum, c) => sum + (c.amount || 0), 0), [costs]);
    const totalPurchaseValue = useMemo(() => (purchase.items || []).reduce((sum, i) => sum + ((i.cost || 0) * (i.quantity || 0)), 0), [purchase.items]);
    const totalPurchaseQty = useMemo(() => (purchase.items || []).reduce((sum, i) => sum + (i.quantity || 0), 0), [purchase.items]);
    const burdenRatio = totalPurchaseValue > 0 ? (totalLandingCost / totalPurchaseValue) * 100 : 0;

    // Preview shares come from the SAME authoritative engine used at
    // posting, so preview totals always equal posting totals for identical
    // inputs. (Posting uses received quantities; the preview uses the PO's
    // ordered quantities, which agree whenever fully received.)
    const allocatedItems = useMemo(() => {
        const items = purchase.items || [];
        const capitalizable = (costs || []).filter(c => Number((c as any).amount) >= 0.005);
        try {
            const result = allocateLandingCosts({
                receiptLines: items.map((item: any) => ({
                    itemId: String(item.itemId || ''),
                    quantityReceived: Number(item.quantity ?? item.quantityReceived ?? 0) || 0,
                    unitCost: Number(item.cost ?? item.cost_price ?? item.costPrice ?? 0) || 0,
                })),
                isEligible: (lineIndex: number) => {
                    const line = (items as any[])[lineIndex];
                    const record = (inventory || []).find((r: any) => String(r.id) === String(line?.itemId));
                    return !!record && isInventoryBearingItem(record);
                },
                landingLines: capitalizable.map(c => ({ id: String(c.id), amount: Number((c as any).amount) })),
                method: canonicalMethod,
            });
            return items.map((item: any, index: number) => {
                const share = sumSharesForReceiptLine(result.shares, String(index));
                const qty = Number(item.quantity ?? item.quantityReceived ?? 0) || 0;
                const unitBurden = qty > 0 ? share / qty : 0;
                return { ...item, share, landedUnitCost: (Number(item.cost) || 0) + unitBurden };
            });
        } catch {
            return (items as any[]).map((item: any) => ({ ...item, share: 0, landedUnitCost: Number(item.cost) || 0 }));
        }
    }, [purchase.items, costs, canonicalMethod, inventory]);

    const handleAddCost = () => {
        const newCost: LandingCostItem = {
            id: `LC-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            category: 'Freight',
            description: '',
            amount: 0
        };
        const updated = [...costs, newCost];
        setCosts(updated);
        onUpdate(updated, canonicalMethod);
    };

    const handlePostAsBill = async (cost: LandingCostItem) => {
        if (!cost.amount || cost.amount <= 0) {
            notify("Cannot post a zero-amount bill", "error");
            return;
        }
        if (!cost.providerId) {
            notify("Select the actual provider (carrier) for this cost before posting it as a bill.", "error");
            return;
        }

        // Landing-cost bill = AP transaction (DR Inventory / CR provider AP),
        // never an operating expense. The transaction boundary enforces
        // single-billing and mutual exclusion with GRN capitalization.
        try {
            const res: any = await transactionService.postLandingCostBill({
                purchaseOrderId: purchase.id,
                landingCostId: cost.id,
            });
            if (res?.success) {
                notify(`Landing bill posted for ${cost.category} — provider AP updated, nothing expensed.`, "success");
            } else {
                notify("Failed to post landing bill.", "error");
            }
        } catch (e: any) {
            notify(e?.message || "Failed to post landing bill.", "error");
        }
    };

    const updateCost = (id: string, field: keyof LandingCostItem, value: any) => {
        const updated = costs.map(c => c.id === id ? { ...c, [field]: value } : c);
        setCosts(updated);
        onUpdate(updated, canonicalMethod);
    };

    const removeCost = (id: string) => {
        const updated = costs.filter(c => c.id !== id);
        setCosts(updated);
        onUpdate(updated, canonicalMethod);
    };

    const handleClearAll = () => {
        if (confirm("Purge all recorded shipping expenses for this PO?")) {
            setCosts([]);
            onUpdate([], canonicalMethod);
        }
    };

    const handleFinalize = async () => {
        setIsSaving(true);
        try {
            await updatePurchase({
                ...purchase,
                landingCosts: costs,
                landingAllocationMethod: canonicalMethod,
                notes: (purchase.notes || '') + `\n[System]: Landing costs updated at ${new Date().toLocaleTimeString()}`
            });
            notify("Shipment burden profiles saved to Purchase Order.", "success");
        } catch (e) {
            notify("Failed to finalize costs.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleQuickAdd = (category: LandingCostItem['category'], amt: number) => {
        const newCost: LandingCostItem = {
            id: `LC-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            category,
            description: `Standard ${category} estimate`,
            amount: amt
        };
        const updated = [...costs, newCost];
        setCosts(updated);
        onUpdate(updated, canonicalMethod);
    };

    return (
        <div className="app-modal" style={{
            display: 'flex', flexDirection: 'column', gap: 16,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            fontSize: 13.5, lineHeight: 1.5, color: '#1e293b',
        }}>
            {/* Analytics Header */}
            <div className="grid grid-cols-1 md:grid-cols-4" style={{ gap: 12 }}>
                <div style={{ background: '#fcfcfd', padding: '12px 14px', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ display: 'inline-flex', padding: 6, background: '#eff6ff', color: '#2563eb', borderRadius: 8 }}><PieChart size={14}/></span>
                        <span className="modal-label">Burden Ratio</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.4, fontVariantNumeric: 'tabular-nums' }}>{(burdenRatio || 0).toFixed(1)}%</span>
                        <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>of goods value</span>
                    </div>
                </div>
                <div style={{ background: '#fcfcfd', padding: '12px 14px', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ display: 'inline-flex', padding: 6, background: '#ecfdf5', color: '#059669', borderRadius: 8 }}><Activity size={14}/></span>
                        <span className="modal-label">Total Surcharges</span>
                    </div>
                    <div className="finance-nums" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.4 }}>{currency}{(totalLandingCost || 0).toLocaleString()}</div>
                </div>
                <div className="col-span-2 flex" style={{ gap: 12 }}>
                    <button
                        onClick={() => handleQuickAdd('Freight', 1500)}
                        className="modal-btn-secondary"
                        style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '8px 12px', textAlign: 'left', cursor: 'pointer', fontSize: 13, lineHeight: 1.45 }}
                    >
                        <Truck size={16} style={{ color: '#64748b', flexShrink: 0 }}/>
                        <span>
                            <span className="modal-label-small" style={{ display: 'block' }}>Quick estimate</span>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Domestic Freight</span>
                        </span>
                    </button>
                    <button
                        onClick={() => handleQuickAdd('Customs', 500)}
                        className="modal-btn-secondary"
                        style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '8px 12px', textAlign: 'left', cursor: 'pointer', fontSize: 13, lineHeight: 1.45 }}
                    >
                        <Landmark size={16} style={{ color: '#64748b', flexShrink: 0 }}/>
                        <span>
                            <span className="modal-label-small" style={{ display: 'block' }}>Quick estimate</span>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Clearance &amp; Duty</span>
                        </span>
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 16 }}>

                {/* Left: Input Ledger */}
                <div style={{ background: '#fcfcfd', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                        <div>
                            <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                                <Landmark size={15} style={{ color: '#2563eb' }}/> Shipment Expense Ledger
                            </h3>
                            <p className="modal-sub" style={{ margin: '2px 0 0' }}>Secondary vendor invoices</p>
                            {consumedLandingIds.size > 0 && (
                                <p style={{ margin: '2px 0 0', fontSize: 12, fontWeight: 500, color: '#b45309' }}>Locked lines have posted bills/capitalization and cannot be edited</p>
                            )}
                        </div>
                        <div className="flex" style={{ gap: 8 }}>
                            <button
                                onClick={handleClearAll}
                                title="Clear All Costs"
                                className="modal-close"
                                style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', display: 'inline-flex' }}
                            >
                                <RotateCcw size={14}/>
                            </button>
                            <button
                                onClick={handleAddCost}
                                title="Add Cost"
                                className="modal-btn-primary"
                                style={{ background: '#2563eb', color: '#f8fafc', border: 'none', cursor: 'pointer', display: 'inline-flex' }}
                            >
                                <Plus size={14}/>
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 280 }}>
                        {(costs || []).length === 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', padding: '40px 0' }}>
                                <AlertCircle size={28} style={{ marginBottom: 8 }}/>
                                <p style={{ fontSize: 13, fontWeight: 500 }}>No surcharges logged</p>
                            </div>
                        ) : (
                            costs.map(cost => (
                                <div key={cost.id} className="group" style={{ position: 'relative', padding: 12, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                                    <div className="grid grid-cols-2" style={{ gap: 10, marginBottom: 10 }}>
                                        <div>
                                            <label className="modal-label" style={{ display: 'block', marginBottom: 4 }}>Cost category</label>
                                            <select
                                                value={cost.category}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'category', e.target.value)}
                                                style={{ width: '100%', padding: '6px 10px', background: '#fcfcfd', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontWeight: 500, outline: 'none', color: '#1e293b', fontFamily: 'inherit', lineHeight: 1.45 }}
                                            >
                                                <option>Freight</option>
                                                <option>Customs</option>
                                                <option>Insurance</option>
                                                <option>Handling</option>
                                                <option>Other</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="modal-label" style={{ display: 'block', marginBottom: 4 }}>Amount ({currency})</label>
                                            <input
                                                type="number"
                                                className="finance-nums"
                                                value={cost.amount || ''}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'amount', parseFloat(e.target.value))}
                                                placeholder="0.00"
                                                style={{ width: '100%', padding: '6px 10px', background: '#fcfcfd', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontWeight: 500, outline: 'none', textAlign: 'right', color: '#1e293b', fontFamily: 'inherit', lineHeight: 1.45 }}
                                            />
                                            {(() => {
                                                const st = getLandingLineState(purchase as any, cost.id);
                                                if ((st.consumed <= 0 && !st.billed && st.remaining === st.source) || st.source <= 0) {
                                                    return null;
                                                }
                                                return (
                                                    <p className="finance-nums" style={{ fontSize: 12, color: '#475569', margin: '4px 0 0' }}>
                                                        Consumed {currency}{st.consumed.toLocaleString()} · Remaining {currency}{st.remaining.toLocaleString()}
                                                        {st.billed ? ` · Billed (${st.billIds.join(', ') || 'bill posted'})` : ''}
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2" style={{ gap: 10 }}>
                                        <div>
                                            <label className="modal-label" style={{ display: 'block', marginBottom: 4 }}>Remit to (carrier)</label>
                                            <select
                                                value={cost.providerId}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'providerId', e.target.value)}
                                                style={{ width: '100%', padding: '6px 10px', background: '#fcfcfd', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontWeight: 500, outline: 'none', color: '#1e293b', fontFamily: 'inherit', lineHeight: 1.45 }}
                                            >
                                                <option value="">-- Manual Provider --</option>
                                                {supplierNames.map(name => <option key={name} value={name}>{name}</option>)}
                                            </select>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                                            <button
                                                onClick={() => handlePostAsBill(cost)}
                                                disabled={!cost.amount || !cost.providerId || isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Already settled: this line has posted financial activity' : undefined}
                                                className="modal-btn-secondary"
                                                style={{ width: '100%', background: '#fcfcfd', border: '1px solid #cbd5e1', color: '#475569', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                            >
                                                <FileCheck size={12}/> Post as Bill
                                            </button>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => removeCost(cost.id)}
                                        disabled={isLineLocked(cost.id)}
                                        title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                        className="modal-close"
                                        style={{ position: 'absolute', top: -8, right: -8, background: '#fcfcfd', border: '1px solid #fecdd3', color: '#e11d48', borderRadius: 999, cursor: 'pointer', display: 'inline-flex' }}
                                    >
                                        <Trash2 size={12}/>
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    <div style={{ padding: '12px 14px', background: '#1e293b', color: '#e2e8f0', flexShrink: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#93c5fd' }}>Total landed load</span>
                            <span className="finance-nums" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}>{currency}{(totalLandingCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                </div>

                {/* Right: Allocation Logic */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ background: '#fcfcfd', padding: 14, borderRadius: 12, border: '1px solid #e2e8f0', position: 'relative', overflow: 'hidden' }}>
                        <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
                            <Scaling size={15} style={{ color: '#7c3aed' }}/> Capitalization Logic
                        </h3>
                        <div style={{ display: 'flex', gap: 6, padding: 4, background: '#f1f5f9', borderRadius: 10, border: '1px solid #e2e8f0', marginBottom: 12 }}>
                            <button
                                onClick={() => { setAllocationMethod('Value'); onUpdate(costs, 'VALUE'); }}
                                disabled={isMethodLocked}
                                title={isMethodLocked ? 'Locked: landing activity already posted under a method' : undefined}
                                style={{ flex: 1, padding: '7px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.45, background: allocationMethod === 'Value' ? '#fcfcfd' : 'transparent', color: allocationMethod === 'Value' ? '#2563eb' : '#64748b', boxShadow: allocationMethod === 'Value' ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}
                            >
                                Value-proportional
                            </button>
                            <button
                                onClick={() => { setAllocationMethod('Quantity'); onUpdate(costs, 'QUANTITY'); }}
                                disabled={isMethodLocked}
                                title={isMethodLocked ? 'Locked: landing activity already posted under a method' : undefined}
                                style={{ flex: 1, padding: '7px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.45, background: allocationMethod === 'Quantity' ? '#fcfcfd' : 'transparent', color: allocationMethod === 'Quantity' ? '#2563eb' : '#64748b', boxShadow: allocationMethod === 'Quantity' ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}
                            >
                                Unit-proportional
                            </button>
                        </div>

                        <div style={{ background: '#eff6ff', padding: '10px 12px', borderRadius: 10, border: '1px solid #bfdbfe', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <Info size={15} style={{ color: '#2563eb', flexShrink: 0, marginTop: 2 }}/>
                            <p style={{ fontSize: 13, color: '#1e40af', lineHeight: 1.5, fontWeight: 400, margin: 0 }}>
                                {allocationMethod === 'Value'
                                    ? 'Costs are distributed based on the monetary weight of each line. Expensive items absorb a higher percentage of the landing cost.'
                                    : 'Costs are split evenly per physical unit. Best used for shipments where weight or size is the primary cost driver.'
                                }
                            </p>
                        </div>
                    </div>

                    <div style={{ background: '#fcfcfd', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ padding: '10px 14px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <TrendingUp size={15} style={{ color: '#059669' }}/>
                                <h3 className="modal-title">Valuation Bridge</h3>
                            </div>
                            <button
                                onClick={() => window.print()}
                                className="modal-btn-secondary"
                                style={{ background: '#fcfcfd', color: '#475569', border: '1px solid #cbd5e1', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                                <Printer size={12}/>
                                Print Report
                            </button>
                        </div>
                        <div id="valuation-bridge" style={{ padding: 0, background: '#fcfcfd' }}>
                            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 13, lineHeight: 1.5 }}>
                                <thead style={{ position: 'sticky', top: 0 }}>
                                    <tr style={{ background: '#f1f5f9' }}>
                                        <th className="table-header" style={{ textAlign: 'left' }}>Item SKU</th>
                                        <th className="table-header numeric-cell">Factory</th>
                                        <th className="table-header numeric-cell">Burden</th>
                                        <th className="table-header numeric-cell">Landed</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {allocatedItems.map((ai, i) => (
                                        <tr key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid #f1f5f9' }}>
                                            <td className="table-body-cell">
                                                <div style={{ fontWeight: 600, color: '#1e293b', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{ai.name}</div>
                                                <div className="finance-nums" style={{ fontSize: 12, color: '#64748b' }}>{ai.sku}</div>
                                            </td>
                                            <td className="table-body-cell numeric-cell finance-nums">{currency}{(ai.cost || 0).toFixed(2)}</td>
                                            <td className="table-body-cell numeric-cell finance-nums" style={{ color: '#2563eb', fontWeight: 600 }}>+{currency}{(ai.share / (ai.quantity || 1)).toFixed(2)}</td>
                                            <td className="table-body-cell numeric-cell finance-nums" style={{ color: '#059669', fontWeight: 600 }}>{currency}{(ai.landedUnitCost || 0).toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

            </div>

            {/* Bottom Finalize Control */}
            <div style={{ background: '#1e293b', padding: '12px 14px', borderRadius: 12, border: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 12, position: 'relative', overflow: 'hidden' }}>
                <div style={{ width: 36, height: 36, background: '#2563eb', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <ShieldCheck size={20} style={{ color: '#f8fafc' }}/>
                </div>
                <div style={{ flex: 1 }}>
                    <h4 style={{ fontWeight: 600, color: '#f1f5f9', fontSize: 13.5, lineHeight: 1.4, margin: 0 }}>Inventory valuation integrity</h4>
                    <p style={{ color: '#94a3b8', fontSize: 12.5, margin: '2px 0 0', lineHeight: 1.5, fontWeight: 400 }}>
                        Finalizing saves these shipment expenses to the purchase order. On receipt, surcharges capitalize into the <b>weighted average unit cost</b> of your items.
                    </p>
                </div>
                <div style={{ flexShrink: 0 }}>
                    <button
                        onClick={handleFinalize}
                        disabled={isSaving}
                        className="modal-btn-primary"
                        style={{ background: '#f8fafc', color: '#1e293b', border: 'none', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                        {isSaving ? <Loader2 size={14} className="animate-spin" style={{ color: '#2563eb' }}/> : <Save size={14} style={{ color: '#2563eb' }}/>}
                        Commit to Order
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LandingCostAllocation;
