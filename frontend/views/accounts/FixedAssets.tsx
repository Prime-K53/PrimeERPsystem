import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Filter, Download, Truck, Monitor, Building2, Armchair,
    Wrench, Package, Trash2, Edit2, Eye, X, CheckCircle, AlertTriangle,
    Calendar, DollarSign, Percent, ChevronDown, ChevronRight, FileText,
    RefreshCw, Loader2
} from 'lucide-react';
import { fixedAssetService } from '../../services/fixedAssetService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { FixedAsset, FixedAssetCategory, FixedAssetStatus, DepreciationEntry } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './components/financeChrome';

const ASSET_CATEGORY_INFO: Record<FixedAssetCategory, { label: string; icon: React.ReactNode; accounts: string[] }> = {
    motor_vehicle: { label: 'Motor Vehicle', icon: <Truck size={16} />, accounts: ['12100'] },
    furniture: { label: 'Furniture & Fixtures', icon: <Armchair size={16} />, accounts: ['12200'] },
    computer_equipment: { label: 'Computer Equipment', icon: <Monitor size={16} />, accounts: ['12300'] },
    building: { label: 'Buildings', icon: <Building2 size={16} />, accounts: ['12400'] },
    machinery: { label: 'Machinery', icon: <Wrench size={16} />, accounts: ['12300'] },
    office_equipment: { label: 'Office Equipment', icon: <Package size={16} />, accounts: ['12800'] },
    other: { label: 'Other', icon: <Package size={16} />, accounts: ['12800'] },
};

const STATUS_COLORS: Record<FixedAssetStatus, { bg: string; text: string; label: string }> = {
    active: { bg: '#d1fae5', text: '#065f46', label: 'Active' },
    fully_depreciated: { bg: '#fef3c7', text: '#92400e', label: 'Fully Depreciated' },
    disposed: { bg: '#fee2e2', text: '#991b1b', label: 'Disposed' },
    under_maintenance: { bg: '#dbeafe', text: '#1e40af', label: 'Under Maintenance' },
};

