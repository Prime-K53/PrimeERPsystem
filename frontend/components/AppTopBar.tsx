import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Box,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronsLeft,
  Clock,
  CornerDownLeft,
  FileText,
  HeartPulse,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  Receipt,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  User,
  Users,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFinancialYear, type FinancialYear } from '../context/FinancialYearContext';
import { useNotifications } from '../context/NotificationContext';
import { useSales } from '../context/SalesContext';
import { useInventory } from '../context/InventoryContext';
import { NotificationCenter } from './ui';
import Breadcrumbs from './Breadcrumbs';
import { getCustomerOptionLabel } from '../utils/customerDisplay';

/**
 * Single source of truth for the admin top navigation bar.
 *
 * Z-index scale for header chrome (do not invent new layers):
 * - header itself ............ z-50
 * - header dropdowns ......... z-[60] (absolute inside relative containers,
 *   so the header backdrop-filter cannot detach them)
 * - search modal ............. z-[200]
 * - NotificationCenter ....... z-1200 (portal, handles its own positioning)
 *
 * Replaces the previously inlined bar in App.tsx and the orphaned
 * components/TopBar.tsx (deleted — it had zero imports).
 */

export interface AppTopBarProps {
  onOpenSidebar: () => void;
  onToggleCollapse: () => void;
  sidebarCollapsed?: boolean;
}

type OpenMenu = null | 'fy' | 'user';

const RECENT_SEARCH_KEY = 'primeerp:recent-searches';
const MAX_RESULTS = 10;

function isFyClosed(fy: FinancialYear | null | undefined): boolean {
  if (!fy) return false;
  return fy.is_closed === 1 || (fy.is_closed as unknown) === true;
}

export function fyShortLabel(fy: FinancialYear | null | undefined): string {
  if (!fy) return 'No FY';
  const startYear = fy.start_date?.slice(0, 4);
  const endYear = fy.end_date?.slice(0, 4);
  if (!startYear) return fy.name || 'Unknown FY';
  return startYear !== endYear ? `FY ${startYear}/${endYear?.slice(2)}` : `FY ${startYear}`;
}

function readRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCH_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

interface SearchResult {
  type: 'Customer' | 'Invoice' | 'Job' | 'Inventory';
  label: string;
  sublabel: string;
  link: string;
  icon: React.ReactNode;
}

const pillButton =
  'flex items-center gap-1.5 rounded-full border border-[#ebe4d6] bg-white px-3 py-1.5 text-[12.5px] font-semibold text-[#5c6567] shadow-[0_1px_2px_rgba(15,84,76,0.03)] transition-colors hover:bg-[#f6f1e7] hover:border-[#d4cdc2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60] disabled:cursor-not-allowed disabled:opacity-50';

