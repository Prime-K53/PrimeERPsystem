import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Filter, Download, Truck, Monitor, Building2, Chair,
    Wrench, Package, Trash2, Edit2, Eye, X, CheckCircle, AlertTriangle,
    Calendar, DollarSign, Percent, ChevronDown, ChevronRight, FileText,
    RefreshCw, Loader2
} from 'lucide-react';
import { fixedAssetService } from '../../services/fixedAssetService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { FixedAsset, FixedAssetCategory, FixedAssetStatus, DepreciationEntry } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';

const ASSET_CATEGORY_INFO: Record<FixedAssetCategory, { label: string; icon: React.ReactNode; accounts: string[] }> = {
    motor_vehicle: { label: 'Motor Vehicle', icon: <Truck size={16} />, accounts: ['12100'] },
    furniture: { label: 'Furniture & Fixtures', icon: <Chair size={16} />, accounts: ['12200'] },
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

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const assets = '#1f8577';

const FixedAssets: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();

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

    return (
        <div className="flex flex-col h-full" style={{ background: paper }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div>
                    <h1 className="text-lg font-semibold" style={{ color: ink }}>Fixed Assets</h1>
                    <p className="text-sm" style={{ color: inkSoft }}>Manage your organization's fixed asset register</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setIsDepreciateModalOpen(true)}
                        className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border transition-colors"
                        style={{ borderColor: hairline, color: ink }}
                    >
                        <Percent size={16} />
                        Run Depreciation
                    </button>
                    {canEdit && (
                        <button
                            onClick={() => setIsAddModalOpen(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white transition-colors"
                            style={{ background: assets }}
                        >
                            <Plus size={16} />
                            Add Asset
                        </button>
                    )}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4 px-6 py-4">
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <DollarSign size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Acquisition Cost</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: ink }}>
                        {formatCurrency(totals.acquisitionCost)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Accumulated Depreciation</span>
                    </div>
                    <span className="text-xl font-semibold text-amber-600">
                        {formatCurrency(totals.accumulatedDepreciation)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <FileText size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Net Book Value</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: assets }}>
                        {formatCurrency(totals.bookValue)}
                    </span>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b" style={{ borderColor: hairline }}>
                <div className="flex-1 relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search assets..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border outline-none"
                        style={{ borderColor: hairline }}
                    />
                </div>
                <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value as FixedAssetCategory | 'All')}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="All">All Categories</option>
                    {Object.entries(ASSET_CATEGORY_INFO).map(([key, info]) => (
                        <option key={key} value={key}>{info.label}</option>
                    ))}
                </select>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as FixedAssetStatus | 'All')}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="All">All Status</option>
                    {Object.entries(STATUS_COLORS).map(([key, info]) => (
                        <option key={key} value={key}>{info.label}</option>
                    ))}
                </select>
                <button
                    onClick={exportToCSV}
                    className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors"
                    style={{ borderColor: hairline, color: ink }}
                >
                    <Download size={16} />
                    Export
                </button>
            </div>

            {/* Asset Table */}
            <div className="flex-1 overflow-auto px-6 py-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin" style={{ color: assets }} />
                    </div>
                ) : filteredAssets.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64" style={{ color: inkSoft }}>
                        <Package size={48} className="mb-4 opacity-50" />
                        <p>No fixed assets found</p>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="text-left text-xs" style={{ color: inkSoft }}>
                                <th className="pb-3 font-medium">Asset</th>
                                <th className="pb-3 font-medium">Category</th>
                                <th className="pb-3 font-medium">Status</th>
                                <th className="pb-3 font-medium text-right">Acquisition Cost</th>
                                <th className="pb-3 font-medium text-right">Accumulated Deprec.</th>
                                <th className="pb-3 font-medium text-right">Book Value</th>
                                <th className="pb-3 font-medium text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredAssets.map(asset => (
                                <tr key={asset.id} className="border-t" style={{ borderColor: hairline }}>
                                    <td className="py-3">
                                        <div>
                                            <p className="font-medium text-sm" style={{ color: ink }}>{asset.name}</p>
                                            <p className="text-xs" style={{ color: inkSoft }}>{asset.asset_code}</p>
                                        </div>
                                    </td>
                                    <td className="py-3">
                                        <div className="flex items-center gap-2 text-sm" style={{ color: ink }}>
                                            {ASSET_CATEGORY_INFO[asset.category]?.icon}
                                            {ASSET_CATEGORY_INFO[asset.category]?.label || asset.category}
                                        </div>
                                    </td>
                                    <td className="py-3">
                                        <span
                                            className="px-2 py-1 text-xs rounded-full"
                                            style={{
                                                background: STATUS_COLORS[asset.status]?.bg,
                                                color: STATUS_COLORS[asset.status]?.text
                                            }}
                                        >
                                            {STATUS_COLORS[asset.status]?.label || asset.status}
                                        </span>
                                    </td>
                                    <td className="py-3 text-sm text-right font-mono" style={{ color: ink }}>
                                        {formatCurrency(asset.acquisition_cost)}
                                    </td>
                                    <td className="py-3 text-sm text-right font-mono text-amber-600">
                                        {formatCurrency(asset.accumulated_depreciation)}
                                    </td>
                                    <td className="py-3 text-sm text-right font-mono" style={{ color: assets }}>
                                        {formatCurrency(asset.current_book_value)}
                                    </td>
                                    <td className="py-3">
                                        <div className="flex items-center justify-center gap-2">
                                            <button
                                                onClick={() => handleViewDetails(asset)}
                                                className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                                                title="View Details"
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
                                                        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                                                        title="Post Depreciation"
                                                    >
                                                        <Percent size={16} style={{ color: inkSoft }} />
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setSelectedAsset(asset);
                                                            setIsDisposeModalOpen(true);
                                                        }}
                                                        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                                                        title="Dispose"
                                                    >
                                                        <Trash2 size={16} style={{ color: '#dc2626' }} />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Add Asset Modal */}
            {isAddModalOpen && (
                <AddAssetModal
                    accounts={accounts}
                    onClose={() => setIsAddModalOpen(false)}
                    onSubmit={handleAddAsset}
                />
            )}

            {/* Asset Details Modal */}
            {selectedAsset && !isDepreciateModalOpen && !isDisposeModalOpen && (
                <AssetDetailsModal
                    asset={selectedAsset}
                    depreciationEntries={depreciationEntries}
                    onClose={() => setSelectedAsset(null)}
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
                />
            )}
        </div>
    );
};

