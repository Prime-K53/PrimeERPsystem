
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { logger } from '../services/logger';
import {
  PieChart, Users, ArrowLeftRight, ArrowRightLeft, BarChart3, Package, Factory,
  ChevronRight, Plus,
  Shield, CreditCard, Barcode, ChevronDown, Download, Upload,
  FileText, Briefcase, Banknote, UserPlus,
  Award,
  TrendingUp, Layers, Cpu, CheckSquare, MessageSquare, LayoutDashboard,
  Activity, Box, Warehouse, Table, Clock, DollarSign, RefreshCw,
  Landmark, Coins, Landmark as Bank, Scale, FileBarChart, PieChart as Pie,
  Wallet, Target, Tag, Truck, WifiOff, HardDrive,
  CheckCircle, MonitorPlay, Maximize, Share2, Sparkles,
  Smartphone, FileSpreadsheet, BookOpen, FileCheck, History,
  Calculator, Search, GitFork,
  Gift, Calendar, FileSearch, Receipt, Inbox, Megaphone, BadgePercent,
  Building2, UserCog, CalendarCheck
} from 'lucide-react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSales } from '../context/SalesContext';
import { useData } from '../context/DataContext';
import { resolveAppAssetUrl } from '../utils/runtime';

interface SidebarProps {
  isOpen: boolean;
  toggle: () => void;
  isCollapsed: boolean;
  toggleCollapse: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isOpen, isCollapsed, toggle, toggleCollapse }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, companyConfig } = useAuth();
  const { setIsPosModalOpen } = useSales();
  const { refreshAllData } = useData();
  const getTabletViewport = () => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width:768px) and (max-width:1024px)').matches;
  };

  const [isNewMenuOpen, setIsNewMenuOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isTabletViewport, setIsTabletViewport] = useState(getTabletViewport);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sidebar:recents') || '[]'); } catch { return []; }
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await refreshAllData?.();
    } catch (err) {
      logger.error('Refresh failed:', err);
      setRefreshError('Failed to refresh application data. Please try again.');
      
      // Auto-clear error after 5 seconds
      setTimeout(() => setRefreshError(null), 5000);
    } finally {
      setIsRefreshing(false);
    }
  };
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({
    'Inventory': false,
    'Manufacturing': false,
    'Sales': false,
    'Procurement': false,
    'Reports': false,
    'Tools': false,
    'Internal Tools': false
  });

  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(event.target as Node)) {
        setIsNewMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const mql = window.matchMedia('(min-width:768px) and (max-width:1024px)');
    const handleChange = () => setIsTabletViewport(mql.matches);
    handleChange();
    // Modern browsers
    if (mql.addEventListener) mql.addEventListener('change', handleChange);
    else mql.addListener(handleChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handleChange);
      else mql.removeListener(handleChange);
    };
  }, []);

  const isCompressed = isCollapsed || isTabletViewport;

  const isActive = useCallback((path: string) => {
    if (!path) return false;
    const clean = (p: string) => p.replace(/\/+$/, '') || '/';
    const loc = clean(location.pathname);
    const target = clean(path);
    if (loc === target) return true;
    if (target === '/') return false;
    // Segment-boundary check: loc must be target + '/' + rest
    const isChild = loc === target || loc.startsWith(target + '/');
    if (!isChild) return false;
    // Preserve original UX: don't highlight parent when drilling into pure sub-routes
    if (target === '/sales-flow' && loc.startsWith('/sales-flow/clients')) return false;
    if (target === '/procurement' && loc.startsWith('/procurement/suppliers')) return false;
    return true;
  }, [location.pathname]);

  const toggleSubMenu = (label: string) => {
    if (isCollapsed) {
      toggleCollapse();
    }
    setExpandedMenus(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const menuGroups = useMemo(() => [
    {
      group: "Command",
      items: [
        { label: 'Dashboard', path: '/', icon: <PieChart size={18} /> },
        {
          label: 'Customers',
          path: '/customers',
          icon: <Users size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Clients', path: '/sales-flow/clients', icon: <UserPlus size={14} /> },
            { label: 'Suppliers', path: '/procurement/suppliers', icon: <Users size={14} /> },
            { label: 'Task Manager', path: '/sales-flow/tasks', icon: <CheckSquare size={14} /> },
            { label: 'Portal Users', path: '/portal/users', icon: <Shield size={14} /> },
          ]
        },
        {
          label: 'Requests',
          path: '/sales-flow/requests',
          icon: <Inbox size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Inbox', path: '/sales-flow/requests', icon: <Inbox size={14} /> },
            { label: 'Quotations', path: '/sales-flow/requests', icon: <FileText size={14} />, state: { tab: 'quotations' } },
            { label: 'Orders', path: '/sales-flow/requests', icon: <CheckSquare size={14} />, state: { tab: 'orders' } },
            { label: 'Payment Requests', path: '/sales-flow/payment-requests', icon: <Banknote size={14} /> },
            { label: 'History', path: '/sales-flow/requests', icon: <History size={14} />, state: { tab: 'history' } },
          ]
        },
      ]
    },
    {
      group: "Operations",
      items: [
        {
          label: 'Supply Chain',
          path: '/supply-chain',
          icon: <Package size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Master Inventory', path: '/supply-chain/inventory', icon: <Box size={14} /> },
            { label: 'Inventory Reports', path: '/supply-chain/inventory-reports', icon: <BarChart3 size={14} /> },
            { label: 'Warehouses', path: '/supply-chain/warehouses', icon: <Warehouse size={14} /> },
            { label: 'Goods Inbound', path: '/supply-chain/grn', icon: <Package size={14} /> },
            { label: 'Shipping Manager', path: '/supply-chain/shipping', icon: <Truck size={14} /> },
          ]
        },
        {
          label: 'Production',
          path: '/industrial',
          icon: <Factory size={18} />,
          visible: companyConfig?.enabledModules?.manufacturing,
          hideSubMenu: true,
          subItems: [
            { label: 'Work Orders', path: '/industrial/work-orders', icon: <Briefcase size={14} /> },
            { label: 'MRP Logic', path: '/industrial/mrp', icon: <Layers size={14} /> },
            { label: 'Production Schedule', path: '/industrial/scheduler', icon: <Clock size={14} /> },
            { label: 'Kiosk Terminal', path: '/industrial/kiosk', icon: <MonitorPlay size={14} /> },
            { label: 'Machine Health', path: '/industrial/maintenance', icon: <Activity size={14} /> },
            { label: 'Service Jobs', path: '/industrial/service-jobs', icon: <Briefcase size={14} /> },
            { label: 'Service Recipes', path: '/industrial/service-recipes', icon: <FileText size={14} /> },
          ]
        },
        {
          label: 'Examination',
          path: '/examination',
          icon: <BookOpen size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Batches', path: '/examination/batches', icon: <Layers size={14} /> },
            { label: 'New Batch', path: '/examination/batches/new', icon: <Plus size={14} /> },
          ]
        },
      ].filter(item => item.visible !== false)
    },
    {
      group: "Intelligence",
      items: [
        {
          label: 'Smart Operations',
          path: '/smart-operations',
          icon: <Cpu size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Market Adjustments', path: '/smart-operations/adjustments', icon: <TrendingUp size={14} /> },
            { label: 'Marketing Messages', path: '/smart-operations/messages', icon: <MessageSquare size={14} /> },
            { label: 'Price Cards', path: '/smart-operations/price-cards', icon: <Tag size={14} /> },
            { label: 'Referrals', path: '/smart-operations/referrals', icon: <Gift size={14} /> },
            { label: 'Promotions', path: '/smart-operations/promotions', icon: <BadgePercent size={14} /> },
            { label: 'Ads', path: '/smart-operations/ads', icon: <Megaphone size={14} /> },
          ]
        },
        {
          label: 'AI Workspace',
          path: '/ai-workspace',
          icon: <Sparkles size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Dashboard', path: '/ai-workspace/dashboard', icon: <LayoutDashboard size={14} /> },
            { label: 'AI Assistant', path: '/ai-workspace/assistant', icon: <MessageSquare size={14} /> },
            { label: 'Gang Run', path: '/ai-workspace/gang-run', icon: <Layers size={14} /> },
            { label: 'Cash Flow', path: '/ai-workspace/cash-flow', icon: <TrendingUp size={14} /> },
            { label: 'Anomaly Detector', path: '/ai-workspace/anomalies', icon: <Activity size={14} /> },
            { label: 'Churn Predictor', path: '/ai-workspace/churn', icon: <Users size={14} /> },
            { label: 'Reorder Opt.', path: '/ai-workspace/reorder', icon: <Package size={14} /> },
            { label: 'PO Matcher', path: '/ai-workspace/po-match', icon: <FileSearch size={14} /> },
            { label: 'Scheduler', path: '/ai-workspace/scheduler', icon: <Calendar size={14} /> },
            { label: 'Conv. Query', path: '/ai-workspace/query', icon: <MessageSquare size={14} /> },
            { label: 'Audit Inv.', path: '/ai-workspace/audit', icon: <Shield size={14} /> },
            { label: 'BOM Generator', path: '/ai-workspace/bom', icon: <FileText size={14} /> },
            { label: 'Smart Sales', path: '/smart-features/sales-dashboard', icon: <BarChart3 size={14} /> },
            { label: 'Invoice Intel', path: '/smart-features/invoice-intelligence', icon: <FileText size={14} /> },
            { label: 'Customer Risk', path: '/smart-features/customer-risk', icon: <Shield size={14} /> },
            { label: 'NL Reporting', path: '/smart-features/natural-language-reporting', icon: <MessageSquare size={14} /> },
            { label: 'Accounting Asst.', path: '/smart-features/accounting-assistant', icon: <Calculator size={14} /> },
            { label: 'Anomaly Detection', path: '/smart-features/anomaly-detection', icon: <Activity size={14} /> },
            { label: 'Report Summaries', path: '/smart-features/report-summaries', icon: <FileBarChart size={14} /> },
            { label: 'Advanced Table', path: '/smart-features/advanced-data-table', icon: <Table size={14} /> },
          ]
        },
      ]
    },
    {
      group: "Revenue",
      items: [
        {
          label: 'Sales Flow',
          path: '/sales-flow',
          icon: <ArrowLeftRight size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Point of Sale', path: '/sales-flow/pos', icon: <Coins size={14} /> },
            { label: 'Payment Management', path: '/sales-flow/payments', icon: <Banknote size={14} /> },
            { label: 'Quotations', path: '/sales-flow/quotations', icon: <FileText size={14} /> },
            { label: 'Orders', path: '/sales-flow/orders', icon: <CheckSquare size={14} /> },
            { label: 'Billing / Invoices', path: '/sales-flow/invoices', icon: <FileSpreadsheet size={14} /> },
            { label: 'Printing Contracts', path: '/sales-flow/printing-contracts', icon: <RefreshCw size={14} /> },
            { label: 'Lead Board', path: '/sales-flow/leads', icon: <Target size={14} /> },
          ]
        },
        {
          label: 'Revenue Analysis',
          path: '/revenue',
          icon: <Activity size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Dashboard', path: '/revenue', icon: <Activity size={14} /> },
            { label: 'Sales Audit', path: '/revenue/sales-audit', icon: <FileText size={14} /> },
            { label: 'Markup Performance', path: '/revenue/margin-performance', icon: <BarChart3 size={14} /> },
            { label: 'Rounding Analytics', path: '/revenue/rounding-analytics', icon: <Activity size={14} /> },
            { label: 'Client Ledger', path: '/revenue/contacts?type=customer-statement', icon: <Users size={14} /> },
            { label: 'Wallet Statement', path: '/revenue/wallet-statement', icon: <Wallet size={14} /> },
            { label: 'Business Intel', path: '/revenue/intel', icon: <PieChart size={14} /> },
            { label: 'Health Diagnostic', path: '/revenue/health', icon: <Sparkles size={14} /> },
          ]
        },
        {
          label: 'Procurement',
          path: '/procurement',
          icon: <CreditCard size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Vendor Bills', path: '/procurement/bills', icon: <FileText size={14} /> },
            { label: 'Supplier Payments', path: '/procurement/payments', icon: <Wallet size={14} /> },
            { label: 'Subcontracting', path: '/procurement/subcontracting', icon: <Share2 size={14} /> },
            { label: 'Expense Log', path: '/procurement/expenses', icon: <TrendingUp size={14} /> },
          ]
        },
      ]
    },
    {
      group: "Capital",
      visible: companyConfig?.enabledModules?.accounting,
      items: [
            { label: 'Banking & Finance', path: '/accounts/banking', icon: <Bank size={18} /> },
        { label: 'Account Transfers', path: '/accounts/transfers', icon: <ArrowRightLeft size={18} /> },
        { label: 'VAT Module', path: '/vat', icon: <FileText size={18} /> },
        { label: 'Finance Hub', path: '/finance', icon: <LayoutDashboard size={18} /> },
        { label: 'Chart of Accounts', path: '/accounts/chart-of-accounts', icon: <Landmark size={18} /> },
        { label: 'Payroll Engine', path: '/accounts/payroll', icon: <Users size={18} />, visible: companyConfig?.enabledModules?.payroll },
        { label: 'Fixed Assets', path: '/accounts/fixed-assets', icon: <Building2 size={18} /> },
        { label: 'Loans & Borrowings', path: '/accounts/loans', icon: <Landmark size={18} /> },
        { label: 'Owner Equity', path: '/accounts/owner-equity', icon: <UserCog size={18} /> },
        { label: 'Year-End Closing', path: '/accounts/year-end-closing', icon: <CalendarCheck size={18} /> },
        {
          label: 'Fiscal Reports',
          path: '/fiscal-reports',
          icon: <FileBarChart size={18} />,
          hideSubMenu: true,
          subItems: [
            { label: 'Dashboard', path: '/fiscal-reports', icon: <BarChart3 size={14} /> },
            { label: 'Profit & Loss', path: '/fiscal-reports/financials?type=IncomeStatement', icon: <TrendingUp size={14} /> },
            { label: 'Balance Sheet', path: '/fiscal-reports/financials?type=BalanceSheet', icon: <Scale size={14} /> },
            { label: 'Cash Flow', path: '/fiscal-reports/financials?type=CashFlow', icon: <Activity size={14} /> },
            { label: 'Trial Balance', path: '/fiscal-reports/financials?type=TrialBalance', icon: <FileCheck size={14} /> },
            { label: 'Ledger Explorer', path: '/fiscal-reports/ledgers', icon: <History size={14} /> },
            { label: 'Budget Analysis', path: '/fiscal-reports/financials?type=Budget', icon: <Target size={14} /> },
            { label: 'Aged Receivables', path: '/fiscal-reports/financials?type=AgedAR', icon: <History size={14} /> },
            { label: 'Aged Payables', path: '/fiscal-reports/financials?type=AgedAP', icon: <FileText size={14} /> },
            { label: 'Bank Recon', path: '/fiscal-reports/reconciliation', icon: <Scale size={14} /> },
            { label: 'Budgets', path: '/fiscal-reports/budgets', icon: <Target size={14} /> },
          ]
        },
      ].filter(item => item.visible !== false)
    },
  ].filter(group => group.visible !== false), [companyConfig?.enabledModules?.manufacturing, companyConfig?.enabledModules?.accounting, companyConfig?.enabledModules?.payroll]);

  // Auto-expand parent when child is active — fixes hidden active state (hideSubMenu lie)
  useEffect(() => {
    const next: Record<string, boolean> = { ...expandedMenus };
    let changed = false;
    menuGroups.forEach(g => g.items.forEach(item => {
      if (item.subItems && !item.hideSubMenu) {
        const hasActiveChild = item.subItems.some(s => isActive(s.path));
        if (hasActiveChild && !next[item.label]) { next[item.label] = true; changed = true; }
      }
    }));
    if (changed) setExpandedMenus(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, menuGroups]);

      // Close Quick Action on Escape + trap focus
  useEffect(() => {
    if (!isNewMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsNewMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isNewMenuOpen]);

  // Track recents for Phase 2 upgrade
  useEffect(() => {
    const path = location.pathname;
    if (!path || path === '/') return;
    setRecents(prev => {
      const next = [path, ...prev.filter(p => p !== path)].slice(0, 5);
      try { localStorage.setItem('sidebar:recents', JSON.stringify(next)); } catch {}
      return next;
    });
  }, [location.pathname]);

  // Cmd+K focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filteredGroups = useMemo(() => {
    // Role gate — bulletproof: hide sensitive modules from non-admin, but never block navigation via URL (server enforces)
    const isPrivileged = !!(user?.isSuperAdmin || String(user?.role || '').toLowerCase().includes('admin'));
    const adminOnlyItems = new Set(['AI Workspace','Fiscal Reports','Payroll Engine','Year-End Closing','Smart Operations']);
    let groups = menuGroups.map(g => ({
      ...g,
      items: g.items.filter(item => {
        if (adminOnlyItems.has(item.label) && !isPrivileged) return false;
        return true;
      })
    })).filter(g => g.items.length > 0);
    if (!searchQuery.trim()) return groups;
    const q = searchQuery.toLowerCase();
    return groups.map(g => ({
      ...g,
      items: g.items.filter(item =>
        item.label.toLowerCase().includes(q) ||
        item.subItems?.some(s => s.label.toLowerCase().includes(q))
      )
    })).filter(g => g.items.length > 0);
  }, [menuGroups, searchQuery, user]);

  return (
    <aside className={`
      fixed top-0 left-0 z-40 h-full text-white/70 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] flex flex-col font-sans border-r border-white/5 md:shrink-0 md:self-start
      ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      md:translate-x-0 md:sticky md:top-0 md:h-screen
      ${isCompressed ? 'md:w-[72px]' : 'md:w-56'}
    `} style={{ background: 'linear-gradient(180deg, #0b3e39, #082e2a)' }}>
      {/* Brand Section */}
      <div className="h-14 flex items-center px-4 shrink-0 border-b border-white/5" style={{ background: 'linear-gradient(180deg, #0b3e39, #082e2a)' }}>
        <div className="flex items-center gap-3 w-full">
          <div
            onClick={toggleCollapse}
            className="w-9 h-9 shrink-0 cursor-pointer hover:opacity-80 transition-all flex items-center justify-center rounded-lg text-white font-['DM_Serif_Display']"
            style={{ background: 'linear-gradient(160deg, #3fa294, #0f544c)' }}
          >
            P
          </div>
          {!isCompressed && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <span className="font-bold text-[16px] tracking-tight text-white truncate">
                Prime<span style={{ color: '#d99a3f' }}>PRINTING</span>
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider -mt-0.5 truncate" style={{ color: 'rgba(255,255,255,.4)' }}>Enterprise ERP</span>
            </div>
          )}
        </div>
      </div>

