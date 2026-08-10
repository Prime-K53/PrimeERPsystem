import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { portalApi, portalLifecycle } from '../../../services/portalApiClient';

const SF = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

interface BadgeCounts {
  unpaidInvoices: number;
  activeDeliveries: number;
  unreadNotifications: number;
}

const MobileBottomNav: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [badges, setBadges] = useState<BadgeCounts>({ unpaidInvoices: 0, activeDeliveries: 0, unreadNotifications: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [dash, notifCount] = await Promise.all([
          portalApi.get<any>('/dashboard'),
          portalApi.get<{ count: number }>('/notifications/unread-count'),
        ]);
        if (!cancelled) {
          setBadges({
            unpaidInvoices: dash?.unpaidInvoiceCount ?? 0,
            activeDeliveries: dash?.activeDeliveries ?? 0,
            unreadNotifications: notifCount?.count ?? 0,
          });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        unsub = await portalLifecycle.subscribe({
          onEvent: (type) => {
            if (!cancelled && (type === 'notification' || type === 'entity_changed')) {
              portalApi.get<any>('/dashboard').then((dash) => {
                if (!cancelled) setBadges((prev) => ({ ...prev, unpaidInvoices: dash?.unpaidInvoiceCount ?? 0, activeDeliveries: dash?.activeDeliveries ?? 0 }));
              }).catch(() => {});
              portalApi.get<{ count: number }>('/notifications/unread-count').then((c) => {
                if (!cancelled) setBadges((prev) => ({ ...prev, unreadNotifications: c?.count ?? 0 }));
              }).catch(() => {});
            }
          },
        });
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const Badge: React.FC<{ count: number }> = ({ count }) => {
    if (count <= 0) return null;
    return (
      <span style={{
        position: 'absolute', top: 0, right: 6, minWidth: 15, height: 15,
        borderRadius: 8, background: '#DC2626', color: '#fff',
        fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 4px', border: '1.5px solid #fff',
      }}>
        {count > 99 ? '99+' : count}
      </span>
    );
  };

  const items = [
    { label: 'Overview', path: '/portal/dashboard', badge: 0, icon: (a: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={a ? '#0F2C59' : '#94A3B8'} strokeWidth={a ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
    { label: 'Invoices', path: '/portal/invoices', badge: badges.unpaidInvoices, icon: (a: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={a ? '#0F2C59' : '#94A3B8'} strokeWidth={a ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> },
    { label: 'Orders', path: '/portal/orders', badge: 0, icon: (a: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={a ? '#0F2C59' : '#94A3B8'} strokeWidth={a ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg> },
    { label: 'Deliveries', path: '/portal/shipments', badge: badges.activeDeliveries, icon: (a: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={a ? '#0F2C59' : '#94A3B8'} strokeWidth={a ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg> },
    { label: 'Referrals', path: '/portal/referrals', badge: 0, icon: (a: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={a ? '#0F2C59' : '#94A3B8'} strokeWidth={a ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg> },
  ];

  return (
    <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 56, background: '#fff', borderTop: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'space-around', paddingBottom: 'env(safe-area-inset-bottom,0)', zIndex: 50, fontFamily: SF }}>
      {items.map((item) => {
        const active = location.pathname === item.path || location.pathname.startsWith(item.path + '/');
        return (
          <button key={item.path} onClick={() => navigate(item.path)} aria-label={item.label} aria-current={active ? 'page' : undefined} style={{ position: 'relative', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: 2, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0', minWidth: 52, color: active ? '#0F2C59' : '#94A3B8' }}>
            <span style={{ position: 'relative' }}>
              {item.icon(active)}
              <Badge count={item.badge} />
            </span>
            <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 500, lineHeight: 1.2, fontFamily: SF, color: active ? '#0F2C59' : '#94A3B8' }}>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileBottomNav;