const FixedAssets: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const [assets, setAssets] = useState<FixedAsset[]>([]);
    const [assetRegister, setAssetRegister] = useState<(FixedAsset & { current_book_value: number; accumulated_depreciation: number })[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<FixedAssetCategory | 'All'>('All');
    const [statusFilter, setStatusFilter] = useState<FixedAssetStatus | 'All'>('All');
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState<FixedAsset | null>(null);
    const [isDepreciateModalOpen, setIsDepreciateModalOpen] = useState(false);
    const [isDisposeModalOpen, setIsDisposeModalOpen] = useState(false);
    const [depreciationEntries, setDepreciationEntries] = useState<DepreciationEntry[]>([]);

    const canEdit = checkPermission('accounts.edit');

    useEffect(() => {
        loadAssets();
    }, []);

    const loadAssets = async () => {
        setIsLoading(true);
        try {
            await fixedAssetService.initializeStores();
            const data = await fixedAssetService.getAssetRegister();
            setAssetRegister(data);
            setAssets(data);
        } catch (error) {
            notify('Failed to load fixed assets', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const filteredAssets = useMemo(() => {
        return assetRegister.filter(asset => {
            const matchesSearch = searchTerm === '' ||
                asset.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                asset.asset_code.toLowerCase().includes(searchTerm.toLowerCase());

            const matchesCategory = categoryFilter === 'All' || asset.category === categoryFilter;
            const matchesStatus = statusFilter === 'All' || asset.status === statusFilter;

            return matchesSearch && matchesCategory && matchesStatus;
        });
    }, [assetRegister, searchTerm, categoryFilter, statusFilter]);

    const totals = useMemo(() => {
        return filteredAssets.reduce((acc, asset) => ({
            acquisitionCost: acc.acquisitionCost + asset.acquisition_cost,
            accumulatedDepreciation: acc.accumulatedDepreciation + asset.accumulated_depreciation,
            bookValue: acc.bookValue + asset.current_book_value,
        }), { acquisitionCost: 0, accumulatedDepreciation: 0, bookValue: 0 });
    }, [filteredAssets]);

    const handleAddAsset = async (data: any) => {
        try {
            await fixedAssetService.create(data, accounts);
            notify('Fixed asset added successfully', 'success');
            setIsAddModalOpen(false);
            loadAssets();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to add asset', 'error');
        }
    };

    const handleDepreciate = async (assetId: string, year: number, month: number) => {
        try {
            const asset = assets.find(a => a.id === assetId);
            if (!asset) return;

            await fixedAssetService.postDepreciation(asset, year, month, accounts);
            notify('Depreciation posted successfully', 'success');
            setIsDepreciateModalOpen(false);
            loadAssets();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to post depreciation', 'error');
        }
    };

    const handleDepreciateAll = async (year: number, month: number) => {
        try {
            const results = await fixedAssetService.postMonthlyDepreciationForAllAssets(year, month, accounts);
            notify(`Posted depreciation for ${results.length} assets`, 'success');
            setIsDepreciateModalOpen(false);
            loadAssets();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to post depreciation', 'error');
        }
    };

    const handleDispose = async (assetId: string, proceeds: number, reason: string) => {
        try {
            const asset = assets.find(a => a.id === assetId);
            if (!asset) return;

            await fixedAssetService.disposeAsset(assetId, getDefaultDate(), proceeds, reason, accounts);
            notify('Asset disposed successfully', 'success');
            setIsDisposeModalOpen(false);
            loadAssets();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to dispose asset', 'error');
        }
    };

    const handleViewDetails = async (asset: FixedAsset) => {
        setSelectedAsset(asset);
        const entries = await fixedAssetService.getDepreciationEntries(asset.id);
        setDepreciationEntries(entries);
    };

    const exportToCSV = () => {
        const headers = ['Asset Code', 'Name', 'Category', 'Status', 'Acquisition Date', 'Acquisition Cost', 'Salvage Value', 'Useful Life', 'Accumulated Depreciation', 'Book Value'];
        const rows = filteredAssets.map(asset => [
            asset.asset_code,
            asset.name,
            ASSET_CATEGORY_INFO[asset.category]?.label || asset.category,
            STATUS_COLORS[asset.status]?.label || asset.status,
            asset.acquisition_date,
            asset.acquisition_cost.toFixed(2),
            asset.salvage_value.toFixed(2),
            asset.useful_life_years,
            asset.accumulated_depreciation.toFixed(2),
            asset.current_book_value.toFixed(2),
        ]);

        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fixed_assets_${getDefaultDate()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const kpis = [
        { label: 'Total Acquisition Cost', value: formatCurrency(totals.acquisitionCost, currency), icon: DollarSign, color: teal[700], bg: teal[50] },
        { label: 'Accumulated Depreciation', value: formatCurrency(totals.accumulatedDepreciation, currency), icon: AlertTriangle, color: amber[600], bg: amber[100] },
        { label: 'Net Book Value', value: formatCurrency(totals.bookValue, currency), icon: FileText, color: teal[700], bg: teal[50] },
    ];

    return (
        <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            <PageHeader
                icon={<Building2 size={19} color="#fff" />}
                title="Fixed Assets"
                subtitle="Asset register — acquisition, depreciation & disposal"
                actions={<>
                    <button
                        onClick={() => setIsDepreciateModalOpen(true)}
                        style={btnGhostStyle}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                    >
                        <Percent size={15} />
                        Run Depreciation
                    </button>
                    <button
                        onClick={exportToCSV}
                        style={btnGhostStyle}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                    >
                        <Download size={15} />
                        Export
                    </button>
                    {canEdit && (
                        <button
                            onClick={() => setIsAddModalOpen(true)}
                            style={btnPrimaryStyle}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                        >
                            <Plus size={15} />
                            Add Asset
                        </button>
                    )}
                </>}
            />

            <KpiCards items={kpis} />

            {/* Filters */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                    <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search assets..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ ...inputStyle, paddingLeft: 34 }}
                    />
                </div>
                <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value as FixedAssetCategory | 'All')}
                    style={{ ...selectStyle, width: 200 }}
                >
                    <option value="All">All Categories</option>
                    {Object.entries(ASSET_CATEGORY_INFO).map(([key, info]) => (
                        <option key={key} value={key}>{info.label}</option>
                    ))}
                </select>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as FixedAssetStatus | 'All')}
                    style={{ ...selectStyle, width: 200 }}
                >
                    <option value="All">All Status</option>
                    {Object.entries(STATUS_COLORS).map(([key, info]) => (
                        <option key={key} value={key}>{info.label}</option>
                    ))}
                </select>
            </div>

            {/* Asset Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
                        <Loader2 size={24} className="animate-spin" style={{ color: teal[500] }} />
                    </div>
                ) : filteredAssets.length === 0 ? (
                    <EmptyState icon={<Package size={32} />} title="No fixed assets found" hint="Add an asset to start building the register." />
                ) : (
                    <div style={tableCard}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={tableHeadRow}>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Asset</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Category</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Status</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Acquisition Cost</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Accumulated Deprec.</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Book Value</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredAssets.map(asset => (
                                    <tr key={asset.id}
                                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                    >
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <div style={{
                                                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                                    background: teal[100], color: teal[700],
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: 13, fontWeight: 700
                                                }}>
                                                    {(asset.name || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <div>
                                                    <p style={{ fontWeight: 600, fontSize: 13, color: ink, margin: 0 }}>{asset.name}</p>
                                                    <p style={{ fontSize: 11, color: inkSoft, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{asset.asset_code}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: ink }}>
                                                {ASSET_CATEGORY_INFO[asset.category]?.icon}
                                                {ASSET_CATEGORY_INFO[asset.category]?.label || asset.category}
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <span
                                                style={{
                                                    padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20,
                                                    background: STATUS_COLORS[asset.status]?.bg,
                                                    color: STATUS_COLORS[asset.status]?.text
                                                }}
                                            >
                                                {STATUS_COLORS[asset.status]?.label || asset.status}
                                            </span>
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: ink, fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(asset.acquisition_cost, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: amber[600], fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(asset.accumulated_depreciation, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: teal[700], fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(asset.current_book_value, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                                <button
                                                    onClick={() => handleViewDetails(asset)}
                                                    style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                    title="View Details"
                                                    onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                >
                                                    <Eye size={16} style={{ color: inkSoft }} />
                                                </button>
                                                {asset.status === 'active' && canEdit && (
                                                    <>
                                                        <button
                                                            onClick={() => {
                                                                setSelectedAsset(asset);
                                                                setIsDepreciateModalOpen(true);
                                                            }}
                                                            style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                            title="Post Depreciation"
                                                            onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <Percent size={16} style={{ color: inkSoft }} />
                                                        </button>
                                                        <button
                                                            onClick={() => {
                                                                setSelectedAsset(asset);
                                                                setIsDisposeModalOpen(true);
                                                            }}
                                                            style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                            title="Dispose"
                                                            onMouseEnter={e => e.currentTarget.style.background = '#fdeeee'}
                                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <Trash2 size={16} style={{ color: danger }} />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add Asset Modal */}
            {isAddModalOpen && (
                <AddAssetModal
                    accounts={accounts}
                    onClose={() => setIsAddModalOpen(false)}
                    onSubmit={handleAddAsset}
                    currency={currency}
                />
            )}

            {/* Asset Details Modal */}
            {selectedAsset && !isDepreciateModalOpen && !isDisposeModalOpen && (
                <AssetDetailsModal
                    asset={selectedAsset}
                    depreciationEntries={depreciationEntries}
                    onClose={() => setSelectedAsset(null)}
                    currency={currency}
                />
            )}

            {/* Depreciation Modal */}
            {isDepreciateModalOpen && (
                <DepreciationModal
                    assets={assets}
                    selectedAsset={selectedAsset}
                    onClose={() => { setIsDepreciateModalOpen(false); setSelectedAsset(null); }}
                    onDepreciate={(assetId, year, month) => handleDepreciate(assetId, year, month)}
                    onDepreciateAll={(year, month) => handleDepreciateAll(year, month)}
                />
            )}

            {/* Dispose Modal */}
            {isDisposeModalOpen && selectedAsset && (
                <DisposeAssetModal
                    asset={selectedAsset}
                    onClose={() => { setIsDisposeModalOpen(false); setSelectedAsset(null); }}
                    onDispose={(proceeds, reason) => handleDispose(selectedAsset.id, proceeds, reason)}
                    currency={currency}
                />
            )}
        </div>
    );
};

