import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi, portalLifecycle, PortalPromotionInfo } from '../../../services/portalApiClient';

const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

const mwk = (v: number) => `MWK ${Math.round(Number(v) || 0).toLocaleString()}`;

const discountLabel = (p: PortalPromotionInfo): string => {
  const type = String(p.discountType || 'percentage');
  const value = Number(p.discountValue ?? 0) || 0;
  if (type === 'percentage') return `${value}% OFF`;
  if (type === 'fixed_price') return `${mwk(value)} each`;
  if (type === 'buy_x_get_y') return 'Buy X Get Y';
  return `${mwk(value)} OFF`;
};

const formatEnds = (endsAt?: string | null): string | null => {
  if (!endsAt) return null;
  const d = new Date(endsAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Live Portal promotion banner.
 *
 * Display-only: fetches the active PORTAL promotions the server exposes
 * (GET /portal/promotions). The authoritative calculation always happens
 * server-side at checkout — this banner never applies or trusts discounts.
 */
const PromotionBanner: React.FC = () => {
  const navigate = useNavigate();
  const [promotions, setPromotions] = useState<PortalPromotionInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalLifecycle.promotions
      .list()
      .then((list) => {
        if (!cancelled) setPromotions(Array.isArray(list) ? list.slice(0, 3) : []);
      })
      .catch(() => {
        if (!cancelled) setPromotions([]);
      });
    return () => { cancelled = true; };
  }, []);

  if (!promotions || promotions.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
      {promotions.map((p) => {
        const ends = formatEnds(p.endsAt);
        const isAuto = p.isAutoApply !== false;
        return (
          <div
            key={p.id}
            onClick={() => navigate('/portal/new-request')}
            style={{
              position: 'relative',
              overflow: 'hidden',
              background: 'linear-gradient(120deg,#0b3e39 0%,#0f544c 55%,#008A4C 130%)',
              borderRadius: 12,
              padding: '13px 16px',
              cursor: 'pointer',
              border: '1px solid rgba(255,255,255,.14)',
              boxShadow: '0 8px 22px -10px rgba(0,138,76,.5)',
              transition: 'transform .15s ease, box-shadow .15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 12px 28px -12px rgba(0,138,76,.6)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 8px 22px -10px rgba(0,138,76,.5)';
            }}
          >
            <div style={{ position: 'absolute', right: -30, top: -40, width: 140, height: 140, borderRadius: '50%', background: 'rgba(255,255,255,.06)' }} />
            <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div
                style={{
                  width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                  background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.22)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17,
                }}
              >
                🏷️
              </div>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                  <span
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: '#fff', background: 'rgba(255,255,255,.18)', border: '1px solid rgba(255,255,255,.28)',
                      padding: '2px 7px', borderRadius: 20,
                    }}
                  >
                    ✦ Portal Exclusive Offer
                  </span>
                  {isAuto && (
                    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a7f3d0', opacity: 0.9 }}>
                      Auto-applied at checkout
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', lineHeight: 1.3 }}>
                  {p.name}{p.code ? ` · ${p.code}` : ''}
                </div>
                <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.78)', marginTop: 1, lineHeight: 1.4 }}>
                  Save <strong style={{ color: '#fff' }}>{discountLabel(p)}</strong>
                  {ends ? ` · ends ${ends}` : ''}
                  {p.minimumOrderAmount ? ` · min order ${mwk(p.minimumOrderAmount)}` : ''}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); navigate('/portal/new-request'); }}
                style={{
                  flexShrink: 0,
                  padding: '8px 14px', borderRadius: 9, border: 'none',
                  background: '#fff', color: '#0b3e39',
                  fontSize: 12, fontWeight: 800, cursor: 'pointer',
                  boxShadow: '0 4px 12px -4px rgba(0,0,0,.35)',
                  display: 'flex', alignItems: 'center', gap: 5,
                  transition: 'transform .15s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)' }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
              >
                Order now
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default PromotionBanner;
