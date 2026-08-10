import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi, portalLifecycle, PortalPromotionInfo } from '../../services/portalApiClient';
import { useCustomerAuth } from '../../context/CustomerAuthContext';
import { usePortalData } from './hooks/usePortalData';
import ErrorBanner from './components/ErrorBanner';
import PortalLoadingSkeleton from './components/PortalLoadingSkeleton';
import {
  Building2,
  CreditCard,
  ShoppingBag,
  ClipboardList,
  Truck,
  Gift,
  Wallet,
  FileText,
  ChevronRight,
  ChevronLeft,
  ArrowRight,
  ExternalLink,
  Percent,
} from 'lucide-react';

interface DashboardData {
  balance: number;
  walletBalance: number;
  outstandingBalance: number;
  creditLimit: number;
  unpaidInvoiceCount: number;
  totalOrders: number;
  activeRequestCount: number;
  openQuotationCount: number;
  productionOrderCount: number;
  unreadMessageCount: number;
  activeDeliveries: number;
  recentDocuments: any[];
  recentTransactions: any[];
  pendingDeliveries: any[];
  health: any;
}

interface UnpaidInvoice {
  id: string;
  invoice_number: string;
  total_amount: number;
  status: string;
  due_date: string;
  created_at: string;
}

interface Slide {
  id: string;
  gradient: string;
  icon: React.ReactNode;
  badge: string;
  title: string;
  subtitle: React.ReactNode;
  cta?: { label: string; to: string };
  onClick: () => void;
}

const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

const fmtMoney = (n: number) =>
  '$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const mwk = (v: number) => `MWK ${Math.round(Number(v) || 0).toLocaleString()}`;

const discountLabel = (p: PortalPromotionInfo): string => {
  const type = String(p.discountType || 'percentage');
  const value = Number(p.discountValue ?? 0) || 0;
  if (type === 'percentage') return `${value}% OFF`;
  if (type === 'fixed_price') return `${mwk(value)} each`;
  if (type === 'buy_x_get_y') return 'Buy X Get Y';
  return `${mwk(value)} OFF`;
};

