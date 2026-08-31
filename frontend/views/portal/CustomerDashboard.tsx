import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi, portalLifecycle, PortalPromotionInfo, PortalAdInfo, PortalDeliveryBanner } from '../../services/portalApiClient';
import { useCustomerAuth } from '../../context/CustomerAuthContext';
import { useAuth } from '../../context/AuthContext';
import { usePortalData } from './hooks/usePortalData';
import { QuoteRequestItem } from '../../types';
import ErrorBanner from './components/ErrorBanner';
import PortalLoadingSkeleton from './components/PortalLoadingSkeleton';
import ModernKPICard from './components/ModernKPICard';
import PremiumKPICard from './components/PremiumKPICard';
import PromotionBanner from './components/PromotionBanner';
import { QuoteRequestModal } from './components/QuoteRequestModal';
import { useToast } from './components/Toast';
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
  Percent,
  Bell,
  Menu,
  PackageCheck,
  Sparkles,
  TrendingUp,
  Eye,
  Clock,
  CheckCircle,
  Star,
} from 'lucide-react';
import { F, MONO, NAVY, TEAL_GRADIENT, EMERALD, INDIGO_GRADIENT, VIOLET_GRADIENT, ROSE_GRADIENT, AMBER_GRADIENT } from './designTokens';

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
  imageUrl?: string;
  cta?: { label: string; to: string };
  onClick: () => void;
}

const fmtMoney = (n: number) =>
  'K' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const mwk = (v: number) => `MWK ${Math.round(Number(v) || 0).toLocaleString()}`;

const discountLabel = (p: PortalPromotionInfo): string => {
  const type = String(p.discountType || 'percentage');
  const value = Number(p.discountValue ?? 0) || 0;
  if (type === 'percentage') return `${value}% OFF`;
  if (type === 'fixed_price') return `${mwk(value)} each`;
  if (type === 'buy_x_get_y') return 'Buy X Get Y';
  return `${mwk(value)} OFF`;
};

