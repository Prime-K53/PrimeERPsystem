import React, { useState, useMemo } from 'react';
import { 
  Plus, Trash2, Calculator, 
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
        <div className="flex flex-col gap-8 animate-in fade-in duration-300">
            
            {/* Analytics Header */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-blue-50 text-blue-600 rounded-lg"><PieChart size={16}/></div>
                        <span className="text-label">Burden Ratio</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-title">{(burdenRatio || 0).toFixed(1)}%</span>
                        <span className="text-[10px] font-bold text-slate-400 tracking-tight uppercase">of Goods Value</span>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg"><Activity size={16}/></div>
                        <span className="text-label">Total Surcharges</span>
                    </div>
                    <div className="text-title finance-nums">{currency}{(totalLandingCost || 0).toLocaleString()}</div>
                </div>
                <div className="col-span-2 flex gap-2">
                    <button 
                        onClick={() => handleQuickAdd('Freight', 1500)}
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl p-4 text-left hover:bg-slate-100 transition-all group"
                    >
                        <Truck size={18} className="text-slate-400 group-hover:text-blue-600 mb-2"/>
                        <span className="block text-label mb-1">Quick Estimate</span>
                        <span className="block text-[13px] font-semibold text-slate-800">Domestic Freight</span>
                    </button>
                    <button 
                        onClick={() => handleQuickAdd('Customs', 500)}
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl p-4 text-left hover:bg-slate-100 transition-all group"
                    >
                        <Landmark size={18} className="text-slate-400 group-hover:text-indigo-600 mb-2"/>
                        <span className="block text-label mb-1">Quick Estimate</span>
                        <span className="block text-[13px] font-semibold text-slate-800">Clearance & Duty</span>
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                
                {/* Left: Input Ledger */}
                <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                    <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <div>
                            <h3 className="text-title flex items-center gap-2">
                                <Landmark size={16} className="text-blue-600"/> Shipment Expense Ledger
                            </h3>
                            <p className="text-[10px] text-slate-400 font-bold uppercase mt-1 tracking-tight">Secondary Vendor Invoices</p>
                            {consumedLandingIds.size > 0 && (
                                <p className="text-[10px] text-amber-700 font-bold uppercase mt-1 tracking-tight">Locked lines have posted bills/capitalization and cannot be edited</p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button 
                                onClick={handleClearAll}
                                title="Clear All Costs"
                                className="bg-slate-100 text-slate-400 p-2 rounded-xl hover:bg-rose-50 hover:text-rose-500 transition-colors"
                            >
                                <RotateCcw size={18}/>
                            </button>
                            <button 
                                onClick={handleAddCost}
                                className="bg-blue-600 text-white p-2 rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all active:scale-95"
                            >
                                <Plus size={18}/>
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar min-h-[350px]">
                        {(costs || []).length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-slate-400 opacity-40 italic py-20">
                                <AlertCircle size={40} className="mb-2"/>
                                <p className="text-[13px] font-bold uppercase tracking-tight">No surcharges logged</p>
                            </div>
                        ) : (
                            costs.map(cost => (
                                <div key={cost.id} className="p-5 bg-slate-50 rounded-2xl border border-slate-200 group relative">
                                    <div className="grid grid-cols-2 gap-4 mb-4">
                                        <div>
                                            <label className="text-label mb-1.5 block">Cost Category</label>
                                            <select 
                                                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-[13px] font-semibold outline-none focus:border-blue-500 disabled:opacity-50"
                                                value={cost.category}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'category', e.target.value)}
                                            >
                                                <option>Freight</option>
                                                <option>Customs</option>
                                                <option>Insurance</option>
                                                <option>Handling</option>
                                                <option>Other</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-label mb-1.5 block">Amount ({currency})</label>
                                            <input 
                                                type="number" 
                                                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-[13px] font-bold outline-none focus:border-blue-500 text-right finance-nums disabled:opacity-50"
                                                value={cost.amount || ''}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'amount', parseFloat(e.target.value))}
                                                placeholder="0.00"
                                            />
                                            {(() => {
                                                const st = getLandingLineState(purchase as any, cost.id);
                                                if ((st.consumed <= 0 && !st.billed && st.remaining === st.source) || st.source <= 0) {
                                                    return null;
                                                }
                                                return (
                                                    <p className="text-[10px] text-slate-500 font-semibold mt-1">
                                                        Consumed {currency}{st.consumed.toLocaleString()} · Remaining {currency}{st.remaining.toLocaleString()}
                                                        {st.billed ? ` · Billed (${st.billIds.join(', ') || 'bill posted'})` : ''}
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="col-span-1">
                                            <label className="text-label mb-1.5 block">Remit To (Carrier)</label>
                                            <select 
                                                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-[13px] outline-none font-semibold disabled:opacity-50"
                                                value={cost.providerId}
                                                disabled={isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                                onChange={e => updateCost(cost.id, 'providerId', e.target.value)}
                                            >
                                                <option value="">-- Manual Provider --</option>
                                                {supplierNames.map(name => <option key={name} value={name}>{name}</option>)}
                                            </select>
                                        </div>
                                        <div className="col-span-1 flex items-end">
                                            <button 
                                                onClick={() => handlePostAsBill(cost)}
                                                disabled={!cost.amount || !cost.providerId || isLineLocked(cost.id)}
                                                title={isLineLocked(cost.id) ? 'Already settled: this line has posted financial activity' : undefined}
                                                className="w-full py-2 bg-white border border-slate-200 rounded-lg text-[13px] font-bold uppercase tracking-tight text-slate-600 hover:text-blue-600 hover:border-blue-200 disabled:opacity-30 transition-all flex items-center justify-center gap-2 shadow-sm"
                                            >
                                                <FileCheck size={12}/> Post as Bill
                                            </button>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => removeCost(cost.id)}
                                        disabled={isLineLocked(cost.id)}
                                        title={isLineLocked(cost.id) ? 'Locked: this line has posted financial activity' : undefined}
                                        className="absolute -top-2 -right-2 bg-white border border-rose-100 text-rose-500 p-1.5 rounded-full shadow-md hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30"
                                    >
                                        <Trash2 size={12}/>
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                    
                    <div className="p-6 bg-slate-900 text-white shrink-0">
                        <div className="flex justify-between items-center">
                            <span className="text-label text-blue-400">Total Landed Load</span>
                            <span className="text-[24px] font-bold finance-nums">{currency}{(totalLandingCost || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                        </div>
                    </div>
                </div>

                {/* Right: Allocation Logic */}
                <div className="space-y-6">
                    <div className="bg-white p-8 rounded-[3rem] border border-slate-200 shadow-sm relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-8 opacity-5 rotate-12 group-hover:rotate-0 transition-transform duration-1000"><Calculator size={120}/></div>
                        <h3 className="text-title mb-6 flex items-center gap-2">
                            <Scaling size={16} className="text-purple-600"/> Capitalization Logic
                        </h3>
                        <div className="flex gap-4 p-1.5 bg-slate-100 rounded-2xl border border-slate-200 mb-8">
                            <button 
                                onClick={() => { setAllocationMethod('Value'); onUpdate(costs, 'VALUE'); }}
                                disabled={isMethodLocked}
                                title={isMethodLocked ? 'Locked: landing activity already posted under a method' : undefined}
                                className={`flex-1 py-3 rounded-xl text-[12.5px] font-bold uppercase tracking-widest transition-all ${allocationMethod === 'Value' ? 'bg-white text-blue-600 shadow-md' : 'text-slate-500 hover:text-slate-800'}`}
                            >
                                Value-Proportional
                            </button>
                            <button 
                                onClick={() => { setAllocationMethod('Quantity'); onUpdate(costs, 'QUANTITY'); }}
                                disabled={isMethodLocked}
                                title={isMethodLocked ? 'Locked: landing activity already posted under a method' : undefined}
                                className={`flex-1 py-3 rounded-xl text-[12.5px] font-bold uppercase tracking-widest transition-all ${allocationMethod === 'Quantity' ? 'bg-white text-blue-600 shadow-md' : 'text-slate-500 hover:text-slate-800'}`}
                            >
                                Unit-Proportional
                            </button>
                        </div>
                        
                        <div className="bg-blue-50 p-5 rounded-2xl border border-blue-100 flex items-start gap-4">
                            <Info size={18} className="text-blue-600 shrink-0 mt-0.5"/>
                            <p className="text-[13px] text-blue-800 leading-relaxed font-medium uppercase tracking-tight">
                                {allocationMethod === 'Value' 
                                    ? "Costs are distributed based on the monetary weight of each line. Expensive items absorb a higher percentage of the landing cost."
                                    : "Costs are split evenly per physical unit. Best used for shipments where weight or size is the primary cost driver."
                                }
                            </p>
                        </div>
                    </div>

                    <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <TrendingUp size={16} className="text-emerald-600"/>
                                <h3 className="text-title">Valuation Bridge</h3>
                            </div>
                    <div className="flex gap-4">
                        <button 
                            onClick={() => window.print()}
                            className="bg-white text-slate-600 px-3 py-1 rounded-xl text-[13px] font-bold uppercase tracking-tight hover:bg-slate-50 border border-slate-200 flex items-center gap-2"
                        >
                            <Printer size={12}/>
                            Print Report
                        </button>
                    </div>
                </div>
                <div id="valuation-bridge" className="p-0 bg-white">
                            <table className="w-full text-left border-collapse">
                                <thead className="sticky top-0 z-10">
                                    <tr className="bg-slate-50/50">
                                        <th className="table-header px-4 py-2">Item SKU</th>
                                        <th className="table-header px-4 py-2 text-right">Factory</th>
                                        <th className="table-header px-4 py-2 text-center">Burden</th>
                                        <th className="table-header px-4 py-2 text-right">Landed</th>
                                    </tr>
                                </thead>

                                <tbody className="divide-y divide-slate-100">
                                    {allocatedItems.map((ai, i) => (
                                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                            <td className="table-body-cell px-4 py-2">
                                                <div className="font-semibold text-slate-800 text-[13px] truncate max-w-[150px]">{ai.name}</div>
                                                <div className="text-[10px] text-slate-400 font-mono">{ai.sku}</div>
                                            </td>
                                            <td className="table-body-cell px-4 py-2 text-right finance-nums">{currency}{(ai.cost || 0).toFixed(2)}</td>
                                            <td className="table-body-cell px-4 py-2 text-center text-blue-600 font-bold finance-nums">+{currency}{(ai.share / (ai.quantity || 1)).toFixed(2)}</td>
                                            <td className="table-body-cell px-4 py-2 text-right font-black text-emerald-600 finance-nums">{currency}{(ai.landedUnitCost || 0).toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

            </div>

            {/* Bottom Finalize Control */}
            <div className="bg-slate-900 p-6 rounded-[2.5rem] border border-white/5 flex flex-col md:flex-row items-center gap-6 shadow-2xl relative overflow-hidden">
                <div className="absolute inset-0 bg-blue-600 opacity-5 pointer-events-none"></div>
                <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg border border-white/10 shrink-0">
                    <ShieldCheck size={32} className="text-white"/>
                </div>
                <div className="flex-1">
                    <h4 className="font-black text-white uppercase text-sm tracking-tighter">Inventory Valuation Integrity</h4>
                    <p className="text-slate-400 text-xs mt-1 leading-relaxed max-w-2xl font-medium">
                        Finalizing will save these shipment expenses to the Purchase Order. When goods are received, the system will automatically capitalization these surcharges into the <b>weighted average unit cost</b> of your items.
                    </p>
                </div>
                <div className="shrink-0">
                    <button 
                        onClick={handleFinalize}
                        disabled={isSaving}
                        className="bg-white text-slate-900 px-8 py-4 rounded-2xl font-black uppercase text-[11px] tracking-widest hover:bg-slate-100 transition-all flex items-center gap-3 shadow-xl active:scale-95 disabled:opacity-50"
                    >
                        {isSaving ? <Loader2 size={18} className="animate-spin text-blue-600"/> : <Save size={18} className="text-blue-600"/>}
                        Commit to Order
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LandingCostAllocation;