const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-full border border-[#ebe4d6] bg-white text-[#0b6e6e] shadow-[0_1px_2px_rgba(15,84,76,0.03)] transition-colors hover:bg-[#f6f1e7] hover:border-[#d4cdc2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60]';

const menuItem =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] font-medium text-[#23282A] transition-colors hover:bg-[#eef7f6] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#146b60] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

const AppTopBar: React.FC<AppTopBarProps> = ({
  onOpenSidebar,
  onToggleCollapse,
  sidebarCollapsed = false,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, companyConfig, isOnline, dbSyncStatus, lastSyncTime, checkPermission, logout, connectDbSync, notify } =
    useAuth();
  const { selectedFinancialYear, availableFinancialYears, setFinancialYear, isLoading: isFyLoading } =
    useFinancialYear();
  const {
    notifications: ctxNotifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    dismissNotification,
  } = useNotifications();
  const { customers, invoices, jobOrders } = useSales();
  const { inventory } = useInventory();

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [syncRetrying, setSyncRetrying] = useState(false);

  const fyMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  const fyClosed = isFyClosed(selectedFinancialYear);
  const isAdmin = Boolean(
    user?.isSuperAdmin || user?.role?.toLowerCase() === 'admin' || user?.role === 'Company Admin'
  );
  const canUsers = isAdmin || checkPermission('admin.users');
  const canSettings = isAdmin || checkPermission('admin.settings');

  const isNonProd = useMemo(() => {
    if (import.meta.env.DEV) return true;
    try {
      return /localhost|127\.0\.0\.1|dev|staging|test|preview/i.test(window.location.hostname);
    } catch {
      return false;
    }
  }, []);

  // ── menus: single close path (click-outside + ESC) with focus return ──
  const closeMenus = useCallback((returnFocus = false) => {
    setOpenMenu(null);
    if (returnFocus && lastTriggerRef.current) {
      lastTriggerRef.current.focus();
      lastTriggerRef.current = null;
    }
  }, []);

  const toggleMenu = useCallback(
    (menu: Exclude<OpenMenu, null>, trigger: HTMLElement | null) => {
      setBellOpen(false);
      setOpenMenu((prev) => {
        if (prev === menu) {
          if (trigger) trigger.focus();
          lastTriggerRef.current = null;
          return null;
        }
        lastTriggerRef.current = trigger;
        return menu;
      });
    },
    []
  );

  useEffect(() => {
    if (!openMenu && !bellOpen && !searchOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        (fyMenuRef.current?.contains(target) ||
          userMenuRef.current?.contains(target) ||
          bellButtonRef.current?.contains(target)) ??
        false;
      if (!inside && !searchOpen) {
        setOpenMenu(null);
        setBellOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setBellOpen(false);
        setSearchOpen(false);
        if (lastTriggerRef.current) {
          lastTriggerRef.current.focus();
          lastTriggerRef.current = null;
        }
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu, bellOpen, searchOpen]);

  // ── sync pill ──
  const syncState: 'offline' | 'syncing' | 'issue' | 'online' = !isOnline
    ? 'offline'
    : dbSyncStatus === 'syncing'
      ? 'syncing'
      : dbSyncStatus === 'error' || dbSyncStatus === 'restricted'
        ? 'issue'
        : 'online';

  const handleRetrySync = useCallback(async () => {
    if (syncRetrying) return;
    setSyncRetrying(true);
    try {
      await connectDbSync();
      notify('Sync retry started.', 'info');
    } catch {
      notify('Sync retry failed. Check your connection and try again.', 'error');
    } finally {
      setSyncRetrying(false);
    }
  }, [connectDbSync, notify, syncRetrying]);

  // ── user menu ──
  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      setOpenMenu(null);
      navigate('/login', { replace: true });
    }
  }, [logout, loggingOut, navigate]);

  const goMenu = useCallback(
    (link: string) => {
      setOpenMenu(null);
      navigate(link);
    },
    [navigate]
  );

  // ── notifications: severity-first sort, deep-link actions ──
  const sortedNotifications = useMemo(() => {
    const rank = (n: { priority?: string; severity?: string }): number => {
      const p = String(n.priority || n.severity || 'medium').toLowerCase();
      if (p === 'urgent' || p === 'critical') return 0;
      if (p === 'high') return 1;
      if (p === 'medium') return 2;
      return 3;
    };
    return [...ctxNotifications].sort((a: never, b: never) => {
      const ra = rank(a as { priority?: string });
      const rb = rank(b as { priority?: string });
      if (ra !== rb) return ra - rb;
      return (
        new Date((b as { created_at: string }).created_at).getTime() -
        new Date((a as { created_at: string }).created_at).getTime()
      );
    });
  }, [ctxNotifications]);

  const notificationItems = useMemo(
    () =>
      sortedNotifications.map((n) => {
        const actionUrl = (n as unknown as { actionUrl?: string }).actionUrl;
        return {
          id: n.id,
          type: (n.type === 'EXAM' ? 'insight' : n.type === 'SYSTEM' ? 'system' : n.priority === 'Urgent' || n.priority === 'High' ? 'alert' : 'insight') as
            | 'insight'
            | 'system'
            | 'alert',
          title: n.title,
          message: n.message,
          timestamp: n.created_at,
          severity: (n.priority === 'Urgent' ? 'critical' : n.priority === 'High' ? 'high' : n.priority === 'Medium' ? 'medium' : 'low') as
            | 'critical'
            | 'high'
            | 'medium'
            | 'low',
          read: n.is_read,
          actionable: Boolean(actionUrl),
          actionLabel: actionUrl ? 'Open' : undefined,
          onAction: actionUrl
            ? () => {
                if (!n.is_read) void markAsRead(n.id);
                setBellOpen(false);
                navigate(actionUrl);
              }
            : undefined,
        };
      }),
    [sortedNotifications, markAsRead, navigate]
  );

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <div
      className="relative flex min-w-0 items-center gap-1.5 px-3.5 py-[7px] sm:gap-2"
      style={{
        background: 'rgba(255, 255, 255, 0.85)',
        backdropFilter: 'saturate(180%) blur(14px)',
        WebkitBackdropFilter: 'saturate(180%) blur(14px)',
        borderBottom: '1px solid #ebe4d6',
        boxShadow: '0 1px 0 rgba(15,84,76,0.04), 0 6px 18px -12px rgba(15,84,76,0.10)',
        zIndex: 50,
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-90"
        style={{ background: 'linear-gradient(90deg, #146b60 0%, #3fa294 45%, #d99a3f 100%)' }}
      />

      {/* left: nav toggles + context */}
      <button
        type="button"
        className="shrink-0 rounded-lg border border-[#ebe4d6] bg-white p-2 text-[#5c6567] transition-colors hover:border-[#d4cdc2] hover:bg-[#f6f1e7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60] md:hidden"
        onClick={onOpenSidebar}
        aria-label="Open sidebar"
      >
        <Menu size={18} />
      </button>
      <button
        type="button"
        className="hidden shrink-0 rounded-lg border border-transparent p-2 text-[#5c6567] transition-colors hover:border-[#ebe4d6] hover:bg-[#f6f1e7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60] md:flex"
        onClick={onToggleCollapse}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeftClose size={18} /> : <ChevronsLeft size={18} />}
      </button>

      <div className="hidden min-w-0 flex-1 lg:flex" aria-label="Page location">
        <Breadcrumbs />
      </div>
      {companyConfig?.companyName && (
        <span
          className="hidden max-w-48 truncate text-[11px] font-semibold text-[#5c6567] xl:block"
          title={companyConfig.companyName}
        >
          {companyConfig.companyName}
        </span>
      )}
      {isNonProd && (
        <span className="hidden rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-700 sm:inline-flex">
          {import.meta.env.DEV ? 'Dev' : 'Non-prod'}
        </span>
      )}

      {/* right cluster */}
      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {/* search trigger: full pill on sm+, icon on mobile */}
        <button
          ref={searchTriggerRef}
          type="button"
          className="hidden w-56 items-center gap-2 rounded-full border border-[#ebe4d6] bg-white px-3 py-1.5 text-left text-[12.5px] text-[#5c6567] shadow-[0_1px_2px_rgba(15,84,76,0.03)] transition-colors hover:border-[#d4cdc2] hover:bg-[#f6f1e7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60] sm:flex lg:w-72"
          onClick={() => {
            lastTriggerRef.current = searchTriggerRef.current;
            setOpenMenu(null);
            setBellOpen(false);
            setSearchOpen(true);
          }}
          aria-label="Search (Ctrl or Cmd + K)"
        >
          <Search size={14} className="shrink-0" />
        </button>
        <button
          type="button"
          className={`${iconButton} sm:hidden`}
          onClick={() => {
            setOpenMenu(null);
            setBellOpen(false);
            setSearchOpen(true);
          }}
          aria-label="Search"
        >
          <Search size={16} />
        </button>

        {/* sync / offline status */}
        {syncState === 'online' ? (
          <span
            className="hidden items-center gap-1.5 rounded-full border border-[#ebe4d6] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 sm:inline-flex"
            title={lastSyncTime ? `Last synced ${new Date(lastSyncTime).toLocaleString()}` : 'Connected'}
            aria-label={lastSyncTime ? `Online, last synced ${new Date(lastSyncTime).toLocaleString()}` : 'Online'}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-reduce:animate-none" />
            <span className="hidden lg:inline">Online</span>
          </span>
        ) : syncState === 'syncing' ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700"
            role="status"
            aria-live="polite"
            aria-label="Syncing"
          >
            <RefreshCw size={12} className="animate-spin motion-reduce:animate-none" />
            <span className="hidden lg:inline">Syncing</span>
          </span>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-60"
            onClick={handleRetrySync}
            disabled={syncRetrying}
            title={
              syncState === 'offline'
                ? 'You are offline. Retry connection.'
                : `Sync needs attention${lastSyncTime ? ` (last synced ${new Date(lastSyncTime).toLocaleString()})` : ''}. Retry.`
            }
            aria-label={syncState === 'offline' ? 'Offline. Activate to retry connection.' : 'Sync issue. Activate to retry.'}
            aria-live="polite"
          >
            {syncState === 'offline' ? <WifiOff size={12} /> : <RefreshCw size={12} className={syncRetrying ? 'animate-spin' : ''} />}
            <span className="hidden lg:inline">{syncState === 'offline' ? 'Offline' : 'Sync issue'}</span>
          </button>
        )}

        {/* financial year: actual label + closed state, not static text */}
        <div ref={fyMenuRef} className="relative">
          <button
            type="button"
            className={`${pillButton} ${openMenu === 'fy' ? '!border-[#a6d9d3] !bg-[#eef7f6] !text-[#146b60]' : ''} ${fyClosed ? '!border-red-200 !bg-red-50 !text-red-700' : ''}`}
            onClick={(e) => toggleMenu('fy', e.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'fy'}
            aria-label={
              selectedFinancialYear
                ? `Financial year ${fyShortLabel(selectedFinancialYear)}${fyClosed ? ', closed' : ''}. Activate to change.`
                : 'Select financial year'
            }
            title={
              selectedFinancialYear
                ? `Financial Year: ${selectedFinancialYear.name}${fyClosed ? ' (Closed)' : ''}`
                : 'Select Financial Year'
            }
          >
            <CalendarDays size={14} className="shrink-0" />
            <span className="hidden whitespace-nowrap sm:inline">
              {isFyLoading ? 'Loading…' : fyShortLabel(selectedFinancialYear)}
            </span>
            {fyClosed && (
              <span className="hidden rounded bg-red-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-red-700 sm:inline">
                Closed
              </span>
            )}
            <ChevronDown size={14} className={`transition-transform ${openMenu === 'fy' ? 'rotate-180' : ''}`} />
          </button>
          {openMenu === 'fy' && (
            <div
              role="menu"
              aria-label="Financial years"
              className="absolute right-0 top-[calc(100%+6px)] z-[60] max-h-72 w-60 overflow-y-auto rounded-xl border border-[#e4ddd1] bg-[#FEFDFB] p-1.5 shadow-[0_30px_70px_-20px_rgba(0,0,0,.55),0_8px_24px_-8px_rgba(0,0,0,.35)]"
            >
              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[#5c6567]">
                Financial years
              </p>
              {availableFinancialYears.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-slate-400">No financial years configured</p>
              ) : (
                availableFinancialYears.map((fy) => {
                  const active = selectedFinancialYear?.id === fy.id;
                  const closed = isFyClosed(fy);
                  return (
                    <button
                      key={fy.id}
                      role="menuitemradio"
                      aria-checked={active}
                      type="button"
                      className={`${menuItem} justify-between ${active ? 'bg-[#eef7f6] font-semibold text-[#146b60]' : ''}`}
                      onClick={() => {
                        setFinancialYear(fy);
                        closeMenus();
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CalendarDays size={14} className="shrink-0 text-slate-400" />
                        <span className="truncate">{fyShortLabel(fy)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {closed ? (
                          <span className="rounded bg-red-100 px-1.5 py-px text-[9px] font-semibold text-red-700">
                            Closed
                          </span>
                        ) : (
                          Boolean(fy.is_default) && (
                            <span className="rounded bg-[#eef7f6] px-1.5 py-px text-[9px] font-semibold text-[#146b60]">
                              Default
                            </span>
                          )
                        )}
                        {active && <Check size={14} className="text-[#146b60]" />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* notifications: real count, severity-sorted, deep-linking */}
        <div className="relative">
          <button
            ref={bellButtonRef}
            type="button"
            className={iconButton}
            onClick={() => {
              setOpenMenu(null);
              setBellOpen((v) => !v);
            }}
            aria-haspopup="dialog"
            aria-expanded={bellOpen}
            aria-label={unreadCount > 0 ? `${unreadCount} unread notifications. Activate to open.` : 'Notifications, none unread. Activate to open.'}
          >
            <Bell size={15} />
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-[#146b60] px-0.5 text-[9px] font-bold leading-none text-white"
              >
                {badgeLabel}
              </span>
            )}
          </button>
          <NotificationCenter
            isOpen={bellOpen}
            onClose={() => setBellOpen(false)}
            notifications={notificationItems}
            onMarkRead={(id) => void markAsRead(id)}
            onMarkAllRead={() => void markAllAsRead()}
            onClear={(id) => void dismissNotification(id)}
            anchorEl={bellButtonRef.current}
          />
        </div>

        {/* identity: name, not role; admin tools gated */}
        <div ref={userMenuRef} className="relative ml-1 flex items-center border-l border-[#ebe4d6] pl-1.5 sm:pl-2.5">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1 transition-colors hover:bg-[#f3ede3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60]"
            onClick={(e) => toggleMenu('user', e.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'user'}
            aria-label={`Account menu for ${user?.fullName || user?.username || 'user'}`}
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold text-white shadow-[0_2px_8px_rgba(15,84,76,0.22)]"
              style={{ background: 'linear-gradient(160deg, #3fa294, #0f544c)' }}
            >
              {(user?.fullName || user?.username || 'U').charAt(0).toUpperCase()}
            </span>
            <ChevronDown size={14} className={`text-[#5b578c] transition-transform ${openMenu === 'user' ? 'rotate-180' : ''}`} />
          </button>
          {openMenu === 'user' && (
            <div
              role="menu"
              aria-label="Account"
              className="absolute right-0 top-[calc(100%+8px)] z-[60] w-60 overflow-hidden rounded-xl border border-[#e4ddd1] bg-[#FEFDFB] shadow-[0_30px_70px_-20px_rgba(0,0,0,.55),0_8px_24px_-8px_rgba(0,0,0,.35)]"
            >
              <div
                aria-hidden="true"
                className="h-[3px]"
                style={{ background: 'linear-gradient(90deg, #146b60, #3fa294 40%, #d99a3f 100%)' }}
              />
              <div className="px-4 pb-2.5 pt-3">
                <p className="text-[9px] font-extrabold uppercase tracking-[0.22em] text-[#146b60]">Account</p>
                <p className="mt-2 truncate text-[13.5px] font-semibold text-[#23282A]">
                  {user?.fullName || user?.username || 'User'}
                </p>
                {user?.email && <p className="mt-0.5 truncate text-[11px] font-medium text-[#5c6567]">{user.email}</p>}
                <p className="mt-0.5 text-[11px] font-medium text-[#5c6567]">
                  {user?.role === 'Company Admin' ? 'Admin' : user?.role || 'User'}
                  {fyClosed ? ' • FY closed' : ''}
                </p>
              </div>
              <div className="p-1.5">
                <button role="menuitem" type="button" className={menuItem} onClick={() => goMenu('/profile')}>
                  <User size={15} className="shrink-0 text-[#6366f1]" /> User Profile
                </button>
                <button role="menuitem" type="button" className={menuItem} onClick={() => goMenu('/audit')}>
                  <ShieldCheck size={15} className="shrink-0 text-[#10b981]" /> Audit Log
                </button>
                <button role="menuitem" type="button" className={menuItem} onClick={() => goMenu('/internal-tools')}>
                  <Wrench size={15} className="shrink-0 text-[#3b82f6]" /> Internal Tools
                </button>
                {canUsers && (
                  <button role="menuitem" type="button" className={menuItem} onClick={() => goMenu('/admin/users')}>
                    <Users size={15} className="shrink-0 text-[#6366f1]" /> User Management
                  </button>
                )}
                {canSettings && (
                  <>
                    <button role="menuitem" type="button" className={menuItem} onClick={() => goMenu('/settings')}>
                      <Settings size={15} className="shrink-0 text-[#f59e0b]" /> Settings
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      className={menuItem}
                      onClick={() => goMenu('/admin/sync-health')}
                    >
                      <HeartPulse size={15} className="shrink-0 text-[#8b5cf6]" /> Sync Health
                    </button>
                  </>
                )}
              </div>
              <div className="border-t border-[#e4ddd1] p-1.5">
                <button
                  role="menuitem"
                  type="button"
                  className={`${menuItem} font-semibold text-[#b5493f]`}
                  onClick={() => void handleLogout()}
                  disabled={loggingOut}
                >
                  <LogOut size={15} className="shrink-0" /> {loggingOut ? 'Logging out…' : 'Log out'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <SearchModal
        open={searchOpen}
        locationKey={location.pathname}
        customers={Array.isArray(customers) ? customers : []}
        invoices={Array.isArray(invoices) ? invoices : []}
        jobOrders={Array.isArray(jobOrders) ? jobOrders : []}
        inventoryItems={Array.isArray(inventory) ? inventory : []}
        onClose={(returnFocus) => {
          setSearchOpen(false);
          if (returnFocus) searchTriggerRef.current?.focus();
        }}
        onNavigate={(link, label) => {
          try {
            const recent = [label, ...readRecentSearches().filter((r) => r !== label)].slice(0, 5);
            localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recent));
          } catch {
            /* non-fatal */
          }
          setSearchOpen(false);
          navigate(link);
        }}
      />
    </div>
  );
};

/* ── search panel: grouped, highlighted, scoped, keyboard-navigable ── */

type SearchScope = 'All' | SearchResult['type'];

const SEARCH_SCOPES: Array<{ id: SearchScope; label: string }> = [
  { id: 'All', label: 'All' },
  { id: 'Customer', label: 'Customers' },
  { id: 'Invoice', label: 'Invoices' },
  { id: 'Job', label: 'Jobs' },
  { id: 'Inventory', label: 'Inventory' },
];

const SEARCH_GROUP_META: Record<SearchResult['type'], { label: string; icon: React.ReactNode; chip: string }> = {
  Customer: { label: 'Customers', icon: <Users size={13} />, chip: 'bg-teal-50 text-[#146b60]' },
  Invoice: { label: 'Invoices', icon: <FileText size={13} />, chip: 'bg-blue-50 text-blue-700' },
  Job: { label: 'Jobs', icon: <Package size={13} />, chip: 'bg-amber-50 text-amber-700' },
  Inventory: { label: 'Inventory', icon: <Box size={13} />, chip: 'bg-emerald-50 text-emerald-700' },
};

const SEARCH_GROUP_ORDER: Array<SearchResult['type']> = ['Customer', 'Invoice', 'Job', 'Inventory'];

/** Bolds the first case-insensitive match so users see *why* a row matched. */
const Highlight: React.FC<{ text: string; needle: string }> = ({ text, needle }) => {
  if (!needle || needle.length < 2) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-amber-200/80 px-px text-inherit">{text.slice(idx, idx + needle.length)}</mark>
      {text.slice(idx + needle.length)}
    </>
  );
};

interface SearchModalProps {
  open: boolean;
  locationKey: string;
  customers: Array<{ name?: string; phone?: string; email?: string }>;
  invoices: Array<{ invoiceNumber?: string; id?: string; customerName?: string }>;
  jobOrders: Array<{ jobName?: string; title?: string; orderNumber?: string; id?: string; status?: string }>;
  inventoryItems: Array<{ name?: string; sku?: string }>;
  onClose: (returnFocus: boolean) => void;
  onNavigate: (link: string, label: string) => void;
}

const SearchModal: React.FC<SearchModalProps> = ({
  open,
  locationKey,
  customers,
  invoices,
  jobOrders,
  inventoryItems,
  onClose,
  onNavigate,
}) => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [scope, setScope] = useState<SearchScope>('All');
  const [recentVersion, setRecentVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const recent = useMemo(() => (open ? readRecentSearches() : []), [open, recentVersion]);

  // reset per open / route change
  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setActiveIndex(0);
      setScope('All');
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, locationKey]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [query]);

  const isSearching = query.trim().length >= 2 && query.trim().toLowerCase() !== debounced;

  const { groups, counts } = useMemo(() => {
    if (debounced.length < 2) return { groups: [] as SearchResult[][], counts: null as null | Record<SearchResult['type'], number> };
    const counts: Record<SearchResult['type'], number> = { Customer: 0, Invoice: 0, Job: 0, Inventory: 0 };
    const buckets: Record<SearchResult['type'], SearchResult[]> = { Customer: [], Invoice: [], Job: [], Inventory: [] };
    const push = (type: SearchResult['type'], item: SearchResult) => {
      counts[type] += 1;
      if (buckets[type].length < 4) buckets[type].push(item);
    };
    for (const c of customers) {
      // Business Name — never the contact name.
      const label = getCustomerOptionLabel(c);
      if (label.toLowerCase().includes(debounced) || c.name?.toLowerCase().includes(debounced)) {
        push('Customer', { type: 'Customer', label, sublabel: c.phone || c.email || '', link: '/sales-flow/clients', icon: <Users size={14} /> });
      }
    }
    for (const inv of invoices) {
      const num = inv.invoiceNumber || inv.id;
      if (String(num ?? '').toLowerCase().includes(debounced) || inv.customerName?.toLowerCase().includes(debounced)) {
        push('Invoice', { type: 'Invoice', label: String(num ?? ''), sublabel: inv.customerName || '', link: '/sales-flow/invoices', icon: <FileText size={14} /> });
      }
    }
    for (const job of jobOrders) {
      const name = job.jobName || job.title || job.orderNumber || job.id;
      if (String(name ?? '').toLowerCase().includes(debounced)) {
        push('Job', { type: 'Job', label: String(name ?? ''), sublabel: job.status || '', link: '/industrial/work-orders', icon: <Package size={14} /> });
      }
    }
    for (const item of inventoryItems) {
      if (item.name?.toLowerCase().includes(debounced) || item.sku?.toLowerCase().includes(debounced)) {
        push('Inventory', { type: 'Inventory', label: item.name ?? '', sublabel: item.sku || '', link: '/supply-chain/inventory', icon: <Box size={14} /> });
      }
    }
    return { groups: SEARCH_GROUP_ORDER.map((t) => buckets[t]), counts };
  }, [debounced, customers, invoices, jobOrders, inventoryItems]);

  /** Flat keyboard-nav order, honouring the scope filter. */
  const results = useMemo(() => {
    const flat = SEARCH_GROUP_ORDER.flatMap((t) =>
      scope === 'All' || scope === t ? (groups[SEARCH_GROUP_ORDER.indexOf(t)] ?? []) : []
    );
    return flat.slice(0, MAX_RESULTS);
  }, [groups, scope]);

  /** Regroup the sliced flat list so rendered order always matches arrow-key order. */
  const displayGroups = useMemo(
    () =>
      SEARCH_GROUP_ORDER.map((t) => ({ type: t, items: results.filter((r) => r.type === t) })).filter(
        (g) => g.items.length > 0
      ),
    [results]
  );

  useEffect(() => setActiveIndex(0), [debounced, scope]);

  // keep the keyboard-active row visible while arrowing through long lists
  useEffect(() => {
    document.getElementById(`apptopbar-search-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const clearRecent = useCallback(() => {
    try {
      localStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      /* non-fatal */
    }
    setRecentVersion((v) => v + 1);
  }, []);

  if (!open) return null;

  const goResult = (r: SearchResult) => onNavigate(r.link, r.label);
  const goFullSearch = () => onNavigate(`/search?q=${encodeURIComponent(query.trim())}`, query.trim());

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-slate-900/45 px-3 pb-8 pt-[9vh] backdrop-blur-sm motion-reduce:transition-none"
      onClick={() => onClose(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-[#e4ddd1] bg-[#FEFDFB] shadow-[0_40px_90px_-20px_rgba(0,0,0,.55),0_8px_24px_-8px_rgba(0,0,0,.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── header ── */}
        <div className="flex items-center gap-3 border-b border-[#e4ddd1] bg-gradient-to-b from-white to-[#faf8f3] px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#146b60] text-white shadow-sm">
            <Search size={15} />
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Global search"
            aria-expanded="true"
            aria-controls="apptopbar-search-results"
            aria-activedescendant={results[activeIndex] ? `apptopbar-search-${activeIndex}` : undefined}
            placeholder="Search…"
            className="min-w-0 flex-1 border-none bg-transparent text-[15px] font-medium text-[#0b3e39] outline-none placeholder:text-[#94a3b8]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onClose(true);
              } else if (e.key === 'ArrowDown' && results.length > 0) {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % results.length);
              } else if (e.key === 'ArrowUp' && results.length > 0) {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + results.length) % results.length);
              } else if (e.key === 'Enter') {
                if (results[activeIndex]) {
                  goResult(results[activeIndex]);
                } else if (debounced.length >= 2) {
                  goFullSearch();
                }
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="rounded-md p-1 text-[#5c6567] transition-colors hover:bg-[#eef7f6] focus-visible:outline-2 focus-visible:outline-[#146b60]"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="hidden rounded-md bg-[#eef7f6] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#5c6567] sm:inline">
              ESC
            </kbd>
          )}
        </div>

        {/* ── scope filter ── */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-[#eef2eb] bg-white px-3 py-2" role="tablist" aria-label="Search scope">
          {SEARCH_SCOPES.map((s) => {
            const n =
              s.id === 'All'
                ? counts
                  ? SEARCH_GROUP_ORDER.reduce((sum, t) => sum + (counts[t] || 0), 0)
                  : 0
                : (counts?.[s.id] ?? 0);
            const active = scope === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setScope(s.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[#146b60] ${
                  active ? 'bg-[#146b60] text-white shadow-sm' : 'text-[#5c6567] hover:bg-[#f6f1e7]'
                }`}
              >
                {s.label}
                {counts && n > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-px text-[10px] font-bold leading-tight ${
                      active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── body ── */}
        <div id="apptopbar-search-results" role="listbox" aria-label="Search results" className="max-h-[52vh] overflow-y-auto p-2">
          {debounced.length < 2 ? (
            <>
              {recent.length > 0 && (
                <div className="pb-1">
                  <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#94a3b8]">
                      <Clock size={11} /> Recent
                    </p>
                    <button
                      type="button"
                      onClick={clearRecent}
                      className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-[#94a3b8] transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-[#146b60]"
                    >
                      Clear
                    </button>
                  </div>
                  {recent.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="option"
                      aria-selected="false"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-[#0b3e39] transition-colors hover:bg-[#eef7f6] focus-visible:outline-2 focus-visible:outline-[#146b60]"
                      onClick={() => setQuery(r)}
                    >
                      <Clock size={13} className="shrink-0 text-[#94a3b8]" />
                      <span className="truncate">{r}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="px-3 pb-1 pt-2">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#94a3b8]">
                  Quick actions
                </p>
              </div>
              <div className="grid grid-cols-1 gap-1.5 p-1 sm:grid-cols-3">
                {[
                  { label: 'New invoice', sub: 'Sales flow', link: '/sales-flow/invoices', icon: <FileText size={15} /> },
                  { label: 'Open POS', sub: 'Terminal sale', link: '/sales-flow/pos', icon: <Receipt size={15} /> },
                  { label: 'View clients', sub: 'Customer ledger', link: '/sales-flow/clients', icon: <Users size={15} /> },
                ].map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => onNavigate(a.link, a.label)}
                    className="flex items-center gap-2.5 rounded-xl border border-[#eef2eb] bg-white px-3 py-2.5 text-left transition-all hover:border-[#a6d9d3] hover:bg-[#eef7f6] hover:shadow-sm focus-visible:outline-2 focus-visible:outline-[#146b60]"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#eef7f6] text-[#146b60]">
                      {a.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-[#0b3e39]">{a.label}</span>
                      <span className="block truncate text-[11px] text-[#5c6567]">{a.sub}</span>
                    </span>
                  </button>
                ))}
             </>
          ) : isSearching ? (
            <div className="space-y-1.5 p-1" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-3 rounded-xl px-3 py-2.5">
                  <div className="h-9 w-9 shrink-0 rounded-lg bg-slate-200/70" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-2/3 rounded bg-slate-200/70" />
                    <div className="h-2.5 w-1/3 rounded bg-slate-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                <Search size={22} />
              </span>
              <p className="mt-4 text-sm font-bold text-slate-700">No results for “{query.trim()}”</p>
              <p className="mt-1 text-xs text-slate-500">
                Check for typos, try a shorter term, or run it on the full search page.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded-full border border-[#ebe4d6] bg-white px-4 py-1.5 text-[12px] font-semibold text-[#5c6567] transition-colors hover:bg-[#f6f1e7] focus-visible:outline-2 focus-visible:outline-[#146b60]"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={goFullSearch}
                  className="rounded-full bg-[#146b60] px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-[#0f544c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60]"
                >
                  Open full search
                </button>
              </div>
            </div>
          ) : (
            <>
              {counts && (
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold text-[#5c6567]" role="status">
                  {results.length} shown
                  {SEARCH_GROUP_ORDER.filter((t) => (counts[t] || 0) > 0)
                    .map((t) => ` • ${t}: ${counts[t]}`)
                    .join('')}
                </p>
              )}
              {displayGroups.map((g) => {
                const meta = SEARCH_GROUP_META[g.type];
                return (
                  <div key={g.type}>
                    <div className="flex items-center gap-2 px-3 pb-1 pt-3">
                      <span className={`flex h-5 w-5 items-center justify-center rounded-md ${meta.chip}`}>
                        {meta.icon}
                      </span>
                      <h3 className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#5c6567]">
                        {meta.label}
                      </h3>
                      <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-bold text-slate-500">
                        {counts?.[g.type] ?? g.items.length}
                      </span>
                      <span aria-hidden="true" className="h-px flex-1 bg-[#eef2eb]" />
                    </div>
                    {g.items.map((r) => {
                      const flatIndex = results.indexOf(r);
                      const isActive = flatIndex === activeIndex;
                      return (
                        <button
                          key={`${r.type}-${r.label}-${flatIndex}`}
                          id={`apptopbar-search-${flatIndex}`}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[#146b60] ${
                            isActive ? 'bg-[#eef7f6] ring-1 ring-inset ring-[#a6d9d3]' : 'hover:bg-slate-50'
                          }`}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onClick={() => goResult(r)}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#eef7f6] text-[#146b60]">
                            {r.icon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-[#0b3e39]">
                              <Highlight text={r.label} needle={debounced} />
                            </span>
                            {r.sublabel && (
                              <span className="block truncate text-[11px] text-[#5c6567]">
                                <Highlight text={r.sublabel} needle={debounced} />
                              </span>
                            )}
                          </span>
                          {isActive ? (
                            <CornerDownLeft size={14} className="shrink-0 text-[#146b60]" aria-hidden="true" />
                          ) : (
                            <ArrowRight size={14} className="shrink-0 text-slate-300" aria-hidden="true" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* ── footer ── */}
        <div className="flex items-center justify-between gap-3 border-t border-[#e4ddd1] bg-[#faf8f3] px-4 py-2.5">
          <div className="hidden items-center gap-3 text-[11px] font-medium text-[#94a3b8] sm:flex" aria-hidden="true">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[#e4ddd1] bg-white px-1.5 py-px font-mono text-[10px] font-bold">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[#e4ddd1] bg-white px-1.5 py-px font-mono text-[10px] font-bold">↵</kbd>
              open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[#e4ddd1] bg-white px-1.5 py-px font-mono text-[10px] font-bold">esc</kbd>
              close
            </span>
          </div>
          {debounced.length >= 2 && !isSearching ? (
            <button
              type="button"
              className="ml-auto flex items-center gap-1.5 rounded-full bg-[#146b60] px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-[#0f544c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#146b60]"
              onClick={goFullSearch}
            >
              See all results for “{query.trim()}” <ArrowRight size={13} aria-hidden="true" />
            </button>
          ) : (
            <span className="ml-auto text-[11px] text-[#94a3b8]">Search across the whole workspace</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppTopBar;
