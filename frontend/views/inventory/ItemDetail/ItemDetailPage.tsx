import React, { Suspense, lazy, useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, ChevronLeft, ChevronRight, Edit3, Copy, Printer, QrCode, Archive, Plus, ArrowUpDown, Package, Layers, DollarSign, Building2, FileText, Sparkles, X, Box, Tag, Ruler, Globe, Eye } from 'lucide-react';
import { useItemDetail } from './hooks/useItemDetail';

import StockAdjustmentModal from '../components/StockAdjustmentModal';
import { TransferStockModal } from '../InventoryList/modals/TransferStockModal';
import { PrintLabelModal } from '../InventoryList/modals/PrintLabelModal';
import { ItemModal } from '../../../components/items/ItemModal';
import { useInventory } from '../../../context/InventoryContext';
import { useAuth } from '../../../context/AuthContext';
import { OverviewTab } from './tabs/OverviewTab';
import { InventoryTab } from './tabs/InventoryTab';
import { PricingTab } from './tabs/PricingTab';
import { SuppliersTab } from './tabs/SuppliersTab';
import { AttachmentsTab } from './tabs/AttachmentsTab';
import type { Item } from '../../../types';
import '../inventory-reference.css';

const TransactionsTab = lazy(() => import('./tabs/TransactionsTab').then(m => ({ default: m.TransactionsTab })));

const TABS = [
  { id: 'overview', label: 'Overview', icon: <Eye size={14} /> },
  { id: 'inventory', label: 'Inventory', icon: <Layers size={14} /> },
  { id: 'pricing', label: 'Pricing', icon: <DollarSign size={14} /> },
  { id: 'suppliers', label: 'Suppliers', icon: <Building2 size={14} /> },
  { id: 'transactions', label: 'Transactions', icon: <ArrowUpDown size={14} />, lazy: true },
  { id: 'documents', label: 'Documents', icon: <FileText size={14} /> },
];

const TYPE_ICONS: Record<string, React.ReactNode> = {
  'Raw Material': <Layers size={22} />,
  'Material': <Box size={22} />,
  'Product': <Package size={22} />,
  'Stationery': <Tag size={22} />,
  'Service': <Globe size={22} />,
};

