import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ShoppingCart, Plus, Minus, Trash2, Search, Package, ChevronDown,
  ChevronRight, MapPin, Truck, X, Receipt, Loader2, CheckCircle2
} from 'lucide-react';
import { portalLifecycle, PortalCatalogItem, PortalPromotionInfo, buildQueryString } from '../../services/portalApiClient';
import { usePortalData } from './hooks/usePortalData';
import { useCart, CartProvider } from '../../context/CartContext';
import { useToast } from './components/Toast';
import PortalPageHeader from './components/PortalPageHeader';
import PortalInput from './components/PortalInput';
import ErrorBanner from './components/ErrorBanner';
import EmptyState from './components/EmptyState';
import PortalLoadingSkeleton from './components/PortalLoadingSkeleton';
import { F } from './portalStyles';
import { DEFAULT_PAGE_SIZE, formatK } from './constants';

type Tab = 'catalog' | 'history';

const ESTIMATED_TAX_RATE = 0.16; // 16% VAT estimate — server is authoritative at submission.

const ORDER_CHIP: Record<string, { label: string; color: string; bg: string; emoji: string }> = {
  draft: { label: 'Draft', color: '#64748B', bg: '#F1F5F9', emoji: '⚪' },
  pending: { label: 'Pending', color: '#B45309', bg: '#FFFBEB', emoji: '🟡' },
  processing: { label: 'Processing', color: '#B45309', bg: '#FFFBEB', emoji: '🟡' },
  confirmed: { label: 'Confirmed', color: '#1D4ED8', bg: '#EFF6FF', emoji: '🔵' },
  shipped: { label: 'Shipped', color: '#4F46E5', bg: '#EEF2FF', emoji: '🚚' },
  in_transit: { label: 'In Transit', color: '#4F46E5', bg: '#EEF2FF', emoji: '🚚' },
  out_for_delivery: { label: 'Out for Delivery', color: '#7C3AED', bg: '#F5F3FF', emoji: '🚚' },
  delivered: { label: 'Delivered', color: '#047857', bg: '#ECFDF5', emoji: '🟢' },
  fulfilled: { label: 'Delivered', color: '#047857', bg: '#ECFDF5', emoji: '🟢' },
  cancelled: { label: 'Cancelled', color: '#DC2626', bg: '#FEF2F2', emoji: '✕' },
};

const chipMeta = (status: string) =>
  ORDER_CHIP[String(status || '').toLowerCase()] || { label: status || 'Order', color: '#64748B', bg: '#F1F5F9', emoji: '⚪' };

const parseItems = (raw: any): { name: string; quantity: number; unitPrice: number; lineTotal: number }[] => {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((it: any) => {
    const unitPrice = Number(it.price ?? it.unitPrice ?? it.unit_price ?? 0);
    const quantity = Number(it.quantity ?? 1);
    return {
      name: it.name || it.productName || it.product_name || it.description || 'Item',
      quantity,
      unitPrice,
      lineTotal: Number(it.lineTotal ?? it.line_total ?? unitPrice * quantity),
    };
  });
};

interface OrderRow {
  id: string;
  orderNumber: string;
  orderDate: string;
  totalAmount: number;
  status: string;
  items: ReturnType<typeof parseItems>;
  shippingAddress: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  driverName: string | null;
  vehicleNo: string | null;
  currentLocation: string | null;
  estimatedDelivery: string | null;
}

const mapOrder = (o: any): OrderRow => ({
  id: o.id,
  orderNumber: o.order_number || o.orderNumber || o.id.slice(0, 8),
  orderDate: o.orderDate || o.order_date || o.created_at || '',
  totalAmount: Number(o.totalAmount ?? o.total ?? 0),
  status: o.status || 'Pending',
  items: parseItems(o.items_json ?? o.items ?? o.itemsJson),
  shippingAddress: o.shipping_address || o.shippingAddress || null,
  trackingNumber: o.tracking_number || o.trackingNumber || null,
  carrier: o.carrier || null,
  driverName: o.driver_name || o.driverName || null,
  vehicleNo: o.vehicle_no || o.vehicleNo || null,
  currentLocation: o.current_location || o.currentLocation || null,
  estimatedDelivery: o.estimated_delivery || o.estimatedDelivery || null,
});