{/* Quick Action Group */}
       <div className="px-3 mt-4 space-y-2">
         {/* Primary Action (Quick Action) */}
         <div className="relative" ref={newMenuRef}>
            <button
              onClick={() => setIsNewMenuOpen(!isNewMenuOpen)}
              aria-expanded={isNewMenuOpen}
              aria-haspopup="menu"
              className="w-full flex items-center justify-center gap-2 py-2 rounded-full transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/50"
              style={{
                background: 'linear-gradient(160deg, #fbbf24, #d97706)',
                color: '#fef3c7',
                boxShadow: '0 1px 2px rgba(217,154,63,.15)',
              }}
            >
             <div className={`transition-transform duration-300 ${isNewMenuOpen ? 'rotate-45' : ''}`}>
               <Plus size={18} />
             </div>
              {!isCompressed && <span className="font-semibold text-[13px]" style={{ color: '#fef3c7' }}>Quick Action</span>}
           </button>
{isNewMenuOpen && (
                <div
                  role="menu"
                  aria-label="Quick Actions"
                  className="absolute z-50 w-[210px] overflow-hidden rounded-[14px] bg-[#FEFDFB] top-full left-0 mt-2 lg:top-0 lg:left-full lg:mt-0 lg:ml-3"
                  style={{
                    boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
                  }}>
                 <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg, #146b60, #3fa294 40%, #d99a3f 100%)' }} />
                 <div style={{ padding: '16px 14px 12px', marginTop: 3 }}>
                   <div style={{ fontSize: 9, fontWeight: 800, color: '#146b60', textTransform: 'uppercase', letterSpacing: '0.22em', marginBottom: 10 }}>Quick Actions</div>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                     {[
                       { icon: Coins, color: '#3b82f6', label: 'Point of Sale', onClick: () => { setIsPosModalOpen(true); setIsNewMenuOpen(false); } },
                       { icon: UserPlus, color: '#146b60', label: 'New Client', onClick: () => { navigate('/sales-flow/clients', { state: { action: 'create' } }); setIsNewMenuOpen(false); } },
                       { icon: FileSpreadsheet, color: '#d99a3f', label: 'Create Invoice', onClick: () => { navigate('/sales-flow/invoices', { state: { action: 'create' } }); setIsNewMenuOpen(false); } },
                       { icon: Receipt, color: '#059669', label: 'New Receipt', onClick: () => { navigate('/sales-flow/payments', { state: { action: 'create' } }); setIsNewMenuOpen(false); } },
                       { icon: FileText, color: '#8b5cf6', label: 'New Quotation', onClick: () => { navigate('/sales-flow/quotations', { state: { action: 'create', type: 'Quotation' } }); setIsNewMenuOpen(false); } },
                       { icon: CheckSquare, color: '#f59e0b', label: 'New Task', onClick: () => { navigate('/sales-flow/tasks', { state: { action: 'create' } }); setIsNewMenuOpen(false); } },
                       { icon: BookOpen, color: '#ec4899', label: 'New Exam Batch', onClick: () => { navigate('/examination/batches/new'); setIsNewMenuOpen(false); } },
                     ].map((item) => (
                        <button key={item.label} onClick={item.onClick} className="group flex items-center gap-[10px] w-full text-left relative rounded-lg px-[10px] py-[7px] border-0 cursor-pointer bg-transparent hover:bg-[#eef7f6] hover:translate-x-[2px] transition-all duration-200" style={{
                          display: 'flex', borderRadius: 8, transition: 'all .2s ease', width: '100%', position: 'relative',
                        }}>
                         <item.icon size={15} color={item.color} style={{ flexShrink: 0 }} />
                         <span style={{ fontSize: 12.5, fontWeight: 500, color: '#23282A', letterSpacing: '0.01em' }}>{item.label}</span>
                       </button>
                     ))}
                   </div>
                 </div>
               </div>
            )}
         </div>
        </div>

      {/* Phase 2: Search + Recents — upgrade */}
      {!isCompressed && (
        <div className="px-3 mt-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search (Cmd+K)"
              className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:border-white/20 focus:bg-white/10 transition-colors"
            />
          </div>
          {recents.length > 0 && !searchQuery && (
            <div className="mt-3">
              <p className="px-3 text-[9px] font-bold text-white/30 uppercase tracking-widest mb-1">Recents</p>
              <div className="space-y-1">
                {recents.slice(0, 3).map(path => (
                  <button key={path} onClick={() => navigate(path)} className="w-full text-left px-3 py-1.5 rounded-md text-[12px] text-white/50 hover:text-white hover:bg-white/5 truncate transition-colors">
                    {path}
                  </button>
                ))}
              </div>
            </div>
          )}
          {searchQuery && filteredGroups.length === 0 && (
            <p className="mt-2 px-3 text-[12px] text-white/40">No matches</p>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 flex flex-col space-y-1 overflow-y-auto custom-scrollbar px-3 py-4 pb-6 relative">
        <div className="absolute right-0 top-0 bottom-0 w-[1px]" style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,.15) 1px, transparent 1px)', backgroundSize: '4px 4px', backgroundRepeat: 'repeat-y' }} />
        {filteredGroups.map((group) => (
          <div key={group.group} className="mb-6">
            {!isCompressed && (
              <p className="px-3 text-[10px] font-bold text-white/40 uppercase tracking-widest mb-3">{group.group}</p>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const hasSub = !!item.subItems && !item.hideSubMenu;
                const isExpanded = expandedMenus[item.label];
                const active = (item.path && isActive(item.path)) || item.subItems?.some(s => isActive(s.path));

                const tourAttr = item.label === 'Dashboard' ? 'dashboard' : item.label === 'Sales Flow' ? 'sales' : item.label === 'Production' ? 'production' : undefined;

                return (
                    <div key={item.label}>
                    <button
                      data-tour={tourAttr}
                      title={isCompressed ? item.label : undefined}
                      onClick={(e) => {
                        if (hasSub) {
                          toggleSubMenu(item.label);
                        } else if (item.path) {
                          navigate(item.path);
                        } else if (item.action) {
                          item.action();
                        }
                      }}
                      className={`
                        w-full flex items-center px-3 py-2 rounded-lg transition-all duration-200 group hover:translate-x-[1px]
                        ${active && !hasSub
                          ? 'text-white'
                          : 'text-white/62 hover:text-white hover:bg-white/5'}
                      `}
                      style={active && !hasSub ? {
                        background: 'linear-gradient(90deg, rgba(217,154,63,.2), rgba(217,154,63,.04))',
                        boxShadow: 'inset 3px 0 0 #d99a3f'
                      } : undefined}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className={`transition-colors duration-200 ${active ? 'text-white' : 'text-white/40 group-hover:text-white'}`}>
                          {item.icon}
                        </span>
                        {!isCompressed && (
                           <span className={`text-[14px] font-semibold truncate ${active ? 'text-white' : ''}`}>
                            {item.label}
                          </span>
                        )}
                      </div>

                      {!isCompressed && hasSub && (
                        <ChevronRight size={14} className={`transition-transform duration-300 text-white/20 ${isExpanded ? 'rotate-90 text-white' : ''}`} />
                      )}
                    </button>

                    {!isCompressed && hasSub && isExpanded && (
                      <div className="mt-1 ml-4 border-l border-white/10 pl-2 space-y-1">
                        {item.subItems.map(sub => {
                          const subActive = isActive(sub.path);
                          return (
                            <button
                              key={sub.path}
                              data-tour={sub.label === 'Master Inventory' ? 'inventory' : undefined}
                              onClick={() => navigate(sub.path)}
                               className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] transition-all hover:translate-x-[1px]
                                             ${subActive
                                     ? 'text-white bg-white/10 font-bold'
                                     : 'text-white/50 hover:text-white hover:bg-white/5'}`}
                            >
                              <div className={`${subActive ? 'text-white' : 'text-white/20'}`}>
                                {sub.icon}
                              </div>
                              {sub.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