interface AddAssetModalProps {
    accounts: any[];
    onClose: () => void;
    onSubmit: (data: any) => void;
}

const AddAssetModal: React.FC<AddAssetModalProps> = ({ accounts, onClose, onSubmit }) => {
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-lg mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Add Fixed Asset</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Asset Name</label>
                        <input
                            type="text"
                            required
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Category</label>
                        <select
                            value={formData.category}
                            onChange={(e) => setFormData({ ...formData, category: e.target.value as FixedAssetCategory })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        >
                            {Object.entries(ASSET_CATEGORY_INFO).map(([key, info]) => (
                                <option key={key} value={key}>{info.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Acquisition Date</label>
                            <input
                                type="date"
                                required
                                value={formData.acquisition_date}
                                onChange={(e) => setFormData({ ...formData, acquisition_date: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Acquisition Cost</label>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.acquisition_cost}
                                onChange={(e) => setFormData({ ...formData, acquisition_cost: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Salvage Value</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={formData.salvage_value}
                                onChange={(e) => setFormData({ ...formData, salvage_value: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Useful Life (Years)</label>
                            <input
                                type="number"
                                required
                                min="1"
                                value={formData.useful_life_years}
                                onChange={(e) => setFormData({ ...formData, useful_life_years: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Depreciation Method</label>
                        <select
                            value={formData.depreciation_method}
                            onChange={(e) => setFormData({ ...formData, depreciation_method: e.target.value as any })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        >
                            <option value="straight_line">Straight Line</option>
                            <option value="declining_balance">Declining Balance</option>
                            <option value="sum_of_years">Sum of Years Digits</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Location</label>
                        <input
                            type="text"
                            value={formData.location}
                            onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: assets }}>
                            Add Asset
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

interface AssetDetailsModalProps {
    asset: FixedAsset;
    depreciationEntries: DepreciationEntry[];
    onClose: () => void;
}

const AssetDetailsModal: React.FC<AssetDetailsModalProps> = ({ asset, depreciationEntries, onClose }) => {
    const categoryInfo = ASSET_CATEGORY_INFO[asset.category];
    const statusInfo = STATUS_COLORS[asset.status];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-2xl mx-4 shadow-xl max-h-[90vh] overflow-auto">
                <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Asset Details</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <div className="p-6">
                    <div className="flex items-center gap-4 mb-6">
                        <div className="p-3 rounded-lg" style={{ background: '#f3f4f6' }}>
                            {categoryInfo?.icon}
                        </div>
                        <div>
                            <h3 className="text-xl font-semibold" style={{ color: ink }}>{asset.name}</h3>
                            <p className="text-sm" style={{ color: inkSoft }}>{asset.asset_code}</p>
                        </div>
                        <span
                            className="ml-auto px-3 py-1 text-sm rounded-full"
                            style={{ background: statusInfo?.bg, color: statusInfo?.text }}
                        >
                            {statusInfo?.label}
                        </span>
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <h4 className="text-sm font-medium mb-3" style={{ color: inkSoft }}>Asset Information</h4>
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Category</span>
                                    <span style={{ color: ink }}>{categoryInfo?.label}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Acquisition Date</span>
                                    <span style={{ color: ink }}>{asset.acquisition_date}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Useful Life</span>
                                    <span style={{ color: ink }}>{asset.useful_life_years} years</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Depreciation Method</span>
                                    <span style={{ color: ink }} className="capitalize">{asset.depreciation_method.replace('_', ' ')}</span>
                                </div>
                                {asset.location && (
                                    <div className="flex justify-between text-sm">
                                        <span style={{ color: inkSoft }}>Location</span>
                                        <span style={{ color: ink }}>{asset.location}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div>
                            <h4 className="text-sm font-medium mb-3" style={{ color: inkSoft }}>Financial Information</h4>
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Acquisition Cost</span>
                                    <span className="font-mono" style={{ color: ink }}>{formatCurrency(asset.acquisition_cost)}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Salvage Value</span>
                                    <span className="font-mono" style={{ color: ink }}>{formatCurrency(asset.salvage_value)}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Accumulated Deprec.</span>
                                    <span className="font-mono text-amber-600">
                                        {formatCurrency(depreciationEntries.reduce((s, e) => s + e.depreciation_amount, 0))}
                                    </span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span style={{ color: inkSoft }}>Book Value</span>
                                    <span className="font-mono font-semibold" style={{ color: assets }}>
                                        {formatCurrency(asset.acquisition_cost - depreciationEntries.reduce((s, e) => s + e.depreciation_amount, 0))}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {depreciationEntries.length > 0 && (
                        <div className="mt-6">
                            <h4 className="text-sm font-medium mb-3" style={{ color: inkSoft }}>Depreciation History</h4>
                            <table className="w-full">
                                <thead>
                                    <tr className="text-left text-xs" style={{ color: inkSoft }}>
                                        <th className="pb-2">Period</th>
                                        <th className="pb-2 text-right">Depreciation</th>
                                        <th className="pb-2 text-right">Accumulated</th>
                                        <th className="pb-2 text-right">Book Value</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {depreciationEntries.map(entry => (
                                        <tr key={entry.id} className="border-t" style={{ borderColor: hairline }}>
                                            <td className="py-2 text-sm" style={{ color: ink }}>
                                                {entry.period_year}-{String(entry.period_month).padStart(2, '0')}
                                            </td>
                                            <td className="py-2 text-sm text-right font-mono" style={{ color: ink }}>
                                                {formatCurrency(entry.depreciation_amount)}
                                            </td>
                                            <td className="py-2 text-sm text-right font-mono" style={{ color: inkSoft }}>
                                                {formatCurrency(entry.accumulated_depreciation)}
                                            </td>
                                            <td className="py-2 text-sm text-right font-mono" style={{ color: assets }}>
                                                {formatCurrency(entry.book_value)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Run Depreciation</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Year</label>
                            <select
                                value={year}
                                onChange={(e) => setYear(parseInt(e.target.value))}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            >
                                {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
                                    <option key={y} value={y}>{y}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Month</label>
                            <select
                                value={month}
                                onChange={(e) => setMonth(parseInt(e.target.value))}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            >
                                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                                    <option key={m} value={m}>{new Date(year, m - 1).toLocaleString('default', { month: 'long' })}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {selectedAsset && (
                        <div className="p-3 rounded-lg border" style={{ borderColor: hairline }}>
                            <p className="text-sm font-medium" style={{ color: ink }}>{selectedAsset.name}</p>
                            <p className="text-xs" style={{ color: inkSoft }}>{selectedAsset.asset_code}</p>
                        </div>
                    )}

                    <div className="pt-2">
                        <p className="text-sm mb-3" style={{ color: inkSoft }}>
                            {selectedAsset
                                ? `Post depreciation for ${selectedAsset.name}`
                                : `Post depreciation for ${activeAssets.length} active assets`
                            }
                        </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                if (selectedAsset) {
                                    onDepreciate(selectedAsset.id, year, month);
                                } else {
                                    onDepreciateAll(year, month);
                                }
                            }}
                            className="px-4 py-2 text-sm rounded-lg text-white"
                            style={{ background: assets }}
                        >
                            Post Depreciation
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface DisposeAssetModalProps {
    asset: FixedAsset;
    onClose: () => void;
    onDispose: (proceeds: number, reason: string) => void;
}

const DisposeAssetModal: React.FC<DisposeAssetModalProps> = ({ asset, onClose, onDispose }) => {
    const [proceeds, setProceeds] = useState('0');
    const [reason, setReason] = useState('');

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Dispose Asset</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <div className="p-3 rounded-lg border" style={{ borderColor: hairline, background: '#fef3c7' }}>
                        <p className="text-sm font-medium" style={{ color: '#92400e' }}>{asset.name}</p>
                        <p className="text-xs" style={{ color: '#92400e' }}>Original Cost: {formatCurrency(asset.acquisition_cost)}</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Disposal Proceeds</label>
                        <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={proceeds}
                            onChange={(e) => setProceeds(e.target.value)}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Reason for Disposal</label>
                        <textarea
                            required
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none resize-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button
                            onClick={() => onDispose(parseFloat(proceeds), reason)}
                            className="px-4 py-2 text-sm rounded-lg text-white"
                            style={{ background: '#dc2626' }}
                        >
                            Dispose Asset
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FixedAssets;
