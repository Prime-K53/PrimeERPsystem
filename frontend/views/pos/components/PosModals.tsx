import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { logger } from '@/services/logger';
// PRICING RULE: Do NOT implement pricing logic here. All pricing MUST go through pricingEngine.ts
import { X, Printer, UserPlus, Save, ArrowRight, Search, Clock, Info, AlertTriangle, Users, Loader2 } from 'lucide-react';
import { HeldOrder, Item, ProductVariant, BillOfMaterial, BOMTemplate } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useFinance } from '../../../context/FinanceContext';
import { useInventory } from '../../../context/InventoryContext';
import { useSales } from '../../../context/SalesContext';
import { roundFinancial, formatNumber, roundToCurrency } from '../../../utils/helpers';
import { bomService } from '../../../services/bomService';
import { pricingService, DynamicServicePricingResult } from '../../../services/pricingService';
import { dbService } from '../../../services/db';
import { calculateServicePrice } from '../../../utils/pricing/pricingEngine';
import { isMarketAdjustmentActive } from '../../../utils/marketAdjustmentSemantics';
import { normalizeStoredPricing, resolveStoredSellingPrice } from '../../../utils/pricing';
import { isInventoryBearingItem } from '../../../utils/inventoryNormalization';
import { getCustomerOptionLabel } from '../../../utils/customerDisplay';
import { PosModal } from './PosModal';
import { Button, Money } from './Button';
// POS palette comes from the shared theme; the modal chrome now comes from
// PosModal. This file used to re-declare both, drifting onto a second ink
// (#23282A) and a second danger (#b5493f) outside the contrast contract.
import {
    NUMERIC_FONT,
    amber,
    borderDanger,
    borderSuccess,
    borderWarning,
    danger,
    hairline,
    ink,
    inkSoft,
    paper,
    success,
    surfaceDanger,
    surfaceSuccess,
    surfaceWarning,
    teal,
    textWarning,
} from '../theme';

/** Customer search field id — the keyboard list handler is scoped to it. */
const CUSTOMER_SEARCH_ID = 'pos-customer-search';

const BOM_OPTION_IDS = new Set(['binding', 'coverPages', 'stapling']);
const OPTION_META: Record<string, { bomSource?: 'tape' | 'cover' | 'staple' }> = {
    binding: { bomSource: 'tape' },
    coverPages: { bomSource: 'cover' },
    stapling: { bomSource: 'staple' },
    cutting: {},
    holePunch: {},
    folding: {},
};
const BOM_DEFAULT_RATES: Record<'tape' | 'cover' | 'staple', number> = { tape: 1.20, cover: 15.00, staple: 0.50 };
function computeBomRatesFromInventory(items: Item[]): Record<'tape' | 'cover' | 'staple', number> {
    const raw = (items || []).filter(i => i.type === 'Raw Material' || (i as any).classification === 'raw');
    const tapeItem = raw.find(i => /tape|binding tape/i.test(i.name || ''));
    const coverItem = raw.find(i => /card|cover|board/i.test(i.name || ''));
    const stapleItem = raw.find(i => /staple/i.test(i.name || ''));
    return {
        tape: tapeItem ? Number(((tapeItem.cost_price || tapeItem.cost || 0) / ((tapeItem as any).conversionRate || 1)).toFixed(2)) : BOM_DEFAULT_RATES.tape,
        cover: coverItem ? Number(((coverItem.cost_price || coverItem.cost || 0) / ((coverItem as any).conversionRate || 1)).toFixed(2)) : BOM_DEFAULT_RATES.cover,
        staple: stapleItem ? Number(((stapleItem.cost_price || stapleItem.cost || 0) / ((stapleItem as any).conversionRate || 1)).toFixed(2)) : BOM_DEFAULT_RATES.staple,
    };
}
function resolveBomPrice(source: 'tape' | 'cover' | 'staple', items: Item[]): number {
    const rates = computeBomRatesFromInventory(items);
    return Math.round((rates[source] || 0) * 100) / 100;
}