interface AddAssetModalProps {
    accounts: any[];
    onClose: () => void;
    onSubmit: (data: any) => void;
    currency: string;
}

const AddAssetModal: React.FC<AddAssetModalProps> = ({ accounts, onClose, onSubmit, currency }) => {
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        category: 'motor_vehicle' as FixedAssetCategory,
        acquisition_date: getDefaultDate(),
        acquisition_cost: '',
        salvage_value: '0',
        useful_life_years: '5',
        depreciation_method: 'straight_line' as const,
        location: '',
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({
            ...formData,
            acquisition_cost: parseFloat(formData.acquisition_cost),
            salvage_value: parseFloat(formData.salvage_value),
            useful_life_years: parseInt(formData.useful_life_years),
            status: 'active' as FixedAssetStatus,
        });
    };

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(600)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Building2 size={19} color="#fff" />}
                    title="Add Fixed Asset"
                    subtitle="New asset record — Fixed asset register"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <form id="add-asset-form" onSubmit={handleSubmit}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                            <div style={{ gridColumn: '1 / -1' }}>
                                <label style={labelStyle}>Asset Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    placeholder="e.g. Delivery Truck"
                                    style={inputStyle}
                                />
                            </div>
                            <div style={{ gridColumn: '1 / -1' }}>
                                <label style={labelStyle}>Category</label>
                                <select
                                    value={formData.category}
                                    onChange={(e) => setFormData({ ...formData, category: e.target.value as FixedAssetCategory })}
                                    style={selectStyle}
                                >
                                    {Object.entries(ASSET_CATEGORY_INFO).map(([key, info]) => (
                                        <option key={key} value={key}>{info.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Acquisition Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="date"
                                    required
                                    value={formData.acquisition_date}
                                    onChange={(e) => setFormData({ ...formData, acquisition_date: e.target.value })}
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Acquisition Cost <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                    <input
                                        type="number"
                                        required
                                        min="0"
                                        step="0.01"
                                        value={formData.acquisition_cost}
                                        onChange={(e) => setFormData({ ...formData, acquisition_cost: e.target.value })}
                                        placeholder="0.00"
                                        style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                            </div>
                            <div>
                                <label style={labelStyle}>Salvage Value</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={formData.salvage_value}
                                        onChange={(e) => setFormData({ ...formData, salvage_value: e.target.value })}
                                        placeholder="0.00"
                                        style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                            </div>
                            <div>
                                <label style={labelStyle}>Useful Life (Years) <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="number"
                                    required
                                    min="1"
                                    value={formData.useful_life_years}
                                    onChange={(e) => setFormData({ ...formData, useful_life_years: e.target.value })}
                                    placeholder="e.g. 5"
                                    style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                />
                            </div>
                        </div>
                        <div style={sectionLabelStyle}><span>Depreciation & Location</span></div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                            <div>
                                <label style={labelStyle}>Depreciation Method</label>
                                <select
                                    value={formData.depreciation_method}
                                    onChange={(e) => setFormData({ ...formData, depreciation_method: e.target.value as any })}
                                    style={selectStyle}
                                >
                                    <option value="straight_line">Straight Line</option>
                                    <option value="declining_balance">Declining Balance</option>
                                    <option value="sum_of_years">Sum of Years Digits</option>
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>
                                    Location
                                    <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                                </label>
                                <input
                                    type="text"
                                    value={formData.location}
                                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                                    placeholder="Physical location"
                                    style={inputStyle}
                                />
                            </div>
                        </div>
                    </form>
                </div>
                <ModalFooter stepLabel="New asset · Fixed asset register" onCancel={onClose} submitLabel="Add Asset" submitFormId="add-asset-form" />
            </div>
        </div>
    );
};

interface AssetDetailsModalProps {
    asset: FixedAsset;
    depreciationEntries: DepreciationEntry[];
    onClose: () => void;
    currency: string;
}

const AssetDetailsModal: React.FC<AssetDetailsModalProps> = ({ asset, depreciationEntries, onClose, currency }) => {
    const categoryInfo = ASSET_CATEGORY_INFO[asset.category];
    const statusInfo = STATUS_COLORS[asset.status];

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(760)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Eye size={19} color="#fff" />}
                    title="Asset Details"
                    subtitle={`${asset.name} · ${asset.asset_code}`}
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px', overflowY: 'auto' }}>
                    <div style={{
                        padding: 14, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                    }}>
                        <div style={{ padding: 10, borderRadius: 10, background: teal[100], color: teal[700], display: 'inline-flex' }}>
                            {categoryInfo?.icon}
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: ink }}>{asset.name}</div>
                            <div style={{ fontSize: 11.5, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{asset.asset_code} · {categoryInfo?.label}</div>
                        </div>
                        <span style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, background: statusInfo?.bg, color: statusInfo?.text }}>
                            {statusInfo?.label}
                        </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                        <div>
                            <div style={sectionLabelStyle}><span>Asset Information</span></div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Category</span>
                                    <span style={{ color: ink, fontWeight: 600 }}>{categoryInfo?.label}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Acquisition Date</span>
                                    <span style={{ color: ink }}>{asset.acquisition_date}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Useful Life</span>
                                    <span style={{ color: ink }}>{asset.useful_life_years} years</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Depreciation Method</span>
                                    <span style={{ color: ink, textTransform: 'capitalize' }}>{asset.depreciation_method.replace('_', ' ')}</span>
                                </div>
                                {asset.location && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                        <span style={{ color: inkSoft }}>Location</span>
                                        <span style={{ color: ink }}>{asset.location}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div>
                            <div style={sectionLabelStyle}><span>Financial Information</span></div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Acquisition Cost</span>
                                    <span style={{ color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(asset.acquisition_cost, currency)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Salvage Value</span>
                                    <span style={{ color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(asset.salvage_value, currency)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Accumulated Deprec.</span>
                                    <span style={{ color: amber[600], fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                                        {formatCurrency(depreciationEntries.reduce((s, e) => s + e.depreciation_amount, 0), currency)}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ color: inkSoft }}>Book Value</span>
                                    <span style={{ color: teal[700], fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                                        {formatCurrency(asset.acquisition_cost - depreciationEntries.reduce((s, e) => s + e.depreciation_amount, 0), currency)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {depreciationEntries.length > 0 ? (
                        <div style={{ marginTop: 20 }}>
                            <div style={sectionLabelStyle}><span>Depreciation History</span></div>
                            <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                    <thead>
                                        <tr style={tableHeadRow}>
                                            <th style={{ padding: '10px 14px', fontWeight: 700 }}>Period</th>
                                            <th style={{ padding: '10px 14px', fontWeight: 700, textAlign: 'right' }}>Depreciation</th>
                                            <th style={{ padding: '10px 14px', fontWeight: 700, textAlign: 'right' }}>Accumulated</th>
                                            <th style={{ padding: '10px 14px', fontWeight: 700, textAlign: 'right' }}>Book Value</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {depreciationEntries.map(entry => (
                                            <tr key={entry.id} style={{ borderTop: `1px solid ${hairline}` }}
                                                onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                            >
                                                <td style={{ padding: '9px 14px', fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}>
                                                    {entry.period_year}-{String(entry.period_month).padStart(2, '0')}
                                                </td>
                                                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: ink, fontVariantNumeric: 'tabular-nums' }}>
                                                    {formatCurrency(entry.depreciation_amount, currency)}
                                                </td>
                                                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: inkSoft, fontVariantNumeric: 'tabular-nums' }}>
                                                    {formatCurrency(entry.accumulated_depreciation, currency)}
                                                </td>
                                                <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: teal[700], fontVariantNumeric: 'tabular-nums' }}>
                                                    {formatCurrency(entry.book_value, currency)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ) : (
                        <div style={{ marginTop: 20 }}>
                            <EmptyState icon={<FileText size={28} />} title="No depreciation posted yet" hint="Run depreciation to build history for this asset." />
                        </div>
                    )}
                </div>
                <ModalFooter stepLabel="Asset · register detail" onCancel={onClose} submitLabel="Done" onSubmit={onClose} />
            </div>
        </div>
    );
};

interface DepreciationModalProps {
    assets: FixedAsset[];
    selectedAsset: FixedAsset | null;
    onClose: () => void;
    onDepreciate: (assetId: string, year: number, month: number) => void;
    onDepreciateAll: (year: number, month: number) => void;
}

const DepreciationModal: React.FC<DepreciationModalProps> = ({ assets, selectedAsset, onClose, onDepreciate, onDepreciateAll }) => {
    const now = new Date();
    const [year, setYear] = useState(now.getFullYear());
    const [month, setMonth] = useState(now.getMonth() + 1);

    const activeAssets = assets.filter(a => a.status === 'active');

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Percent size={19} color="#fff" />}
                    title="Run Depreciation"
                    subtitle={selectedAsset ? `Single asset · ${selectedAsset.name}` : `Bulk run · ${activeAssets.length} active assets`}
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                            <label style={labelStyle}>Year</label>
                            <select
                                value={year}
                                onChange={(e) => setYear(parseInt(e.target.value))}
                                style={selectStyle}
                            >
                                {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
                                    <option key={y} value={y}>{y}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label style={labelStyle}>Month</label>
                            <select
                                value={month}
                                onChange={(e) => setMonth(parseInt(e.target.value))}
                                style={selectStyle}
                            >
                                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                                    <option key={m} value={m}>{new Date(year, m - 1).toLocaleString('default', { month: 'long' })}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {selectedAsset && (
                        <div style={{
                            padding: 14, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                        }}>
                            <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[700] }}>
                                <Building2 size={18} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: ink }}>{selectedAsset.name}</div>
                                <div style={{ fontSize: 11.5, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{selectedAsset.asset_code}</div>
                            </div>
                        </div>
                    )}

                    <div style={{
                        padding: 12, background: paper, borderRadius: 9, border: `1px solid ${hairline}`,
                        fontSize: 12.5, color: inkSoft, marginBottom: 18
                    }}>
                        {selectedAsset
                            ? `Post depreciation for ${selectedAsset.name}`
                            : `Post depreciation for ${activeAssets.length} active assets`
                        }
                    </div>
                </div>
                <ModalFooter
                    stepLabel="Depreciation · posts to ledger"
                    onCancel={onClose}
                    submitLabel="Post Depreciation"
                    onSubmit={() => {
                        if (selectedAsset) {
                            onDepreciate(selectedAsset.id, year, month);
                        } else {
                            onDepreciateAll(year, month);
                        }
                    }}
                />
            </div>
        </div>
    );
};

interface DisposeAssetModalProps {
    asset: FixedAsset;
    onClose: () => void;
    onDispose: (proceeds: number, reason: string) => void;
    currency: string;
}

const DisposeAssetModal: React.FC<DisposeAssetModalProps> = ({ asset, onClose, onDispose, currency }) => {
    const [proceeds, setProceeds] = useState('0');
    const [reason, setReason] = useState('');

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Trash2 size={19} color="#fff" />}
                    title="Dispose Asset"
                    subtitle="Gain / loss will be posted to the ledger"
                    onClose={onClose}
                    dangerTile
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <div style={{
                        padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                    }}>
                        <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                            <Building2 size={18} />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: ink }}>{asset.name}</div>
                            <div style={{ fontSize: 11.5, color: inkSoft, fontWeight: 500 }}>
                                Original Cost: <b style={{ fontFamily: "'JetBrains Mono', monospace" }}>{formatCurrency(asset.acquisition_cost, currency)}</b>
                            </div>
                        </div>
                    </div>

                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Disposal Proceeds</label>
                        <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={proceeds}
                                onChange={(e) => setProceeds(e.target.value)}
                                placeholder="0.00"
                                style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                            />
                        </div>
                    </div>

                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Reason for Disposal <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                        <textarea
                            required
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="e.g. Sold, scrapped, donated…"
                            style={textareaStyle}
                        />
                    </div>
                </div>
                <ModalFooter
                    stepLabel="Disposal · posts gain / loss"
                    onCancel={onClose}
                    submitLabel="Dispose Asset"
                    onSubmit={() => onDispose(parseFloat(proceeds), reason)}
                    danger
                />
            </div>
        </div>
    );
};

export default FixedAssets;
