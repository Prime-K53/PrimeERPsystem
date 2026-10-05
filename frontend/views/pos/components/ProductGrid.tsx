
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Plus, PauseCircle, Printer, Book, Scissors, Image, Layout, PenTool, Box, Briefcase, Layers, FileText, Grid, Hash } from 'lucide-react';
import { Item, ProductVariant } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useProduction } from '../../../context/ProductionContext';
import { useKeyboardListNavigation } from '../../../hooks/useKeyboardListNavigation';
import { VariantSelectorModal, PrintingVariantModal } from './PosModals';
import { ItemModal } from '../../../components/items/ItemModal';

import { formatNumber } from '../../../utils/helpers';
import { generateLocalId } from '../../../utils/idGeneration';
import { useInventory } from '../../../context/InventoryContext';
import { generateNextId } from '../../../utils/helpers';
import { resolveStoredCalculatedPrice, resolveStoredCost, resolveStoredSellingPrice } from '../../../utils/pricing';
import { isInventoryBearingItem } from '../../../utils/inventoryNormalization';
import { getSnapshotCalculatedAmount, resolveItemAdjustmentSnapshots } from '../../../utils/pricingBreakdown';
import { formatAmount } from '../../../utils/posMoney';
import { registerType, stock as stockTokens, stockState, hairline, hairlineStrong, inkSoft, teal, amber, NUMERIC_FONT, UI_FONT } from '../theme';

const B = '#1E3A5F';
const B7 = '#2563EB';
const B6 = '#1D4ED8';
const B5 = '#3B82F6';
const B100 = '#DBEAFE';
const B50 = '#EFF6FF';
const PAPER = '#faf9f6';
const INK = '#16211f';
const SOFT = '#5c6b68';
const LINE = '#e1e5e2';
const AMBER = '#b8863f';
const RED = '#b3402f';
const GREEN = '#1f7a52';

const SCANNER_THRESHOLD_MS = 50;

interface ProductGridProps {
    inventory: Item[];
    addToCart: (item: Item) => void;
    onConfigureService: (item: Item) => void;
    onRecall: () => void;
    heldCount: number;
    onZReport: () => void;
}

type ViewMode = 'Large' | 'Small' | 'List';

/**
 * Whether an item is out of stock, i.e. exactly the case StockChip states in
 * words. One predicate for both: a dimmed tile next to a healthy chip (or the
 * reverse) reads as a bug to the cashier.
 *
 * Non-inventory-bearing items (Product, Service) are never out of stock —
 * they have no on-hand quantity to run out.
 */
const isOutOfStock = (item: Item): boolean =>
    isInventoryBearingItem(item) &&
    stockState(Number(item.stock ?? 0), Number(item.minStockLevel ?? 0)) === 'out';

/**
 * Stock as a dot + number, never a bare colour and never the old S/P letter
 * badge (which conveyed "Service/Product" — already obvious from the tile).
 *
 * Out-of-stock is stated in words because the tile is also disabled: a
 * cashier who cannot click a tile still needs to know *why*.
 */
const StockChip: React.FC<{ item: Item; compact?: boolean }> = ({ item, compact }) => {
    if (!isInventoryBearingItem(item)) {
        return (
            <span style={{ ...registerType.meta, color: inkSoft, whiteSpace: 'nowrap' }}>
                {item.type === 'Service' ? 'Service' : (item.type || 'Item')}
            </span>
        );
    }

    const state = stockState(Number(item.stock ?? 0), Number(item.minStockLevel ?? 0));
    const dot = state === 'ok' ? stockTokens.dotOk : state === 'low' ? stockTokens.dotLow : stockTokens.dotOut;
    const tint = state === 'ok' ? stockTokens.ok : state === 'low' ? stockTokens.low : stockTokens.out;

    return (
        <span
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                ...registerType.meta, color: tint, whiteSpace: 'nowrap',
            }}
            title={state === 'out' ? 'Out of stock' : state === 'low' ? 'Low stock' : 'In stock'}
        >
            <span
                aria-hidden="true"
                style={{
                    width: compact ? 6 : 7, height: compact ? 6 : 7, borderRadius: 9999,
                    background: dot, flexShrink: 0,
                }}
            />
            {state === 'out'
                ? 'Out of stock'
                : <>{formatAmount(Number(item.stock ?? 0))}{!compact && item.unit ? ` ${item.unit}` : ''}</>}
        </span>
    );
};