// --- Printing Variant Modal ---
export const PrintingVariantModal: React.FC<{
    product: Item;
    bom?: BillOfMaterial;
    materials: Item[];
    onSelect: (variant: any) => void;
    onClose: () => void;
}> = ({ product, bom, materials, onSelect, onClose }) => {
    const { companyConfig } = useAuth(); const { inventory, marketAdjustments } = useInventory();
    const currency = companyConfig.currencySymbol;
    const [bomTemplates, setBomTemplates] = useState<BOMTemplate[]>([]);
    const [attributes, setAttributes] = useState<Record<string, any>>({
        number_of_pages: 1,
        paper_type: 'A4 80g',
        print_mode: 'B/W',
        binding_type: 'None'
    });
    const [pricingState, setPricingState] = useState({
        baseCost: product.cost,
        adjustmentTotal: 0,
        sellingPrice: product.price,
        adjustmentBreakdown: [] as Array<{ name: string; value: number; type: string }>,
        adjustmentSnapshots: [] as Array<{ name: string; type: string; value: number; calculatedAmount: number }>
    });
    const [quantity, setQuantity] = useState(1);

    useEffect(() => {
        let mounted = true;
        dbService.getAll<BOMTemplate>('bomTemplates')
            .then((templates) => {
                if (mounted) setBomTemplates(templates || []);
            })
            .catch((err) => {
                logger.error('Failed to load BOM templates for variant pricing', err);
            });
        return () => { mounted = false; };
    }, []);

    const materialsList = useMemo(() => inventory || materials, [inventory, materials]);
    const adjustmentsList = useMemo(() => marketAdjustments || [], [marketAdjustments]);

    useEffect(() => {
        const hasHiddenBOM = product.smartPricing?.hiddenBOMId || product.smartPricing?.bomTemplateId;

        if (hasHiddenBOM) {
            const virtualVariant = {
                id: 'virtual',
                productId: product.id,
                sku: product.sku,
                name: product.name,
                attributes: attributes,
                pages: attributes.number_of_pages || 1,
                price: 0,
                cost: 0,
                stock: 0,
                pricingSource: 'dynamic',
                inheritsParentBOM: true
            } as unknown as ProductVariant;

            const result = pricingService.calculateVariantPrice(
                product,
                virtualVariant,
                quantity,
                materialsList,
                bomTemplates,
                adjustmentsList
            );

            const finishingCost = (result.breakdown || []).reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);

            setPricingState({
                baseCost: result.cost + finishingCost,
                adjustmentTotal: result.adjustmentTotal,
                sellingPrice: result.price,
                adjustmentBreakdown: result.breakdown,
                adjustmentSnapshots: result.adjustmentSnapshots
            });
        } else if (bom) {
            const result = bomService.calculateVariantBOM(bom, { attributes: attributes as Record<string, any> }, materials);
            const cost = roundFinancial(result.totalProductionCost);

            let price = product.price;
            if (bom.priceFormula) {
                price = roundFinancial(bomService.resolveFormula(bom.priceFormula, attributes));
            }

            setPricingState({
                baseCost: cost,
                adjustmentTotal: 0,
                sellingPrice: roundToCurrency(Number.isFinite(price) && price > 0 ? price : cost),
                adjustmentBreakdown: [],
                adjustmentSnapshots: []
            });
        }
    }, [attributes, bom, materials, product, quantity, materialsList, adjustmentsList]);

    const handleAttributeChange = (key: string, value: any) => {
        setAttributes(prev => ({ ...prev, [key]: value }));
    };

    const handleConfirm = () => {
        const variantName = `${product.name} (${Object.entries(attributes).map(([k, v]) => `${k}: ${v}`).join(', ')})`;
        const virtualVariant = {
            ...product,
            id: `${product.id}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            parentId: product.id,
            name: variantName,
            attributes: attributes,
            quantity: Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1,
            price: Number.isFinite(pricingState.sellingPrice) && pricingState.sellingPrice > 0 ? pricingState.sellingPrice : 0,
            cost: Number.isFinite(pricingState.baseCost) ? pricingState.baseCost : 0,
            adjustmentTotal: pricingState.adjustmentTotal,
            adjustmentSnapshots: pricingState.adjustmentSnapshots,
            pagesOverride: attributes.number_of_pages
        };
        onSelect(virtualVariant);
    };

    return (
        <PosModal
            open
            onClose={onClose}
            title={`Configure ${product.name}`}
            subtitle="Printing Variant"
            icon={<Printer size={19} color="#fff" />}
            size="md"
            footer={(
                <>
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={handleConfirm} icon={<ArrowRight size={14} />}>Add to Order</Button>
                </>
            )}
        >
            <div style={{ padding: '20px 24px', overflowY: 'auto', maxHeight: '60vh' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 10 }}>Attributes</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
                        <div>
                            <label htmlFor="pv-pages" style={{ fontSize: 10, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 4, display: 'block' }}>Number of Pages</label>
                            <input id="pv-pages" type="number" inputMode="numeric"
                                style={{ width: '100%', padding: '8px 10px', border: `1.4px solid ${hairline}`, borderRadius: 8, fontSize: 13, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }}
                                placeholder="e.g. 5"
                                onChange={e => { const n = parseInt(e.target.value, 10); handleAttributeChange('number_of_pages', Number.isFinite(n) && n >= 1 ? n : 1); }}
                            />
                        </div>
                        <div>
                            <label htmlFor="pv-paper" style={{ fontSize: 10, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 4, display: 'block' }}>Paper Type</label>
                            <select id="pv-paper" style={{ width: '100%', padding: '8px 10px', border: `1.4px solid ${hairline}`, borderRadius: 8, fontSize: 13, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }}
                                value={attributes.paper_type ?? ''}
                                onChange={e => handleAttributeChange('paper_type', e.target.value)}>
                                <option value="">Select...</option>
                                <option value="A4 80g">A4 80g</option>
                                <option value="A4 100g">A4 100g</option>
                                <option value="A3 80g">A3 80g</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="pv-qty" style={{ fontSize: 10, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 4, display: 'block' }}>Quantity</label>
                            <input id="pv-qty" type="number" inputMode="numeric"
                                style={{ width: '100%', padding: '8px 10px', border: `1.4px solid ${hairline}`, borderRadius: 8, fontSize: 13, fontWeight: 700, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }}
                                value={quantity}
                                onChange={e => { const raw = e.target.value; const q = raw === '' ? 1 : parseInt(raw, 10); setQuantity(Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1); }}
                            />
                        </div>
                    </div>
                    <div style={{ background: teal[50], padding: 16, borderRadius: 10, border: `1px solid ${teal[100]}`, marginBottom: 18 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Unit Price</span>
                            <span style={{ fontSize: 15, fontWeight: 700, color: ink, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums' }}>{currency}{formatNumber(pricingState.sellingPrice || 0)}</span>
                        </div>
                        <div style={{ height: 1, background: teal[100], marginBottom: 8 }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: ink, textTransform: 'uppercase', letterSpacing: 0.05 }}>Total Amount</span>
                            <span style={{ fontSize: 20, fontWeight: 700, color: teal[600], fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums' }}>{currency}{formatNumber((pricingState.sellingPrice || 0) * quantity)}</span>
                        </div>
                    </div>
            </div>
        </PosModal>
    );
};

// --- Dynamic Service Calculator Modal ---
const getFinishingName = (id: string) => ({ binding: 'Binding', coverPages: 'Cover Pages', cutting: 'Cutting & Trimming', holePunch: 'Hole Punching', folding: 'Folding', stapling: 'Stapling' })[id] || id;

export const ServiceCalculatorModal: React.FC<{
    service: Item;
    currencySymbol: string;
    initialPages?: number;
    initialCopies?: number;
    onConfirm: (pricing: DynamicServicePricingResult) => void;
    onClose: () => void;
}> = ({ service, currencySymbol, initialPages = 1, initialCopies = 1, onConfirm, onClose }) => {
    const { companyConfig } = useAuth(); const { inventory = [], marketAdjustments = [] } = useInventory();
    const [pages, setPages] = useState(Math.max(1, Number(initialPages) || 1));
    const [copies, setCopies] = useState(Math.max(1, Number(initialCopies) || 1));
    const [enginePricing, setEnginePricing] = useState<DynamicServicePricingResult | null>(null);
    const [finishingCostOverrides, setFinishingCostOverrides] = useState<Record<string, number>>({});
    const [sellingPrice, setSellingPrice] = useState<number>(0);
    const [priceManuallySet, setPriceManuallySet] = useState(false);
    const [bomTemplate, setBomTemplate] = useState<any>(null);

    const sp = service.smartPricing || service.pricingConfig;
    const hasSmartPricing = !!sp;

    const [enabledFinishing, setEnabledFinishing] = useState<string[]>(() => {
        const fromSmart = sp?.finishingEnabled;
        if (fromSmart && fromSmart.length > 0) return fromSmart as string[];
        const fromConfig = sp?.finishingOptions?.filter((o: any) => o.active)?.map((o: any) => o.name || o.id) || [];
        return fromConfig;
    });

    useEffect(() => { let m = true; dbService.getSetting<Record<string, number>>('finishingOptionCosts').then(c => { if (m) setFinishingCostOverrides(c || {}); }).catch(() => { if (m) setFinishingCostOverrides({}); }); return () => { m = false; }; }, []);

    useEffect(() => {
        const bomId = sp?.bomTemplateId;
        if (bomId) {
            dbService.get('bomTemplates', bomId).then(tpl => {
                if (tpl) setBomTemplate(tpl);
            }).catch(() => {});
        } else {
            setBomTemplate(null);
        }
    }, [sp?.bomTemplateId]);

    // Named paperItem, not `paper`: a local `paper` used to shadow the theme's
    // paper colour token, so `background: paper` inside this component silently
    // rendered an inventory item instead of the colour (pre-existing defect).
    const paperItem = useMemo(() => sp && sp.paperItemId ? inventory.find((i: any) => i.id === sp.paperItemId) : null, [sp, inventory]);
    const toner = useMemo(() => sp && sp.tonerItemId ? inventory.find((i: any) => i.id === sp.tonerItemId) : null, [sp, inventory]);

    const normalizedAdjustments = useMemo(() => (marketAdjustments || []).filter((adj: any) => isMarketAdjustmentActive(adj) && (!adj.applyToCategories?.length || adj.applyToCategories.includes(service.category))).map((adj: any) => ({ name: adj.name, type: adj.type, value: adj.value, percentage: adj.percentage ?? adj.value, calculatedAmount: adj.value, adjustmentId: adj.id, isActive: true })), [marketAdjustments, service.category]);

    const resolveFinishingCost = useCallback((id: string): number => {
        if (!sp) return 0;
        const storedConfig = companyConfig?.productionSettings?.finishingOptions?.find((o: any) => o?.id === id);
        if (BOM_OPTION_IDS.has(id)) {
            const meta = OPTION_META[id];
            const unit = meta?.bomSource ? resolveBomPrice(meta.bomSource, inventory) : 0;
            if (unit > 0) {
                const qty = Number(storedConfig?.quantity ?? sp.finishingSelections?.find((o: any) => o?.id === id)?.quantity ?? 1) || 1;
                return Math.round(unit * qty * 100) / 100;
            }
        }
        const savedCost = sp.finishingSelections?.find((o: any) => o?.id === id)?.price ?? (sp.finishingOptionCosts || {})[id] ?? finishingCostOverrides[id] ?? storedConfig?.price ?? 0;
        if (Number(savedCost) > 0) return Number(savedCost);
        if (sp.finishingOptions) {
            const opt = sp.finishingOptions.find((o: any) => (o.name || o.id) === id);
            if (opt && Number(opt.price) > 0) return Number(opt.price);
        }
        const fees = ((sp.finishingEnabled || []) as string[]);
        const fb = fees.length > 0 && Number(sp.finishingCost) > 0 ? Number(sp.finishingCost) / (fees.length * Math.max(1, Number(sp.copies) || 1)) : 0;
        if (fb > 0) return Number(fb.toFixed(2));
        return ({ binding: 150, coverPages: 20, cutting: 30, holePunch: 20, folding: 15, stapling: 10 }[id] || 0);
    }, [sp, companyConfig, finishingCostOverrides, inventory]);

    const costBreakdown = useMemo(() => {
        let paperCost = 0, sheetsPerCopy = 0, totalSheets = 0, costPerSheet = 0;
        let tonerCost = 0, tonerCostPerPage = 0;
        let fd: any[] = [], fc = 0;

        if (sp) {
            sheetsPerCopy = Math.ceil(pages / 2);
            totalSheets = sheetsPerCopy * copies;
            const finishingMultiplier = sp.pricingMethod === 'per_job' ? 1 : copies;

            if (paperItem) {
                const rs = Number(paperItem.conversionRate || paperItem.conversion_rate || 500);
                costPerSheet = rs > 0 ? Number(paperItem.cost_price || paperItem.cost_per_unit || paperItem.cost || 0) / rs : 0;
                paperCost = Number((totalSheets * costPerSheet).toFixed(2));
            } else if (Number(sp.paperCost) > 0) {
                costPerSheet = Number(sp.paperCost);
                paperCost = Number((totalSheets * costPerSheet).toFixed(2));
            }

            if (toner) {
                const perUnitCost = Number(toner.cost_per_unit || 0);
                if (perUnitCost > 0) {
                    tonerCostPerPage = perUnitCost;
                } else {
                    const tonerRate = Number(toner.conversionRate || toner.conversion_rate || 20000);
                    tonerCostPerPage = tonerRate > 0 ? Number(toner.cost_price || toner.cost || 0) / tonerRate : 0;
                }
                tonerCost = Number(((pages * copies) * tonerCostPerPage).toFixed(2));
            } else if (Number(sp.tonerCost) > 0) {
                tonerCostPerPage = Number(sp.tonerCost);
                tonerCost = Number((pages * copies * tonerCostPerPage).toFixed(2));
            }

            fd = enabledFinishing.map(id => {
                let perCopyCost = resolveFinishingCost(id);
                if (perCopyCost === 0 && sp.finishingOptions) {
                    const opt = sp.finishingOptions.find((o: any) => (o.name || o.id) === id);
                    if (opt) perCopyCost = Number(opt.price) || 0;
                }
                const total = Number((perCopyCost * finishingMultiplier).toFixed(2));
                return { id, name: getFinishingName(id), cost: perCopyCost, total };
            });
            fc = Number(fd.reduce((s, f) => s + f.total, 0).toFixed(2));
        }

        return { paperCost, tonerCost, finishingCost: fc, baseCost: Number((paperCost + tonerCost + fc).toFixed(2)), sheetsPerCopy, totalSheets, costPerSheet, tonerCostPerPage, finishingDetails: fd };
    }, [pages, copies, paper, toner, sp, enabledFinishing, resolveFinishingCost]);

    const computePageScaledCost = useCallback((pageCount: number, copyCount: number): number => {
        if (!sp) { const flat = service.serviceConfig?.baseLaborCost || service.serviceConfig?.baseRate || service.cost || 0; return flat * (pageCount / (Number(service.pages) || 1)) * copyCount; }
        const totalSheets = Math.ceil(pageCount / 2) * copyCount;
        const totalPages = pageCount * copyCount;
        const finishingMultiplier = sp.pricingMethod === 'per_job' ? 1 : copyCount;
        let pc = 0, tc = 0;
        if (sp.paperItemId) {
            const p = inventory.find((i: any) => i.id === sp.paperItemId);
            if (p) pc = Number((totalSheets * (Number(p.conversionRate || p.conversion_rate || 500) > 0 ? Number(p.cost_price || p.cost_per_unit || p.cost || 0) / Number(p.conversionRate || p.conversion_rate || 500) : 0)).toFixed(2));
        } else if (Number(sp.paperCost) > 0) {
            pc = Number((totalSheets * Number(sp.paperCost)).toFixed(2));
        }
        if (sp.tonerItemId) {
            const tn = inventory.find((i: any) => i.id === sp.tonerItemId);
            if (tn) {
                const tnPerUnit = Number(tn.cost_per_unit || 0);
                if (tnPerUnit > 0) {
                    tc = Number((totalPages * tnPerUnit).toFixed(2));
                } else {
                    const tnRate = Number(tn.conversionRate || tn.conversion_rate || 20000);
                    tc = Number((totalPages * (tnRate > 0 ? Number(tn.cost_price || tn.cost || 0) / tnRate : 0)).toFixed(2));
                }
            }
        } else if (Number(sp.tonerCost) > 0) {
            tc = Number((totalPages * Number(sp.tonerCost)).toFixed(2));
        }
        const fc = enabledFinishing.reduce((s, id) => {
            let perCopyCost = resolveFinishingCost(id);
            if (perCopyCost === 0 && sp.finishingOptions) {
                const opt = sp.finishingOptions.find((o: any) => (o.name || o.id) === id);
                if (opt) perCopyCost = Number(opt.price) || 0;
            }
            return s + perCopyCost * finishingMultiplier;
        }, 0);
        return Number((pc + tc + fc).toFixed(2));
    }, [service, inventory, sp, enabledFinishing, resolveFinishingCost]);

    useEffect(() => { let m = true; const calc = async () => { try { const bc = computePageScaledCost(pages, copies); const r = await calculateServicePrice({ itemId: service.id, categoryId: service.category, baseCost: bc, pages, copies, adjustments: normalizedAdjustments, context: 'SERVICE' }); if (m) { const tp = pages * copies; setEnginePricing({ pages, copies, totalPages: tp, unitCostPerCopy: copies > 0 ? roundToCurrency(bc / copies) : bc, unitPricePerCopy: r.unitPrice, unitCostPerPage: tp > 0 ? roundToCurrency(bc / tp) : bc, unitPricePerPage: tp > 0 ? roundToCurrency(r.unitPrice / tp) : r.unitPrice, totalCost: bc, totalPrice: r.totalPrice, calculatedTotalPrice: r.totalPrice, adjustmentTotal: r.adjustmentTotal, adjustmentSnapshots: r.adjustmentSnapshots, marginAmount: r.marginAmount, rounding_difference: r.roundingDifference, components: [], serviceDetails: { pages, copies, totalPages: tp, unitCostPerPage: tp > 0 ? roundToCurrency(bc / tp) : bc, unitPricePerPage: tp > 0 ? roundToCurrency(r.unitPrice / tp) : r.unitPrice, unitCostPerCopy: copies > 0 ? roundToCurrency(bc / copies) : bc, unitPricePerCopy: r.unitPrice, totalCost: bc, totalPrice: r.totalPrice, calculatedTotalPrice: r.totalPrice, materials: [], adjustments: [] } }); } } catch (e) { logger.error('[ServiceCalculatorModal] Pricing engine error:', e); } }; calc(); return () => { m = false; }; }, [service, pages, copies, normalizedAdjustments, computePageScaledCost]);

    useEffect(() => { if (enginePricing && !priceManuallySet && enginePricing.totalPrice > 0) setSellingPrice(enginePricing.totalPrice); }, [enginePricing, priceManuallySet]);

    const ap = enginePricing;
    if (!ap) {
        return (
            <PosModal
                open
                onClose={onClose}
                title={service.name}
                eyebrow="Printing Service"
                icon={<Printer size={19} color="#fff" />}
                size="lg"
            >
                <div
                    aria-busy="true"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '80px 20px', color: inkSoft }}
                >
                    <Loader2 size={22} className="animate-spin" style={{ color: teal[500] }} />
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Calculating pricing…</div>
                    <div style={{ fontSize: 12 }}>This may take a moment for complex services.</div>
                </div>
            </PosModal>
        );
    }
    const fc = (v: number) => `${currencySymbol}${formatNumber(v)}`;
    const profit = roundToCurrency(sellingPrice - (ap?.totalCost || 0));
    const isLoss = profit < 0;
    const profitMarginPct = (ap?.totalCost || 0) > 0 ? roundToCurrency((profit / (ap?.totalCost || 1)) * 100) : 0;
    const priceDiff = ap ? roundToCurrency(sellingPrice - ap.totalPrice) : 0;

    const handleConfirm = () => onConfirm({ ...ap, totalPrice: sellingPrice, unitPricePerCopy: copies > 0 ? roundToCurrency(sellingPrice / copies) : 0, calculatedTotalPrice: ap.totalPrice, marginAmount: profit, priceLocked: true, lockedTotalPrice: sellingPrice, lockedUnitPricePerCopy: copies > 0 ? roundToCurrency(sellingPrice / copies) : 0, lockedUnitCostPerCopy: copies > 0 ? roundToCurrency(ap.totalCost / copies) : 0 });

    return (
        <PosModal
            open
            onClose={onClose}
            title={service.name}
            eyebrow="Printing Service"
            icon={<Printer size={19} color="#fff" />}
            size="lg"
            footer={(
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                    <div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>Total Due</div>
                        <div style={{ color: ink, lineHeight: 1.15 }}>
                            <Money value={sellingPrice} symbol={currencySymbol} size={23} />
                        </div>
                        <div style={{ fontSize: 10, color: inkSoft }}>{pages * copies} page{pages * copies !== 1 ? 's' : ''} &middot; {Math.ceil(pages / 2) * copies} sheet{Math.ceil(pages / 2) * copies !== 1 ? 's' : ''} &middot; {fc(copies > 0 ? roundToCurrency(sellingPrice / copies) : 0)}/copy</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                        <Button variant="primary" onClick={handleConfirm} icon={<ArrowRight size={14} />}>Add to Order</Button>
                    </div>
                </div>
            )}
        >
            <div className="pos-split" style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr', flex: 1, minHeight: 0 }}>
                    <div className="pos-split-pane" style={{ padding: '16px 20px', maxHeight: '60vh', overflowY: 'auto' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 9 }}>Quantities</div>
                        <div style={{ display: 'flex', border: `1.4px solid ${hairline}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
                            <div style={{ flex: 1, padding: '8px 10px', borderRight: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 9, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 3 }}>Pages</div>
                                <input type="number" min={1} value={pages} onChange={e => setPages(Math.max(1, parseInt(e.target.value || '1', 10) || 1))}
                                    style={{ border: 'none', padding: 0, fontSize: 14, fontWeight: 700, color: ink, width: '100%', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                            </div>
                            <div style={{ flex: 1, padding: '8px 10px', background: teal[50], textAlign: 'center' }}>
                                <div style={{ fontSize: 9, fontWeight: 600, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 3 }}>Copies</div>
                                <input type="number" min={1} value={copies} onChange={e => setCopies(Math.max(1, parseInt(e.target.value || '1', 10) || 1))}
                                    style={{ border: 'none', padding: 0, fontSize: 14, fontWeight: 700, color: ink, width: '100%', background: 'transparent', outline: 'none', textAlign: 'center', fontFamily: 'inherit' }} />
                            </div>
                        </div>
                        {bomTemplate && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: inkSoft, paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${hairline}` }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={amber[500]} strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>
                                Specs from <b style={{ color: ink, fontWeight: 700 }}>BOM: {bomTemplate.name}</b>
                            </div>
                        )}
                        {costBreakdown.finishingDetails.length > 0 && (
                            <>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 9 }}>Finishing Options</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {costBreakdown.finishingDetails.map(fd => {
                                        const isOn = enabledFinishing.includes(fd.id);
                                        return (
                                            <button key={fd.id} type="button" onClick={() => setEnabledFinishing(prev => prev.includes(fd.id) ? prev.filter(id => id !== fd.id) : [...prev, fd.id])}
                                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', background: isOn ? amber[100] : teal[50], transition: 'all .12s' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: isOn ? amber[500] : inkSoft }}></div>
                                                    <span style={{ fontSize: 12, fontWeight: 600, color: ink }}>{fd.name}</span>
                                                </div>
                                                <span style={{ fontSize: 11, color: isOn ? amber[500] : inkSoft }}>{fc(fd.cost)}/job</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </div>
                    <div className="pos-split-divider" style={{ background: hairline }} />
                    <div className="pos-split-pane" style={{ padding: '16px 20px', maxHeight: '60vh', overflowY: 'auto' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 9 }}>Cost Breakdown</div>
                        {hasSmartPricing ? (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Paper</span>
                                    <span style={{ fontWeight: 600, color: ink }}>{fc(costBreakdown.paperCost)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Toner</span>
                                    <span style={{ fontWeight: 600, color: ink }}>{fc(costBreakdown.tonerCost)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Finishing</span>
                                    <span style={{ fontWeight: 600, color: ink }}>{fc(costBreakdown.finishingCost)}</span>
                                </div>
                                <div style={{ borderTop: `1px dashed ${hairline}`, margin: '4px 0' }}></div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Cost Price</span>
                                    <span style={{ fontWeight: 600, color: ink }}>{fc(costBreakdown.baseCost)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Selling Price</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ fontSize: 11, color: inkSoft }}>{currencySymbol}</span>
                                        <input type="number" step="0.01" min={0} value={sellingPrice} onChange={e => { const n = parseFloat(e.target.value); setSellingPrice(Number.isFinite(n) ? Math.max(0, n) : 0); setPriceManuallySet(true); }}
                                            style={{ width: 80, textAlign: 'right', border: `1.4px solid ${hairline}`, borderRadius: 6, padding: '3px 7px', fontSize: 12.5, fontWeight: 700, color: ink, outline: 'none', fontFamily: 'inherit' }} />
                                    </div>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Calculated</span>
                                    <span style={{ fontSize: 13.5, fontWeight: 700, color: amber[600] }}>{fc(ap.totalPrice)}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: surfaceSuccess, border: `1px solid ${borderSuccess}`, borderRadius: 8, padding: '9px 12px', marginTop: 12 }}>
                                    <div style={{ fontSize: 11.5, color: success, fontWeight: 700 }}>
                                        Profit {isLoss ? '-' : '+'}{fc(Math.abs(profit))}
                                    </div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: success, background: paper, padding: '3px 9px', borderRadius: 999 }}>{profitMarginPct}% margin</div>
                                </div>
                                {isLoss && (
                                    <div style={{ marginTop: 8, padding: '6px 10px', background: surfaceDanger, border: `1px solid ${borderDanger}`, borderRadius: 8, fontSize: 11, color: danger, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <AlertTriangle size={12} /> Below cost — loss of {fc(Math.abs(profit))}
                                    </div>
                                )}
                                {!isLoss && profit > 0 && profitMarginPct < 10 && (
                                    <div style={{ marginTop: 8, padding: '6px 10px', background: surfaceWarning, border: `1px solid ${borderWarning}`, borderRadius: 8, fontSize: 11, color: textWarning, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Info size={12} /> Low margin ({profitMarginPct}%) — increase price
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Base Rate</span>
                                    <span style={{ fontWeight: 600, color: ink }}>{fc(ap.totalCost)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 12.5 }}>
                                    <span style={{ color: inkSoft }}>Selling Price</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ fontSize: 11, color: inkSoft }}>{currencySymbol}</span>
                                        <input type="number" step="0.01" min={0} value={sellingPrice} onChange={e => { const n = parseFloat(e.target.value); setSellingPrice(Number.isFinite(n) ? Math.max(0, n) : 0); setPriceManuallySet(true); }}
                                            style={{ width: 80, textAlign: 'right', border: `1.4px solid ${hairline}`, borderRadius: 6, padding: '3px 7px', fontSize: 12.5, fontWeight: 700, color: ink, outline: 'none', fontFamily: 'inherit' }}
                                            />
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
            </div>
        </PosModal>
    );
};

// --- Customer Modal ---
export const CustomerModal: React.FC<{
    onSelect: (name: string) => void;
    onClose: () => void;
}> = ({ onSelect, onClose }) => {
    const { companyConfig, notify } = useAuth(); const { invoices } = useFinance(); const { customers } = useSales();
    const [showQuickAdd, setShowQuickAdd] = useState(false);
    const [newCustomerName, setNewCustomerName] = useState('');
    const [newCustomerContact, setNewCustomerContact] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);

    const customerNames = useMemo(() => {
        const names = new Set<string>();
        customers?.forEach(c => {
            const label = getCustomerOptionLabel(c);
            if (label && label !== 'Unknown customer') names.add(label);
        });
        invoices?.forEach(inv => {
            if (inv.customerName) names.add(inv.customerName);
        });
        return Array.from(names).sort();
    }, [invoices, customers]);

    const filteredCustomerNames = useMemo(() => {
        if (!searchTerm.trim()) return customerNames;
        const term = searchTerm.trim().toLowerCase();
        return customerNames.filter(name => name.toLowerCase().includes(term));
    }, [customerNames, searchTerm]);

    useEffect(() => { setActiveIndex(0); }, [filteredCustomerNames]);

    // Escape is owned by useModalA11y (registered in the capture phase). This
    // handler used to also fire onClose, so a single Escape press invoked the
    // dismiss handler twice.
    //
    // Scope: only the search field drives the list from the keyboard. The old
    // window handler also swallowed Enter/arrows meant for the quick-add form
    // (its submit never fired — the highlighted customer was selected instead)
    // and Enter on focused buttons (the close button added a customer, and a
    // tabbed-to row selected `activeIndex`, not the row under the cursor).
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') return;
            if (filteredCustomerNames.length === 0) return;
            const target = e.target as HTMLElement | null;
            const inSearch = !!target && target.id === CUSTOMER_SEARCH_ID;
            const inTextField = !!target && (
                target.tagName === 'TEXTAREA' || target.isContentEditable ||
                (target.tagName === 'INPUT' && !inSearch)
            );
            const inButton = !!target && target.tagName === 'BUTTON';

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (inTextField) return; // let the caret move
                const down = e.key === 'ArrowDown';
                e.preventDefault();
                setActiveIndex(i => down
                    ? Math.min(i + 1, filteredCustomerNames.length - 1)
                    : Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Enter') {
                if (inTextField || inButton) return; // native submit / click wins
                const name = filteredCustomerNames[activeIndex];
                if (name) { e.preventDefault(); onSelect(name); }
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [filteredCustomerNames, activeIndex, onSelect]);

    const handleQuickAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newCustomerName) return;
        onSelect(newCustomerName);
        notify(`Customer ${newCustomerName} selected`, 'success');
        onClose();
    };

return (
        <PosModal
            open
            onClose={onClose}
            title="Select Customer"
            subtitle={`${filteredCustomerNames.length} account${filteredCustomerNames.length !== 1 ? 's' : ''}`}
            icon={<Users size={19} color="#fff" />}
            size="md"
            footerTone="quiet"
            footer={(
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 10, color: inkSoft }}>↑↓ navigate &middot; ↵ select &middot; esc close</span>
                    <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4,
                        fontSize: 10, fontWeight: 700, border: `1px solid rgba(15,84,76,0.2)`,
                        background: 'rgba(15,84,76,0.08)', color: teal[600]
                    }}>POS Mode</span>
                </div>
            )}
        >
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                    <div style={{ padding: '10px 20px', borderBottom: `1px solid ${hairline}` }}>
                        <div style={{ position: 'relative' }}>
                            <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} size={14} />
                            <input type="text" id={CUSTOMER_SEARCH_ID} placeholder="Search customers…" value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                style={{ width: '100%', padding: '8px 10px 8px 34px', border: `1.4px solid ${hairline}`, borderRadius: 8, fontSize: 13, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }} />
                            {searchTerm && (
                                <button onClick={() => setSearchTerm('')}
                                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 20, height: 20, borderRadius: '50%', border: 'none', background: teal[50], color: inkSoft, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <X size={11} />
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ padding: '8px 20px', borderBottom: `1px solid ${hairline}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: inkSoft }}>Actions</span>
                        <Button
                            variant={showQuickAdd ? 'secondary' : 'primary'}
                            size="sm"
                            icon={showQuickAdd ? <X size={13} /> : <UserPlus size={13} />}
                            onClick={() => setShowQuickAdd(!showQuickAdd)}
                        >
                            {showQuickAdd ? 'Cancel' : 'New Customer'}
                        </Button>
                    </div>
                    {showQuickAdd && (
                        <form onSubmit={handleQuickAdd} style={{ padding: '12px 20px', background: teal[50], borderBottom: `1px solid ${hairline}` }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
                                <div>
                                    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: inkSoft, marginBottom: 5, display: 'block' }}>
                                        Full Name <span style={{ color: danger }}>*</span>
                                    </label>
                                    <input placeholder="e.g. Acme Printing" value={newCustomerName}
                                        onChange={e => setNewCustomerName(e.target.value)}
                                        style={{ width: '100%', padding: '7px 10px', border: `1.4px solid ${hairline}`, borderRadius: 7, fontSize: 13, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }} />
                                </div>
                                <div>
                                    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: inkSoft, marginBottom: 5, display: 'block' }}>Contact Info</label>
                                    <input placeholder="Phone or Email" value={newCustomerContact}
                                        onChange={e => setNewCustomerContact(e.target.value)}
                                        style={{ width: '100%', padding: '7px 10px', border: `1.4px solid ${hairline}`, borderRadius: 7, fontSize: 13, color: ink, background: paper, outline: 'none', fontFamily: 'inherit' }} />
                                </div>
                            </div>
                            <Button type="submit" variant="primary" block disabled={!newCustomerName} icon={<Save size={13} />}>
                                Save and Select
                            </Button>
                        </form>
                    )}
                    <div style={{ flex: 1, overflowY: 'auto', background: paper }}>
                        {filteredCustomerNames.length === 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 24px' }}>
                                <div style={{ width: 48, height: 48, borderRadius: '50%', background: teal[50], display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                                    <Users size={20} style={{ color: inkSoft, opacity: 0.5 }} />
                                </div>
                                <p style={{ fontSize: 13, fontWeight: 500, color: inkSoft, textAlign: 'center' }}>
                                    {searchTerm ? `No matches for "${searchTerm}"` : 'No customers found'}
                                </p>
                                <p style={{ fontSize: 11, color: inkSoft, marginTop: 4, textAlign: 'center' }}>
                                    {searchTerm ? 'Try adjusting your search criteria' : 'Add a new customer to get started'}
                                </p>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                                {filteredCustomerNames.map((name, idx) => {
                                    const custInvoices = invoices.filter(i => i.customerName === name && i.status !== 'Paid' && i.status !== 'Draft');
                                    const custDebt = custInvoices.reduce((sum, i) => sum + (i.totalAmount - (i.paidAmount || 0)), 0);
                                    const initials = name.charAt(0).toUpperCase();
                                    const isActive = idx === activeIndex;

                                    return (
                                        <button key={name} onClick={() => onSelect(name)}
                                            className="pos-row"
                                            data-active={isActive ? 'true' : undefined}
                                            style={{ width: '100%', textAlign: 'left', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, border: 'none', borderBottom: `1px solid ${hairline}`, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, color: ink }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                                                <div className="pos-avatar" style={{
                                                    width: 36, height: 36, borderRadius: 8, background: teal[50], color: inkSoft,
                                                    border: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: 14, fontWeight: 700, flexShrink: 0,
                                                    transition: 'all .12s'
                                                }}>
                                                    {initials}
                                                </div>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ fontWeight: 700, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                                                </div>
                                            </div>
                                            <div style={{ flexShrink: 0, textAlign: 'right' }}>
                                                <div style={{
                                                    display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
                                                    borderRadius: 5,
                                                    border: `1px solid ${custDebt > 0 ? borderDanger : borderSuccess}`,
                                                    background: custDebt > 0 ? surfaceDanger : surfaceSuccess
                                                }}>
                                                    <Money value={custDebt} symbol={companyConfig.currencySymbol} size={11} color={custDebt > 0 ? danger : success} />
                                                </div>
                                                <div style={{ fontSize: 10, color: inkSoft, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', marginTop: 2 }}>
                                                    {custDebt > 0 ? 'Outstanding' : 'Settled'}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
            </div>
        </PosModal>
    );
};

// --- Held Orders Modal ---
export const HeldOrdersModal: React.FC<{
    orders: HeldOrder[];
    onRetrieve: (o: HeldOrder) => void;
    onClose: () => void;
}> = ({ orders, onRetrieve, onClose }) => {
    return (
        <PosModal open onClose={onClose} title="Parked Orders" subtitle="Retrieve a parked order" icon={<Clock size={19} color="#fff" />} size="md">
            <div style={{ overflowY: 'auto', flex: 1 }}>
                {orders.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', color: inkSoft }}>
                        <Clock size={48} style={{ marginBottom: 16, opacity: 0.2 }} />
                        <p style={{ fontSize: 14, fontWeight: 500 }}>No parked orders found</p>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {orders.map(order => (
                            <div key={order.id}
                                className="pos-row"
                                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: `1px solid ${hairline}` }}>
                                <div>
                                    <div style={{ fontWeight: 700, color: ink }}>{order.customerName}</div>
                                    <div style={{ fontSize: 12, color: inkSoft, display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                                        <span>{new Date(order.date).toLocaleString()}</span>
                                        <span style={{ width: 4, height: 4, borderRadius: '50%', background: hairline }}></span>
                                        <span>{order.items.length} items</span>
                                    </div>
                                    {order.note && <div style={{ fontSize: 12, color: inkSoft, fontStyle: 'italic', marginTop: 2 }}>Note: {order.note}</div>}
                                </div>
                                <Button variant="secondary" size="sm" onClick={() => onRetrieve(order)}>
                                    Retrieve
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </PosModal>
    );
};

// --- Variant Selector Modal ---
export const VariantSelectorModal: React.FC<{
    product: Item;
    onSelect: (variant: ProductVariant) => void;
    onClose: () => void;
}> = ({ product, onSelect, onClose }) => {
    const { companyConfig } = useAuth();
    const currency = companyConfig.currencySymbol;
    const [quantity, setQuantity] = useState(1);

    const handleVariantClick = (v: ProductVariant) => {
        onSelect({ ...normalizeStoredPricing(v as unknown as Record<string, unknown>), quantity } as unknown as ProductVariant);
    };

    return (
        <PosModal open onClose={onClose} title="Select Variant" subtitle={product.name} icon={<Printer size={19} color="#fff" />} size="md">
                <div style={{ padding: '12px 24px', borderBottom: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Quantity to Add</label>
                    <input type="number" min="1" inputMode="numeric"
                        style={{ width: 120, padding: '7px 10px', border: `1.4px solid ${hairline}`, borderRadius: 7, fontSize: 13, fontWeight: 700, color: ink, background: paper, outline: 'none', textAlign: 'right', fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums' }}
                        value={quantity}
                        onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') return; // let the user clear without snapping to 1
                            const n = parseInt(raw, 10);
                            if (Number.isFinite(n) && n >= 1) setQuantity(Math.floor(n));
                        }}
                        onBlur={() => setQuantity(q => (Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1))}
                        />
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                    {product.variants?.map((v, vi) => (
                        <button key={v.id || vi} onClick={() => handleVariantClick(v)}
                            className="pos-row"
                            style={{ width: '100%', textAlign: 'left', padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: 'none', cursor: 'pointer', borderBottom: `1px solid ${hairline}`, fontFamily: 'inherit' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700, color: ink, fontSize: 13 }}>{v.name}</div>
                                {/* The variant's OWN persisted SKU. */}
                                {v.sku && (
                                    <div style={{ fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 10, color: inkSoft, marginTop: 2 }}>
                                        {v.sku}
                                    </div>
                                )}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                                    {Object.entries(v.attributes || {}).map(([attrKey, val]) => (
                                        <span key={attrKey}
                                            style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: teal[50], color: inkSoft, textTransform: 'uppercase', border: `1px solid ${teal[100]}` }}>
                                            {attrKey.replace(/_/g, ' ')}: {String(val)}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div style={{ textAlign: 'right', marginLeft: 16, flexShrink: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 700, color: teal[600] }}>{currency}{formatNumber(resolveStoredSellingPrice(v))}</div>
                                {isInventoryBearingItem(product) && v.stock > 0 && (
                                    <div style={{ fontSize: 10, fontWeight: 500, color: inkSoft }}>{v.stock} in stock</div>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
        </PosModal>
    );
};