export const ItemDetailPage: React.FC = () => {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const {
    item, loading, error,
    transactions, purchases, sales, auditLogs, productionData, suppliers,
    activeTab, setActiveTab,
    stockCalc, pricingCalc,
    prevItem, nextItem,
    allItems, refresh, handleSave, handleDuplicate,
  } = useItemDetail(itemId);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const { updateItem } = useInventory();
  const { notify } = useAuth();

  const [isEditing, setIsEditing] = useState(false);
  const [aiOpen, setAiOpen] = useState(true);

  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [printMode, setPrintMode] = useState<'barcode' | 'qrcode' | null>(null);

  const ext = (item ?? {}) as Item & { classification?: string; productType?: string; averageMonthlyUsage?: number; brand?: string };
  const isRaw = useMemo(() => {
    const t = item?.type || '';
    return t === 'Raw Material' || t === 'Material' || ext.classification === 'raw_material' || ext.classification === 'material';
  }, [item]);

  const isProduct = useMemo(() => {
    const t = item?.type || '';
    return t === 'Product' || t === 'Service' || ext.productType === 'MANUFACTURED';
  }, [item]);

  const isStockTracked = useMemo(() => {
    const t = item?.type || '';
    return t === 'Raw Material' || t === 'Stationery';
  }, [item]);

  const handleEditSave = useCallback(async (updated: Item) => {
    await handleSave(updated);
    setIsEditing(false);
    refresh();
  }, [handleSave, refresh]);

  const handleBack = () => navigate('/supply-chain/inventory');

  const onDuplicate = useCallback(async () => {
    if (!item) return;
    const dup = await handleDuplicate();
    if (dup) navigate(`/supply-chain/inventory/${encodeURIComponent(dup.id)}`);
  }, [item, handleDuplicate, navigate]);

  const handleToggleStatus = useCallback(async () => {
    if (!item) return;
    const newStatus = item.status === 'Inactive' ? 'Active' : 'Inactive';
    try {
      await updateItem({ ...item, status: newStatus }, `Status changed to ${newStatus}`);
      notify?.(`${item.name} ${newStatus === 'Inactive' ? 'archived' : 'activated'}`, 'success');
      refresh();
    } catch (err: any) {
      notify?.(`Failed to update status: ${err?.message || 'Unknown error'}`, 'error');
    }
  }, [item, updateItem, notify, refresh]);

  // KPI data
  const kpis = useMemo(() => {
    if (!item || !stockCalc || !pricingCalc) return [];
    const cur = stockCalc.currentStock;
    const avail = stockCalc.available;
    const reserved = stockCalc.reserved;
    const value = stockCalc.inventoryValue;

    if (isStockTracked) {
      const common = [
        { label: 'Current Stock', value: String(cur), sub: `${avail} available`, color: cur === 0 ? '#DC2626' : cur <= (item.minStockLevel || 0) ? '#D97706' : '#16A34A' },
        { label: 'Available', value: String(avail), sub: `${((avail / (cur || 1)) * 100).toFixed(0)}% of stock`, color: '#2563EB' },
        { label: 'Reserved', value: String(reserved), sub: `${((reserved / (cur || 1)) * 100).toFixed(0)}% allocated`, color: '#7C3AED' },
        { label: 'Stock Value', value: value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), sub: 'Total cost value', color: '#059669' },
      ];

      if (isRaw) {
        return [...common,
          { label: 'Avg Cost', value: pricingCalc.costPrice.toFixed(2), sub: 'Per unit', color: '#2563EB' },
          { label: 'Reorder Level', value: String(item.reorderPoint || item.minStockLevel || 0), sub: item.reorderPoint ? `Min: ${item.minStockLevel || '—'}` : 'Not set', color: cur <= (item.reorderPoint || 0) ? '#DC2626' : '#64748B' },
        ];
      }

      return [...common,
        { label: 'Selling Price', value: pricingCalc.sellingPrice.toFixed(2), sub: `Profit ${pricingCalc.profit.toFixed(2)}`, color: pricingCalc.profit >= 0 ? '#16A34A' : '#DC2626' },
        { label: 'Gross Margin', value: `${pricingCalc.markup.toFixed(1)}%`, sub: `Min ${pricingCalc.minimumMarkup}%`, color: pricingCalc.markup >= pricingCalc.minimumMarkup ? '#16A34A' : '#DC2626' },
      ];
    }

    // For non-stock-tracked items (Products, Services)
    return [
      { label: 'Selling Price', value: pricingCalc.sellingPrice.toFixed(2), sub: `Profit ${pricingCalc.profit.toFixed(2)}`, color: pricingCalc.profit >= 0 ? '#16A34A' : '#DC2626' },
      { label: 'Gross Margin', value: `${pricingCalc.markup.toFixed(1)}%`, sub: `Min ${pricingCalc.minimumMarkup}%`, color: pricingCalc.markup >= pricingCalc.minimumMarkup ? '#16A34A' : '#DC2626' },
    ];
  }, [item, stockCalc, pricingCalc, isRaw, isStockTracked]);

  // AI insights
  const aiInsights = useMemo(() => {
    if (!item || !stockCalc || !pricingCalc) return [];
    const insights: { text: string; severity: 'high' | 'med' | 'low' | 'ok' }[] = [];
    const cur = stockCalc.currentStock;
    const reorder = item.reorderPoint || item.minStockLevel || 0;

    if (isStockTracked) {
      if (cur <= 0) insights.push({ text: 'Item is out of stock. Urgent reorder needed.', severity: 'high' });
      else if (reorder > 0 && cur <= reorder) insights.push({ text: `Stock level (${cur}) is at or below reorder point (${reorder}).`, severity: 'med' });
      else insights.push({ text: 'Stock level is healthy.', severity: 'ok' });

      if (cur > 0 && ext.averageMonthlyUsage) {
        const months = cur / ext.averageMonthlyUsage;
        if (months < 1) insights.push({ text: `Estimated ${(months * 30).toFixed(0)} days until stockout based on usage.`, severity: 'med' });
        else insights.push({ text: `Estimated ${months.toFixed(1)} months of stock remaining.`, severity: 'ok' });
      }

      if (isRaw && !item.preferredSupplierId) insights.push({ text: 'No preferred supplier assigned.', severity: 'low' });
    } else {
      insights.push({ text: 'Stock tracking is not enabled for this item type.', severity: 'low' });
    }

    if (!pricingCalc.sellingPrice && !isRaw) insights.push({ text: 'No selling price configured.', severity: 'high' });
    else if (pricingCalc.markup < pricingCalc.minimumMarkup) insights.push({ text: `Markup ${pricingCalc.markup.toFixed(1)}% is below minimum ${pricingCalc.minimumMarkup}%.`, severity: 'med' });
    else if (pricingCalc.sellingPrice > 0) insights.push({ text: `Current markup ${pricingCalc.markup.toFixed(1)}% meets minimum target.`, severity: 'ok' });

    return insights;
  }, [item, stockCalc, pricingCalc, isRaw, isStockTracked]);

  if (loading && !mounted) {
    return (
      <div className="h-full flex items-center justify-center bg-[#F3F0EC]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={32} className="animate-spin text-slate-300" />
          <span className="text-sm font-medium text-slate-400">Loading item...</span>
        </div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="h-full flex items-center justify-center bg-[#F3F0EC]">
        <div className="text-center">
          <Package size={48} className="mx-auto mb-4 text-slate-300" />
          <h2 className="text-lg font-bold mb-2 text-slate-800">{error || 'Item not found'}</h2>
          <button onClick={handleBack} className="px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 bg-blue-600 text-white hover:bg-blue-700">
            <ChevronLeft size={16} /> Back to Inventory
          </button>
        </div>
      </div>
    );
  }

  const getStockStatus = () => {
    if (!isStockTracked) return 'not-applicable';
    const cur = stockCalc?.currentStock || 0;
    if (cur <= 0) return 'out-of-stock';
    if ((item.reorderPoint || 0) > 0 && cur <= item.reorderPoint!) return 'low-stock';
    return 'active';
  };

  const getTypeBadgeClass = () => {
    const t = item.type || '';
    if (t === 'Raw Material' || t === 'Material') return 'rm';
    if (t === 'Product' || t === 'Stationery') return 'fg';
    if (t === 'Service') return 'svc';
    return 'cons';
  };

  const stockStatus = getStockStatus();

  const getStockStatusLabel = () => {
    if (stockStatus === 'not-applicable') return 'No Stock Tracking';
    if (stockStatus === 'active') return 'Active';
    if (stockStatus === 'low-stock') return 'Low Stock';
    return 'Out of Stock';
  };

  return (
    <div className="item-detail-shell">

      {/* ── STICKY HEADER ── */}
      <div className="item-detail-top">
        <div className="item-identity" style={{ padding: '16px 28px', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="item-avatar">
            {TYPE_ICONS[item.type || ''] || <Package size={22} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400, fontSize: 20, margin: 0, color: '#0b3e39', letterSpacing: 0.2 }}>{item.name}</h1>
              <span className={`item-type-badge ${getTypeBadgeClass()}`}>{item.type || ext.classification || 'Item'}</span>
              <span className={`item-status-badge ${stockStatus}`}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                {getStockStatusLabel()}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '2px 7px', background: '#eef7f6', borderRadius: 5, color: '#5c6567' }}>{item.sku}</span>
              {item.category && <span style={{ fontSize: 11, color: '#5c6567', display: 'flex', alignItems: 'center', gap: 3 }}><Tag size={10} /> {item.category}</span>}
              {ext.brand && <span style={{ fontSize: 11, color: '#5c6567' }}>{item.brand || ext.brand}</span>}
              <span style={{ fontSize: 11, color: '#5c6567', display: 'flex', alignItems: 'center', gap: 3 }}><Ruler size={10} /> {item.unit || 'pcs'}</span>
              <span style={{ fontSize: 10, color: '#94A3B8' }}>Updated {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '—'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button className="qa-btn primary" onClick={() => setIsEditing(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 9, fontSize: 11.5, fontWeight: 600, border: '1.4px solid transparent', background: 'linear-gradient(155deg, #1f8577, #0f544c)', color: '#fff', cursor: 'pointer', boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)' }}>
              <Edit3 size={13} /> Edit
            </button>
            <button className="qa-btn" onClick={onDuplicate} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 9, fontSize: 11.5, fontWeight: 600, border: '1.4px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer' }}>
              <Copy size={13} /> Duplicate
            </button>
            <button className="qa-icon" title="Print Barcode" onClick={() => setPrintMode('barcode')} style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Printer size={14} />
            </button>
            <button className="qa-icon" title="Generate QR" onClick={() => setPrintMode('qrcode')} style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <QrCode size={14} />
            </button>
            <button className="qa-icon" title={item?.status === 'Inactive' ? 'Activate' : 'Archive'} onClick={handleToggleStatus} style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Archive size={14} />
            </button>
            {prevItem && <button className="qa-icon" onClick={() => navigate(`/supply-chain/inventory/${encodeURIComponent(prevItem.id)}`)} title="Previous" style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><ChevronLeft size={14} /></button>}
            {nextItem && <button className="qa-icon" onClick={() => navigate(`/supply-chain/inventory/${encodeURIComponent(nextItem.id)}`)} title="Next" style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><ChevronRight size={14} /></button>}
          </div>
        </div>

        {/* ── KPI DASHBOARD ── */}
        <div className="item-kpi-bar">
          <div className="item-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, padding: '12px 28px' }}>
            {kpis.map(kpi => (
              <div key={kpi.label} style={{ background: '#FEFDFB', border: '1px solid #e4ddd1', borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,.03)', padding: '10px 14px', borderLeft: `3px solid ${kpi.color}` }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '-.02em', color: '#5c6567', marginBottom: 2 }}>{kpi.label}</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#23282A', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{kpi.value}</div>
                <div style={{ fontSize: 9, color: '#5c6567', marginTop: 1 }}>{kpi.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── TAB NAV ── */}
        <div className="item-tab-bar">
          {TABS.map(tab => {
            const showTab = TABS.some(t => t.id === tab.id);
            if (!showTab) return null;
            return (
              <button key={tab.id} className={`item-tab ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
                {tab.icon} {tab.label}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          <button className="item-tab" onClick={() => setAiOpen(v => !v)} style={{ color: aiOpen ? 'var(--inv-stamp)' : undefined }}>
            <Sparkles size={14} /> AI
          </button>
        </div>
      </div>

      {/* ── BODY + AI PANEL ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div className="item-detail-body">
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <Loader2 size={28} className="animate-spin text-slate-300" />
            </div>
          }>
            {activeTab === 'overview' && <OverviewTab item={item} />}
            {activeTab === 'inventory' && <InventoryTab item={item} stockCalc={stockCalc} />}
            {activeTab === 'warehouses' && <WarehousesTab item={item} />}
            {activeTab === 'pricing' && <PricingTab item={item} />}
            {activeTab === 'procurement' && <PurchaseHistoryTab purchases={purchases} itemId={item.id || ''} />}
            {activeTab === 'suppliers' && <SuppliersTab item={item} suppliers={suppliers} />}
            {activeTab === 'transactions' && <TransactionsTab transactions={transactions} />}
            {activeTab === 'documents' && <AttachmentsTab item={item} />}
          </Suspense>
        </div>

        {/* ── AI PANEL ── */}
        {aiOpen && (
          <div className="ai-panel">
            <div className="ai-panel-header">
              <Sparkles size={15} style={{ color: 'var(--inv-stamp)' }} />
              AI Intelligence
              <button onClick={() => setAiOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 4 }}><X size={14} /></button>
            </div>
            <div className="ai-panel-body">
              {aiInsights.length === 0 && (
                <div className="ai-insight-card ok">All checks passed. Item data looks good.</div>
              )}
              {aiInsights.map((ins, i) => (
                <div key={i} className={`ai-insight-card ${ins.severity}`}>{ins.text}</div>
              ))}
              <div style={{ borderTop: '1px solid var(--inv-line-soft)', paddingTop: 10, marginTop: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94A3B8', marginBottom: 6 }}>Smart Actions</div>
                {isRaw && <div className="ai-insight-card low" style={{ cursor: 'pointer' }}>Create Purchase Order</div>}
                {isProduct && <div className="ai-insight-card low" style={{ cursor: 'pointer' }}>Create Sales Order</div>}
                {isStockTracked && stockCalc && stockCalc.currentStock <= (item.reorderPoint || 0) && stockCalc.currentStock > 0 && (
                  <div className="ai-insight-card med" style={{ cursor: 'pointer' }}>Reorder Now</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ItemModal
        open={isEditing}
        item={item}
        onClose={() => setIsEditing(false)}
        onSave={handleEditSave}
        allItems={allItems}
        sourceTab={
          item?.type === 'Product'
            ? 'product'
            : item?.type === 'Stationery'
              ? 'stationery'
              : item?.type === 'Service' || (item as any)?.classification === 'printing_service'
                ? 'printing'
                : null
        }
      />
      <StockAdjustmentModal isOpen={isAdjustOpen} onClose={() => setIsAdjustOpen(false)} item={item} />

      <TransferStockModal open={isTransferOpen} item={item} onClose={() => setIsTransferOpen(false)} onSuccess={refresh} />

      <PrintLabelModal open={printMode !== null} items={[item]} mode={printMode || 'barcode'} onClose={() => setPrintMode(null)} />
    </div>
  );
};

export default ItemDetailPage;