export const ProductGrid: React.FC<ProductGridProps> = ({ inventory, addToCart, onConfigureService, onRecall, heldCount, onZReport }) => {
    const { companyConfig, user } = useAuth(); const { boms } = useProduction();
    const { addItem: inventoryAddItem } = useInventory();
    const searchInputRef = useRef<HTMLInputElement>(null);
    const currency = companyConfig.currencySymbol;
    const [searchTerm, setSearchTerm] = useState('');
    const [activeCategory, setActiveCategory] = useState<string>('All');
    const [viewMode, setViewMode] = useState<ViewMode>('List');
    const [selectedProductForVariants, setSelectedProductForVariants] = useState<Item | null>(null);
    const [showCreateItemModal, setShowCreateItemModal] = useState(false);
    const lastKeyTimeRef = useRef(0);
    const scannerBufferRef = useRef('');

    // Quick Item Entry: Auto-focus search on mount and after item add
    useEffect(() => {
        if (companyConfig.transactionSettings?.quickItemEntry) {
            searchInputRef.current?.focus();
        }
    }, [companyConfig.transactionSettings?.quickItemEntry]);

    const saleableInventory = inventory.filter(i => i.type && i.type !== 'Material' && i.type !== 'Raw Material');

    const categoryGroups = [
        { label: 'All', match: (_: Item) => true },
        { label: 'Products', match: (p: Item) => p.type === 'Product' },
        { label: 'Stationery', match: (p: Item) => p.type === 'Stationery' },
        { label: 'Service', match: (p: Item) => p.type === 'Service' || p.category === 'Service' },
    ] as const;

    const term = searchTerm.toLowerCase();
    const filteredProducts = saleableInventory.filter(p => {
        const group = categoryGroups.find(g => g.label === activeCategory);
        if (group && !group.match(p)) return false;
        if (!term) return true;
        if (p.name.toLowerCase().includes(term)) return true;
        if (p.sku.toLowerCase().includes(term)) return true;
        if (p.barcode && p.barcode.toLowerCase().includes(term)) return true;
        // A variant SKU (or variant name) must be able to find its parent, so
        // the cashier can then pick the variant. Variant identity itself still
        // travels as variant.id, never as the SKU.
        return (p.variants || []).some(v =>
            String(v?.name || '').toLowerCase().includes(term) ||
            String(v?.sku || '').toLowerCase().includes(term));
    });

    // Barcode / SKU lookup: exact match regardless of the category filter. A
    // scanner (or a typed variant SKU) that resolves to a single variant adds
    // that variant straight to the cart.
    const exactTerm = searchTerm.trim().toLowerCase();
    const barcodeMatch = exactTerm
        ? saleableInventory.find(p => p.barcode && p.barcode.toLowerCase() === exactTerm)
        : null;

    const exactVariantMatch = useMemo(() => {
        if (!exactTerm) return null;
        for (const parent of saleableInventory) {
            const variant = (parent.variants || []).find(
                v => String(v?.sku || '').trim().toLowerCase() === exactTerm,
            );
            if (variant) return { parent, variant };
        }
        return null;
    }, [exactTerm, saleableInventory]);

    // Detect scanner vs manual typing by measuring inter-key timing
    const detectScannerInput = (): boolean => {
        const now = Date.now();
        const elapsed = now - lastKeyTimeRef.current;
        lastKeyTimeRef.current = now;
        return elapsed > 0 && elapsed < SCANNER_THRESHOLD_MS;
    };

    const autoAddItem = (item: Item) => {
        const itemType = item.type || item.category || '';
        const isService = itemType === 'Service' || item.category === 'Service';
        // Only clear search when we're directly adding to cart (not opening a modal)
        if (!item.isVariantParent && !isService) {
            setSearchTerm('');
        }
        handleItemClick(item);
    };

    const gridCols = viewMode === 'List' ? 1 : viewMode === 'Small' ? 8 : (companyConfig.transactionSettings?.pos?.gridColumns || 5);

    const handleItemClick = (item: Item) => {
        const itemType = item.type || item.category || '';
        const isService = itemType === 'Service' || item.category === 'Service';
        if (item.isVariantParent) {
            setSelectedProductForVariants(item);
        } else if (isService) {
            onConfigureService(item);
        } else {
            addToCart(item);
        }
    };

    const handleVariantSelect = (variant: ProductVariant) => {
        if (!selectedProductForVariants) return;

        const adjustmentSnapshots = resolveItemAdjustmentSnapshots(variant);
        const adjustmentTotal = Number(
            variant.smartPricingSnapshot?.marketAdjustmentTotal
            ?? variant.adjustmentTotal
            ?? adjustmentSnapshots.reduce((sum: number, snapshot: any) => sum + getSnapshotCalculatedAmount(snapshot), 0)
        );

        // Convert variant to Item with parentId for stock reservation
        // Include variant-specific adjustment data for margin tracking
        const variantItem: any = {
            ...selectedProductForVariants,
            id: variant.id,
            parentId: selectedProductForVariants.id,
            // The VARIANT's own persisted SKU. SKU is display/business data —
            // the relational identity stays `variantId` / the parentId above.
            sku: variant.sku,
            variantId: variant.id,
            variantSku: variant.sku,
            name: variant.name,
            price: resolveStoredSellingPrice(variant) || 0,
            cost: resolveStoredCost(variant) || 0,
            cost_price: resolveStoredCost(variant) || 0,
            calculated_price: resolveStoredCalculatedPrice(variant) || 0,
            selling_price: resolveStoredSellingPrice(variant) || 0,
            rounding_difference: variant.rounding_difference,
            rounding_method: variant.rounding_method,
            stock: variant.stock,
            isVariantParent: false,
            variants: [],
            // ✅ Variant-specific adjustment data
            adjustmentSnapshots,
            adjustmentTotal,
            smartPricingSnapshot: variant.smartPricingSnapshot,
            productionCostSnapshot: variant.productionCostSnapshot,
            pagesOverride: variant.pages,
            pricingSource: variant.pricingSource,
            quantity: variant.quantity || 1 // Use selected quantity or default to 1
        };

        addToCart(variantItem);
        setSelectedProductForVariants(null);
    };

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const term = searchTerm.trim();
        if (!term) return;

        // 1) Exact barcode match (fast path for scanner)
        if (barcodeMatch) {
            autoAddItem(barcodeMatch);
            return;
        }

        // 2) Exact VARIANT SKU — the variant goes straight in the cart. The
        // line still references variant.id; the SKU only selected it.
        if (exactVariantMatch) {
            setSelectedProductForVariants(exactVariantMatch.parent);
            handleVariantSelect(exactVariantMatch.variant);
            setSearchTerm('');
            return;
        }

        // 3) Single filtered result — auto-add
        if (filteredProducts.length === 1) {
            autoAddItem(filteredProducts[0]);
            return;
        }

        // 4) Multiple results — select first with keyboard nav
        if (filteredProducts.length > 0) {
            setActiveIndex(0);
        }
    };

    const { activeIndex, setActiveIndex } = useKeyboardListNavigation({
        itemCount: filteredProducts.length,
        columns: gridCols,
        onSelect: (index) => handleItemClick(filteredProducts[index])
    });

    const getCategoryIcon = (cat: string | undefined) => {
        const lower = (cat || '').toLowerCase();
        if (lower.includes('print') || lower.includes('paper')) return <Printer size={12} />;
        if (lower.includes('book') || lower.includes('binding')) return <Book size={12} />;
        if (lower.includes('design')) return <PenTool size={12} />;
        if (lower.includes('large') || lower.includes('banner')) return <Image size={12} />;
        if (lower.includes('cut') || lower.includes('finish')) return <Scissors size={12} />;
        if (lower.includes('service')) return <Briefcase size={12} />;
        if (lower.includes('material')) return <Layers size={12} />;
        return <Box size={12} />;
    };

    const renderItems = (items: Item[]) => {
        const price = (item: Item) => resolveStoredSellingPrice(item) || 0;
        const lowestVariantPrice = (item: Item) => {
            if (!item.variants || item.variants.length === 0) return 0;
            const prices = item.variants.map(v => Number(resolveStoredSellingPrice(v) || 0));
            return Math.min(...prices);
        };

        if (viewMode === 'List') {
            return (
                <div style={{ width: '100%' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 110px 100px 70px', gap: 24, padding: '10px 16px', fontSize: 10, fontWeight: 700, color: teal[600], textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: `1px solid ${hairlineStrong}`, background: '#fff' }}>
                        <span></span>
                        <span>Item</span>
                        <span style={{ textAlign: 'right' }}>Price</span>
                        <span style={{ textAlign: 'right' }}>Stock</span>
                        <span style={{ textAlign: 'center' }}>Type</span>
                    </div>
                    {items.map((item, idx) => (
                        <button
                            key={item.id}
                            onMouseEnter={() => setActiveIndex(idx)}
                            onClick={() => handleItemClick(item)}
                            style={{
                                width: '100%',
                                display: 'grid',
                                gridTemplateColumns: '28px 1fr 110px 100px 70px',
                                gap: 24,
                                alignItems: 'center',
                                padding: '12px 16px',
                                textAlign: 'left',
                                border: 'none',
                                borderBottom: `1px solid ${hairline}`,
                                background: activeIndex === idx ? teal[50] : 'transparent',
                                cursor: 'pointer',
                                opacity: 1,
                                fontFamily: "'Inter','DM Sans',sans-serif",
                                transition: 'all .15s cubic-bezier(.4,0,.2,1)',
                                position: 'relative'
                            }}
                            onMouseOver={e => { if (activeIndex !== idx) e.currentTarget.style.background = '#faf9f6'; }}
                            onMouseOut={e => { if (activeIndex !== idx) e.currentTarget.style.background = 'transparent'; }}
                        >
                            {activeIndex === idx && <div style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, background: `linear-gradient(180deg, ${teal[500]}, ${teal[400]})`, borderRadius: '0 3px 3px 0' }} />}
                            <div style={{ padding: 6, borderRadius: 8, background: activeIndex === idx ? '#fff' : teal[50], color: teal[600], display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: activeIndex === idx ? `0 0 0 1px ${teal[200]}` : 'none', transition: 'all .15s' }}>
                                {getCategoryIcon(item.category)}
                            </div>
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: -0.01 }}>{item.name}</div>
                                <div style={{ fontSize: 10, color: inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2, fontFamily: NUMERIC_FONT }}>{item.sku}</div>
                            </div>
                            <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: INK, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.02 }}>
                                {item.isVariantParent ? (
                                    <>From&nbsp;{currency}{formatNumber(lowestVariantPrice(item))} <span style={{ fontSize: 9, color: teal[500], marginLeft: 2 }}>▼</span></>
                                ) : (
                                    `${currency}${formatNumber(price(item))}`
                                )}
                            </div>
                            <div style={{ textAlign: 'right', fontSize: 12, color: inkSoft, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums' }}>
                                {isInventoryBearingItem(item) ? `${item.stock}${item.unit ? ' ' + item.unit : ''}` : '—'}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'center' }}>
                                <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 6, textTransform: 'uppercase', background: item.type === 'Service' ? teal[100] : '#fff', color: item.type === 'Service' ? teal[700] : inkSoft, border: `1px solid ${item.type === 'Service' ? teal[200] : hairline}`, letterSpacing: 0.04, boxShadow: '0 1px 2px rgba(0,0,0,.03)' }}>
                                    {(item.type || '?').charAt(0)}
                                </span>
                            </div>
                        </button>
                    ))}
                </div>
            );
        }

        return items.map((item, idx) => (
            <button
                key={item.id}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleItemClick(item)}
                style={{
                    position: 'relative',
                    background: activeIndex === idx ? '#fff' : '#fefdfb',
                    border: `1px solid ${activeIndex === idx ? teal[300] : '#e4ddd1'}`,
                    borderRadius: 12,
                    padding: viewMode === 'Small' ? 10 : 12,
                    textAlign: 'left',
                    cursor: 'pointer',
                    opacity: 1,
                    fontFamily: "'Inter','DM Sans',sans-serif",
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    transition: 'all .2s cubic-bezier(.4,0,.2,1)',
                    boxShadow: activeIndex === idx ? '0 4px 16px -4px rgba(30,58,95,.08), 0 0 0 1px rgba(30,58,95,.04)' : '0 1px 3px rgba(0,0,0,.02)',
                    overflow: 'hidden'
                }}
                onMouseOver={e => {
                    if (activeIndex !== idx) {
                        e.currentTarget.style.borderColor = teal[200];
                        e.currentTarget.style.boxShadow = '0 4px 12px -4px rgba(30,58,95,.06), 0 0 0 1px rgba(30,58,95,.03)';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                    }
                }}
                onMouseOut={e => {
                    if (activeIndex !== idx) {
                        e.currentTarget.style.borderColor = '#e4ddd1';
                        e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,.02)';
                        e.currentTarget.style.transform = 'translateY(0)';
                    }
                }}
            >
                {activeIndex === idx && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${teal[500]}, ${teal[400]}, ${amber[500]})`, borderRadius: '12px 12px 0 0' }} />}
                {companyConfig.transactionSettings?.pos?.showItemImages && item.image && (
                    <div style={{
                        width: '100%',
                        aspectRatio: '16 / 10',
                        background: '#f8f6f1',
                        marginBottom: 10,
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        border: `1px solid #e4ddd1`,
                        position: 'relative'
                    }}>
                        <img src={item.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform .3s' }} />
                        {isOutOfStock(item) && <div style={{ position: 'absolute', inset: 0, background: 'rgba(254,253,251,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(1px)' }}><span style={{ fontSize: 11, fontWeight: 700, color: '#A8382F', letterSpacing: 0.04, background: '#fff', padding: '4px 10px', borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>Out of stock</span></div>}
                    </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontSize: viewMode === 'Small' ? 12 : 13,
                        fontWeight: 600,
                        color: isOutOfStock(item) ? inkSoft : INK,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        lineHeight: 1.4,
                        letterSpacing: -0.01
                    }}>
                        {item.name}
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 'auto', paddingTop: 10 }}>
                    <div style={{ minWidth: 0 }}>
                        {item.isVariantParent ? (
                            <span style={{ fontSize: viewMode === 'Small' ? 12 : 13, fontWeight: 700, color: isOutOfStock(item) ? inkSoft : teal[700], whiteSpace: 'nowrap', fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.02 }}>
                                From&nbsp;{currency}{formatAmount(lowestVariantPrice(item))}
                            </span>
                        ) : (
                            <span style={{ fontSize: viewMode === 'Small' ? 12 : 13, fontWeight: 700, color: isOutOfStock(item) ? inkSoft : INK, whiteSpace: 'nowrap', fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.02 }}>
                                {currency}{formatAmount(price(item))}
                                {(item.type === 'Service' || item.category === 'Service') && item.pages ? <span style={{ fontSize: 11, fontWeight: 400, color: inkSoft, marginLeft: 3 }}>/pg</span> : ''}
                            </span>
                        )}
                        {item.isVariantParent && (
                            <div style={{ fontSize: 11, color: inkSoft, marginTop: 3, fontWeight: 500 }}>
                                {item.variants?.length ?? 0} option{(item.variants?.length ?? 0) === 1 ? '' : 's'}
                            </div>
                        )}
                    </div>
                    <StockChip item={item} compact={viewMode === 'Small'} />
                </div>
            </button>
        ));
    };

    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: PAPER, fontFamily: "'Inter','DM Sans',sans-serif" }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: `1px solid ${LINE}`, background: B50 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: 6, background: B7, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
                        <Grid size={12} />
                    </div>
                    <h3 style={{ margin: 0, fontSize: 14, fontFamily: "'Inter','DM Sans',sans-serif", fontWeight: 400, color: INK }}>Items</h3>
                    <span style={{ fontSize: 12, color: SOFT }}>{filteredProducts.length} item{filteredProducts.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex" style={{ border: `1px solid ${LINE}`, borderRadius: 8, overflow: 'hidden' }}>
                        {(['Large', 'Small', 'List'] as ViewMode[]).map(mode => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode)}
                                style={{
                                    padding: '6px 10px',
                                    transition: '.15s',
                                    border: 'none',
                                    borderRight: mode !== 'List' ? `1px solid ${LINE}` : 'none',
                                    cursor: 'pointer',
                                    background: viewMode === mode ? B100 : '#fff',
                                    color: viewMode === mode ? B7 : SOFT,
                                    fontSize: 12,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontFamily: "'Inter','DM Sans',sans-serif",
                                    fontWeight: viewMode === mode ? 600 : 400
                                }}
                            >
                                {mode === 'Large' ? <Grid size={13} /> : mode === 'Small' ? <Layout size={13} /> : <FileText size={13} />}
                                <span style={{ fontSize: 10, display: 'none' }}>{mode}</span>
                            </button>
                        ))}
                    </div>
                    <div style={{ width: 1, height: 20, background: LINE }} />
                    <button onClick={onRecall} style={{ color: B6, fontWeight: 600, fontSize: 12.5, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <PauseCircle size={15} /> Recall ({heldCount})
                    </button>
                </div>
            </div>

            {/* Search */}
            <div style={{ padding: '10px 16px', background: '#fff', borderBottom: `1px solid ${LINE}` }}>
                <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: SOFT }} />
                    <input
                        ref={searchInputRef}
                        type="text"
                        style={{
                            width: '100%',
                            padding: '8px 12px 8px 36px',
                            borderRadius: 8,
                            border: `1px solid ${LINE}`,
                            outline: 'none',
                            fontSize: 13,
                            fontFamily: "'Inter','DM Sans',sans-serif",
                            color: INK,
                            background: PAPER,
                            boxSizing: 'border-box'
                        }}
                        placeholder="Find items (Alt+S)..."
                        value={searchTerm}
                        onChange={e => {
                            const val = e.target.value;
                            const isScanner = detectScannerInput();
                            setSearchTerm(val);
                            if (isScanner && val.trim()) {
                                const match = saleableInventory.find(
                                    p => p.barcode && p.barcode.toLowerCase() === val.trim().toLowerCase()
                                );
                                if (match) {
                                    autoAddItem(match);
                                }
                            }
                        }}
                        onFocus={() => setActiveIndex(-1)}
                        onKeyDown={handleSearchKeyDown}
                    />
                </div>
            </div>

            {companyConfig.transactionSettings?.pos?.showCategoryFilters !== false && (
                <div style={{ background: '#fff', borderBottom: `1px solid ${LINE}`, overflowX: 'auto' }}>
                    <div style={{ display: 'flex', gap: 6, padding: '8px 16px' }}>
                        {categoryGroups.map(g => {
                            const isActive = activeCategory === g.label;
                            return (
                                <button
                                    key={g.label}
                                    onClick={() => { setActiveCategory(g.label); setActiveIndex(-1); }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '6px 14px',
                                        borderRadius: 20,
                                        border: isActive ? 'none' : `1px solid ${LINE}`,
                                        background: isActive ? B7 : '#fff',
                                        color: isActive ? '#fff' : INK,
                                        fontSize: 12,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        fontFamily: "'Inter','DM Sans',sans-serif",
                                        whiteSpace: 'nowrap',
                                        transition: '.12s'
                                    }}
                                >
                                    {g.label !== 'All' && (
                                        <span style={{ color: isActive ? '#fff' : SOFT, display: 'flex' }}>
                                            {getCategoryIcon(g.label)}
                                        </span>
                                    )}
                                    <span>{g.label}</span>
                                </button>
                            )
                        })}
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ padding: viewMode === 'List' ? '0' : '12px 16px' }}>
                {filteredProducts.length === 0 && searchTerm ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center">
                        <div style={{ fontSize: 13, color: SOFT, marginBottom: 12 }}>No items found for "{searchTerm}"</div>
                        <button
                            type="button"
                            onClick={() => setShowCreateItemModal(true)}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                padding: '8px 16px', fontSize: 13, fontWeight: 600,
                                color: '#fff', background: B7, border: 'none', borderRadius: 8,
                                cursor: 'pointer', transition: '.12s'
                            }}
                            onMouseOver={e => e.currentTarget.style.background = B6}
                            onMouseOut={e => e.currentTarget.style.background = B7}
                        >
                            <Plus size={14} />
                            <span>Create new item</span>
                        </button>
                    </div>
                ) : viewMode === 'List' ? (
                    renderItems(filteredProducts)
                ) : (
                    <div className="grid gap-3 content-start pb-20" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
                        {renderItems(filteredProducts)}
                    </div>
                )}
            </div>

            {showCreateItemModal && (
                <ItemModal
                    open={showCreateItemModal}
                    onClose={() => setShowCreateItemModal(false)}
                    onSave={async (item) => {
                        await inventoryAddItem(item);
                        addToCart(item);
                        setShowCreateItemModal(false);
                    }}
                    allItems={inventory}
                />
            )}

            {selectedProductForVariants && (
                selectedProductForVariants.variants && selectedProductForVariants.variants.length > 0 ? (
                    <VariantSelectorModal
                        product={selectedProductForVariants}
                        onSelect={handleVariantSelect}
                        onClose={() => setSelectedProductForVariants(null)}
                    />
                ) : (
                    <PrintingVariantModal
                        product={selectedProductForVariants}
                        bom={boms.find((b: any) =>
                            b.productId === selectedProductForVariants.id ||
                            (selectedProductForVariants.parentId && b.productId === selectedProductForVariants.parentId)
                        )}
                        materials={inventory}
                        onSelect={(virtualVariant) => {
                            addToCart(virtualVariant);
                            setSelectedProductForVariants(null);
                        }}
                        onClose={() => setSelectedProductForVariants(null)}
                    />
                )
            )}
        </div>
    );
};
