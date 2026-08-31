import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, FileText, Receipt, CreditCard,
  FileBarChart, Wallet, MessageSquare, ChevronLeft, ChevronRight,
  User, LogOut, Globe, X, Users, Truck, Bell, Package, ClipboardList,
  Sparkles,
} from 'lucide-react';
import { useCustomerAuth } from '../../../context/CustomerAuthContext';

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  action?: () => void;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  moduleName?: string;
}

const SIDEBAR_COLLAPSED_KEY = 'prime-portal-sidebar-collapsed';

const RAIL_BG = `
  linear-gradient(180deg, rgba(15,44,89,0.98) 0%, rgba(7,24,54,0.99) 100%)
`;

const ACTIVE_ITEM_BG = 'linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(99,102,241,0.05) 100%)';
const ACTIVE_ITEM_SHADOW = 'inset 0 0 0 1px rgba(99,102,241,0.3), 0 4px 16px -4px rgba(99,102,241,0.35)';

const PortalSidebar: React.FC<Props> = ({ isOpen, onClose, collapsed: collapsedExternal, onCollapsedChange, moduleName }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, user } = useCustomerAuth();
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      return stored ? JSON.parse(stored) : false;
    } catch {
      return false;
    }
  });
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  const collapsed = collapsedExternal ?? internalCollapsed;
  const setCollapsed = (value: boolean) => {
    setInternalCollapsed(value);
    onCollapsedChange?.(value);
  };
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [indicator, setIndicator] = useState({ top: 0, height: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch { /* noop */ }
  }, [collapsed]);

  useEffect(() => {
    if (collapsed && activeRef.current && navRef.current) {
      const navRect = navRef.current.getBoundingClientRect();
      const activeRect = activeRef.current.getBoundingClientRect();
      setIndicator({
        top: activeRect.top - navRect.top,
        height: activeRect.height,
      });
    }
  }, [collapsed, location.pathname]);

  const handleNavigate = (path: string) => {
    navigate(path);
    if (window.innerWidth < 768) onClose();
  };

  const handleLogout = () => {
    logout();
    navigate('/portal/login');
  };

  const navSections: NavSection[] = [
    {
      title: 'Overview',
      items: [
        { label: 'Dashboard', path: '/portal/dashboard', icon: LayoutDashboard },
      ],
    },
    {
      title: 'Commerce',
      items: [
        { label: 'Product Orders', path: '/portal/orders', icon: ShoppingCart },
        { label: 'Quotations', path: '/portal/quotations', icon: FileText },
        { label: 'Referrals', path: '/portal/referrals', icon: Users },
      ],
    },
    {
      title: 'Documents & Billing',
      items: [
        { label: 'Invoices', path: '/portal/invoices', icon: Receipt },
      ],
    },
    {
      title: 'Finance',
      items: [
        { label: 'Receipt', path: '/portal/payments', icon: CreditCard },
        { label: 'Wallet', path: '/portal/wallet', icon: Wallet },
        { label: 'Account Statements', path: '/portal/account-statements', icon: FileBarChart },
      ],
    },
    {
      title: 'Logistics',
      items: [
        { label: 'Deliveries & Tracking', path: '/portal/deliveries', icon: Truck },
      ],
    },
    {
      title: 'Account',
      items: [
        { label: 'Support', path: '/portal/support', icon: MessageSquare },
        { label: 'Notifications', path: '/portal/notifications', icon: Bell },
        { label: 'Documents', path: '/portal/documents', icon: Package },
        { label: 'Log Out', path: '', icon: LogOut, action: handleLogout },
      ],
    },
  ];

  const renderNavItem = (item: NavItem, isActive: boolean) => {
    const Icon = item.icon;
    const showTooltip = collapsed && hoveredItem === item.path;
    const handleClick = () => {
      if (item.action) {
        item.action();
      } else {
        handleNavigate(item.path);
      }
    };
    return (
      <button
        key={item.path}
        ref={isActive ? activeRef : undefined}
        onClick={handleClick}
        onMouseEnter={() => setHoveredItem(item.path)}
        onMouseLeave={() => setHoveredItem(null)}
        className={`
          group relative w-full flex items-center gap-2.5 rounded-xl text-sm
          transition-all duration-200 ease-out
          ${isActive ? '' : 'hover:bg-white/[0.04]'}
            ${collapsed ? 'justify-center px-2 py-1.5' : 'px-3 py-2'}
        `}
        style={{
          cursor: 'pointer',
          background: isActive ? ACTIVE_ITEM_BG : undefined,
          boxShadow: isActive ? ACTIVE_ITEM_SHADOW : undefined,
        }}
      >
        {isActive && !collapsed && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[20px] rounded-r-full pointer-events-none"
            style={{
              background: 'linear-gradient(180deg, #818CF8, #6366F1)',
              boxShadow: '0 0 14px rgba(99,102,241,0.6)',
            }}
          />
        )}
        <span
          className={`
            flex items-center justify-center w-8 h-8 rounded-xl shrink-0 transition-all duration-200
            ${isActive ? '' : 'text-white/50 group-hover:bg-white/8 group-hover:text-white/80'}
          `}
          style={isActive ? {
            background: 'linear-gradient(135deg, #6366F1, #4F46E5)',
            color: '#fff',
            boxShadow: '0 4px 12px -2px rgba(99,102,241,0.5)',
          } : undefined}
        >
          <Icon size={16} strokeWidth={2} />
        </span>
        {!collapsed && (
          <span
            className={`font-medium whitespace-nowrap text-[13px] transition-colors duration-200 ${isActive ? '' : 'text-white/50 group-hover:text-white/80'}`}
            style={isActive ? { color: '#FFFFFF', fontWeight: 600 } : undefined}
          >
            {item.label}
          </span>
        )}
        {showTooltip && (
          <div
            className="absolute left-full ml-3 px-3 py-2 rounded-xl text-xs font-semibold text-white whitespace-nowrap z-50 pointer-events-none"
            style={{
              background: 'rgba(15,44,89,0.95)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              boxShadow: '0 8px 32px -8px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.08)',
              border: '1px solid rgba(99,102,241,0.2)',
            }}
          >
            {item.label}
          </div>
        )}
      </button>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div
        className="h-14 flex items-center gap-3 px-3 shrink-0 border-b relative overflow-hidden"
        style={{
          borderColor: 'rgba(255,255,255,0.06)',
          background: 'linear-gradient(180deg, rgba(13,37,77,0.6), rgba(7,24,54,0.3))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <span
          className="absolute inset-x-0 top-0 h-px pointer-events-none"
          style={{ background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.4), transparent)' }}
        />
        <div
          className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white"
          style={{
            background: 'linear-gradient(160deg, #6366F1 0%, #4F46E5 100%)',
            boxShadow: '0 4px 16px -4px rgba(99,102,241,0.5), inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          <Sparkles size={18} strokeWidth={2} />
        </div>
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            {moduleName ? (
              <span className="font-bold text-[15px] tracking-tight text-white truncate leading-tight">
                {moduleName}
              </span>
            ) : (
              <>
                <span className="font-bold text-[16px] tracking-tight text-white truncate leading-tight">
                  Prime<span style={{ color: '#818CF8' }}>Portal</span>
                </span>
                <span className="text-[9px] font-bold uppercase tracking-[0.18em] -mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Customer Portal
                </span>
              </>
            )}
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:flex ml-auto w-7 h-7 items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all duration-200"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
        <button
          onClick={onClose}
          className="md:hidden ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all duration-200"
          aria-label="Close sidebar"
        >
          <X size={14} />
        </button>
      </div>

      {user && !collapsed && (
        <div
          className="mx-3 mt-3 p-3 rounded-xl relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(79,70,229,0.05) 100%)',
            border: '1px solid rgba(99,102,241,0.15)',
          }}
        >
          <div
            className="absolute top-0 right-0 w-16 h-16 rounded-full opacity-10 pointer-events-none"
            style={{ background: 'radial-gradient(circle, #818CF8 0%, transparent 70%)', transform: 'translate(30%, -30%)' }}
          />
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm"
              style={{
                background: 'linear-gradient(135deg, #6366F1, #4F46E5)',
                boxShadow: '0 2px 8px -2px rgba(99,102,241,0.4)',
              }}
            >
              {(user.full_name || 'C').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-white truncate leading-tight">
                {user.full_name || 'Customer'}
              </div>
              <div className="text-[10px] text-white/40 truncate mt-0.5">
                {user.email || 'Welcome back'}
              </div>
            </div>
          </div>
        </div>
      )}

      <nav
        ref={navRef}
        className="flex-1 overflow-y-auto custom-scrollbar py-3 px-2 space-y-1 relative"
        style={{ scrollbarColor: 'rgba(255,255,255,0.15) rgba(255,255,255,0.02)' }}
      >
        {collapsed && indicator.height > 0 && (
          <div
            className="absolute left-0 right-0 mx-auto w-9 rounded-lg pointer-events-none"
            style={{
              top: indicator.top,
              height: indicator.height,
              background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(99,102,241,0.03))',
              border: '1px solid rgba(99,102,241,0.2)',
              boxShadow: '0 0 20px rgba(99,102,241,0.2)',
              transition: 'all 0.2s cubic-bezier(.4,0,.2,1)',
            }}
          />
        )}
        {navSections.map((section) => (
          <div key={section.title}>
            {!collapsed && (
              <div className="flex items-center gap-2 px-3 mb-1.5 mt-2">
                <p className="text-[9px] font-bold uppercase tracking-[0.14em] m-0" style={{ color: 'rgba(255,255,255,0.25)' }}>
                  {section.title}
                </p>
                <span className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.06), transparent)' }} />
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = item.path ? location.pathname === item.path || location.pathname.startsWith(item.path + '/') : false;
                return renderNavItem(item, isActive);
              })}
            </div>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div
          className="shrink-0 mx-3 mb-3 p-3 rounded-xl"
          style={{
            background: 'linear-gradient(135deg, rgba(5,150,105,0.08) 0%, rgba(5,150,105,0.03) 100%)',
            border: '1px solid rgba(5,150,105,0.12)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center bg-emerald-500/20"
            >
              <Globe size={14} style={{ color: '#34D399' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-white/80 leading-tight">Need Help?</div>
              <div className="text-[10px] text-white/40 leading-tight mt-0.5">Contact support</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const railStyle: React.CSSProperties = {
    background: RAIL_BG,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderColor: 'rgba(255,255,255,0.06)',
    boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.03), 8px 0 32px -12px rgba(4,16,43,0.4)',
  };

  return (
    <>
      <aside
        className={`
          fixed top-0 left-0 z-40 h-full flex flex-col text-white/60 border-r transition-all duration-200 ease-out
          hidden md:flex
          ${collapsed ? 'w-[72px]' : 'w-[240px]'}
        `}
        style={railStyle}
      >
        {sidebarContent}
      </aside>

      {isOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <aside
            className="absolute top-0 left-0 h-full w-[260px] flex flex-col text-white/60 border-r transition-all duration-200 ease-out"
            style={railStyle}
          >
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};

export default PortalSidebar;
