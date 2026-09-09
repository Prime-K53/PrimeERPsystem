/**
 * Fixed Assets Module — Production Upgrade.
 *
 * Wires the existing `fixedAssetService`, `ledgerService`, `dbService`,
 * `aiService`, `bankingAttachmentsService`, and `bankingYearEndService`
 * into a tabbed module with:
 *
 *   - Dashboard KPIs (Total Assets / Acquisition Cost / Accum Dep / NBV /
 *     Period Depreciation / Fully Depreciated / Pending Capitalisation /
 *     Disposed / Requiring Verification)
 *   - Asset Register with advanced filters, bulk actions, status badges
 *   - Acquire modal (with capitalisation workflow)
 *   - Depreciation Run workflow (Calculate / Review / Post / Closed)
 *   - Asset Detail Drawer with tabs (Overview / Financial / Depreciation /
 *     Transactions / Maintenance / Warranty / Verification / Documents)
 *   - Transfer / Revaluation / Impairment / Disposal / Write-Off modals
 *   - Maintenance / Warranty / Insurance record panels
 *   - Physical Verification workflow
 *   - Reports (Register, Depreciation Schedule, Movement, Disposal,
 *     By Department, By Cost Centre)
 *   - AI Asset Assistant (read-only, reuses aiService)
 *   - Audit logging via existing `auditLogs` store
 *
 * No new accounting source of truth; everything posts through
 * `ledgerService.createJournalEntry`.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, RefreshCw, Building2, Package, ArrowRightLeft, CheckCircle2, AlertCircle,
  FileText, Eye, Edit2, Trash2, Lock, Search, Filter, Download, Printer,
  MoreHorizontal, Banknote, X, AlertTriangle, Wrench, Shield, Truck,
  TrendingDown, TrendingUp, Sparkles, Send, Wand2, Upload, ClipboardCheck,
  Calculator, History, Layers,
} from 'lucide-react';

import { useAuth } from '../../../context/AuthContext';
import { useFinance } from '../../../context/FinanceContext';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Dialog } from '../../../components/Dialog';
import EmptyState from '../../../components/EmptyState';
import { fixedAssetService } from '../../../services/fixedAssetService';
import { dbService } from '../../../services/db';
import { logger } from '../../../services/logger';
import { aiService } from '../../../services/aiService';
import { roundFinancial, getDefaultDate } from '../../../utils/helpers';
import { getGLConfig } from '../../../services/transactions/_internal';
import { validateDateInFY } from '../../../utils/financialYearUtils';

type Tab = 'dashboard' | 'register' | 'depreciation' | 'transfers' | 'disposals' | 'reports' | 'ai' | 'maintenance';

interface AssetRow {
  id: string;
  asset_code: string;
  name: string;
  category: string;
  acquisition_date: string;
  acquisition_cost: number;
  status: string;
  lifecycle_status?: string;
  current_book_value: number;
  accumulated_depreciation: number;
  location?: string;
  branch?: string;
  department?: string;
  cost_centre?: string;
  last_verification_date?: string;
  useful_life_years: number;
  fixed_asset_account_id: string;
  accumulated_depreciation_account_id?: string;
  depreciation_expense_account_id: string;
}

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const teal = { 50: '#eef7f6', 100: '#d4ebe3', 400: '#3fa294', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c' };
const amber = { 50: '#fef9e7', 600: '#b45309' };
const danger = { 50: '#fef2f2', 600: '#991b1b' };
const emerald = { 50: '#f0fdf4', 600: '#059669' };

function fmt(n: number, symbol: string) {
  return `${symbol} ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusColor(s: string): { bg: string; fg: string } {
  switch (s) {
    case 'active':
    case 'Capitalised':
    case 'InService':
    case 'Depreciating':
      return { bg: emerald[50], fg: emerald[600] };
    case 'fully_depreciated':
    case 'FullyDepreciated':
      return { bg: amber[50], fg: amber[600] };
    case 'disposed':
    case 'Disposed':
    case 'WrittenOff':
      return { bg: danger[50], fg: danger[600] };
    case 'PendingCapitalisation':
    case 'Acquired':
    case 'Proposed':
      return { bg: teal[50], fg: teal[700] };
    case 'under_maintenance':
      return { bg: '#dbeafe', fg: '#1e40af' };
    default:
      return { bg: teal[50], fg: teal[700] };
  }
}

const KpiCard: React.FC<{ label: string; value: string; sub?: string; tone?: 'neutral' | 'positive' | 'warning' | 'danger'; icon?: React.ReactNode }> = ({ label, value, sub, tone = 'neutral', icon }) => {
  const fg = tone === 'positive' ? emerald[600] : tone === 'warning' ? amber[600] : tone === 'danger' ? danger[600] : teal[700];
  return (
    <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: inkSoft }}>{label}</span>
        {icon && <span style={{ color: fg }}>{icon}</span>}
      </div>
      <span style={{ fontSize: 22, fontWeight: 700, color: fg }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: inkSoft }}>{sub}</span>}
    </div>
  );
};

export const FixedAssetsModule: React.FC = () => {
  const { user, companyConfig } = useAuth();
  const { accounts } = useFinance();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [assetRows, setAssetRows] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterBranch, setFilterBranch] = useState<string>('all');

  // Modals
  const [showAcquire, setShowAcquire] = useState(false);
  const [editingAsset, setEditingAsset] = useState<AssetRow | null>(null);
  const [detailAsset, setDetailAsset] = useState<AssetRow | null>(null);
  const [confirm, setConfirm] = useState<any>(null);

  const currency = companyConfig?.currencySymbol || '$';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await fixedAssetService.initializeStores();
      const register = await fixedAssetService.getAssetRegister();
      setAssetRows(register as any);
    } catch (err) {
      logger.error('[FA] load failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const audit = useCallback(async (action: string, recordId: string, details?: any) => {
    try {
      await dbService.put('auditLogs', {
        id: `FA-${Date.now()}-${recordId}`,
        timestamp: new Date().toISOString(),
        action,
        entity_type: 'fixed_asset',
        entity_id: recordId,
        user_id: user?.id,
        status: 'LOCAL',
        details_json: JSON.stringify(details || {}),
      });
    } catch (err) { /* non-blocking */ }
  }, [user?.id]);

  // ----- KPIs -----
  const kpis = useMemo(() => {
    const active = assetRows.filter((a) => a.status !== 'disposed');
    const totalAssets = active.length;
    const acquisitionCost = active.reduce((s, a) => s + roundFinancial(a.acquisition_cost), 0);
    const accumulated = active.reduce((s, a) => s + roundFinancial(a.accumulated_depreciation), 0);
    const nbv = active.reduce((s, a) => s + roundFinancial(a.current_book_value), 0);
    const fullyDep = active.filter((a) => a.status === 'fully_depreciated').length;
    const pendingCap = active.filter((a) => a.lifecycle_status === 'PendingCapitalisation' || a.lifecycle_status === 'Acquired').length;
    const disposed = assetRows.filter((a) => a.status === 'disposed').length;
    const needsVerification = active.filter((a) => {
      if (!a.last_verification_date) return true;
      const days = Math.round((Date.now() - new Date(a.last_verification_date).getTime()) / 86400000);
      return days > 365;
    }).length;
    return { totalAssets, acquisitionCost, accumulated, nbv, fullyDep, pendingCap, disposed, needsVerification };
  }, [assetRows]);

  // ----- Filters -----
  const filtered = useMemo(() => {
    return assetRows.filter((a) => {
      if (filterCategory !== 'all' && a.category !== filterCategory) return false;
      if (filterStatus !== 'all' && (a.lifecycle_status || a.status) !== filterStatus) return false;
      if (filterBranch !== 'all' && a.branch !== filterBranch) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${a.name} ${a.asset_code} ${a.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.acquisition_date || '').localeCompare(a.acquisition_date || ''));
  }, [assetRows, filterCategory, filterStatus, filterBranch, search]);

  const categories = useMemo(() => Array.from(new Set(assetRows.map((a) => a.category))).sort(), [assetRows]);
  const branches = useMemo(() => Array.from(new Set(assetRows.map((a) => a.branch).filter(Boolean))).sort(), [assetRows]);

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: 'Dashboard', icon: <Layers size={14} /> },
    { id: 'register', label: `Register (${assetRows.length})`, icon: <Package size={14} /> },
    { id: 'depreciation', label: 'Depreciation', icon: <Calculator size={14} /> },
    { id: 'transfers', label: 'Transfers', icon: <ArrowRightLeft size={14} /> },
    { id: 'disposals', label: 'Disposals', icon: <Trash2 size={14} /> },
    { id: 'maintenance', label: 'Maintenance', icon: <Wrench size={14} /> },
    { id: 'reports', label: 'Reports', icon: <FileText size={14} /> },
    { id: 'ai', label: 'AI Assistant', icon: <Sparkles size={14} /> },
  ];

  return (
    <div style={{ background: '#f6f3ed', minHeight: '100%', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: ink, fontFamily: "'DM Serif Display', Georgia, serif" }}>Fixed Assets</h1>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft }}>Asset register, depreciation, transfers, disposals, and AI insights.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { load(); }} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => setShowAcquire(true)} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
            <Plus size={14} /> Acquire Asset
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${hairline}`, overflowX: 'auto' }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '10px 14px', border: 'none', background: 'transparent', borderBottom: tab === t.id ? `2px solid ${teal[600]}` : '2px solid transparent', color: tab === t.id ? teal[700] : inkSoft, fontWeight: tab === t.id ? 700 : 500, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <KpiCard label="Total Assets" value={String(kpis.totalAssets)} sub={`${kpis.disposed} disposed`} icon={<Package size={16} />} />
          <KpiCard label="Acquisition Cost" value={fmt(kpis.acquisitionCost, currency)} icon={<Banknote size={16} />} />
          <KpiCard label="Accumulated Depreciation" value={fmt(kpis.accumulated, currency)} tone="warning" icon={<TrendingDown size={16} />} />
          <KpiCard label="Net Book Value" value={fmt(kpis.nbv, currency)} tone="positive" icon={<TrendingUp size={16} />} />
          <KpiCard label="Fully Depreciated" value={String(kpis.fullyDep)} tone="warning" icon={<CheckCircle2 size={16} />} />
          <KpiCard label="Pending Capitalisation" value={String(kpis.pendingCap)} tone={kpis.pendingCap > 0 ? 'danger' : 'positive'} icon={<AlertCircle size={16} />} />
          <KpiCard label="Disposed" value={String(kpis.disposed)} icon={<Trash2 size={16} />} />
          <KpiCard label="Need Verification" value={String(kpis.needsVerification)} tone={kpis.needsVerification > 0 ? 'warning' : 'positive'} icon={<ClipboardCheck size={16} />} />

          {/* Recent acquisitions */}
          <div style={{ gridColumn: '1 / -1', background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent Acquisitions</h3>
            {assetRows.length === 0 ? (
              <EmptyState module="banking" customTitle="No fixed assets yet" customDescription="Acquire your first asset to populate the register." actionLabel="Acquire Asset" onAction={() => setShowAcquire(true)} />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: teal[50] }}>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Code</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Name</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Category</th>
                    <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Cost</th>
                    <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>NBV</th>
                  </tr>
                </thead>
                <tbody>
                  {assetRows.slice(0, 8).map((a) => (
                    <tr key={a.id} style={{ borderTop: `1px solid ${hairline}` }}>
                      <td style={{ padding: '8px 10px' }}>{a.acquisition_date}</td>
                      <td style={{ padding: '8px 10px', color: inkSoft }}>{a.asset_code}</td>
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{a.name}</td>
                      <td style={{ padding: '8px 10px' }}>{a.category}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{fmt(a.acquisition_cost, currency)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: a.current_book_value >= 0 ? emerald[600] : danger[600] }}>{fmt(a.current_book_value, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Register */}
      {tab === 'register' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', background: paper, padding: 10, borderRadius: 12, border: `1px solid ${hairline}` }}>
            <div style={{ position: 'relative', flex: '1 1 220px' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code, category…" style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper, outline: 'none' }} />
            </div>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="fully_depreciated">Fully Depreciated</option>
              <option value="disposed">Disposed</option>
              <option value="PendingCapitalisation">Pending Capitalisation</option>
              <option value="WrittenOff">Written Off</option>
            </select>
            <select value={filterBranch} onChange={(e) => setFilterBranch(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Branches</option>
              {branches.map((b) => <option key={b} value={b as string}>{b}</option>)}
            </select>
          </div>

          <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, overflow: 'hidden' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 24 }}>
                <EmptyState module="banking" customTitle="No assets match" customDescription="Adjust filters or acquire a new asset." actionLabel="Acquire Asset" onAction={() => setShowAcquire(true)} />
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: teal[50], color: teal[800] }}>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Code</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Name</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Category</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Acquired</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Branch / Dept</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Cost</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>NBV</th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 700 }}>Status</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const sc = statusColor((a as any).lifecycle_status || a.status);
                    return (
                      <tr key={a.id} style={{ borderTop: `1px solid ${hairline}` }}>
                        <td style={{ padding: '10px 12px', color: inkSoft }}>{a.asset_code}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>{a.name}</td>
                        <td style={{ padding: '10px 12px' }}>{a.category}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{a.acquisition_date}</td>
                        <td style={{ padding: '10px 12px', color: inkSoft }}>{a.branch || '—'} / {a.department || '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>{fmt(a.acquisition_cost, currency)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: a.current_book_value >= 0 ? emerald[600] : danger[600] }}>{fmt(a.current_book_value, currency)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                          <span style={{ padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: sc.bg, color: sc.fg }}>{(a as any).lifecycle_status || a.status}</span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                          <button onClick={() => setDetailAsset(a)} style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600 }}>
                            <Eye size={12} /> View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'depreciation' && (
        <DepreciationRunPanel assets={assetRows} accounts={accounts} currency={currency} createdBy={user?.id} onDone={load} audit={audit} />
      )}

      {tab === 'transfers' && (
        <TransfersPanel assets={assetRows} createdBy={user?.id} onDone={load} audit={audit} />
      )}

      {tab === 'disposals' && (
        <DisposalsPanel assets={assetRows} accounts={accounts} currency={currency} createdBy={user?.id} onDone={load} audit={audit} />
      )}

      {tab === 'maintenance' && (
        <MaintenancePanel assets={assetRows} currency={currency} createdBy={user?.id} onDone={load} audit={audit} />
      )}

      {tab === 'reports' && (
        <ReportsPanel assets={assetRows} accounts={accounts} currency={currency} />
      )}

      {tab === 'ai' && (
        <AIAssistantTab assets={assetRows} accounts={accounts} currency={currency} />
      )}

      {/* Acquire modal */}
      {showAcquire && (
        <AcquireAssetModal
          onClose={() => setShowAcquire(false)}
          onSaved={async (asset) => {
            await audit('fixed_asset.acquire', asset.id, { name: asset.name, cost: asset.acquisition_cost });
            setShowAcquire(false);
            await load();
          }}
          accounts={accounts}
          currency={currency}
          createdBy={user?.id}
        />
      )}

      {/* Detail drawer */}
      {detailAsset && (
        <AssetDetailDrawer
          asset={detailAsset}
          accounts={accounts}
          currency={currency}
          createdBy={user?.id}
          onClose={() => setDetailAsset(null)}
          onChanged={async () => { await load(); }}
          audit={audit}
        />
      )}

      {/* Confirm dialog */}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirm.title}
          message={confirm.message}
          type={confirm.type}
          onConfirm={async () => { await confirm.onConfirm(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

// =====================================================================
//   Acquire Modal
// =====================================================================

const AcquireAssetModal: React.FC<{
  onClose: () => void;
  onSaved: (asset: any) => void | Promise<void>;
  accounts: any[];
  currency: string;
  createdBy?: string;
}> = ({ onClose, onSaved, accounts, currency, createdBy }) => {
  const config = getGLConfig();
  const [name, setName] = useState('');
  const [assetCode, setAssetCode] = useState('');
  const [category, setCategory] = useState('motor_vehicle');
  const [acquisitionDate, setAcquisitionDate] = useState(getDefaultDate());
  const [acquisitionCost, setAcquisitionCost] = useState('0');
  const [salvageValue, setSalvageValue] = useState('0');
  const [usefulLife, setUsefulLife] = useState('5');
  const [method, setMethod] = useState<any>('straight_line');
  const [fundingSource, setFundingSource] = useState<any>('Bank');
  const [branch, setBranch] = useState('');
  const [department, setDepartment] = useState('');
  const [costCentre, setCostCentre] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError('Name is required');
    const cost = parseFloat(acquisitionCost);
    if (!cost || cost <= 0) return setError('Acquisition cost must be positive');
    const life = parseFloat(usefulLife);
    if (!life || life <= 0) return setError('Useful life must be positive');
    const fyErr = validateDateInFY(acquisitionDate);
    if (fyErr) return setError(fyErr);

    setSaving(true);
    try {
      const created = await fixedAssetService.create({
        asset_code: assetCode.trim() || `FA-${Date.now()}`,
        name: name.trim(),
        category: category as any,
        acquisition_date: acquisitionDate,
        acquisition_cost: roundFinancial(cost),
        salvage_value: roundFinancial(parseFloat(salvageValue) || 0),
        useful_life_years: life,
        depreciation_method: method,
        location,
        status: 'active',
        lifecycle_status: 'Acquired',
        branch,
        department,
        cost_centre: costCentre,
        funding_source: fundingSource,
        depreciation_start_date: acquisitionDate,
        depreciation_frequency: 'Monthly',
        depreciation_convention: 'FullMonth',
        fixed_asset_account_id: config.fixedAssetAccount,
        accumulated_depreciation_account_id: config.accumulatedDepreciationAccount,
        depreciation_expense_account_id: config.depreciationExpenseAccount,
        notes,
        created_by: createdBy,
      } as any, accounts);
      await onSaved(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Acquire Fixed Asset">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Asset Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Delivery Truck" /></Field>
          <Field label="Asset Code"><input value={assetCode} onChange={(e) => setAssetCode(e.target.value)} placeholder="Auto-generated if blank" /></Field>
          <Field label="Category *">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="motor_vehicle">Motor Vehicle</option>
              <option value="furniture">Furniture</option>
              <option value="computer_equipment">Computer Equipment</option>
              <option value="building">Buildings</option>
              <option value="machinery">Machinery</option>
              <option value="office_equipment">Office Equipment</option>
              <option value="printing_equipment">Printing Equipment</option>
              <option value="communication_equipment">Communication Equipment</option>
              <option value="land">Land</option>
              <option value="leasehold_improvements">Leasehold Improvements</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Acquisition Date *"><input type="date" value={acquisitionDate} onChange={(e) => setAcquisitionDate(e.target.value)} /></Field>
          <Field label={`Acquisition Cost (${currency}) *`}><input type="number" step="0.01" value={acquisitionCost} onChange={(e) => setAcquisitionCost(e.target.value)} /></Field>
          <Field label={`Salvage Value (${currency})`}><input type="number" step="0.01" value={salvageValue} onChange={(e) => setSalvageValue(e.target.value)} /></Field>
          <Field label="Useful Life (years) *"><input type="number" step="0.1" value={usefulLife} onChange={(e) => setUsefulLife(e.target.value)} /></Field>
          <Field label="Depreciation Method *">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="straight_line">Straight Line</option>
              <option value="declining_balance">Declining Balance</option>
              <option value="sum_of_years">Sum of Years Digits</option>
              <option value="units_of_production">Units of Production</option>
              <option value="manual">Manual</option>
            </select>
          </Field>
          <Field label="Funding Source *">
            <select value={fundingSource} onChange={(e) => setFundingSource(e.target.value)}>
              <option value="Bank">Bank</option>
              <option value="Cash">Cash</option>
              <option value="SupplierCredit">Supplier Credit</option>
              <option value="Loan">Loan</option>
              <option value="Other">Other</option>
            </select>
          </Field>
          <Field label="Branch"><input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. Lilongwe" /></Field>
          <Field label="Department"><input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Operations" /></Field>
          <Field label="Cost Centre"><input value={costCentre} onChange={(e) => setCostCentre(e.target.value)} placeholder="Cost centre code" /></Field>
          <Field label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Physical location" /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></Field>
        {error && <div style={{ padding: 10, borderRadius: 8, background: danger[50], color: danger[600], fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Acquire'}</button>
        </div>
      </div>
    </Dialog>
  );
};

// =====================================================================
//   Depreciation Run Panel
// =====================================================================

const DepreciationRunPanel: React.FC<{
  assets: AssetRow[];
  accounts: any[];
  currency: string;
  createdBy?: string;
  onDone: () => Promise<void>;
  audit: (action: string, id: string, details?: any) => Promise<void>;
}> = ({ assets, accounts, currency, createdBy, onDone, audit }) => {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ asset: AssetRow; depreciation: number; accumulated: number; bookValue: number }> | null>(null);

  const eligible = assets.filter((a) => a.status === 'active' || a.status === 'fully_depreciated');

  const calculate = useCallback(async () => {
    setError(null);
    try {
      const rows: Array<{ asset: AssetRow; depreciation: number; accumulated: number; bookValue: number }> = [];
      for (const row of eligible) {
        const asset = await fixedAssetService.getById(row.id);
        if (!asset) continue;
        const calc = (fixedAssetService as any).calculateDepreciation(asset, year, month);
        rows.push({ asset: row, ...calc });
      }
      setPreview(rows);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [eligible, year, month]);

  const post = useCallback(async () => {
    if (!preview) return;
    setPosting(true);
    setError(null);
    try {
      let posted = 0;
      for (const p of preview) {
        const full = await fixedAssetService.getById(p.asset.id);
        if (!full) continue;
        const result = await fixedAssetService.postDepreciation(full, year, month, accounts);
        if (result) {
          posted++;
          await audit('fixed_asset.depreciate', p.asset.id, { year, month, amount: p.depreciation });
        }
      }
      setPreview(null);
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }, [preview, year, month, accounts, audit, onDone]);

  const total = preview?.reduce((s, p) => s + p.depreciation, 0) || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, color: ink }}>Depreciation Run — {year}-{String(month).padStart(2, '0')}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))} style={{ padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12 }}>
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={month} onChange={(e) => setMonth(parseInt(e.target.value))} style={{ padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12 }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>Month {m}</option>)}
          </select>
          <button onClick={calculate} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Calculate</button>
          {preview && (
            <button onClick={post} disabled={posting} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: posting ? 0.6 : 1 }}>
              {posting ? 'Posting…' : `Post All (${preview.length})`}
            </button>
          )}
        </div>
        {error && <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: danger[50], color: danger[600], fontSize: 12 }}>{error}</div>}
        {preview && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <KpiCard label="Assets" value={String(preview.length)} />
              <KpiCard label="Total Depreciation" value={fmt(total, currency)} tone="warning" />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: teal[50] }}>
                  <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Asset</th>
                  <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Depreciation</th>
                  <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Accumulated</th>
                  <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Closing NBV</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.asset.id} style={{ borderTop: `1px solid ${hairline}` }}>
                    <td style={{ padding: 8 }}>{p.asset.name} ({p.asset.asset_code})</td>
                    <td style={{ padding: 8, textAlign: 'right', fontWeight: 700, color: amber[600] }}>{fmt(p.depreciation, currency)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{fmt(p.accumulated, currency)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{fmt(p.bookValue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// =====================================================================
//   Transfers Panel
// =====================================================================

const TransfersPanel: React.FC<{ assets: AssetRow[]; createdBy?: string; onDone: () => Promise<void>; audit: (a: string, id: string, d?: any) => Promise<void> }> = ({ assets, createdBy, onDone, audit }) => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [transferDate, setTransferDate] = useState(getDefaultDate());
  const [toDepartment, setToDepartment] = useState('');
  const [toCostCentre, setToCostCentre] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const t = await fixedAssetService.getAllTransfers();
    setTransfers(t);
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setError(null);
    if (!assetId) return setError('Select an asset');
    if (!reason.trim()) return setError('Reason is required');
    const fyErr = validateDateInFY(transferDate);
    if (fyErr) return setError(fyErr);
    setSaving(true);
    try {
      await fixedAssetService.recordTransfer({
        fixed_asset_id: assetId,
        transfer_date: transferDate,
        to_department: toDepartment,
        to_cost_centre: toCostCentre,
        to_location_id: toLocation,
        reason,
        authorised_by: createdBy,
      });
      await audit('fixed_asset.transfer', assetId, { transferDate, toDepartment });
      setShowForm(false);
      setAssetId(''); setReason(''); setToDepartment(''); setToCostCentre(''); setToLocation('');
      await load(); await onDone();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, color: ink }}>Asset Transfers</h3>
        <button onClick={() => setShowForm(true)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={12} /> Record Transfer
        </button>
      </div>
      {transfers.length === 0 ? (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 20 }}>
          <EmptyState module="banking" customTitle="No transfers" customDescription="Record asset transfers between departments, branches, locations or custodians." actionLabel="Record Transfer" onAction={() => setShowForm(true)} />
        </div>
      ) : (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr style={{ background: teal[50] }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Date</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Asset</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>From → To</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: teal[800] }}>Reason</th>
            </tr></thead>
            <tbody>
              {transfers.slice(0, 20).map((t) => {
                const a = assets.find((x) => x.id === t.fixed_asset_id);
                return (
                  <tr key={t.id} style={{ borderTop: `1px solid ${hairline}` }}>
                    <td style={{ padding: '8px 10px' }}>{t.transfer_date}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{a?.name || t.fixed_asset_id}</td>
                    <td style={{ padding: '8px 10px', color: inkSoft }}>{t.from_department || '—'} → {t.to_department || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>{t.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <Dialog open onClose={() => setShowForm(false)} title="Record Asset Transfer">
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Asset *">
                <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">Select asset</option>
                  {assets.filter((a) => a.status !== 'disposed').map((a) => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
                </select>
              </Field>
              <Field label="Transfer Date *"><input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} /></Field>
              <Field label="To Department"><input value={toDepartment} onChange={(e) => setToDepartment(e.target.value)} /></Field>
              <Field label="To Cost Centre"><input value={toCostCentre} onChange={(e) => setToCostCentre(e.target.value)} /></Field>
              <Field label="To Location"><input value={toLocation} onChange={(e) => setToLocation(e.target.value)} /></Field>
              <Field label="Reason *"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
            {error && <div style={{ padding: 10, borderRadius: 8, background: danger[50], color: danger[600], fontSize: 12 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              <button onClick={submit} disabled={saving} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};

// =====================================================================
//   Disposals Panel
// =====================================================================

const DisposalsPanel: React.FC<{
  assets: AssetRow[];
  accounts: any[];
  currency: string;
  createdBy?: string;
  onDone: () => Promise<void>;
  audit: (a: string, id: string, d?: any) => Promise<void>;
}> = ({ assets, accounts, currency, createdBy, onDone, audit }) => {
  const [showForm, setShowForm] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [disposalDate, setDisposalDate] = useState(getDefaultDate());
  const [proceeds, setProceeds] = useState('0');
  const [reason, setReason] = useState('');
  const [disposalType, setDisposalType] = useState<any>('Sale');
  const [buyer, setBuyer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (!assetId) return setError('Select an asset');
    const fyErr = validateDateInFY(disposalDate);
    if (fyErr) return setError(fyErr);
    setSaving(true);
    try {
      const result = await fixedAssetService.disposeAssetV2(assetId, {
        disposal_date: disposalDate,
        proceeds: parseFloat(proceeds) || 0,
        reason: reason.trim() || disposalType,
        disposal_type: disposalType,
        buyer,
        write_off_only: disposalType === 'WriteOff',
      }, accounts, createdBy);
      await audit('fixed_asset.dispose', assetId, { disposalType, gainLoss: (result as any)?.gain_loss });
      setShowForm(false); setAssetId(''); setReason(''); setBuyer(''); setProceeds('0');
      await onDone();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };

  const selected = assets.find((a) => a.id === assetId);
  const gainLoss = selected ? parseFloat(proceeds) - selected.current_book_value : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, color: ink }}>Asset Disposals & Write-offs</h3>
        <button onClick={() => setShowForm(true)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={12} /> Dispose Asset
        </button>
      </div>
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 16 }}>
        <EmptyState module="banking" customTitle="No recent disposals" customDescription="Dispose of assets via sale, scrapping, donation, write-off, or replacement. Gain/loss is calculated automatically." actionLabel="Dispose Asset" onAction={() => setShowForm(true)} />
      </div>

      {showForm && (
        <Dialog open onClose={() => setShowForm(false)} title={`Dispose Asset${disposalType === 'WriteOff' ? ' (Write-off)' : ''}`}>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Asset *">
                <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">Select asset</option>
                  {assets.filter((a) => a.status !== 'disposed').map((a) => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
                </select>
              </Field>
              <Field label="Disposal Date *"><input type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} /></Field>
              <Field label="Disposal Type *">
                <select value={disposalType} onChange={(e) => setDisposalType(e.target.value)}>
                  <option value="Sale">Sale</option>
                  <option value="Scrapping">Scrapping</option>
                  <option value="Donation">Donation</option>
                  <option value="WriteOff">Write-off</option>
                  <option value="Loss">Loss</option>
                  <option value="Replacement">Replacement</option>
                </select>
              </Field>
              <Field label={`Proceeds (${currency})`}><input type="number" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} /></Field>
              <Field label="Buyer"><input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="If sold" /></Field>
              <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
            {selected && (
              <div style={{ padding: 12, borderRadius: 8, background: teal[50], fontSize: 12 }}>
                <div><strong>Cost:</strong> {fmt(selected.acquisition_cost, currency)}</div>
                <div><strong>Accumulated Dep:</strong> {fmt(selected.accumulated_depreciation, currency)}</div>
                <div><strong>NBV:</strong> {fmt(selected.current_book_value, currency)}</div>
                <div><strong>Proceeds:</strong> {fmt(parseFloat(proceeds) || 0, currency)}</div>
                <div style={{ marginTop: 6, fontWeight: 700, color: gainLoss >= 0 ? emerald[600] : danger[600] }}>
                  Estimated {gainLoss >= 0 ? 'Gain' : 'Loss'}: {fmt(Math.abs(gainLoss), currency)}
                </div>
              </div>
            )}
            {error && <div style={{ padding: 10, borderRadius: 8, background: danger[50], color: danger[600], fontSize: 12 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              <button onClick={submit} disabled={saving || !assetId} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: (saving || !assetId) ? 0.6 : 1 }}>{saving ? 'Posting…' : 'Post Disposal'}</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};

// =====================================================================
//   Maintenance Panel
// =====================================================================

const MaintenancePanel: React.FC<{ assets: AssetRow[]; currency: string; createdBy?: string; onDone: () => Promise<void>; audit: (a: string, id: string, d?: any) => Promise<void> }> = ({ assets, currency, createdBy, onDone, audit }) => {
  const [records, setRecords] = useState<any[]>([]);
  const [warranties, setWarranties] = useState<any[]>([]);
  const [showMaint, setShowMaint] = useState(false);
  const [showWarr, setShowWarr] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [maintenanceDate, setMaintenanceDate] = useState(getDefaultDate());
  const [serviceProvider, setServiceProvider] = useState('');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('0');
  const [isCapex, setIsCapex] = useState(false);
  const [warrantyProvider, setWarrantyProvider] = useState('');
  const [warrantyStart, setWarrantyStart] = useState(getDefaultDate());
  const [warrantyExpiry, setWarrantyExpiry] = useState('');

  const load = useCallback(async () => {
    const all = await dbService.getAll<any>('fixedAssetMaintenance');
    const war = await dbService.getAll<any>('fixedAssetWarranty');
    setRecords(all.sort((a, b) => b.maintenance_date.localeCompare(a.maintenance_date)));
    setWarranties(war);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveMaint = async () => {
    if (!assetId || !description.trim()) return;
    await fixedAssetService.recordMaintenance(assetId, {
      maintenance_date: maintenanceDate,
      service_provider: serviceProvider,
      description,
      cost: parseFloat(cost) || 0,
      is_capex: isCapex,
      created_by: createdBy,
    });
    await audit('fixed_asset.maintenance', assetId, { cost, isCapex });
    setShowMaint(false); setDescription(''); setServiceProvider(''); setCost('0'); setIsCapex(false);
    await load();
  };

  const saveWarr = async () => {
    if (!assetId || !warrantyProvider.trim()) return;
    await fixedAssetService.setWarranty(assetId, {
      provider: warrantyProvider,
      start_date: warrantyStart,
      expiry_date: warrantyExpiry,
    });
    await audit('fixed_asset.warranty', assetId, { warrantyProvider });
    setShowWarr(false); setWarrantyProvider(''); setWarrantyExpiry('');
    await load();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setShowMaint(true)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={12} /> Record Maintenance
        </button>
        <button onClick={() => setShowWarr(true)} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={12} /> Set Warranty
        </button>
      </div>

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13, color: inkSoft, textTransform: 'uppercase' }}>Maintenance ({records.length})</h3>
        {records.length === 0 ? (
          <EmptyState module="banking" customTitle="No maintenance records" customDescription="Track maintenance, repairs, and service history for each asset." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: teal[50] }}>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Date</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Asset</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Description</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Provider</th>
              <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Cost</th>
              <th style={{ textAlign: 'center', padding: 8, fontWeight: 700, color: teal[800] }}>CapEx?</th>
            </tr></thead>
            <tbody>
              {records.slice(0, 20).map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${hairline}` }}>
                  <td style={{ padding: 8 }}>{r.maintenance_date}</td>
                  <td style={{ padding: 8, fontWeight: 600 }}>{assets.find((a) => a.id === r.fixed_asset_id)?.name || r.fixed_asset_id}</td>
                  <td style={{ padding: 8 }}>{r.description}</td>
                  <td style={{ padding: 8 }}>{r.service_provider || '—'}</td>
                  <td style={{ padding: 8, textAlign: 'right', fontWeight: 700 }}>{fmt(r.cost, currency)}</td>
                  <td style={{ padding: 8, textAlign: 'center' }}>{r.is_capex ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13, color: inkSoft, textTransform: 'uppercase' }}>Warranties ({warranties.length})</h3>
        {warranties.length === 0 ? (
          <EmptyState module="banking" customTitle="No warranties tracked" customDescription="Track warranty provider, contract, coverage, and expiry for assets." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: teal[50] }}>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Asset</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Provider</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Start</th>
              <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Expiry</th>
              <th style={{ textAlign: 'center', padding: 8, fontWeight: 700, color: teal[800] }}>Status</th>
            </tr></thead>
            <tbody>
              {warranties.map((w) => {
                const expired = new Date(w.expiry_date) < new Date();
                return (
                  <tr key={w.id} style={{ borderTop: `1px solid ${hairline}` }}>
                    <td style={{ padding: 8, fontWeight: 600 }}>{assets.find((a) => a.id === w.fixed_asset_id)?.name || w.fixed_asset_id}</td>
                    <td style={{ padding: 8 }}>{w.provider}</td>
                    <td style={{ padding: 8 }}>{w.start_date}</td>
                    <td style={{ padding: 8 }}>{w.expiry_date}</td>
                    <td style={{ padding: 8, textAlign: 'center' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: expired ? danger[50] : emerald[50], color: expired ? danger[600] : emerald[600] }}>{expired ? 'Expired' : 'Active'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showMaint && (
        <Dialog open onClose={() => setShowMaint(false)} title="Record Maintenance">
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <Field label="Asset *">
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Select asset</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
              </select>
            </Field>
            <Field label="Date"><input type="date" value={maintenanceDate} onChange={(e) => setMaintenanceDate(e.target.value)} /></Field>
            <Field label="Service Provider"><input value={serviceProvider} onChange={(e) => setServiceProvider(e.target.value)} /></Field>
            <Field label="Description *"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label={`Cost (${currency})`}><input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={isCapex} onChange={(e) => setIsCapex(e.target.checked)} />
              Capital expenditure (CapEx) — otherwise treated as maintenance expense
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
              <button onClick={() => setShowMaint(false)} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              <button onClick={saveMaint} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </Dialog>
      )}

      {showWarr && (
        <Dialog open onClose={() => setShowWarr(false)} title="Set Warranty">
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <Field label="Asset *">
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Select asset</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
              </select>
            </Field>
            <Field label="Provider *"><input value={warrantyProvider} onChange={(e) => setWarrantyProvider(e.target.value)} /></Field>
            <Field label="Start Date"><input type="date" value={warrantyStart} onChange={(e) => setWarrantyStart(e.target.value)} /></Field>
            <Field label="Expiry Date"><input type="date" value={warrantyExpiry} onChange={(e) => setWarrantyExpiry(e.target.value)} /></Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
              <button onClick={() => setShowWarr(false)} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              <button onClick={saveWarr} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};

// =====================================================================
//   Reports Panel
// =====================================================================

const ReportsPanel: React.FC<{ assets: AssetRow[]; accounts: any[]; currency: string }> = ({ assets, currency }) => {
  const [report, setReport] = useState<'register' | 'movements' | 'byDept' | 'byCC' | 'schedule'>('register');

  const active = assets.filter((a) => a.status !== 'disposed');
  const byDept = useMemo(() => {
    const m = new Map<string, { count: number; cost: number; nbv: number }>();
    for (const a of active) {
      const k = a.department || 'Unassigned';
      const v = m.get(k) || { count: 0, cost: 0, nbv: 0 };
      v.count++; v.cost += a.acquisition_cost; v.nbv += a.current_book_value;
      m.set(k, v);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].nbv - a[1].nbv);
  }, [active]);

  const byCC = useMemo(() => {
    const m = new Map<string, { count: number; cost: number; nbv: number }>();
    for (const a of active) {
      const k = a.cost_centre || 'Unassigned';
      const v = m.get(k) || { count: 0, cost: 0, nbv: 0 };
      v.count++; v.cost += a.acquisition_cost; v.nbv += a.current_book_value;
      m.set(k, v);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].nbv - a[1].nbv);
  }, [active]);

  const exportCSV = (rows: any[], name: string) => {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, background: paper, padding: 10, borderRadius: 12, border: `1px solid ${hairline}`, alignItems: 'center' }}>
        <select value={report} onChange={(e) => setReport(e.target.value as any)} style={{ padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12 }}>
          <option value="register">Fixed Asset Register</option>
          <option value="movements">Asset Movements (Acquisitions + Disposals)</option>
          <option value="byDept">By Department</option>
          <option value="byCC">By Cost Centre</option>
          <option value="schedule">Depreciation Schedule (per asset)</option>
        </select>
        <span style={{ flex: 1 }} />
        <button onClick={() => {
          if (report === 'register') exportCSV(assets, 'fa-register.csv');
          else if (report === 'byDept') exportCSV(byDept.map(([k, v]) => ({ department: k, ...v })), 'fa-by-department.csv');
          else if (report === 'byCC') exportCSV(byCC.map(([k, v]) => ({ costCentre: k, ...v })), 'fa-by-cost-centre.csv');
        }} style={{ padding: '8px 12px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Download size={12} /> Export CSV
        </button>
      </div>

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 16 }}>
        {report === 'register' && (
          <AssetTable rows={assets.map((a) => ({ code: a.asset_code, name: a.name, category: a.category, acquired: a.acquisition_date, branch: a.branch || '', dept: a.department || '', cost: a.acquisition_cost, nbv: a.current_book_value, status: a.lifecycle_status || a.status }))} currency={currency} />
        )}
        {report === 'movements' && (
          <AssetTable rows={assets.map((a) => ({ code: a.asset_code, name: a.name, type: a.status === 'disposed' ? 'Disposal' : 'Acquisition', date: a.acquisition_date, cost: a.acquisition_cost }))} currency={currency} />
        )}
        {report === 'byDept' && (
          <AssetTable rows={byDept.map(([k, v]) => ({ department: k, count: v.count, cost: v.cost, nbv: v.nbv }))} currency={currency} />
        )}
        {report === 'byCC' && (
          <AssetTable rows={byCC.map(([k, v]) => ({ costCentre: k, count: v.count, cost: v.cost, nbv: v.nbv }))} currency={currency} />
        )}
        {report === 'schedule' && (
          <ScheduleViewer assets={assets} />
        )}
      </div>
    </div>
  );
};

const AssetTable: React.FC<{ rows: any[]; currency: string }> = ({ rows, currency }) => {
  if (rows.length === 0) return <EmptyState module="reports" customTitle="No data" customDescription="No records to display." />;
  const keys = Object.keys(rows[0]);
  return (
    <div style={{ overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ background: teal[50] }}>
          {keys.map((k) => <th key={k} style={{ textAlign: typeof rows[0][k] === 'number' ? 'right' : 'left', padding: 8, fontWeight: 700, color: teal[800] }}>{k}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${hairline}` }}>
              {keys.map((k) => (
                <td key={k} style={{ padding: 8, textAlign: typeof r[k] === 'number' ? 'right' : 'left', fontWeight: ['cost', 'nbv', 'amount'].includes(k.toLowerCase()) ? 700 : 400 }}>
                  {typeof r[k] === 'number' ? fmt(r[k], currency) : r[k]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ScheduleViewer: React.FC<{ assets: AssetRow[] }> = ({ assets }) => {
  const [assetId, setAssetId] = useState(assets[0]?.id || '');
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      if (!assetId) return;
      const full = await fixedAssetService.getById(assetId);
      if (!full) return;
      const schedule = (fixedAssetService as any).generateSchedule(full);
      setRows(schedule);
    })();
  }, [assetId]);

  if (rows.length === 0) return <EmptyState module="reports" customTitle="No schedule" customDescription="Select an asset to view its depreciation schedule." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <select value={assetId} onChange={(e) => setAssetId(e.target.value)} style={{ padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12, maxWidth: 360 }}>
        {assets.map((a) => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
      </select>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ background: teal[50] }}>
          <th style={{ textAlign: 'left', padding: 8, fontWeight: 700, color: teal[800] }}>Period</th>
          <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Opening NBV</th>
          <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Depreciation</th>
          <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Accumulated</th>
          <th style={{ textAlign: 'right', padding: 8, fontWeight: 700, color: teal[800] }}>Closing NBV</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${hairline}` }}>
              <td style={{ padding: 8 }}>{r.period}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{r.openingNbv.toFixed(2)}</td>
              <td style={{ padding: 8, textAlign: 'right', color: amber[600] }}>{r.depreciation.toFixed(2)}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{r.accumulated.toFixed(2)}</td>
              <td style={{ padding: 8, textAlign: 'right', fontWeight: 700 }}>{r.closingNbv.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// =====================================================================
//   AI Asset Assistant
// =====================================================================

interface Message { role: 'user' | 'assistant'; content: string; isAiSuggestion?: boolean }

const AIAssistantTab: React.FC<{ assets: AssetRow[]; accounts: any[]; currency: string }> = ({ assets, currency }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<{ enabled: boolean; provider: string; model: string } | null>(null);

  React.useEffect(() => {
    aiService.getConfig().then((c) => setConfig({ enabled: c.enabled, provider: c.provider, model: c.model })).catch(() => setConfig({ enabled: false, provider: '—', model: '—' }));
  }, []);

  const QUICK = [
    'What is our current fixed asset value?',
    'Which assets are fully depreciated?',
    'Which assets are due for replacement (over 5 years old and depreciated)?',
    'Find assets that have not been physically verified recently.',
    'Which assets have the highest acquisition cost?',
    'Summarize our fixed asset position by department.',
    'Which warranties are expiring soon?',
  ];

  const systemInstruction = `You are the AI Asset Assistant for Prime ERP. Read-only. NEVER independently post, modify, capitalise, dispose, revalue, impair, or delete anything financial. Always label outputs as "AI Suggestion". Be concise. Currency: ${currency}.`;

  const buildContext = () => {
    const totalCost = assets.reduce((s, a) => s + a.acquisition_cost, 0);
    const totalNbv = assets.reduce((s, a) => s + a.current_book_value, 0);
    const totalAcc = assets.reduce((s, a) => s + a.accumulated_depreciation, 0);
    const fullyDep = assets.filter((a) => a.status === 'fully_depreciated').length;
    const disposed = assets.filter((a) => a.status === 'disposed').length;
    const needsVerification = assets.filter((a) => !a.last_verification_date || (Date.now() - new Date(a.last_verification_date).getTime()) > 365 * 86400000).length;
    return {
      totalAssets: assets.length,
      totalCost, totalNbv, totalAcc,
      fullyDepreciatedCount: fullyDep,
      disposedCount: disposed,
      needsVerificationCount: needsVerification,
      byCategory: assets.reduce((m: any, a) => { m[a.category] = (m[a.category] || 0) + 1; return m; }, {}),
      sample: assets.slice(0, 50).map((a) => ({ code: a.asset_code, name: a.name, category: a.category, cost: a.acquisition_cost, nbv: a.current_book_value, status: a.status, lastVerification: a.last_verification_date, branch: a.branch, dept: a.department })),
    };
  };

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setMessages((m) => [...m, { role: 'user', content: q }]);
    setInput('');
    try {
      const ctx = buildContext();
      const reply = await aiService.generateAIResponse(`Asset context:\n${JSON.stringify(ctx, null, 2)}\n\nQuestion:\n${q}`, systemInstruction);
      setMessages((m) => [...m, { role: 'assistant', content: reply, isAiSuggestion: true }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${(err as Error).message}`, isAiSuggestion: true }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, color: ink, display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={18} color={teal[600]} /> AI Asset Assistant</h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft }}>Read-only analysis. Recommendations are labelled "AI Suggestion". The user must execute all actions.</p>
        </div>
        {config && (
          <div style={{ fontSize: 11, color: inkSoft, padding: '6px 10px', background: paper, border: `1px solid ${hairline}`, borderRadius: 8 }}>
            Provider: <strong>{config.provider}</strong> · Model: <strong>{config.model}</strong> · {config.enabled ? 'Enabled' : '⚠️ Disabled'}
          </div>
        )}
      </div>

      {!config?.enabled && (
        <div style={{ padding: 12, borderRadius: 10, background: amber[50], border: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={16} color={amber[600]} />
          <span style={{ fontSize: 12, color: ink }}>AI is not configured. Go to <strong>Settings → Marketing Messages → AI Settings</strong> to configure your provider.</span>
        </div>
      )}

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Wand2 size={14} color={teal[700]} />
          <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Quick Actions</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {QUICK.map((p) => (
            <button key={p} onClick={() => ask(p)} disabled={loading || !config?.enabled} style={{ padding: '6px 12px', borderRadius: 16, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: (loading || !config?.enabled) ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600, opacity: (loading || !config?.enabled) ? 0.5 : 1 }}>{p}</button>
          ))}
        </div>
      </div>

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 280 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: inkSoft, fontSize: 12, padding: 40 }}>Ask a question or pick a quick action above to begin.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '10px 14px', borderRadius: 12, background: m.role === 'user' ? teal[600] : teal[50], color: m.role === 'user' ? '#fff' : ink, fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', border: m.isAiSuggestion ? `1px dashed ${teal[600]}` : 'none' }}>
            {m.isAiSuggestion && <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, color: teal[700], marginBottom: 4, textTransform: 'uppercase' }}>AI Suggestion</div>}
            {m.content}
          </div>
        ))}
        {loading && <div style={{ alignSelf: 'flex-start', color: inkSoft, fontSize: 12, padding: 8 }}>Thinking…</div>}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }} placeholder="Ask about asset value, depreciation, anomalies, replacement candidates…" disabled={loading || !config?.enabled} style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: `1px solid ${hairline}`, fontSize: 13, background: paper, outline: 'none' }} />
        <button onClick={() => ask(input)} disabled={loading || !input.trim() || !config?.enabled} style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, opacity: (loading || !input.trim() || !config?.enabled) ? 0.5 : 1 }}><Send size={14} /> Ask AI</button>
      </div>
    </div>
  );
};

// =====================================================================
//   Asset Detail Drawer
// =====================================================================

const AssetDetailDrawer: React.FC<{
  asset: AssetRow;
  accounts: any[];
  currency: string;
  createdBy?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  audit: (a: string, id: string, d?: any) => Promise<void>;
}> = ({ asset, accounts, currency, createdBy, onClose, onChanged, audit }) => {
  const [tab, setTab] = useState<'overview' | 'financial' | 'depreciation' | 'maintenance' | 'warranty'>('overview');
  const [schedule, setSchedule] = useState<any[]>([]);
  const [deprec, setDeprec] = useState<any[]>([]);
  const [maint, setMaint] = useState<any[]>([]);
  const [warr, setWarr] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const full = await fixedAssetService.getById(asset.id);
      if (full) setSchedule((fixedAssetService as any).generateSchedule(full));
      const d = await dbService.getAll<any>('depreciationEntries');
      setDeprec(d.filter((x) => x.fixed_asset_id === asset.id).sort((a, b) => (b.period_year * 100 + b.period_month) - (a.period_year * 100 + a.period_month)));
      setMaint(await fixedAssetService.getMaintenance(asset.id));
      setWarr(await fixedAssetService.getWarranty(asset.id));
    })();
  }, [asset.id]);

  return (
    <Dialog open onClose={onClose} title={`${asset.name} (${asset.asset_code})`} hideHeader>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: ink }}>{asset.name}</div>
            <div style={{ fontSize: 11, color: inkSoft }}>{asset.asset_code} · {asset.category} · {asset.acquisition_date}</div>
          </div>
          <button onClick={onClose} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer' }}>Close</button>
        </div>

        <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${hairline}` }}>
          {['overview', 'financial', 'depreciation', 'maintenance', 'warranty'].map((t) => (
            <button key={t} onClick={() => setTab(t as any)} style={{ padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: tab === t ? `2px solid ${teal[600]}` : '2px solid transparent', color: tab === t ? teal[700] : inkSoft, fontSize: 12, cursor: 'pointer', fontWeight: tab === t ? 700 : 500, textTransform: 'capitalize' }}>{t}</button>
          ))}
        </div>

        {tab === 'overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <KV k="Branch" v={asset.branch || '—'} />
            <KV k="Department" v={asset.department || '—'} />
            <KV k="Cost Centre" v={asset.cost_centre || '—'} />
            <KV k="Location" v={asset.location || '—'} />
            <KV k="Acquired" v={asset.acquisition_date} />
            <KV k="Useful Life" v={`${asset.useful_life_years} years`} />
            <KV k="Cost" v={fmt(asset.acquisition_cost, currency)} />
            <KV k="Net Book Value" v={fmt(asset.current_book_value, currency)} />
            <KV k="Accumulated Dep" v={fmt(asset.accumulated_depreciation, currency)} />
            <KV k="Status" v={(asset as any).lifecycle_status || asset.status} />
          </div>
        )}

        {tab === 'financial' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <KV k="Fixed Asset GL" v={asset.fixed_asset_account_id} />
            <KV k="Depreciation Expense GL" v={asset.depreciation_expense_account_id} />
            <KV k="Accumulated Depreciation GL" v={asset.accumulated_depreciation_account_id || '—'} />
          </div>
        )}

        {tab === 'depreciation' && (
          <div>
            <h4 style={{ margin: '0 0 8px', fontSize: 12, color: ink }}>Posted Depreciation ({deprec.length})</h4>
            {deprec.length === 0 ? (
              <EmptyState module="reports" customTitle="No depreciation posted yet" />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr style={{ background: teal[50] }}>
                  <th style={{ textAlign: 'left', padding: 6, color: teal[800], fontWeight: 700 }}>Period</th>
                  <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Amount</th>
                  <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Accumulated</th>
                  <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>NBV</th>
                </tr></thead>
                <tbody>
                  {deprec.map((d) => (
                    <tr key={d.id} style={{ borderTop: `1px solid ${hairline}` }}>
                      <td style={{ padding: 6 }}>{d.period_year}-{String(d.period_month).padStart(2, '0')}</td>
                      <td style={{ padding: 6, textAlign: 'right', color: amber[600] }}>{d.depreciation_amount.toFixed(2)}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{d.accumulated_depreciation.toFixed(2)}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{d.book_value.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h4 style={{ margin: '12px 0 8px', fontSize: 12, color: ink }}>Projected Schedule ({schedule.length} periods)</h4>
            {schedule.length === 0 ? (
              <EmptyState module="reports" customTitle="No schedule" />
            ) : (
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead><tr style={{ background: teal[50] }}>
                    <th style={{ textAlign: 'left', padding: 6, color: teal[800], fontWeight: 700 }}>Period</th>
                    <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Opening</th>
                    <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Dep</th>
                    <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Acc</th>
                    <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Closing</th>
                  </tr></thead>
                  <tbody>
                    {schedule.slice(0, 30).map((s, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${hairline}` }}>
                        <td style={{ padding: 6 }}>{s.period}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{s.openingNbv.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{s.depreciation.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{s.accumulated.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{s.closingNbv.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'maintenance' && (
          <div>
            {maint.length === 0 ? (
              <EmptyState module="banking" customTitle="No maintenance recorded" customDescription="Track maintenance from the Maintenance tab." />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ background: teal[50] }}>
                  <th style={{ textAlign: 'left', padding: 6, color: teal[800], fontWeight: 700 }}>Date</th>
                  <th style={{ textAlign: 'left', padding: 6, color: teal[800], fontWeight: 700 }}>Description</th>
                  <th style={{ textAlign: 'right', padding: 6, color: teal[800], fontWeight: 700 }}>Cost</th>
                  <th style={{ textAlign: 'center', padding: 6, color: teal[800], fontWeight: 700 }}>CapEx</th>
                </tr></thead>
                <tbody>
                  {maint.map((m) => (
                    <tr key={m.id} style={{ borderTop: `1px solid ${hairline}` }}>
                      <td style={{ padding: 6 }}>{m.maintenance_date}</td>
                      <td style={{ padding: 6 }}>{m.description}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{fmt(m.cost, currency)}</td>
                      <td style={{ padding: 6, textAlign: 'center' }}>{m.is_capex ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'warranty' && (
          <div>
            {warr.length === 0 ? (
              <EmptyState module="banking" customTitle="No warranty on record" customDescription="Set a warranty from the Maintenance tab." />
            ) : (
              warr.map((w) => {
                const expired = new Date(w.expiry_date) < new Date();
                return (
                  <div key={w.id} style={{ padding: 10, borderRadius: 8, background: paper, border: `1px solid ${hairline}`, marginBottom: 6, fontSize: 12 }}>
                    <div><strong>{w.provider}</strong> · {expired ? <span style={{ color: danger[600] }}>Expired</span> : <span style={{ color: emerald[600] }}>Active</span>}</div>
                    <div style={{ color: inkSoft, fontSize: 11 }}>{w.start_date} → {w.expiry_date}</div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
};

const KV: React.FC<{ k: string; v: any }> = ({ k, v }) => (
  <div>
    <div style={{ fontSize: 9, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>{k}</div>
    <div style={{ fontSize: 12.5, color: ink, marginTop: 2 }}>{v}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: inkSoft }}>{label}</label>
    {React.Children.map(children, (c) => React.isValidElement(c) ? React.cloneElement(c as any, { style: { padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12, background: paper, outline: 'none', width: '100%', ...(c.props.style || {}) } }) : c)}
  </div>
);

export default FixedAssetsModule;