const promoToSlide = (p: PortalPromotionInfo, navigate: (to: string) => void): Slide => {
  const ends = p.endsAt ? new Date(p.endsAt) : null;
  const endsLabel =
    ends && !Number.isNaN(ends.getTime())
      ? ` · ends ${ends.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : '';
  const minOrder = p.minimumOrderAmount ? ` · min order ${mwk(p.minimumOrderAmount)}` : '';
  const isAuto = p.isAutoApply !== false;
  return {
    id: `promo-${p.id}`,
    gradient: 'linear-gradient(120deg,#0b3e39 0%,#0f544c 55%,#008A4C 130%)',
    icon: <Percent size={22} />,
    badge: '✦ Portal Exclusive Offer',
    title: `${p.name}${p.code ? ` · ${p.code}` : ''}`,
    subtitle: (
      <>
        Save <strong style={{ color: '#fff' }}>{discountLabel(p)}</strong>
        {endsLabel}
        {minOrder}
        {isAuto ? ' · auto-applied at checkout' : ''}
      </>
    ),
    cta: { label: 'Order now', to: '/portal/new-request' },
    onClick: () => navigate('/portal/new-request'),
  };
};

const buildFallbackSlides = (
  navigate: (to: string) => void,
  displayName: string
): Slide[] => [
  {
    id: 'welcome',
    gradient: 'linear-gradient(135deg,#0F2C59 0%,#1E3A8A 100%)',
    icon: <Building2 size={22} />,
    badge: 'Welcome',
    title: `Welcome, ${displayName.split(' ')[0] || 'Customer'}!`,
    subtitle: (
      <>Enterprise B2B Portal — real-time tracking, quotes, statements &amp; payments.</>
    ),
    onClick: () => navigate('/portal/catalog'),
  },
  {
    id: 'catalog',
    gradient: 'linear-gradient(135deg,#065F46 0%,#059669 100%)',
    icon: <ShoppingBag size={22} />,
    badge: 'New Orders',
    title: 'Browse the Catalog',
    subtitle: (
      <>Place new orders, request quotes and track every step in real time.</>
    ),
    onClick: () => navigate('/portal/catalog'),
  },
  {
    id: 'payments',
    gradient: 'linear-gradient(135deg,#7C2D12 0%,#D97706 100%)',
    icon: <CreditCard size={22} />,
    badge: 'Payments',
    title: 'Stay on Top of Payments',
    subtitle: (
      <>Pay invoices online, view statements and monitor your account balance.</>
    ),
    onClick: () => navigate('/portal/statements'),
  },
];

// Scoped premium styling (hover lifts, arrow reveals, icon chips).
const DASHBOARD_CSS = `
  .cpd-card { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .cpd-card:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -18px rgba(15,44,89,.28) !important; }
  .cpd-card:active { transform: translateY(0) scale(.995); }
  .cpd-card-arrow { opacity: 0; transform: translateX(-5px); transition: all .18s ease; }
  .cpd-card:hover .cpd-card-arrow { opacity: 1 !important; transform: translateX(0); }
  .cpd-qicon { transition: transform .18s ease, box-shadow .18s ease; }
  .cpd-card:hover .cpd-qicon { transform: translateY(-2px) scale(1.07); }
  .cpd-ghost { transition: all .15s ease; }
  .cpd-ghost:hover { background: #EEF2FF !important; border-color: #C7D2FE !important; }
  .cpd-link { transition: color .15s ease, gap .15s ease; }
  .cpd-link:hover { color: #1D4ED8 !important; gap: 6px !important; }
  .cpd-row { transition: background .15s ease; }
  .cpd-row:hover { background: #F8FAFF !important; }
  @media (max-width: 480px) {
    .cpd-carousel-cta { display: none !important; }
    .cpd-carousel-arrow { display: none !important; }
  }
`;

const CustomerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useCustomerAuth();
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [promotions, setPromotions] = useState<PortalPromotionInfo[] | null>(null);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const touchX = useRef<number | null>(null);

  const displayName = user?.full_name || 'Customer';
  const accountId = user?.customer_id || '';
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);

  const { loading, error, refresh, clearError } = usePortalData<DashboardData>({
    key: '/dashboard',
    label: 'Dashboard',
    fetcher: () => portalApi.get<DashboardData>('/dashboard'),
    onData: async (data) => {
      setDashboardData(data);
      try {
        const inv = await portalApi.get<{ invoices: UnpaidInvoice[] }>('/invoices?status=Unpaid');
        setUnpaidInvoices((inv.invoices || []).slice(0, 5));
      } catch {
        setUnpaidInvoices([]);
      }
    },
  });

  // Live portal promotions for the banner carousel (display only).
  useEffect(() => {
    let cancelled = false;
    portalLifecycle.promotions
      .list()
      .then((list) => {
        if (!cancelled) setPromotions(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setPromotions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let off = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const T = ['invoice', 'order', 'sale', 'payment', 'quotation', 'request', 'shipment'];
      unsub = await portalLifecycle.subscribe({
        onEvent: (type, p) => {
          const dt = p?.docType;
          if ((p?.event === 'payment_allocated' || (dt && T.includes(dt)) || type === 'activity') && !off)
            refresh();
        },
      });
    })();
    return () => {
      off = true;
      unsub?.();
    };
  }, [refresh]);

  // Banner slides: live promotions first, padded with curated slides so the
  // carousel always has at least 3 slides.
  const slides = useMemo<Slide[]>(() => {
    const promoSlides = (promotions || []).map((p) => promoToSlide(p, navigate));
    const fallbacks = buildFallbackSlides(navigate, displayName);
    const count = Math.max(3, promoSlides.length);
    return [...promoSlides, ...fallbacks].slice(0, count);
  }, [promotions, navigate, displayName]);

  // Clamp index when the slide set changes (e.g. promotions arrive).
  useEffect(() => {
    if (active >= slides.length) setActive(0);
  }, [active, slides.length]);

  // Auto-advance, paused while hovered, when the tab is hidden, or when the
  // user prefers reduced motion.
  useEffect(() => {
    if (hovered || slides.length <= 1) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setActive((a) => (a + 1) % slides.length);
    }, 4500);
    return () => clearInterval(id);
  }, [hovered, slides.length]);

  if (loading) return <div style={{ padding: 12 }}><PortalLoadingSkeleton type="card" count={6} /></div>;
  if (error) return <div style={{ padding: 12 }}><ErrorBanner message={error} onDismiss={clearError} onRetry={refresh} /></div>;

  return (
    <div style={{ fontFamily: F, fontSize: 13, lineHeight: 1.4, color: '#1E293B', background: '#F5F6FA', minHeight: '100vh' }}>
      <style>{DASHBOARD_CSS}</style>

      {/* Account Header */}
      <div style={{ padding: '14px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', margin: 0, lineHeight: 1.2 }}>{displayName}</h1>
            <p style={{ fontSize: 12, color: '#64748B', margin: '2px 0 0' }}>Account ID: {accountId}</p>
          </div>
          <button
            onClick={() => navigate('/portal/profile')}
            className="cpd-ghost"
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10,
              padding: '7px 13px', fontSize: 12, fontWeight: 600, color: '#0F2C59',
              cursor: 'pointer', boxShadow: '0 1px 3px rgba(15,23,42,.05)',
            }}
          >
            View Profile <ExternalLink size={12} />
          </button>
        </div>
      </div>

      {/* Promotions Carousel Banner */}
      <div
        className="cpd-carousel"
        role="region"
        aria-roledescription="carousel"
        aria-label="Promotions and updates"
        style={{
          margin: '0 16px 16px', borderRadius: 16, overflow: 'hidden', position: 'relative',
          boxShadow: '0 18px 40px -22px rgba(15,44,89,.55)',
          border: '1px solid rgba(255,255,255,.12)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          touchX.current = null;
          if (Math.abs(dx) > 40) {
            setActive((a) => (dx < 0 ? (a + 1) % slides.length : (a - 1 + slides.length) % slides.length));
          }
        }}
      >
        <div
          aria-live="polite"
          style={{
            display: 'flex',
            transition: 'transform .65s cubic-bezier(.4,0,.2,1)',
            transform: `translateX(-${active * 100}%)`,
          }}
        >
          {slides.map((s) => (
            <div
              key={s.id}
              onClick={s.onClick}
              style={{ minWidth: '100%', position: 'relative', background: s.gradient, cursor: 'pointer', overflow: 'hidden' }}
            >
              <div style={{ position: 'absolute', right: -40, top: -60, width: 190, height: 190, borderRadius: '50%', background: 'rgba(255,255,255,.07)' }} />
              <div style={{ position: 'absolute', left: -50, bottom: -90, width: 210, height: 210, borderRadius: '50%', background: 'rgba(255,255,255,.05)' }} />
              <div
                style={{
                  position: 'relative', padding: '16px 52px 22px 16px',
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minHeight: 92,
                }}
              >
                <div
                  style={{
                    width: 40, height: 40, borderRadius: 11, flexShrink: 0,
                    background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.24)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                    boxShadow: '0 4px 10px -4px rgba(0,0,0,.35)',
                  }}
                >
                  {s.icon}
                </div>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(255,255,255,.72)', marginBottom: 2 }}>
                    {s.badge}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', lineHeight: 1.25 }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.8)', marginTop: 1, lineHeight: 1.45 }}>{s.subtitle}</div>
                </div>
                {s.cta ? (
                  <button
                    className="cpd-carousel-cta"
                    onClick={(e) => { e.stopPropagation(); navigate(s.cta!.to); }}
                    style={{
                      flexShrink: 0, padding: '8px 14px', borderRadius: 10, border: 'none',
                      background: '#fff', color: '#0b3e39', fontSize: 12, fontWeight: 800, cursor: 'pointer',
                      boxShadow: '0 6px 16px -6px rgba(0,0,0,.4)',
                      display: 'flex', alignItems: 'center', gap: 5,
                      transition: 'transform .15s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.04)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                  >
                    {s.cta.label} <ChevronRight size={12} />
                  </button>
                ) : (
                  <div className="cpd-carousel-cta" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, color: 'rgba(255,255,255,.92)', fontSize: 11, fontWeight: 700 }}>
                    Explore <ArrowRight size={12} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Arrows */}
        {slides.length > 1 && (
          <>
            <button
              aria-label="Previous slide"
              className="cpd-carousel-arrow"
              onClick={() => setActive((a) => (a - 1 + slides.length) % slides.length)}
              style={{
                position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)',
                width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: 'rgba(255,255,255,.22)', color: '#fff', fontSize: 15, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(4px)', zIndex: 2,
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              aria-label="Next slide"
              className="cpd-carousel-arrow"
              onClick={() => setActive((a) => (a + 1) % slides.length)}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: 'rgba(255,255,255,.22)', color: '#fff', fontSize: 15, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(4px)', zIndex: 2,
              }}
            >
              <ChevronRight size={14} />
            </button>
          </>
        )}

        {/* Dots */}
        {slides.length > 1 && (
          <div style={{ position: 'absolute', bottom: 4, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, zIndex: 2 }}>
            {slides.map((s, i) => (
              <button
                key={s.id}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === active ? 'true' : undefined}
                onClick={() => setActive(i)}
                style={{
                  width: 22, height: 18, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: i === active ? 18 : 6, height: 6, borderRadius: 3,
                    background: i === active ? '#fff' : 'rgba(255,255,255,.45)',
                    transition: 'all .25s ease',
                    boxShadow: i === active ? '0 1px 4px rgba(0,0,0,.3)' : 'none',
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Account Summary */}
      <div style={{ padding: '0 16px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', margin: 0 }}>Account Summary</h2>
          <button
            onClick={() => navigate('/portal/statements')}
            className="cpd-link"
            style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 2 }}
          >
            View All <ArrowRight size={12} />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {/* Unpaid Invoices */}
          <div
            onClick={() => navigate('/portal/invoices?status=Unpaid')}
            className="cpd-card"
            style={{
              position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(150deg,#FEF2F2 0%,#FFFFFF 65%)',
              borderRadius: 16, padding: '14px 12px 12px', border: '1px solid #FECACA', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(220,38,38,.06)', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ position: 'absolute', top: -20, right: -20, width: 70, height: 70, borderRadius: '50%', background: 'rgba(220,38,38,.07)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: '#FEE2E2', color: '#DC2626', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(220,38,38,.18)' }}>
                <FileText size={14} />
              </div>
              <ChevronRight size={14} color="#DC2626" className="cpd-card-arrow" />
            </div>
             <div style={{ fontSize: 10.5, fontWeight: 700, color: '#991B1B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Unpaid Invoices</div>
             <div style={{ fontSize: 18, fontWeight: 800, color: '#991B1B', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>{dashboardData?.unpaidInvoiceCount ?? 0}</div>
             <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginTop: 5 }}>1 Overdue</div>
          </div>
          {/* Active Deliveries */}
          <div
            onClick={() => navigate('/portal/shipments')}
            className="cpd-card"
            style={{
              position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(150deg,#EFF6FF 0%,#FFFFFF 65%)',
              borderRadius: 16, padding: '14px 12px 12px', border: '1px solid #BFDBFE', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(37,99,235,.06)', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ position: 'absolute', top: -20, right: -20, width: 70, height: 70, borderRadius: '50%', background: 'rgba(37,99,235,.07)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: '#DBEAFE', color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(37,99,235,.18)' }}>
                <Truck size={14} />
              </div>
              <ChevronRight size={14} color="#2563EB" className="cpd-card-arrow" />
            </div>
             <div style={{ fontSize: 10.5, fontWeight: 700, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Active Deliveries</div>
             <div style={{ fontSize: 18, fontWeight: 800, color: '#1E40AF', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>{dashboardData?.activeDeliveries ?? 0}</div>
             <div style={{ fontSize: 11, fontWeight: 600, color: '#2563EB', marginTop: 5 }}>Real-time Tracking</div>
          </div>
          {/* Available Credit */}
          <div
            onClick={() => navigate('/portal/wallet')}
            className="cpd-card"
            style={{
              position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(150deg,#ECFDF5 0%,#FFFFFF 65%)',
              borderRadius: 16, padding: '14px 12px 12px', border: '1px solid #A7F3D0', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(5,150,105,.06)', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ position: 'absolute', top: -20, right: -20, width: 70, height: 70, borderRadius: '50%', background: 'rgba(5,150,105,.07)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: '#D1FAE5', color: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(5,150,105,.18)' }}>
                <Wallet size={14} />
              </div>
              <ChevronRight size={14} color="#059669" className="cpd-card-arrow" />
            </div>
             <div style={{ fontSize: 10.5, fontWeight: 700, color: '#065F46', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Available Credit</div>
             <div style={{ fontSize: 18, fontWeight: 800, color: '#065F46', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>{fmtMoney(dashboardData?.creditLimit)}</div>
             <div style={{ fontSize: 11, fontWeight: 600, color: '#059669', marginTop: 5 }}>Available</div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ padding: '0 16px', marginBottom: 18 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', margin: '0 0 10px' }}>Quick Actions</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {[
            { label: 'Pay Invoices', icon: <CreditCard size={18} />, to: '/portal/invoices?status=Unpaid', bg: 'linear-gradient(135deg,#1E3A8A,#0F2C59)', glow: '0 6px 14px -6px rgba(15,44,89,.5)' },
            { label: 'New Order', icon: <ShoppingBag size={18} />, to: '/portal/catalog', bg: 'linear-gradient(135deg,#059669,#065F46)', glow: '0 6px 14px -6px rgba(5,150,105,.5)' },
            { label: 'Get Quote', icon: <ClipboardList size={18} />, to: '/portal/requests', bg: 'linear-gradient(135deg,#D97706,#92400E)', glow: '0 6px 14px -6px rgba(217,119,6,.5)' },
            { label: 'Track Shipments', icon: <Truck size={18} />, to: '/portal/shipments', bg: 'linear-gradient(135deg,#2563EB,#1E40AF)', glow: '0 6px 14px -6px rgba(37,99,235,.5)' },
            { label: 'Refer Business', icon: <Gift size={18} />, to: '/portal/referrals', bg: 'linear-gradient(135deg,#7C3AED,#5B21B6)', glow: '0 6px 14px -6px rgba(124,58,237,.5)' },
            { label: 'Statements', icon: <Wallet size={18} />, to: '/portal/statements', bg: 'linear-gradient(135deg,#0D9488,#115E59)', glow: '0 6px 14px -6px rgba(13,148,136,.5)' },
          ].map((a, i) => (
            <div
              key={i}
              onClick={() => navigate(a.to)}
              className="cpd-card"
              style={{
                background: '#fff', borderRadius: 16, padding: '15px 10px 13px',
                border: '1px solid #E8EDF5', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, cursor: 'pointer',
                boxShadow: '0 1px 4px rgba(15,23,42,.05)',
              }}
            >
              <div
                className="cpd-qicon"
                style={{
                  width: 40, height: 40, borderRadius: 12, background: a.bg, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: a.glow, border: '1px solid rgba(255,255,255,.25)',
                }}
              >
                {a.icon}
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>{a.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Unpaid Invoices Needing Attention */}
      <div style={{ padding: '0 16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', margin: 0 }}>Unpaid Invoices Needing Attention</h2>
          <button
            onClick={() => navigate('/portal/invoices?status=Unpaid')}
            className="cpd-link"
            style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 2 }}
          >
            View All <ArrowRight size={12} />
          </button>
        </div>
        {unpaidInvoices.length === 0 ? (
          <div
            style={{
              background: 'linear-gradient(150deg,#FFFFFF,#F8FAFF)', borderRadius: 16,
              border: '1px solid #E8EDF5', padding: 26, textAlign: 'center', color: '#94A3B8', fontSize: 12,
              boxShadow: '0 1px 4px rgba(15,23,42,.04)',
            }}
          >
            No unpaid invoices
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #E8EDF5', overflow: 'hidden', boxShadow: '0 1px 4px rgba(15,23,42,.04)' }}>
            {unpaidInvoices.map((inv, i) => (
              <div
                key={inv.id}
                onClick={() => navigate(`/portal/invoices/${inv.id}`)}
                className="cpd-row"
                style={{
                  display: 'flex', alignItems: 'center', padding: '13px 14px',
                  borderTop: i > 0 ? '1px solid #F1F5F9' : undefined, cursor: 'pointer',
                }}
              >
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#FEF2F2', color: '#DC2626', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 10, flexShrink: 0 }}>
                  <FileText size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', lineHeight: 1.3 }}>{inv.invoice_number || inv.id}</div>
                  <div style={{ fontSize: 11, color: '#64748B', marginTop: 1 }}>Invoice Date: {inv.created_at ? new Date(inv.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {/overdue/i.test(String(inv.status || '')) && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', background: '#FEF2F2', padding: '2px 8px', borderRadius: 5, textTransform: 'uppercase' }}>Overdue</span>
                  )}
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(inv.total_amount || 0)}</span>
                  <ChevronRight size={16} color="#CBD5E0" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CustomerDashboard;