const OrdersInner: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { addToast } = useToast();
  const { items: cartItems, itemCount, total: cartTotal, addItem, removeItem, updateQuantity, clearCart } = useCart();

  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'history' ? 'history' : 'catalog');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [filter, setFilter] = useState('All');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  // ---- Product Catalog data (local-first) ----
  const [products, setProducts] = useState<PortalCatalogItem[]>([]);
  const [promotions, setPromotions] = useState<PortalPromotionInfo[]>([]);
  const catalog = usePortalData<PortalCatalogItem[]>({
    key: '/catalog',
    label: 'Orders · Catalog',
    fetcher: () => portalLifecycle.catalog.list(),
    onData: (data) => { if (Array.isArray(data)) setProducts(data); },
  });

  // Active portal promotions — display-only badges. Server re-calculates at submission.
  useEffect(() => {
    let cancelled = false;
    portalLifecycle.promotions.list()
      .then((p) => { if (!cancelled) setPromotions(p || []); })
      .catch(() => { /* display-only, non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // ---- Order History data (local-first) ----
  const historyQuery = buildQueryString({ page, pageSize: DEFAULT_PAGE_SIZE, search: search || undefined, status: filter === 'All' ? undefined : filter });
  const historyEndpoint = historyQuery ? `/orders?${historyQuery}` : '/orders';
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const history = usePortalData<any>({
    key: historyEndpoint,
    label: 'Orders · History',
    fetcher: () => portalLifecycle.orders.list({ page, pageSize: DEFAULT_PAGE_SIZE, search: search || undefined, status: filter === 'All' ? undefined : filter }),
    onData: (data: any) => {
      if (data && 'orders' in data) {
        setOrders((data.orders || []).map(mapOrder));
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      } else if (Array.isArray(data)) {
        setOrders(data.map(mapOrder));
        setTotalPages(1);
        setTotal(data.length);
      }
    },
  });

  // ---- Review cart bottom sheet ----
  const [reviewOpen, setReviewOpen] = useState(false);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill delivery address from the customer profile (primary address).
  useEffect(() => {
    let cancelled = false;
    portalLifecycle.profile.get()
      .then((p: any) => {
        if (cancelled || !p) return;
        const addr = [p.address, p.city, p.state, p.zip, p.country].filter(Boolean).join(', ');
        if (addr.trim()) setDeliveryAddress(addr.trim());
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSearchParams(tab === 'history' ? { tab: 'history' } : {}, { replace: true });
  }, [tab, setSearchParams]);

  useEffect(() => { setPage(1); }, [tab, search, filter]);

  const categories = useMemo(() => {
    const fromData = Array.from(new Set(products.map((p) => p.category).filter(Boolean))) as string[];
    if (fromData.length === 0) return ['All', 'Steel & Piping', 'Electrical', 'Plumbing', 'Roofing'];
    return ['All', ...fromData.sort()];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchSearch = !q
        || p.name?.toLowerCase().includes(q)
        || p.sku?.toLowerCase().includes(q)
        || `${p.category || ''}`.toLowerCase().includes(q);
      const matchCategory = category === 'All' || p.category === category;
      return matchSearch && matchCategory;
    });
  }, [products, search, category]);

  // Canonical lifecycle statuses (filtering is server-side, so the dropdown
  // must not depend on which statuses happen to be on the current page).
  const availableStatuses = ['All', 'Pending', 'Processing', 'Confirmed', 'Shipped', 'In Transit', 'Out for Delivery', 'Delivered', 'Cancelled'];

  const ordersTotalValue = useMemo(() => orders.reduce((s, o) => s + o.totalAmount, 0), [orders]);
  const pendingCount = useMemo(() => orders.filter((o) => ['Pending', 'Processing', 'Confirmed'].includes(o.status)).length, [orders]);

  const promoForProduct = (product: PortalCatalogItem): PortalPromotionInfo | null =>
    promotions.find((p) => p.isAutoApply && (
      p.applicableTo === 'all' ||
      (p.applicableTo === 'categories' && (p.categoryIds || []).includes(product.category || '')) ||
      (p.applicableTo === 'products' && (p.productIds || []).includes(product.id))
    )) || null;

  const promoPrice = (price: number, promo: PortalPromotionInfo | null): number => {
    if (!promo) return price;
    if (promo.discountType === 'percentage') return Math.round(price * (1 - promo.discountValue / 100) * 100) / 100;
    if (promo.discountType === 'fixed_amount') return Math.max(0, price - promo.discountValue);
    if (promo.discountType === 'fixed_price') return Math.min(price, promo.discountValue);
    return price;
  };

  const handleAdd = (product: PortalCatalogItem) => {
    addItem(product);
    addToast('success', `${product.name} added to cart`);
  };

  const handleSubmitOrder = async () => {
    if (cartItems.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const created = await portalLifecycle.requests.create({
        requestType: 'order',
        items: cartItems.map((i) => ({
          productId: i.product.id,
          name: i.product.name,
          quantity: i.quantity,
          unitPrice: Number(i.product.unitPrice ?? i.product.price ?? 0),
        })),
        notes: deliveryAddress.trim() ? `Delivery address: ${deliveryAddress.trim()}` : undefined,
      });
      addToast('success', `Order submitted — ${created.request_number || 'request received'}. Our team will confirm shortly.`);
      clearCart();
      setReviewOpen(false);
      history.refresh();
    } catch (err: any) {
      addToast('error', err.message || 'Failed to submit order');
    } finally {
      setSubmitting(false);
    }
  };

  const subtotal = cartTotal;
  const taxEstimate = subtotal * ESTIMATED_TAX_RATE;
  const grandTotal = subtotal + taxEstimate;

  const catalogLoading = catalog.loading && products.length === 0;
  const historyLoading = history.loading && page === 1;

  return (
    <div style={{ fontFamily: F, fontSize: 13, lineHeight: 1.4, color: '#2D3748' }}>
      <style>{`
        @keyframes cpoSlideUp { from { transform: translateY(100%); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        @keyframes cpoFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes cpoBarIn { from { transform: translateY(24px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        @keyframes cpoPulse { 0%,100% { box-shadow: 0 6px 18px -6px rgba(0,138,76,.55) } 50% { box-shadow: 0 6px 26px -4px rgba(0,138,76,.8) } }
        .cpo-scroll::-webkit-scrollbar { display: none }
        .cpo-scroll { scrollbar-width: none; -ms-overflow-style: none }
      `}</style>

      <PortalPageHeader
        title="Orders"
        subtitle={tab === 'catalog' ? 'Browse the material catalog and place an order' : 'Track your order history and deliveries'}
        icon={ShoppingCart}
        action={tab === 'history'
          ? { label: 'New Order', onClick: () => setTab('catalog'), icon: Plus }
          : { label: 'Order History', onClick: () => setTab('history'), icon: Receipt }}
      />

      {/* ── Section tabs ── */}
      <div style={{ padding: '0 12px' }} className="sm:px-5">
        <div style={{ display: 'flex', gap: 6, padding: '6px 0', borderBottom: '1px solid #E9EDF3', marginBottom: 4 }}>
          {([['catalog', 'Product Catalog', Package], ['history', 'Order History', Receipt]] as [Tab, string, React.ElementType][]).map(([key, label, Icon]) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => { setTab(key); setSearch(''); setFilter('All'); setCategory('All'); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  fontFamily: F, fontSize: 13, fontWeight: 600,
                  background: active ? '#ECFDF5' : 'transparent',
                  color: active ? '#0D5047' : '#718096',
                  transition: 'all .15s ease', lineHeight: 1.4,
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══════════════ PRODUCT CATALOG TAB ═══════════════ */}
      {tab === 'catalog' && (
        <div style={{ padding: '0 12px' }} className="sm:px-5">
          {catalog.error && <ErrorBanner message={catalog.error} onDismiss={catalog.clearError} onRetry={catalog.refresh} />}

          {/* Search */}
          <div style={{ display: 'flex', gap: 8, margin: '14px 0 10px' }}>
            <div style={{ position: 'relative', flex: '1 1 240px' }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#8A94A6', pointerEvents: 'none', zIndex: 1 }} />
              <PortalInput
                label=""
                placeholder="Search by product name, SKU or specification..."
                value={search}
                onChange={setSearch}
                onFocus={() => {}}
                onBlur={() => {}}
                style={{ paddingLeft: 36, height: 44, fontSize: 13, fontFamily: F, padding: '8px 12px 8px 36px', border: '1px solid #E9EDF3', borderRadius: 10, background: '#fff', color: '#1A202C', outline: 'none', width: '100%' }}
              />
            </div>
          </div>

          {/* Category chips — horizontally scrollable */}
          <div className="cpo-scroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 1px 10px' }}>
            {categories.map((cat) => {
              const active = category === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  style={{
                    flexShrink: 0, fontFamily: F, fontSize: 12, fontWeight: 600,
                    padding: '7px 14px', borderRadius: 9, border: active ? '1px solid transparent' : '1px solid #E9EDF3',
                    background: active ? '#008A4C' : '#fff',
                    color: active ? '#fff' : '#718096', cursor: 'pointer',
                    transition: 'all .15s ease', lineHeight: 1.4,
                  }}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          {/* Product grid */}
          {catalogLoading ? (
            <div style={{ padding: 8 }}><PortalLoadingSkeleton type="card" count={6} /></div>
          ) : filteredProducts.length === 0 ? (
            <EmptyState
              icon={<Package size={28} />}
              title="No products found"
              description={search || category !== 'All' ? 'Try adjusting your search or category filters.' : 'No products available in the catalog yet.'}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, paddingBottom: cartItems.length > 0 ? 110 : 32 }}>
              {filteredProducts.map((product) => {
                const inCart = cartItems.find((i) => i.product.id === product.id);
                const price = Number(product.unitPrice ?? product.price ?? 0);
                const promo = promoForProduct(product);
                const shownPrice = promoPrice(price, promo);
                const stock = Number(product.quantity ?? 0);
                const inStock = stock > 0;
                return (
                  <div
                    key={product.id}
                    style={{
                      background: '#fff', borderRadius: 14, border: inCart ? '2px solid #008A4C' : '1px solid #E9EDF3',
                      padding: '16px', transition: 'all .15s ease', display: 'flex', flexDirection: 'column',
                      boxShadow: inCart ? '0 4px 12px rgba(0,138,76,0.12)' : '0 1px 3px rgba(0,0,0,.04)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFDF5', color: '#008A4C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Package size={18} />
                      </div>
                      {product.category && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: '#0f544c', background: '#ECFDF5', border: '1px solid #d3ece9', padding: '2px 8px', borderRadius: 6 }}>
                          {product.category}
                        </span>
                      )}
                    </div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A202C', margin: 0, lineHeight: 1.3 }}>{product.name}</h3>
                    {product.sku && <p style={{ fontSize: 11, color: '#8A94A6', margin: '2px 0 6px', fontFamily: "'JetBrains Mono', monospace" }}>SKU: {product.sku}</p>}

                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '6px 0 4px' }}>
                      <span style={{ fontSize: 17, fontWeight: 800, color: '#047857', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                        {formatK(shownPrice)}
                      </span>
                      {product.unit && <span style={{ fontSize: 11, color: '#8A94A6' }}>/{product.unit}</span>}
                      {promo && shownPrice < price && (
                        <span style={{ fontSize: 11, color: '#A0AEC0', textDecoration: 'line-through', fontFamily: "'JetBrains Mono', monospace" }}>{formatK(price)}</span>
                      )}
                    </div>

                    {promo && shownPrice < price && (
                      <span style={{ alignSelf: 'flex-start', fontSize: 9.5, fontWeight: 800, letterSpacing: 0.04, textTransform: 'uppercase', color: '#047857', background: '#ECFDF5', border: '1px solid #a7f3d0', padding: '2px 7px', borderRadius: 6, marginBottom: 6 }}>
                        🎉 {promo.name || 'Portal Offer'}
                      </span>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 10 }}>
                      {inStock ? (
                        <>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: '#22C55E', boxShadow: '0 0 0 3px rgba(34,197,94,.15)' }} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#047857' }}>In Stock</span>
                          <span style={{ fontSize: 10, color: '#8A94A6' }}>· {stock} unit{stock === 1 ? '' : 's'}</span>
                        </>
                      ) : (
                        <>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: '#F59E0B' }} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#B45309' }}>Low Stock</span>
                        </>
                      )}
                    </div>

                    {inCart ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
                        <button onClick={() => updateQuantity(product.id, inCart.quantity - 1)} aria-label="Decrease quantity" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}>
                          <Minus size={12} />
                        </button>
                        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 20, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{inCart.quantity}</span>
                        <button onClick={() => updateQuantity(product.id, inCart.quantity + 1)} aria-label="Increase quantity" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}>
                          <Plus size={12} />
                        </button>
                        <button onClick={() => removeItem(product.id)} aria-label="Remove from cart" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #FECACA', background: '#FEF2F2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#DC2626', marginLeft: 2 }}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleAdd(product)}
                        disabled={!inStock}
                        style={{
                          marginTop: 'auto', padding: '7px 14px', borderRadius: 8, border: 'none',
                          background: !inStock ? '#E2E8F0' : 'linear-gradient(135deg, #00A35C, #008A4C)',
                          color: !inStock ? '#94A3B8' : '#fff', fontSize: 12, fontWeight: 600, cursor: !inStock ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          boxShadow: inStock ? '0 4px 10px -4px rgba(0,138,76,.5)' : 'none', transition: 'all .15s ease',
                        }}
                      >
                        <Plus size={13} /> Add to Cart
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ ORDER HISTORY TAB ═══════════════ */}
      {tab === 'history' && (
        <div style={{ padding: '0 12px' }} className="sm:px-5">
          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, margin: '14px 0 4px' }}>
            <div style={{ background: 'linear-gradient(135deg, #1f857712, #4ed3c708)', borderRadius: 12, border: '1px solid #E9EDF3', padding: '12px 14px' }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: '#0f544c', textTransform: 'uppercase', letterSpacing: 0.08 }}>Total Orders</p>
              <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{total}</p>
            </div>
            <div style={{ background: 'linear-gradient(135deg, #d99a3f12, #d99a3f08)', borderRadius: 12, border: '1px solid #E9EDF3', padding: '12px 14px' }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: '#b97e2b', textTransform: 'uppercase', letterSpacing: 0.08 }}>Total Value</p>
              <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatK(ordersTotalValue)}</p>
            </div>
            <div style={{ background: 'linear-gradient(135deg, #6366f112, #6366f108)', borderRadius: 12, border: '1px solid #E9EDF3', padding: '12px 14px' }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: '#4f46e5', textTransform: 'uppercase', letterSpacing: 0.08 }}>In Progress</p>
              <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{pendingCount}</p>
            </div>
          </div>

          {history.error && <ErrorBanner message={history.error} onDismiss={history.clearError} onRetry={history.refresh} />}

          {/* Search + status filter */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 8px' }}>
            <div style={{ position: 'relative', flex: '1 1 240px' }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#8A94A6', pointerEvents: 'none', zIndex: 1 }} />
              <PortalInput
                label=""
                placeholder="Search orders by reference..."
                value={search}
                onChange={(v) => { setPage(1); setSearch(v); }}
                onFocus={() => {}}
                onBlur={() => {}}
                style={{ paddingLeft: 36, height: 44, fontSize: 13, fontFamily: F, padding: '8px 12px 8px 36px', border: '1px solid #E9EDF3', borderRadius: 10, background: '#fff', color: '#1A202C', outline: 'none', width: '100%' }}
              />
            </div>
            <select
              value={filter}
              onChange={(e) => { setPage(1); setFilter(e.target.value); }}
              aria-label="Filter by status"
              style={{
                fontFamily: F, fontSize: 13, padding: '8px 32px 8px 12px',
                border: filter !== 'All' ? '1px solid #a6d9d3' : '1px solid #E9EDF3', borderRadius: 10, background: '#fff', color: '#1A202C',
                appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 14px center', cursor: 'pointer',
                boxShadow: filter !== 'All' ? '0 0 0 3px #ECFDF5' : 'none', outline: 'none', transition: 'all .15s ease', lineHeight: 1.4,
              }}
            >
              {availableStatuses.map((s) => <option key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</option>)}
            </select>
          </div>

          {/* Order cards */}
          {historyLoading ? (
            <div style={{ padding: 8 }}><PortalLoadingSkeleton type="table" count={5} /></div>
          ) : orders.length === 0 ? (
            <EmptyState icon={<ShoppingCart size={28} />} title="No orders yet" description={filter !== 'All' ? `No orders with status "${filter}".` : 'Your order history will appear here once you place your first order.'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 28 }}>
              {orders.map((order) => {
                const meta = chipMeta(order.status);
                const isOpen = expanded === order.id;
                const date = order.orderDate ? new Date(order.orderDate) : null;
                const hasTracking = !!(order.trackingNumber || order.carrier || order.currentLocation);
                return (
                  <div key={order.id} style={{ background: '#fff', borderRadius: 14, border: '1px solid #E9EDF3', boxShadow: '0 1px 3px rgba(0,0,0,.04)', overflow: 'hidden', transition: 'all .15s ease' }}>
                    <button
                      onClick={() => setExpanded(isOpen ? null : order.id)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: F }}
                    >
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: meta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 17 }}>{meta.emoji}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace" }}>{order.orderNumber}</div>
                        <div style={{ fontSize: 10.5, color: '#8A94A6', marginTop: 1 }}>
                          {date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                          {order.items.length > 0 ? ` · ${order.items.reduce((s, i) => s + i.quantity, 0)} item(s)` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatK(order.totalAmount)}</div>
                          <div style={{ fontSize: 9.5, color: '#8A94A6', textTransform: 'uppercase', letterSpacing: 0.05 }}>Total</div>
                        </div>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 7, background: meta.bg, color: meta.color, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {meta.emoji} {meta.label}
                        </span>
                        <ChevronDown size={16} style={{ color: '#8A94A6', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }} />
                      </div>
                    </button>

                    {isOpen && (
                      <div style={{ borderTop: '1px solid #F1F5F9', background: '#FBFDFE', padding: '14px 16px', animation: 'cpoFadeIn .2s ease' }}>
                        {/* Delivery destination */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                          <MapPin size={14} style={{ color: '#8A94A6', marginTop: 1, flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#8A94A6', textTransform: 'uppercase', letterSpacing: 0.06 }}>Delivery Destination</div>
                            <div style={{ fontSize: 12.5, color: '#1A202C', marginTop: 1 }}>{order.shippingAddress || 'Address to be confirmed'}</div>
                          </div>
                        </div>

                        {/* Line items */}
                        {order.items.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#8A94A6', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 6 }}>Line Items</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {order.items.map((it, idx) => (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', background: '#fff', border: '1px solid #E9EDF3', borderRadius: 8 }}>
                                  <span style={{ fontSize: 12, color: '#1A202C', fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                                  <span style={{ fontSize: 11, color: '#8A94A6', whiteSpace: 'nowrap' }}>×{it.quantity}</span>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: '#047857', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>{formatK(it.lineTotal)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Tracking */}
                        {hasTracking && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#8A94A6', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 6 }}>Tracking</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                              {order.trackingNumber && (
                                <div style={{ padding: '8px 10px', background: '#fff', border: '1px solid #E9EDF3', borderRadius: 8 }}>
                                  <div style={{ fontSize: 9.5, color: '#8A94A6', textTransform: 'uppercase' }}>Tracking No.</div>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace" }}>{order.trackingNumber}</div>
                                </div>
                              )}
                              {order.carrier && (
                                <div style={{ padding: '8px 10px', background: '#fff', border: '1px solid #E9EDF3', borderRadius: 8 }}>
                                  <div style={{ fontSize: 9.5, color: '#8A94A6', textTransform: 'uppercase' }}>Carrier</div>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1A202C' }}>{order.carrier}</div>
                                </div>
                              )}
                              {order.currentLocation && (
                                <div style={{ padding: '8px 10px', background: '#fff', border: '1px solid #E9EDF3', borderRadius: 8 }}>
                                  <div style={{ fontSize: 9.5, color: '#8A94A6', textTransform: 'uppercase' }}>Current Location</div>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1A202C' }}>{order.currentLocation}</div>
                                </div>
                              )}
                              {order.estimatedDelivery && (
                                <div style={{ padding: '8px 10px', background: '#fff', border: '1px solid #E9EDF3', borderRadius: 8 }}>
                                  <div style={{ fontSize: 9.5, color: '#8A94A6', textTransform: 'uppercase' }}>Est. Delivery</div>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1A202C' }}>
                                    {new Date(order.estimatedDelivery).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate('/portal/shipments'); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid #4F46E5', background: '#EEF2FF', color: '#4338CA', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
                          >
                            <Truck size={13} /> Track Shipment
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(`/portal/orders/${order.id}`); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: '1px solid #E9EDF3', background: '#fff', color: '#4A5568', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
                          >
                            View Details <ChevronRight size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 24, gap: 12 }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{ flex: 1, padding: '8px 14px', borderRadius: 10, border: '1px solid #E9EDF3', background: '#fff', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1, fontSize: 12, fontWeight: 600, color: '#4A5568', fontFamily: F, lineHeight: 1.4 }}
              >
                Previous
              </button>
              <div style={{ fontSize: 12, color: '#8A94A6', fontWeight: 600 }}>Page {page} of {totalPages}</div>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{ flex: 1, padding: '8px 14px', borderRadius: 10, border: '1px solid #E9EDF3', background: '#fff', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.4 : 1, fontSize: 12, fontWeight: 600, color: '#4A5568', fontFamily: F, lineHeight: 1.4 }}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Floating Order Summary Bar ── */}
      {tab === 'catalog' && cartItems.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 40,
          background: '#fff', borderTop: '1px solid #E9EDF3', boxShadow: '0 -6px 24px rgba(0,0,0,0.12)',
          padding: '12px 16px', animation: 'cpoBarIn .25s ease',
        }}>
          <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ width: 38, height: 38, borderRadius: 12, background: 'linear-gradient(135deg, #00A35C, #008A4C)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', animation: 'cpoPulse 2s ease-in-out infinite' }}>
                <ShoppingCart size={17} />
                <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, borderRadius: 9, background: '#E53E3E', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', border: '1.5px solid #fff' }}>
                  {itemCount}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1A202C' }}>{itemCount} item{itemCount !== 1 ? 's' : ''}</div>
                <div style={{ fontSize: 12, color: '#8A94A6', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>Subtotal {formatK(subtotal)}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={clearCart}
                style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid #E9EDF3', background: '#fff', fontSize: 12, fontWeight: 600, color: '#4A5568', cursor: 'pointer', fontFamily: F }}
              >
                Clear
              </button>
              <button
                onClick={() => setReviewOpen(true)}
                style={{ padding: '8px 18px', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg, #00A35C, #008A4C)', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 4px 12px -4px rgba(0,138,76,.55)', fontFamily: F }}
              >
                Review Cart <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Review Cart Modal (New Order Bottom Sheet) ── */}
      {reviewOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(2,8,23,.55)', backdropFilter: 'blur(2px)', zIndex: 90, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'cpoFadeIn .18s ease' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) setReviewOpen(false); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-cart-title"
        >
          <div style={{
            background: '#fff', width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto',
            borderRadius: '20px 20px 0 0', boxShadow: '0 -16px 48px rgba(2,8,23,.3)',
            animation: 'cpoSlideUp .28s cubic-bezier(.16,1,.3,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 12px' }}>
              <div>
                <h2 id="review-cart-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1A202C', fontFamily: F }}>Review Your Order</h2>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#8A94A6', fontFamily: F }}>Confirm quantities and delivery details</p>
              </div>
              <button
                onClick={() => { if (!submitting) setReviewOpen(false); }}
                aria-label="Close"
                style={{ width: 30, height: 30, borderRadius: 9, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A94A6' }}
              >
                <X size={15} />
              </button>
            </div>

            {/* Itemized list with + / - */}
            <div style={{ padding: '4px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cartItems.map((i) => {
                const unitPrice = Number(i.product.unitPrice ?? i.product.price ?? 0);
                return (
                  <div key={i.product.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#F8FAFC', border: '1px solid #E9EDF3', borderRadius: 12 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: '#ECFDF5', color: '#008A4C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Package size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1A202C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.product.name}</div>
                      <div style={{ fontSize: 11, color: '#8A94A6', fontFamily: "'JetBrains Mono', monospace" }}>{formatK(unitPrice)}{i.product.unit ? ` /${i.product.unit}` : ''}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <button onClick={() => updateQuantity(i.product.id, i.quantity - 1)} aria-label="Decrease" style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}>
                        <Minus size={12} />
                      </button>
                      <span style={{ fontSize: 13, fontWeight: 700, minWidth: 22, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{i.quantity}</span>
                      <button onClick={() => updateQuantity(i.product.id, i.quantity + 1)} aria-label="Increase" style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}>
                        <Plus size={12} />
                      </button>
                    </div>
                    <div style={{ minWidth: 72, textAlign: 'right' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#047857', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatK(unitPrice * i.quantity)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Delivery address */}
            <div style={{ padding: '14px 20px 0' }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#4A5568', textTransform: 'uppercase', letterSpacing: 0.05, display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                <MapPin size={13} /> Delivery Address
              </label>
              <textarea
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="Enter delivery address"
                rows={2}
                style={{
                  width: '100%', fontFamily: F, fontSize: 13, padding: '10px 12px', borderRadius: 10,
                  border: '1px solid #E9EDF3', background: '#fff', color: '#1A202C', outline: 'none', resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Totals */}
            <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span style={{ color: '#4A5568' }}>Subtotal</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{formatK(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span style={{ color: '#4A5568' }}>Estimated VAT (16%)</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{formatK(taxEstimate)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, borderTop: '1px solid #E9EDF3', paddingTop: 8 }}><span style={{ color: '#1A202C', fontWeight: 700 }}>Total</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, color: '#047857' }}>{formatK(grandTotal)}</span></div>
              <p style={{ margin: '2px 0 0', fontSize: 10.5, color: '#8A94A6' }}>Final pricing is confirmed by our team at submission. An order request will be created for review.</p>
            </div>

            <div style={{ padding: '12px 20px 20px' }}>
              <button
                onClick={handleSubmitOrder}
                disabled={submitting}
                style={{
                  width: '100%', padding: '12px 16px', borderRadius: 11, border: 'none',
                  background: submitting ? '#9CA3AF' : 'linear-gradient(135deg, #00A35C, #008A4C)',
                  color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  boxShadow: submitting ? 'none' : '0 6px 16px -6px rgba(0,138,76,.6)', fontFamily: F,
                }}
              >
                {submitting ? (<><Loader2 size={15} className="animate-spin" /> Submitting...</>) : (<><CheckCircle2 size={16} /> Confirm & Submit Order</>)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const CustomerOrders: React.FC = () => (
  <CartProvider>
    <OrdersInner />
  </CartProvider>
);

export default CustomerOrders;
