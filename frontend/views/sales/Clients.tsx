import React, { useState, useMemo, useEffect } from 'react';
import {
  Search, Plus, Filter, Download, Phone,
  ChevronRight, User, School, Building2, Landmark,
  Trash2, Edit, Edit2, ExternalLink, MoreVertical,
  DollarSign, Clock, CheckCircle, AlertCircle, TrendingUp, AlertTriangle, FileText, Target,
  Mail, Eye, Send, Wallet, BookOpen, Printer, LayoutGrid,
  AlertTriangle as AlertIcon, MapPin,
  Grid, List, MessageSquare, Phone as PhoneIcon, Send as SendIcon
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSales } from '../../context/SalesContext';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { Customer, Invoice, CustomerPayment } from '../../types';
import { usePagination } from '../../hooks/usePagination';
import Pagination from '../../components/Pagination';
import { ClientModal } from './components/ClientModal';
import { CustomerCard } from './components/CustomerCard';
import { CustomerWorkspace } from './components/CustomerWorkspace';
import { isAfter, parseISO, subDays, format } from 'date-fns';
import { exportToCSV } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';
import { CustomerSearch } from '../../components/CustomerSearch';
import { ConfirmDialog, ConfirmDialogType } from '../../components/ConfirmDialog';
import { getFloatingMenuStyle } from '../../utils/actionMenu';
import { buildLedgerFromRecords } from '../../services/customerLedger';

const teal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a'
};
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

const pageWrapper: React.CSSProperties = {
  background: paper,
  fontFamily: "'Inter','DM Sans',sans-serif",
  fontSize: 13.5,
  color: ink,
  minHeight: '100vh',
  padding: '12px 12px 32px'
};
// Mobile-first: sm: 16px 24px, md: 16px 24px
const pageWrapperResponsive = `${pageWrapper}`; // Base mobile, use Tailwind classes on container

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: teal[800],
  marginBottom: 6,
  letterSpacing: 0.01,
  display: 'block'
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: "'Inter', sans-serif",
  fontSize: 13.5,
  color: ink,
  background: paper,
  border: '1.4px solid #e4ddd1',
  borderRadius: 9,
  padding: '9px 12px',
  outline: 'none',
  transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease'
};

const btnPrimary: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
  padding: '9px 18px', borderRadius: 9, cursor: 'pointer', border: '1.4px solid transparent',
  background: 'linear-gradient(155deg, #1f8577, #0f544c)',
  color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 7,
  boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
  transition: 'all .15s ease'
};

const btnGhost: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
  padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
  background: paper, border: '1.4px solid #e4ddd1', color: inkSoft,
  display: 'inline-flex', alignItems: 'center', gap: 7, transition: 'all .15s ease'
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 30,
  cursor: 'pointer'
};

const menuItemStyle: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8,
  color: ink, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', width: '100%', transition: 'background .15s'
};

const AVATAR_PALETTE = [
  { bg: '#dff1ec', text: '#146b60' },
  { bg: '#fbead0', text: '#a8711f' },
  { bg: '#e6ecf8', text: '#3b5b9b' },
  { bg: '#f3e8f7', text: '#7c3aed' },
  { bg: '#fde8e8', text: '#b5493f' },
  { bg: '#e8f3ea', text: '#15803d' },
];

const getInitials = (name: string) =>
  (name || '?').trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

const avatarPaletteFor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
};

