import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Search, Package, Plus, Minus, Trash2, ChevronRight } from 'lucide-react';
import { portalLifecycle, PortalCatalogItem, PortalPromotionInfo } from '../../services/portalApiClient';
import { useCart, CartProvider } from '../../context/CartContext';
import PortalPageHeader from './components/PortalPageHeader';
import PortalInput from './components/PortalInput';
import EmptyState from './components/EmptyState';
import PortalLoadingSkeleton from './components/PortalLoadingSkeleton';
import { useToast } from './components/Toast';
import { F } from './portalStyles';
import { formatK } from './constants';

const ProductCatalogInner: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { items: cartItems, itemCount, total, addItem, removeItem, updateQuantity, clearCart, isOpen: cartOpen, setIsOpen: setCartOpen } = useCart();
  const [products, setProducts] = useState<PortalCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [promotions, setPromotions] = useState<PortalPromotionInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await portalLifecycle.catalog.list();
        if (!cancelled) setProducts(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load catalog');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Active Portal promotions — display-only badges. The server is the final
  // authority and re-calculates at checkout.
  useEffect(() => {
    let cancelled = false;
    portalLifecycle.promotions.list()
      .then((p) => { if (!cancelled) setPromotions(p || []); })
      .catch(() => { /* display-only, non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  const promoForProduct = (product: PortalCatalogItem): PortalPromotionInfo | null => {
    return promotions.find((p) => p.isAutoApply && (
      p.applicableTo === 'all' ||
      (p.applicableTo === 'categories' && (p.categoryIds || []).includes(product.category || '')) ||
      (p.applicableTo === 'products' && (p.productIds || []).includes(product.id))
    )) || null;
  };

  const promoPrice = (price: number, promo: PortalPromotionInfo): number => {
    if (!promo) return price;
    if (promo.discountType === 'percentage') return Math.round(price * (1 - promo.discountValue / 100) * 100) / 100;
    if (promo.discountType === 'fixed_amount') return Math.max(0, price - promo.discountValue);
    if (promo.discountType === 'fixed_price') return Math.min(price, promo.discountValue);
    return price;
  };

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [products]);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase());
      const matchCategory = category === 'All' || p.category === category;
      return matchSearch && matchCategory;
    });
  }, [products, search, category]);

  const handleAddToOrder = (product: PortalCatalogItem) => {
    addItem(product);
    addToast('success', `${product.name} added to order`);
  };

  if (loading) return <div style={{ padding: 12 }}><PortalLoadingSkeleton type="card" count={6} /></div>;

  return (
    <div style={{ fontFamily: F, fontSize: 13, lineHeight: 1.4, color: '#2D3748' }}>
      <PortalPageHeader
        title="Product Catalog"
        subtitle="Browse products and add to your order"
        icon={Package}
        action={{ label: `New Request`, onClick: () => navigate('/portal/new-request'), icon: Plus }}
      />

      <div style={{ padding: '0 28px' }}>
        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 12, padding: '12px 16px', fontSize: 13, marginBottom: 16 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#8A94A6', pointerEvents: 'none', zIndex: 1 }} />
            <PortalInput
              label=""
              placeholder="Search products by name or SKU..."
              value={search}
              onChange={setSearch}
              onFocus={() => {}}
              onBlur={() => {}}
              style={{ paddingLeft: 36, height: 44, fontSize: 13, fontFamily: F, padding: '8px 12px 8px 36px', border: '1px solid #E9EDF3', borderRadius: 10, background: '#fff', color: '#1A202C', outline: 'none', width: '100%' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {categories.map((cat) => {
            const active = category === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{
                  fontFamily: F, fontSize: 12, fontWeight: 600,
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

        {filtered.length === 0 ? (
          <EmptyState icon={<Package size={28} />} title="No products found" description={search || category !== 'All' ? 'Try adjusting your search or filters.' : 'No products available in the catalog.'} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, paddingBottom: cartItems.length > 0 ? 100 : 28 }}>
            {filtered.map((product) => {
              const inCart = cartItems.find((i) => i.product.id === product.id);
              return (
                <div
                  key={product.id}
                  style={{
                    background: '#fff', borderRadius: 12, border: inCart ? '2px solid #008A4C' : '1px solid #E9EDF3',
                    padding: '16px', transition: 'all .15s ease',
                    boxShadow: inCart ? '0 4px 12px rgba(0,138,76,0.12)' : '0 1px 3px rgba(0,0,0,.04)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFDF5', color: '#008A4C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Package size={18} />
                    </div>
                    {product.category && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#0f544c', background: '#ECFDF5', border: '1px solid #d3ece9', padding: '2px 8px', borderRadius: 6 }}>
                        {product.category}
                      </span>
                    )}
                  </div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A202C', margin: '0 0 4px', lineHeight: 1.3 }}>{product.name}</h3>
                  {product.sku && <p style={{ fontSize: 11, color: '#8A94A6', margin: '0 0 8px', fontFamily: "'JetBrains Mono', monospace" }}>SKU: {product.sku}</p>}
                  {(() => {
                    const promo = promoForProduct(product)
                    const price = Number(product.unitPrice ?? product.price ?? 0)
                    const discounted = promoPrice(price, promo)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', marginTop: 12, gap: 4 }}>
                        <div>
                          {promo && discounted < price ? (
                            <>
                              <span style={{ fontSize: 13, color: '#A0AEC0', textDecoration: 'line-through', fontFamily: "'JetBrains Mono', monospace" }}>
                                {formatK(price)}
                              </span>{' '}
                              <span style={{ fontSize: 16, fontWeight: 800, color: '#047857', fontFamily: "'JetBrains Mono', monospace" }}>
                                {formatK(discounted)}
                              </span>
                            </>
                          ) : (
                            <span style={{ fontSize: 16, fontWeight: 700, color: '#1A202C', fontFamily: "'JetBrains Mono', monospace" }}>
                              {formatK(price)}
                            </span>
                          )}
                          {product.unit && <span style={{ fontSize: 11, color: '#8A94A6', marginLeft: 4 }}>/{product.unit}</span>}
                        </div>
                        {promo && discounted < price && (
                          <span style={{
                            fontSize: 9.5, fontWeight: 800, letterSpacing: 0.04, textTransform: 'uppercase',
                            color: '#047857', background: '#ECFDF5', border: '1px solid #a7f3d0',
                            padding: '2px 7px', borderRadius: 6,
                          }}>
                            🎉 Portal Offer
                          </span>
                        )}
                      </div>
                    )
                  })()}
                    {inCart ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          onClick={() => updateQuantity(product.id, inCart.quantity - 1)}
                          style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}
                        >
                          <Minus size={12} />
                        </button>
                        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 20, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{inCart.quantity}</span>
                        <button
                          onClick={() => updateQuantity(product.id, inCart.quantity + 1)}
                          style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E9EDF3', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4A5568' }}
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          onClick={() => removeItem(product.id)}
                          style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #FECACA', background: '#FEF2F2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#DC2626', marginLeft: 2 }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleAddToOrder(product)}
                        style={{
                          padding: '6px 14px', borderRadius: 8, border: '1px solid #008A4C', background: '#008A4C',
                          color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5, transition: 'all .15s ease',
                        }}
                      >
                        <Plus size={13} /> Add to Order
                      </button>
                    )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {cartItems.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 40,
          background: '#fff', borderTop: '1px solid #E9EDF3',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
          padding: '12px 28px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: '#008A4C', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <ShoppingCart size={16} />
                <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, background: '#E53E3E', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', border: '1.5px solid #fff' }}>
                  {itemCount}
                </span>
              </div>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#1A202C' }}>{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                <span style={{ fontSize: 13, color: '#8A94A6', marginLeft: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{formatK(total)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={clearCart}
                style={{
                  padding: '8px 14px', borderRadius: 8, border: '1px solid #E9EDF3', background: '#fff',
                  fontSize: 12, fontWeight: 600, color: '#4A5568', cursor: 'pointer',
                }}
              >
                Clear
              </button>
              <button
                onClick={() => navigate('/portal/new-request?type=order')}
                style={{
                  padding: '8px 18px', borderRadius: 8, border: 'none', background: '#008A4C',
                  color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                View Cart & Checkout <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const CustomerCatalog: React.FC = () => (
  <CartProvider>
    <ProductCatalogInner />
  </CartProvider>
);

export default CustomerCatalog;