const adToSlide = (ad: PortalAdInfo, navigate: (to: string) => void): Slide => {
  const ctaTo = ad.ctaTarget || '/portal/orders';
  const ends = ad.endsAt ? new Date(ad.endsAt) : null;
  const endsLabel =
    ends && !Number.isNaN(ends.getTime())
      ? ` · ends ${ends.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : '';
  return {
    id: `ad-${ad.id}`,
    gradient: ad.gradient || 'linear-gradient(135deg, #4F46E5 0%, #3730A3 100%)',
    imageUrl: ad.imageUrl || undefined,
    icon: <span style={{ fontSize: 22 }}>{ad.emoji || '🎯'}</span>,
    badge: ad.badge || 'Sponsored',
    title: ad.title || '',
    subtitle: ad.subtitle
      ? (<>{ad.subtitle}{endsLabel}</>)
      : ad.imageUrl
        ? (<></>)
        : (<>{'Explore our latest offers.'}{endsLabel}</>),
    cta: { label: ad.ctaLabel || 'Order Now', to: ctaTo },
    onClick: () => navigate(ctaTo),
  };
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
    gradient: 'linear-gradient(120deg, #7C3AED 0%, #5B21B6 55%, #4F46E5 130%)',
    icon: <Percent size={22} />,
    badge: '✦ Exclusive Offer',
    title: `${p.name}${p.code ? ` · ${p.code}` : ''}`,
    subtitle: (
      <>
        Save <strong style={{ color: '#fff' }}>{discountLabel(p)}</strong>
        {endsLabel}
        {minOrder}
        {isAuto ? ' · auto-applied' : ''}
      </>
    ),
    cta: { label: 'Order now', to: '/portal/new-request' },
    onClick: () => navigate('/portal/new-request'),
  };
};

const deliveryToSlide = (b: PortalDeliveryBanner, navigate: (to: string) => void): Slide => {
  const ref = b.invoiceNumber ? `invoice ${b.invoiceNumber}` : (b.orderNumber ? `order ${b.orderNumber}` : 'your order');
  const config = ({
    inbound: {
      gradient: 'linear-gradient(135deg, #2563EB 0%, #1E40AF 100%)',
      badge: 'Out of Warehouse',
      title: 'Your delivery is on the move',
      msg: `Delivery for ${ref} is out of the warehouse.`,
    },
    active: {
      gradient: 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)',
      badge: 'Out for Delivery',
      title: 'Your delivery is on its way',
      msg: `Delivery for ${ref} is out for delivery.`,
    },
    delivered: {
      gradient: 'linear-gradient(135deg, #059669 0%, #065F46 100%)',
      badge: 'Delivered',
      title: 'Delivery complete',
      msg: `Delivery for ${ref} has been delivered.`,
    },
  } as Record<string, { gradient: string; badge: string; title: string; msg: string }>)[b.stage] || {
    gradient: 'linear-gradient(135deg, #2563EB 0%, #1E40AF 100%)',
    badge: 'Delivery Update',
    title: 'Delivery update',
    msg: `Delivery for ${ref} has an update.`,
  };
  return {
    id: `delivery-${b.id}`,
    gradient: config.gradient,
    icon: <PackageCheck size={22} />,
    badge: config.badge,
    title: config.title,
    subtitle: config.msg,
    cta: { label: b.stage === 'delivered' ? 'View' : 'Track', to: '/portal/deliveries' },
    onClick: () => navigate('/portal/deliveries'),
  };
};

const buildFallbackSlides = (navigate: (to: string) => void, displayName: string, companyName: string): Slide[] => [
  {
    id: 'welcome',
    gradient: 'linear-gradient(135deg, #0F2C59 0%, #1E3A8A 100%)',
    icon: <Building2 size={22} />,
    badge: 'Welcome',
    title: `Welcome, ${displayName.split(' ')[0] || 'Customer'}!`,
    subtitle: (<>{companyName} — real-time tracking, quotes, statements & payments.</>),
    onClick: () => navigate('/portal/orders'),
  },
  {
    id: 'catalog',
    gradient: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
    icon: <ShoppingBag size={22} />,
    badge: 'New Orders',
    title: 'Browse the Catalog',
    subtitle: (<>Place new orders, request quotes and track every step in real time.</>),
    onClick: () => navigate('/portal/orders'),
  },
  {
    id: 'payments',
    gradient: 'linear-gradient(135deg, #D97706 0%, #B45309 100%)',
    icon: <CreditCard size={22} />,
    badge: 'Receipt',
    title: 'Stay on Top of Receipts',
    subtitle: (<>Pay invoices online, view statements and monitor your account balance.</>),
    onClick: () => navigate('/portal/account-statements'),
  },
];

const DASHBOARD_CSS = `
  .cpd-card { transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
  .cpd-card:hover { transform: translateY(-3px); box-shadow: 0 16px 40px -12px rgba(15,44,89,0.2) !important; }
  .cpd-card:active { transform: translateY(0) scale(.995); }
  .cpd-qicon { transition: transform .2s ease, box-shadow .2s ease; }
  .cpd-card:hover .cpd-qicon { transform: translateY(-2px) scale(1.08); }
  .cpd-ghost { transition: all .15s ease; }
  .cpd-ghost:hover { background: #EEF2FF !important; border-color: #C7D2FE !important; }
  .cpd-link { transition: color .15s ease, gap .15s ease; }
  .cpd-link:hover { color: #4F46E5 !important; gap: 6px !important; }
  .cpd-row { transition: background .15s ease; }
  .cpd-row:hover { background: #F8FAFF !important; }
  @keyframes cpdSlideIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .cpd-section { animation: cpdSlideIn 0.4s ease both; }
  @media (max-width: 480px) {
    .cpd-carousel-cta { display: none !important; }
    .cpd-carousel-arrow { display: none !important; }
  }
`;

const CustomerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useCustomerAuth();
  const { companyConfig } = useAuth();
  const { addToast } = useToast();
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [promotions, setPromotions] = useState<PortalPromotionInfo[] | null>(null);
  const [ads, setAds] = useState<PortalAdInfo[]>([]);
  const [deliveryBanners, setDeliveryBanners] = useState<PortalDeliveryBanner[]>([]);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const touchX = useRef<number | null>(null);

  const displayName = user?.full_name || 'Customer';
  const accountId = user?.customer_id || '';
  const companyName = companyConfig?.companyName || 'ERP';
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loyaltyTier, setLoyaltyTier] = useState<string>('');

  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const overdueInvoices = useMemo(
    () =>
      (unpaidInvoices || []).filter((inv) => {
        if (/overdue|past_due/i.test(String(inv.status || ''))) return true;
        if (!inv.due_date) return false;
        const due = new Date(inv.due_date);
        return !Number.isNaN(due.getTime()) && due < todayStart();
      }).length,
    [unpaidInvoices]
  );

  const creditLimitNum = Number(dashboardData?.creditLimit || 0);
  const outstandingNum = Math.max(0, Number(dashboardData?.outstandingBalance || 0));
  const creditUtilizationPct = creditLimitNum > 0 ? Math.round(Math.min(100, (outstandingNum / creditLimitNum) * 100)) : 0;
  const paymentHistory = Number(dashboardData?.health?.factors?.paymentHistory ?? 100);
  const onTimeScore = Number(dashboardData?.health?.factors?.overdueInvoices ?? 100);

  const { loading, error, refresh, clearError } = usePortalData<DashboardData>({
    key: '/dashboard',
    label: 'Dashboard',
    fetcher: () => portalApi.get<DashboardData>('/dashboard'),
    onData: async (data) => {
      setDashboardData(data);
      try {
        const inv = await portalApi.get<{ invoices: UnpaidInvoice[] }>('/invoices?status=Unpaid&pageSize=100');
        setUnpaidInvoices(inv.invoices || []);
      } catch {
        if (unpaidInvoices.length === 0) setUnpaidInvoices([]);
      }
    },
  });

  const loadDeliveryBanners = useCallback(() => {
    portalLifecycle.deliveries
      .banners()
      .then((list) => setDeliveryBanners(Array.isArray(list) ? list : []))
      .catch(() => setDeliveryBanners((prev) => prev));
  }, []);

  useEffect(() => {
    loadDeliveryBanners();
    const id = setInterval(loadDeliveryBanners, 60000);
    return () => clearInterval(id);
  }, [loadDeliveryBanners]);

  useEffect(() => {
    let cancelled = false;
    portalLifecycle.promotions.list().then((list) => { if (!cancelled) setPromotions(Array.isArray(list) ? list : []); }).catch(() => { if (!cancelled) setPromotions([]); });
    portalLifecycle.ads.list().then((list) => { if (!cancelled) setAds(Array.isArray(list) ? list : []); }).catch(() => { if (!cancelled) setAds([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    portalLifecycle.loyalty.get().then((data) => { if (!cancelled && data?.tier) setLoyaltyTier(data.tier); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notifRefreshFailed, setNotifRefreshFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    portalApi.get<{ count: number }>('/notifications/unread-count')
      .then((c) => { if (!cancelled) { setUnreadNotifications(c?.count ?? 0); setNotifRefreshFailed(false); } })
      .catch(() => { if (!cancelled) setNotifRefreshFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let off = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const T = ['invoice', 'order', 'sale', 'payment', 'quotation', 'request', 'shipment', 'delivery', 'delivery_note'];
      unsub = await portalLifecycle.subscribe({
        onEvent: (type, p) => {
          if ((p?.event === 'payment_allocated' || (p?.docType && T.includes(p.docType)) || type === 'activity' || type === 'notification') && !off) {
            refresh();
            loadDeliveryBanners();
            portalApi.get<{ count: number }>('/notifications/unread-count')
              .then((c) => { if (!off) { setUnreadNotifications(c?.count ?? 0); setNotifRefreshFailed(false); } })
              .catch(() => { if (!off) setNotifRefreshFailed(true); });
          }
        },
      });
    })();
    return () => { off = true; unsub?.(); };
  }, [refresh, loadDeliveryBanners]);

  const slides = useMemo<Slide[]>(() => {
    const deliverySlides = (deliveryBanners || []).map((b) => deliveryToSlide(b, navigate));
    const adSlides = ads.map((a) => adToSlide(a, navigate));
    const promoSlides = (promotions || []).map((p) => promoToSlide(p, navigate));
    const fallbacks = buildFallbackSlides(navigate, displayName, companyName);
    const count = Math.max(3, deliverySlides.length + adSlides.length + promoSlides.length);
    return [...deliverySlides, ...adSlides, ...promoSlides, ...fallbacks].slice(0, count);
  }, [deliveryBanners, ads, promotions, navigate, displayName, companyName]);

  useEffect(() => { if (active >= slides.length) setActive(0); }, [active, slides.length]);

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

  const displayedInvoices = unpaidInvoices.slice(0, 5);

  const handleQuoteSubmit = async (
    items: QuoteRequestItem[],
    requiredByDate: string,
    deliveryLocation: string,
    priority: 'standard' | 'urgent' | 'express',
    notes: string
  ) => {
    try {
      const extra = [priority && `Priority: ${priority}`, deliveryLocation && `Delivery: ${deliveryLocation}`].filter(Boolean).join('\n');
      await portalLifecycle.requests.create({
        requestType: 'quotation',
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.targetPrice || 0 })),
        notes: [notes, extra].filter(Boolean).join('\n\n') || undefined,
        requestedDeliveryDate: requiredByDate || null,
      });
      setShowQuoteModal(false);
      addToast('success', 'Quotation request submitted');
      navigate('/portal/quotations');
    } catch (err: any) {
      addToast('error', err.message || 'Failed to submit quotation request');
    }
  };

  const quickActions = [
    { label: 'Pay Invoices', icon: <CreditCard size={20} />, to: '/portal/invoices?status=Unpaid', bg: INDIGO_GRADIENT, delay: 0 },
    { label: 'New Order', icon: <ShoppingBag size={20} />, to: '/portal/orders', bg: TEAL_GRADIENT, delay: 50 },
    { label: 'Get Quote', icon: <ClipboardList size={20} />, to: '/portal/quotations', bg: VIOLET_GRADIENT, delay: 100 },
    { label: 'Track Shipments', icon: <Truck size={20} />, to: '/portal/deliveries', bg: AMBER_GRADIENT, delay: 150 },
    { label: 'Refer Business', icon: <Gift size={20} />, to: '/portal/referrals', bg: ROSE_GRADIENT, delay: 200 },
    { label: 'Statements', icon: <FileText size={20} />, to: '/portal/account-statements', bg: 'linear-gradient(135deg, #0F2C59 0%, #1E3A8A 100%)', delay: 250 },
  ];

  return (
    <div style={{ fontFamily: F, fontSize: 13.5, lineHeight: 1.5, color: '#1E293B', paddingBottom: 24 }}>
      <style>{DASHBOARD_CSS}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('toggle-portal-sidebar'))}
            aria-label="Toggle sidebar"
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              border: '1px solid rgba(226,232,240,0.8)',
              background: 'rgba(255,255,255,0.8)',
              backdropFilter: 'blur(8px)',
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#CBD5E1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.8)'; e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'; }}
          >
            <Menu size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/portal/notifications')}
            style={{
              position: 'relative',
              width: 40,
              height: 40,
              borderRadius: 12,
              border: '1px solid rgba(226,232,240,0.8)',
              background: 'rgba(255,255,255,0.8)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#475569',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#CBD5E1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.8)'; e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'; }}
          >
            <Bell size={18} />
            {unreadNotifications > 0 && (
              <span style={{
                position: 'absolute',
                top: -4,
                right: -4,
                minWidth: 18,
                height: 18,
                padding: '0 5px',
                borderRadius: 9,
                background: '#DC2626',
                color: '#fff',
                fontSize: 10,
                fontWeight: 800,
                lineHeight: '18px',
                textAlign: 'center',
                border: '2px solid #fff',
              }}>
                {unreadNotifications}
              </span>
            )}
          </button>
          <button
            onClick={() => navigate('/portal/profile')}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: INDIGO_GRADIENT,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
              border: 'none',
              boxShadow: '0 4px 12px -2px rgba(79,70,229,0.35)',
            }}
          >
            {displayName.charAt(0).toUpperCase()}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{
              fontSize: 26,
              fontWeight: 800,
              color: '#0F172A',
              margin: 0,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
            }}>
              Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {displayName.split(' ')[0]}
            </h1>
            <p style={{ fontSize: 13, color: '#64748B', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{companyName}</span>
              <span style={{ color: '#E2E8F0' }}>·</span>
              <span>Account ID: {accountId}</span>
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {loyaltyTier && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 9999,
                background: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)',
                border: '1px solid #FCD34D',
                boxShadow: '0 2px 8px -2px rgba(245,158,11,0.25)',
              }}>
                <Star size={14} fill="#D97706" color="#D97706" />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#92400E' }}>{loyaltyTier}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="cpd-carousel"
        role="region"
        aria-roledescription="carousel"
        aria-label="Promotions and updates"
        style={{
          marginBottom: 24,
          borderRadius: 20,
          overflow: 'hidden',
          position: 'relative',
          boxShadow: '0 8px 32px -8px rgba(15,44,89,0.15), inset 0 0 0 1px rgba(255,255,255,0.1)',
          border: '1px solid rgba(226,232,240,0.6)',
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
            transition: 'transform .5s cubic-bezier(.4,0,.2,1)',
            transform: `translateX(-${active * 100}%)`,
          }}
        >
          {slides.map((s) => {
            const hasImage = Boolean(s.imageUrl);
            const hasText = Boolean(s.title || s.subtitle);
            return (
              <div
                key={s.id}
                onClick={s.onClick}
                style={{
                  minWidth: '100%',
                  position: 'relative',
                  aspectRatio: '21 / 9',
                  minHeight: 120,
                  background: hasImage ? s.gradient : s.gradient,
                  cursor: 'pointer',
                  overflow: 'hidden',
                }}
              >
                {hasImage && (
                  <img src={s.imageUrl} alt={s.title || 'Promotion'} loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
                {hasImage && hasText && (
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(15,44,89,0.85) 0%, rgba(15,44,89,0.5) 50%, rgba(15,44,89,0.1) 100%)' }} />
                )}
                {!hasImage && (
                  <>
                    <div style={{ position: 'absolute', right: -60, top: -80, width: 240, height: 240, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' }} />
                    <div style={{ position: 'absolute', left: -80, bottom: -120, width: 280, height: 280, borderRadius: '50%', background: 'rgba(255,255,255,0.04)' }} />
                  </>
                )}
                {hasText && (
                  <div style={{ position: 'relative', padding: '24px 60px 24px 24px', display: 'flex', alignItems: 'center', gap: 16, minHeight: 120 }}>
                    <div style={{
                      width: 52,
                      height: 52,
                      borderRadius: 16,
                      flexShrink: 0,
                      background: 'rgba(255,255,255,0.15)',
                      backdropFilter: 'blur(8px)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      boxShadow: '0 8px 24px -8px rgba(0,0,0,0.3)',
                    }}>
                      {s.icon}
                    </div>
                    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)', marginBottom: 4 }}>
                        {s.badge}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', lineHeight: 1.25, letterSpacing: '-0.01em' }}>{s.title}</div>
                      <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', marginTop: 4, lineHeight: 1.45 }}>{s.subtitle}</div>
                    </div>
                    {s.cta ? (
                      <button
                        className="cpd-carousel-cta"
                        onClick={(e) => { e.stopPropagation(); navigate(s.cta!.to); }}
                        style={{
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          color: 'rgba(255,255,255,0.95)',
                          fontSize: 12,
                          fontWeight: 700,
                          background: 'rgba(255,255,255,0.15)',
                          backdropFilter: 'blur(8px)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          padding: '10px 18px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          fontFamily: F,
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.25)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                      >
                        {s.cta.label} <ArrowRight size={13} />
                      </button>
                    ) : (
                      <div className="cpd-carousel-cta" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: 600 }}>
                        Explore <ArrowRight size={13} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {slides.length > 1 && (
          <>
            <button
              aria-label="Previous slide"
              className="cpd-carousel-arrow"
              onClick={() => setActive((a) => (a - 1 + slides.length) % slides.length)}
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                background: 'rgba(255,255,255,0.2)',
                backdropFilter: 'blur(8px)',
                color: '#fff',
                fontSize: 16,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.35)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              aria-label="Next slide"
              className="cpd-carousel-arrow"
              onClick={() => setActive((a) => (a + 1) % slides.length)}
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                background: 'rgba(255,255,255,0.2)',
                backdropFilter: 'blur(8px)',
                color: '#fff',
                fontSize: 16,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.35)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}

        {slides.length > 1 && (
          <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, zIndex: 2 }}>
            {slides.map((s, i) => (
              <button
                key={s.id}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === active ? 'true' : undefined}
                onClick={() => setActive(i)}
                style={{
                  width: i === active ? 24 : 8,
                  height: 8,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: i === active ? 24 : 8,
                    height: 8,
                    borderRadius: 4,
                    background: i === active ? '#fff' : 'rgba(255,255,255,0.4)',
                    transition: 'all .25s ease',
                    boxShadow: i === active ? '0 2px 6px rgba(0,0,0,0.2)' : 'none',
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }} className="cpd-section">
        <ModernKPICard
          label="Outstanding Balance"
          value={fmtMoney(dashboardData?.outstandingBalance)}
          icon={FileText}
          badge={dashboardData?.unpaidInvoiceCount ? (overdueInvoices > 0 ? 'Overdue' : 'Due') : 'All Clear'}
          badgeColor={dashboardData?.unpaidInvoiceCount ? (overdueInvoices > 0 ? '#DC2626' : '#D97706') : '#059669'}
          sublabel={overdueInvoices > 0 ? `${overdueInvoices} Overdue` : undefined}
          sublabelColor={dashboardData?.unpaidInvoiceCount ? '#DC2626' : '#059669'}
          trend={{ value: paymentHistory, positive: paymentHistory >= 80, suffix: 'paid on time' }}
          gradient="linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)"
          glowColor="rgba(220,38,38,0.3)"
          lightBg="#FFF5F5"
          iconBg="#DC2626"
          onClick={() => navigate('/portal/invoices?status=Unpaid')}
          delay={0}
        />
        <ModernKPICard
          label="Wallet Balance"
          value={fmtMoney(dashboardData?.walletBalance || 0)}
          icon={Wallet}
          badge={dashboardData?.walletBalance > 0 ? 'Active' : 'No Balance'}
          badgeColor={dashboardData?.walletBalance > 0 ? '#059669' : '#94A3B8'}
          trend={{ value: onTimeScore, positive: onTimeScore >= 80, suffix: 'on-time' }}
          gradient="linear-gradient(135deg, #059669 0%, #047857 100%)"
          glowColor="rgba(5,150,105,0.3)"
          lightBg="#F0FDF4"
          iconBg="#059669"
          onClick={() => navigate('/portal/wallet')}
          delay={50}
        />
        <ModernKPICard
          label="Active Orders"
          value={dashboardData?.totalOrders || 0}
          icon={ShoppingBag}
          badge={dashboardData?.productionOrderCount ? 'In Production' : 'No Active'}
          badgeColor={dashboardData?.productionOrderCount ? '#7C3AED' : '#94A3B8'}
          description="Track your orders"
          gradient="linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)"
          glowColor="rgba(124,58,237,0.3)"
          lightBg="#FAF5FF"
          iconBg="#7C3AED"
          onClick={() => navigate('/portal/orders')}
          delay={100}
        />
        <ModernKPICard
          label="Active Deliveries"
          value={dashboardData?.activeDeliveries || 0}
          icon={Truck}
          badge={dashboardData?.activeDeliveries ? 'In Transit' : 'All Delivered'}
          badgeColor={dashboardData?.activeDeliveries ? '#2563EB' : '#059669'}
          description="Track shipments"
          gradient="linear-gradient(135deg, #2563EB 0%, #1E40AF 100%)"
          glowColor="rgba(37,99,235,0.3)"
          lightBg="#EFF6FF"
          iconBg="#2563EB"
          onClick={() => navigate('/portal/deliveries')}
          delay={150}
        />
      </div>

      {promotions && promotions.length > 0 && (
        <div style={{ marginBottom: 24 }} className="cpd-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={18} style={{ color: '#D97706' }} />
              Active Promotions
            </h2>
          </div>
          <PromotionBanner promotions={promotions} onNavigate={(path) => navigate(path)} />
        </div>
      )}

      <div style={{ marginBottom: 24 }} className="cpd-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', margin: 0 }}>Quick Actions</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {quickActions.map((action, i) => (
            <div
              key={i}
              onClick={() => (action.label === 'Get Quote' ? setShowQuoteModal(true) : navigate(action.to))}
              className="cpd-card"
              style={{
                background: '#fff',
                borderRadius: 16,
                padding: '16px 14px',
                border: '1px solid rgba(226,232,240,0.8)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(15,23,42,0.02)',
                animation: `cpdSlideIn 0.4s ease ${action.delay}ms both`,
              }}
            >
              <div
                className="cpd-qicon"
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  background: action.bg,
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 14px -4px rgba(0,0,0,0.15)',
                }}
              >
                {action.icon}
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#334155', textAlign: 'center' }}>{action.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="cpd-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={18} style={{ color: '#64748B' }} />
            Unpaid Invoices
            {overdueInvoices > 0 && (
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#fff',
                background: '#DC2626',
                padding: '2px 10px',
                borderRadius: 9999,
              }}>
                {overdueInvoices} Overdue
              </span>
            )}
          </h2>
          <button
            onClick={() => navigate('/portal/invoices?status=Unpaid')}
            className="cpd-link"
            style={{ background: 'none', border: 'none', color: '#6366F1', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            View All <ArrowRight size={13} />
          </button>
        </div>

        {displayedInvoices.length === 0 ? (
          <div style={{
            background: 'linear-gradient(135deg, #fff 0%, #F8FAFC 100%)',
            borderRadius: 16,
            border: '1px solid rgba(226,232,240,0.8)',
            padding: 32,
            textAlign: 'center',
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: '#F0FDF4',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px',
            }}>
              <CheckCircle size={28} style={{ color: '#059669' }} />
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 4px' }}>All caught up!</p>
            <p style={{ fontSize: 12.5, color: '#64748B', margin: 0 }}>No unpaid invoices at the moment.</p>
          </div>
        ) : (
          <div style={{
            background: '#fff',
            borderRadius: 16,
            border: '1px solid rgba(226,232,240,0.8)',
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(15,23,42,0.02)',
          }}>
            {displayedInvoices.map((inv, i) => (
              <div
                key={inv.id}
                onClick={() => navigate(`/portal/invoices/${inv.id}`)}
                className="cpd-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '14px 16px',
                  borderTop: i > 0 ? '1px solid #F1F5F9' : undefined,
                  cursor: 'pointer',
                  transition: 'background 0.15s ease',
                }}
              >
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: /overdue/i.test(String(inv.status || '')) ? '#FEF2F2' : '#F8FAFC',
                  color: /overdue/i.test(String(inv.status || '')) ? '#DC2626' : '#64748B',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 14,
                  flexShrink: 0,
                }}>
                  <FileText size={20} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', lineHeight: 1.3 }}>{inv.invoice_number || inv.id}</div>
                  <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                    Invoice: {inv.created_at ? new Date(inv.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'}
                    {inv.due_date && (
                      <> · Due: {new Date(inv.due_date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}</>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  {/overdue/i.test(String(inv.status || '')) && (
                    <span style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#DC2626',
                      background: '#FEF2F2',
                      padding: '4px 10px',
                      borderRadius: 8,
                      textTransform: 'uppercase',
                      border: '1px solid #FECACA',
                    }}>
                      Overdue
                    </span>
                  )}
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtMoney(inv.total_amount || 0)}
                  </span>
                  <ChevronRight size={18} color="#CBD5E0" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <QuoteRequestModal isOpen={showQuoteModal} onClose={() => setShowQuoteModal(false)} onSubmitQuoteRequest={handleQuoteSubmit} />
    </div>
  );
};

export default CustomerDashboard;