const relativeDate = (iso: string) => {
  const date = parseISO(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return format(date, 'MMM dd, yyyy');
};

export const Clients: React.FC = () => {
  const { customers, addCustomer, updateCustomer, deleteCustomer, isLoading, customerPayments } = useSales();
  const { invoices } = useFinance();
  const { companyConfig } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSegmentModalOpen, setIsSegmentModalOpen] = useState(false);
  const [pendingSegment, setPendingSegment] = useState<string | undefined>();
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | undefined>();
  const [selectedWorkspaceCustomer, setSelectedWorkspaceCustomer] = useState<Customer | null>(null);
  const [selectedCardCustomer, setSelectedCardCustomer] = useState<Customer | null>(null);
  const [filterStatus, setFilterStatus] = useState<'All' | 'Active' | 'Inactive' | 'Lead'>('All');
  const [selectedMetric, setSelectedMetric] = useState<'All' | 'Overdue' | 'Open' | 'Paid'>('All');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);

  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; confirmText?: string; type?: ConfirmDialogType; onConfirm?: () => void }>({ open: false, title: '', message: '' });

  const [balanceRange, setBalanceRange] = useState<string>('Any Balance');
  const [customerSegment, setCustomerSegment] = useState<string>('All Segments');
  const [pipelineStageFilter, setPipelineStageFilter] = useState<string>('All Stages');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      setActiveMenuId(null);
      // Close advanced filters when clicking outside the filter area
      const target = e.target as HTMLElement;
      if (!target.closest('#advanced-filters-wrapper')) {
        setShowAdvancedFilters(false);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(() => {
    if (location.state?.action === 'create') {
      handleAddNew();
      window.history.replaceState({}, document.title);
    } else if (location.state?.customerId) {
      const customer = customers.find(c => c.id === location.state.customerId);
      if (customer) {
        setSelectedWorkspaceCustomer(customer);
      }
      window.history.replaceState({}, document.title);
    }
  }, [location.state, customers]);

  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);

  /**
   * Running balance per customer = stored Opening Balance (customer.balance)
   * + transactional deltas (invoices debit / payments credit), computed by the
   * canonical ledger service (services/customerLedger.ts) so the list column
   * matches statements and the customer workspace.
   */
  const runningBalanceByCustomer = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of customers) {
      const custInvoices = (invoices || []).filter((inv: any) => inv.customerId === c.id || inv.customerName === c.name);
      const custPayments = (customerPayments || []).filter((p: any) => p.customerId === c.id || p.customerName === c.name);
      const { closingBalance } = buildLedgerFromRecords({
        customerId: c.id,
        invoices: custInvoices as any[],
        payments: custPayments as any[],
        openingBalance: Number(c.balance || 0),
      });
      map.set(c.id, closingBalance);
    }
    return map;
  }, [customers, invoices, customerPayments]);

  const filteredCustomers = useMemo(() => {
    // Exclude locally soft-deleted clients. Deletes are local-first: the row is
    // kept (flagged with deletedAt) until the tombstone propagates to the cloud
    // and is re-pulled. Without this filter a deleted client stays visible in
    // the list (and can reappear after a cloud pull), so it looks like the
    // delete "did nothing".
    return customers.filter(c => {
      if ((c as Customer & Record<string, unknown>).deletedAt) return false;
      const matchesSearch = (c.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.phone && c.phone.includes(searchQuery));
      const matchesStatus = filterStatus === 'All' || c.status === filterStatus;

      const matchesSegment = customerSegment === 'All Segments' || c.segment === customerSegment;
      const matchesPipelineStage = pipelineStageFilter === 'All Stages' || (c as Customer & Record<string, unknown>).pipelineStage === pipelineStageFilter;

      let matchesBalance = true;
      const balance = runningBalanceByCustomer.get(c.id) ?? Number(c.balance || 0);
      if (balanceRange === 'Over $1,000') matchesBalance = balance > 1000;
      else if (balanceRange === 'Over $5,000') matchesBalance = balance > 5000;
      else if (balanceRange === 'Over $10,000') matchesBalance = balance > 10000;
      else if (balanceRange === 'Negative (Credit)') matchesBalance = balance < 0;

      let matchesMetric = true;
      if (selectedMetric === 'Overdue') {
        const hasOverdue = invoices.some(inv =>
          inv.customerId === c.id &&
          inv.status !== 'Paid' &&
          inv.status !== 'Cancelled' &&
          isAfter(new Date(), parseISO(inv.dueDate))
        );
        matchesMetric = hasOverdue;
      } else if (selectedMetric === 'Open') {
        const hasOpen = invoices.some(inv =>
          inv.customerId === c.id &&
          (inv.status === 'Unpaid' || inv.status === 'Partial')
        );
        matchesMetric = hasOpen;
      } else if (selectedMetric === 'Paid') {
        const hasRecentPayment = customerPayments.some(r =>
          r.customerId === c.id &&
          r.status === 'Cleared' &&
          isAfter(parseISO(r.date), subDays(new Date(), 30))
        );
        matchesMetric = hasRecentPayment;
      }

      return matchesSearch && matchesStatus && matchesMetric && matchesSegment && matchesBalance && matchesPipelineStage;
    });
  }, [customers, searchQuery, filterStatus, selectedMetric, invoices, customerPayments, balanceRange, customerSegment, pipelineStageFilter, runningBalanceByCustomer]);

  const { currentItems, currentPage, maxPage, totalItems, next, prev, first, last, setItemsPerPage, itemsPerPage } = usePagination(filteredCustomers, 25);

  const handleEdit = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsModalOpen(true);
  };

  const handleAddNew = () => {
    setIsModalOpen(true);
  };

  const handleSegmentSelect = (segment: string) => {
    setPendingSegment(segment);
    setIsSegmentModalOpen(false);
    setSelectedCustomer(undefined);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    setConfirmState({
      open: true,
      title: 'Delete Client',
      message: 'Are you sure you want to delete this client?',
      type: 'danger',
      confirmText: 'Delete',
      onConfirm: async () => {
        await deleteCustomer(id);
      }
    });
  };

  const handleBatchDelete = async () => {
    setConfirmState({
      open: true,
      title: 'Delete Clients',
      message: `Are you sure you want to delete ${selectedIds.length} clients?`,
      type: 'danger',
      confirmText: 'Delete All',
      onConfirm: async () => {
        for (const id of selectedIds) {
          await deleteCustomer(id);
        }
        setSelectedIds([]);
      }
    });
  };

  const handleBatchStatusUpdate = async (status: 'Active' | 'Inactive') => {
    for (const id of selectedIds) {
      const customer = customers.find(c => c.id === id);
      if (customer) {
        await updateCustomer({ ...customer, status });
      }
    }
    setSelectedIds([]);
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredCustomers.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredCustomers.map(c => c.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleRowMenuClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    // Anchor the dropdown to the trigger button via fixed positioning so it is
    // never clipped/overlapped by the scrollable table wrapper.
    setMenuAnchor((e.currentTarget as HTMLElement)?.getBoundingClientRect() ?? null);
    setActiveMenuId(prev => (prev === id ? null : id));
  };

  if (selectedWorkspaceCustomer) {
    return (
      <>
        <CustomerWorkspace
          customer={selectedWorkspaceCustomer}
          onBack={() => setSelectedWorkspaceCustomer(null)}
          onEdit={(customer) => {
            setSelectedCustomer(customer);
            setIsModalOpen(true);
          }}
        />

       <ClientModal
          isOpen={isModalOpen}
          onClose={() => { setIsModalOpen(false); setPendingSegment(undefined); }}
          onSave={selectedCustomer ? (c) => updateCustomer(c).then(() => null) : addCustomer}
          customer={selectedCustomer}
          initialSegment={pendingSegment}
        />
      </>
    );
  }

  const getLastTransaction = (customerId: string) => {
    const customerInvoices = invoices.filter(inv => inv.customerId === customerId || inv.customerName === customers.find(c => c.id === customerId)?.name);
    if (customerInvoices.length === 0) return null;

    return customerInvoices.reduce((prev, current) =>
      isAfter(parseISO(current.date), parseISO(prev.date)) ? current : prev
    );
  };

  const fmtMoney = (v: number | undefined) =>
    `${currency}${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; text: string; border: string }> = {
      'Active': { bg: teal[100], text: teal[700], border: teal[200] },
      'Inactive': { bg: '#f5f5f4', text: inkSoft, border: hairline },
      'Lead': { bg: amber[100], text: amber[600], border: amber[300] },
      'Suspended': { bg: '#fef2f2', text: '#b5493f', border: '#f5c6c6' },
      'VIP': { bg: teal[50], text: teal[800], border: teal[200] },
      'Prospect': { bg: teal[50], text: teal[700], border: teal[200] },
      'Credit Hold': { bg: '#fef2f2', text: '#b5493f', border: '#f5c6c6' },
    };
    const s = map[status] || { bg: '#f5f5f4', text: inkSoft, border: hairline };
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: '2px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 700,
        border: `1px solid ${s.border}`, background: s.bg, color: s.text,
        letterSpacing: 0.01, whiteSpace: 'nowrap'
      }}>
        {status}
      </span>
    );
  };
  return (
    <div style={pageWrapper}>
      <style>{`
        .client-card:hover .card-quick-actions { opacity: 1 !important; pointer-events: auto !important; }
      `}</style>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{
            fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
            fontSize: 24, margin: 0, color: teal[800], letterSpacing: 0.2
          }}>
            Clients
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: inkSoft, fontWeight: 500 }}>
            {filteredCustomers.length} of {customers.length} clients
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/sales-flow/leads')} style={btnGhost}>
            <Target size={15} /> Lead Board
          </button>
          <button onClick={() => exportToCSV(customers.map(c => ({ 'Customer ID': c.id, 'Full name': c.name, 'Billing Address': c.billingAddress || c.address || '', 'Phone number': c.phone, 'Segment': c.segment, 'Shipping Address': c.shippingAddress || '', 'Opening Balance': c.balance || 0, 'Wallet Balance': c.walletBalance || 0, 'Branch Account': c.accountNumber || '' })), 'Clients')} style={btnGhost}>
            <Download size={15} /> Export
          </button>
          <button onClick={handleAddNew} style={btnPrimary}>
            <Plus size={16} /> New Client
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{
        background: paper, borderRadius: 14, border: `1px solid ${hairline}`,
        overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,.04)'
      }}>
        {/* Toolbar */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${hairline}`,
          background: '#fafaf8', flexWrap: 'wrap', gap: 10
        }}>
          {/* Search + Filters left */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 280 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
              <input type="text" placeholder="Search clients..." value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ ...inputStyle, paddingLeft: 32, fontSize: 12.5, padding: '7px 10px 7px 32px' }} />
            </div>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
              style={{ ...inputStyle, width: 'auto', padding: '7px 28px 7px 10px', fontSize: 12 }}>
              <option value="All">All Status</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Lead">Lead</option>
              <option value="Suspended">Suspended</option>
              <option value="VIP">VIP</option>
              <option value="Prospect">Prospect</option>
              <option value="Credit Hold">Credit Hold</option>
            </select>
            <select value={pipelineStageFilter} onChange={e => setPipelineStageFilter(e.target.value)}
              style={{ ...inputStyle, width: 'auto', padding: '7px 28px 7px 10px', fontSize: 12 }}>
              <option value="All Stages">All Stages</option>
              <option value="New">New</option><option value="Qualified">Qualified</option>
              <option value="Proposal">Proposal</option><option value="Negotiation">Negotiation</option>
              <option value="Won">Won</option><option value="Lost">Lost</option>
            </select>
            <div id="advanced-filters-wrapper" style={{ position: 'relative' }}>
              <button onClick={() => setShowAdvancedFilters(p => !p)}
                style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                <Filter size={13} /> Filters
              </button>
              {showAdvancedFilters && (
                <div style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', width: 240, borderRadius: 12, boxShadow: '0 20px 40px -16px rgba(0,0,0,.22)', padding: 16, zIndex: 30, background: paper, border: `1px solid ${hairline}` }}>
                  <h4 style={{ fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 12px' }}>Advanced Filters</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Balance Range</label>
                      <select value={balanceRange} onChange={e => setBalanceRange(e.target.value)} style={{ ...inputStyle, fontSize: 12 }}>
                        <option value="Any Balance">Any Balance</option>
                        <option value="Over $1,000">Over $1,000</option>
                        <option value="Over $5,000">Over $5,000</option>
                        <option value="Over $10,000">Over $10,000</option>
                        <option value="Negative (Credit)">Negative (Credit)</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Segment</label>
                      <select value={customerSegment} onChange={e => setCustomerSegment(e.target.value)} style={{ ...inputStyle, fontSize: 12 }}>
                        <option value="All Segments">All Segments</option>
                        <option value="Individual">Individual</option>
                        <option value="School Account">School Account</option>
                        <option value="Institution">Institution</option>
                        <option value="Government">Government</option>
                      </select>
                    </div>
                    <button onClick={() => { setBalanceRange('Any Balance'); setCustomerSegment('All Segments'); }}
                      style={{ ...btnGhost, width: '100%', justifyContent: 'center', fontSize: 12, padding: '6px' }}>
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Batch Actions */}
            {selectedIds.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 8, border: `1px solid ${teal[200]}`, background: teal[50], color: teal[800] }}>
                  {selectedIds.length} selected
                </span>
                <select
                  onChange={e => {
                    if (e.target.value === 'delete') handleBatchDelete();
                    else if (e.target.value === 'active') handleBatchStatusUpdate('Active');
                    else if (e.target.value === 'inactive') handleBatchStatusUpdate('Inactive');
                    e.target.value = '';
                  }}
                  style={{ ...inputStyle, width: 'auto', padding: '6px 24px 6px 10px', fontSize: 12 }}>
                  <option value="">Batch</option>
                  <option value="active">Make Active</option>
                  <option value="inactive">Make Inactive</option>
                  <option value="delete">Delete</option>
                </select>
              </div>
            )}
          </div>

          {/* View Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 3, borderRadius: 10, border: `1px solid ${hairline}`, background: paper }}>
            <button onClick={() => setViewMode('grid')}
              style={{ padding: '6px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', background: viewMode === 'grid' ? teal[600] : 'transparent', color: viewMode === 'grid' ? '#fff' : inkSoft, display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, transition: 'all .15s' }}>
              <Grid size={13} /> Grid
            </button>
            <button onClick={() => setViewMode('list')}
              style={{ padding: '6px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? teal[600] : 'transparent', color: viewMode === 'list' ? '#fff' : inkSoft, display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, transition: 'all .15s' }}>
              <List size={13} /> List
            </button>
          </div>
        </div>

        {/* GRID VIEW */}
        {viewMode === 'grid' && (
          <div style={{ padding: '16px', overflowY: 'auto', maxHeight: 'calc(100vh - 360px)' }}>
            {isLoading ? (
              <div style={{ padding: 60, textAlign: 'center', color: inkSoft }}>Loading clients...</div>
            ) : filteredCustomers.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No clients found matching your criteria.</div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 12
              }}>
                {currentItems.map(customer => {
                  const pal = avatarPaletteFor(customer.name || customer.id);
                  const openBalance = runningBalanceByCustomer.get(customer.id) ?? Number(customer.balance || 0);
                  const owing = openBalance > 0.5;
                  const lastTx = getLastTransaction(customer.id);
                  const overdue = invoices.some(inv =>
                    inv.customerId === customer.id &&
                    inv.status !== 'Paid' && inv.status !== 'Cancelled' &&
                    isAfter(new Date(), parseISO(inv.dueDate))
                  );
                  const hasOverdue = overdue;
                  return (
                    <div key={customer.id} className="client-card"
                      onClick={() => setSelectedCardCustomer(customer)}
                      style={{
                        background: paper, border: `1px solid ${hairline}`, borderRadius: 12,
                        overflow: 'hidden', cursor: 'pointer',
                        transition: 'all .18s ease',
                        position: 'relative'
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = teal[300];
                        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px -4px rgba(20,107,96,.18)';
                        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = hairline;
                        (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
                      }}>

                      {/* Teal top accent strip */}
                      <div style={{ height: 3, background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 60%, ${amber[500]} 100%)` }} />

                      {/* Card header */}
                      <div style={{ background: `linear-gradient(135deg, ${teal[800]} 0%, ${teal[600]} 100%)`, padding: '14px 14px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          {/* Avatar */}
                          <div style={{
                            width: 42, height: 42, borderRadius: 10,
                            background: 'rgba(255,255,255,0.15)',
                            border: '2px solid rgba(255,255,255,0.25)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, fontSize: 16, fontWeight: 600, color: '#fff'
                          }}>
                            {customer.name?.charAt(0)?.toUpperCase() || '?'}{customer.name?.split(' ')[1]?.charAt(0)?.toUpperCase() || ''}
                          </div>

                          {/* Name + meta */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', lineHeight: 1.25, marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {customer.name}
                            </div>
                            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.06 }}>
                              {customer.id} · {customer.segment || 'Individual'}
                            </div>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 5, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 20, padding: '2px 8px', fontSize: 9.5, color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ADE80' }} />
                              {customer.status || 'Active'}
                            </div>
                          </div>
                        </div>

                        {/* Phone + address chips */}
                        {(customer.phone || customer.address) && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                            {customer.phone && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 8px', fontSize: 10.5, color: 'rgba(255,255,255,0.85)' }}>
                                <PhoneIcon size={10} />{customer.phone}
                              </div>
                            )}
                            {customer.address && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 8px', fontSize: 10.5, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                                <MapPin size={10} />{customer.address}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Card body */}
                      <div style={{ padding: '12px 14px' }}>
                        {/* Balance + Wallet metrics */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                          <div style={{ padding: '9px 10px', borderRadius: 8, background: teal[50], border: `1px solid ${teal[100]}`, position: 'relative', overflow: 'hidden' }}>
                            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2.5, background: owing ? danger : '#059669', borderRadius: '8px 8px 0 0' }} />
                            <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.08, color: inkSoft, marginBottom: 3 }}>Outstanding</div>
                            <div style={{ fontSize: 16, fontWeight: 600, color: owing ? danger : '#059669', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
                              {owing ? fmtMoney(openBalance) : 'Paid'}
                            </div>
                          </div>
                          <div style={{ padding: '9px 10px', borderRadius: 8, background: teal[50], border: `1px solid ${teal[100]}`, position: 'relative', overflow: 'hidden' }}>
                            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2.5, background: '#059669', borderRadius: '8px 8px 0 0' }} />
                            <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.08, color: inkSoft, marginBottom: 3 }}>Wallet</div>
                            <div style={{ fontSize: 16, fontWeight: 600, color: '#059669', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
                              {fmtMoney(customer.walletBalance)}
                            </div>
                          </div>
                        </div>

                        {/* Badges: Overdue + Pipeline Stage */}
                        {(hasOverdue || (customer as Customer & Record<string, unknown>).pipelineStage) && (
                          <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
                            {hasOverdue && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 999, fontSize: 9.5, fontWeight: 700, background: '#fef2f2', color: danger, border: `1px solid ${danger}40` }}>
                                <AlertIcon size={9} /> Overdue
                              </span>
                            )}
                            {(customer as Customer & Record<string, unknown>).pipelineStage && (
                              <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 9.5, fontWeight: 700, background: teal[50], color: teal[700], border: `1px solid ${teal[200]}` }}>
                                {(customer as Customer & Record<string, unknown>).pipelineStage as string}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Quick Action Buttons */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
                          <button onClick={(e) => { e.stopPropagation(); navigate('/sales-flow/invoices', { state: { action: 'create', customer: customer.name } }); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: ink, transition: 'all .12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[100]; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[50]; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={teal[600]} strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                            Invoice
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); navigate('/sales-flow/orders', { state: { action: 'create', customer: customer.name } }); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: ink, transition: 'all .12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[100]; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[50]; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={teal[600]} strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            Quote
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); navigate('/revenue/contacts', { state: { customerId: customer.id } }); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: ink, transition: 'all .12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[100]; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[50]; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={teal[600]} strokeWidth="2"><path d="M9 17H5a2 2 0 00-2 2v1M15 17h4a2 2 0 002-2v1M12 11V3M8 7l4-4 4 4"/></svg>
                            Statement
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); if (customer.phone) window.open(`https://wa.me/${customer.phone.replace(/[^0-9]/g, '')}`, '_blank'); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: ink, transition: 'all .12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[100]; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[50]; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#25D366" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                            WhatsApp
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setSelectedWorkspaceCustomer(customer); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: '#f3e8f7', border: `1px solid #d8b4fe`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: '#7c3aed', transition: 'all .12s', gridColumn: 'span 2' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ede9fe'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f3e8f7'; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                            View Profile
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleEdit(customer); }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', background: amber[100], border: `1px solid ${amber[300]}`, borderRadius: 8, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: amber[600], transition: 'all .12s', gridColumn: 'span 2' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fde68a'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = amber[100]; }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={amber[500]} strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit Details
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* LIST VIEW */}
        {viewMode === 'list' && (
          <div className="clients-table-wrap sales-list-scroll" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 360px)' }}>
            <style>{`
              .clients-table tbody tr { transition: background .12s ease; }
              .clients-table tbody tr:hover > td { background: #f3faf8; }
              .clients-table tbody tr.selected-row > td { background: #eef7f6; }
            `}</style>
            <table className="clients-table" style={{ width: '100%', minWidth: 1080, textAlign: 'left', fontSize: 13, color: ink }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, textAlign: 'center', width: 44, background: teal[50], borderBottom: `1px solid ${hairline}` }}>
                    <input type="checkbox" style={{ width: 14, height: 14, borderRadius: 5, accentColor: teal[600], cursor: 'pointer' }}
                      checked={selectedIds.length === filteredCustomers.length && filteredCustomers.length > 0}
                      onChange={toggleSelectAll} />
                  </th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, background: teal[50], borderBottom: `1px solid ${hairline}` }}>Customer</th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, background: teal[50], borderBottom: `1px solid ${hairline}` }}>Contact</th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, background: teal[50], borderBottom: `1px solid ${hairline}` }}>Last Activity</th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, textAlign: 'right', background: teal[50], borderBottom: `1px solid ${hairline}` }}>Wallet</th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, textAlign: 'right', background: teal[50], borderBottom: `1px solid ${hairline}` }}>Outstanding</th>
                  <th style={{ position: 'sticky', top: 0, zIndex: 5, padding: '11px 14px', fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08, textAlign: 'center', width: 64, background: teal[50], borderBottom: `1px solid ${hairline}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>Loading clients...</td></tr>
                ) : filteredCustomers.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No clients found matching your criteria.</td></tr>
                ) : (
                  currentItems.map(customer => {
                    const isChecked = selectedIds.includes(customer.id);
                    const pal = avatarPaletteFor(customer.name || customer.id);
                    const lastTx = getLastTransaction(customer.id);
                    const openBalance = runningBalanceByCustomer.get(customer.id) ?? Number(customer.balance || 0);
                    const owing = openBalance > 0.5;
                    const overdue = invoices.some(inv =>
                      inv.customerId === customer.id && inv.status !== 'Paid' && inv.status !== 'Cancelled' &&
                      isAfter(new Date(), parseISO(inv.dueDate))
                    );
                    return (
                      <React.Fragment key={customer.id}>
                        <tr className={isChecked ? 'selected-row' : ''}
                          onClick={() => setSelectedCardCustomer(customer)}
                          style={{ cursor: 'pointer', background: isChecked ? teal[50] : owing ? '#fffefa' : 'transparent' }}>
                          <td style={{ padding: '12px 14px', textAlign: 'center', borderBottom: `1px solid ${hairline}` }} onClick={e => e.stopPropagation()}>
                            <input type="checkbox" style={{ width: 14, height: 14, borderRadius: 5, accentColor: teal[600], cursor: 'pointer' }}
                              checked={isChecked} onChange={() => toggleSelect(customer.id)} />
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ width: 36, height: 36, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: pal.bg, color: pal.text, fontWeight: 700, fontSize: 12, letterSpacing: 0.3, flexShrink: 0, border: `1px solid ${teal[100]}` }}>
                                {getInitials(customer.name)}
                              </div>
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                                  <span style={{ fontWeight: 600, color: ink }}>{customer.name}</span>
                                  {statusBadge(customer.status)}
                                  {overdue && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 999, fontSize: 9, fontWeight: 700, background: '#fef2f2', color: danger, border: `1px solid ${danger}40` }}><AlertIcon size={8} /> Overdue</span>}
                                </div>
                                <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: inkSoft, marginTop: 2 }}>{customer.id}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}` }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {customer.phone && <span style={{ fontSize: 11.5, color: inkSoft, display: 'flex', alignItems: 'center', gap: 5 }}><PhoneIcon size={10} />{customer.phone}</span>}
                              {(customer.portalEmail || customer.email) && <span style={{ fontSize: 11.5, color: teal[700], display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}><Mail size={10} />{customer.portalEmail || customer.email}</span>}
                            </div>
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}` }}>
                            {lastTx ? (
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 12 }}>{relativeDate(lastTx.date)}</div>
                                <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}>{(lastTx as unknown as { invoiceNumber?: string }).invoiceNumber || (lastTx as unknown as { invoice_number?: string }).invoice_number || lastTx.id}</div>
                              </div>
                            ) : <span style={{ color: inkSoft, fontSize: 12 }}>—</span>}
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}`, textAlign: 'right', fontWeight: 600, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                            {fmtMoney(customer.walletBalance)}
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}`, textAlign: 'right' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12.5, color: owing ? danger : '#15803d', fontVariantNumeric: 'tabular-nums' }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: owing ? danger : '#22c55e', flexShrink: 0 }} />
                              {owing ? fmtMoney(openBalance) : 'Paid'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 14px', borderBottom: `1px solid ${hairline}`, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                            <div style={{ position: 'relative', display: 'inline-block' }}>
                              <button onClick={e => handleRowMenuClick(e, customer.id)}
                                style={{ padding: '6px 8px', borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'inline-flex', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
                                <MoreVertical size={14} />
                              </button>
                              {activeMenuId === customer.id && (
                                <div onClick={e => e.stopPropagation()} style={{ ...getFloatingMenuStyle(menuAnchor, { minWidth: 220, estimatedHeight: 280 }), borderRadius: 12, boxShadow: '0 16px 36px -12px rgba(0,0,0,.28)', padding: '8px 10px', background: paper, border: `1px solid ${hairline}`, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  <button onClick={() => { setActiveMenuId(null); setSelectedWorkspaceCustomer(customer); }} style={menuItemStyle}><Eye size={13} style={{ color: inkSoft }} /> View Profile</button>
                                  <button onClick={() => { setActiveMenuId(null); handleEdit(customer); }} style={menuItemStyle}><Edit size={13} style={{ color: inkSoft }} /> Edit</button>
                                  <button onClick={() => { setActiveMenuId(null); navigate('/sales-flow/invoices', { state: { action: 'create', customer: customer.name } }); }} style={menuItemStyle}><Send size={13} style={{ color: teal[600] }} /> New Invoice</button>
                                  <button onClick={() => { setActiveMenuId(null); navigate('/sales-flow/payments', { state: { action: 'create', customer: customer.name, isTopUp: true } }); }} style={menuItemStyle}><Wallet size={13} style={{ color: teal[600] }} /> Deposit Wallet</button>
                                  <button onClick={() => { setActiveMenuId(null); navigate('/revenue/contacts', { state: { customerId: customer.id } }); }} style={menuItemStyle}><BookOpen size={13} style={{ color: inkSoft }} /> Ledger</button>
                                  <div style={{ height: 1, background: hairline, margin: '3px 0' }} />
                                  <button onClick={() => { setActiveMenuId(null); handleDelete(customer.id); }} style={{ ...menuItemStyle, color: danger }}><Trash2 size={13} /> Delete</button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expandedClientId === customer.id && customer.subAccounts && customer.subAccounts.length > 0 && (
                          <tr>
                            <td style={{ padding: 0, borderBottom: `1px solid ${hairline}` }}></td>
                            <td colSpan={6} style={{ padding: '16px 20px', borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                              <div style={{ borderRadius: 10, border: `1px solid ${teal[100]}`, overflow: 'hidden' }}>
                                <div style={{ padding: '10px 14px', background: teal[100], borderBottom: `1px solid ${teal[200]}` }}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: teal[800], textTransform: 'uppercase', letterSpacing: 0.08 }}>Sub Accounts</span>
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                  <thead>
                                    <tr>
                                      <th style={{ padding: '8px 14px', fontWeight: 700, color: teal[800], textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.06, textAlign: 'left', borderBottom: `1px solid ${teal[100]}` }}>Name</th>
                                      <th style={{ padding: '8px 14px', fontWeight: 700, color: teal[800], textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.06, textAlign: 'right', borderBottom: `1px solid ${teal[100]}` }}>Wallet</th>
                                      <th style={{ padding: '8px 14px', fontWeight: 700, color: teal[800], textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.06, textAlign: 'right', borderBottom: `1px solid ${teal[100]}` }}>Balance</th>
                                      <th style={{ padding: '8px 14px', fontWeight: 700, color: teal[800], textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.06, textAlign: 'center', borderBottom: `1px solid ${teal[100]}` }}>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {customer.subAccounts.map((sub: any) => (
                                      <tr key={sub.id} style={{ borderBottom: `1px solid ${teal[100]}` }}>
                                        <td style={{ padding: '8px 14px', fontWeight: 600, color: ink }}>{sub.name}</td>
                                        <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{currency}{(sub.walletBalance || 0).toLocaleString()}</td>
                                        <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: (sub.balance || 0) > 0 ? danger : ink }}>{currency}{(sub.balance || 0).toLocaleString()}</td>
                                        <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                                          <span style={{ padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: sub.status === 'Active' ? teal[100] : '#f5f5f4', color: sub.status === 'Active' ? teal[700] : inkSoft }}>{sub.status}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${hairline}`, background: '#fafaf8', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ color: inkSoft, fontSize: 11.5, fontWeight: 500 }}>
            Page {currentPage} of {maxPage} · {totalItems} clients
          </div>
          <Pagination currentPage={currentPage} maxPage={maxPage} totalItems={totalItems} itemsPerPage={itemsPerPage} onNext={next} onPrev={prev} onFirst={first} onLast={last} onItemsPerPageChange={setItemsPerPage} />
        </div>
      </div>

      {selectedCardCustomer && (
        <CustomerCard
          customer={selectedCardCustomer}
          balance={runningBalanceByCustomer.get(selectedCardCustomer.id) ?? Number(selectedCardCustomer.balance || 0)}
          onClose={() => setSelectedCardCustomer(null)}
          onViewProfile={c => { setSelectedCardCustomer(null); setSelectedWorkspaceCustomer(c); }}
          onEdit={c => { setSelectedCardCustomer(null); handleEdit(c); }}
          onCreateInvoice={c => { setSelectedCardCustomer(null); navigate('/sales-flow/invoices', { state: { action: 'create', customer: c.name } }); }}
          onCreateQuote={c => { setSelectedCardCustomer(null); navigate('/sales-flow/orders', { state: { action: 'create', customer: c.name } }); }}
          onStatement={c => { setSelectedCardCustomer(null); navigate('/revenue/contacts', { state: { customerId: c.id } }); }}
          onWhatsApp={c => { setSelectedCardCustomer(null); if (c.phone) window.open(`https://wa.me/${c.phone.replace(/[^0-9]/g, '')}`, '_blank'); }}
          onPortalUpdate={c => { updateCustomer(c).catch(() => {}); }}
        />
      )}

      <ClientModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setPendingSegment(undefined); }}
        onSave={selectedCustomer ? (c) => updateCustomer(c).then(() => null) : addCustomer}
        customer={selectedCustomer}
        initialSegment={pendingSegment}
      />

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={open => !open && setConfirmState(c => ({ ...c, open: false }))}
        onConfirm={() => { confirmState.onConfirm?.(); setConfirmState(c => ({ ...c, open: false })); }}
        onCancel={() => setConfirmState(c => ({ ...c, open: false }))}
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        type={confirmState.type || 'question'}
      />
    </div>
  );
};

export default Clients;
