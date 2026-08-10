import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, User, Building2, Search, Bell } from 'lucide-react';
import { useCustomerAuth } from '../../../context/CustomerAuthContext';
import { useAuth } from '../../../context/AuthContext';
import { portalLifecycle } from '../../../services/portalApiClient';

const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

interface Props { title: string; onMenuToggle: () => void; sidebarCollapsed?: boolean; onCommandToggle?: () => void; }

interface NotificationItem { id: string; type: string; title: string; body: string; link: string; is_read: boolean; created_at: string; }

const PortalHeader: React.FC<Props> = ({ title, onMenuToggle, onCommandToggle }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useCustomerAuth();
  const { companyConfig } = useAuth();
  const [showDD, setShowDD] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [notifs, setNotifs] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const ddRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setShowDD(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotif(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const loadNotifs = async () => {
    try {
      const [l, c] = await Promise.all([portalLifecycle.notifications.list(), portalLifecycle.notifications.unreadCount()]);
      setNotifs(l.slice(0, 10));
      setUnread(c.count);
    } catch {}
  };

  useEffect(() => { loadNotifs(); }, []);
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => { unsub = await portalLifecycle.subscribe({ onEvent: (t) => { if (t === 'notification') loadNotifs(); } }); })();
    return () => { unsub?.(); };
  }, []);

  const logout_ = () => { setShowDD(false); logout(); navigate('/portal/login'); };

  const clickNotif = async (n: NotificationItem) => {
    if (!n.is_read) {
      await portalLifecycle.notifications.markRead(n.id).catch(() => {});
      setNotifs((p) => p.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnread((c) => Math.max(0, c - 1));
    }
    if (n.link) navigate(n.link.startsWith('#') ? n.link.slice(1) : n.link);
    setShowNotif(false);
  };

  const markAll = async () => {
    await portalLifecycle.notifications.markAllRead().catch(() => {});
    setNotifs((p) => p.map((x) => ({ ...x, is_read: true })));
    setUnread(0);
  };

  const isDash = location.pathname === '/portal/dashboard';
  const moduleIcon = isDash ? <Building2 size={22} color="#0F2C59" /> : null;
  const moduleTitle = isDash ? (companyConfig?.companyName || 'Customer') : title;

  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        height: 56,
        background: '#ffffff',
        borderBottom: '1px solid #E2E8F0',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px',
        fontFamily: F,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 1200 }}>
        <div style={{ width: 40, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
          {moduleIcon}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', lineHeight: 1.2, whiteSpace: 'nowrap', textAlign: 'center' }}>{moduleTitle}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
          <button
            onClick={() => onCommandToggle?.()}
            aria-label="Search"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px', borderRadius: 6, color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Search size={18} />
          </button>

          <div ref={notifRef} style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowNotif((v) => !v); setShowDD(false); }}
              aria-label="Notifications"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px', borderRadius: 6, color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
            >
              <Bell size={18} />
              {unread > 0 && (
                <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 14, height: 14, borderRadius: '50%', background: '#DC2626', color: '#fff', fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', border: '1.5px solid #fff' }}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
            {showNotif && (
              <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)', zIndex: 200, width: 300, overflow: 'hidden', animation: 'modalIn .15s ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #F1F5F9' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Notifications</span>
                  {unread > 0 && (
                    <button onClick={markAll} style={{ border: 'none', fontSize: 11, fontWeight: 700, color: '#059669', cursor: 'pointer', padding: '4px 0', background: 'transparent' }}>Mark all read</button>
                  )}
                </div>
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {notifs.length === 0 ? <p style={{ padding: '18px 14px', textAlign: 'center', fontSize: 11.5, color: '#94A3B8' }}>No notifications yet.</p> : notifs.map((n) => (
                    <button key={n.id} onClick={() => clickNotif(n)} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', borderBottom: '1px solid #F1F5F9', background: n.is_read ? 'transparent' : '#F0FDF4', cursor: 'pointer', border: 'none', display: 'block' }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: n.is_read ? '#475569' : '#0F172A', margin: 0, lineHeight: 1.3 }}>{n.title}</p>
                      {n.body && <p style={{ fontSize: 11, color: '#94A3B8', margin: '2px 0 0', lineHeight: 1.3 }}>{n.body}</p>}
                      <p style={{ fontSize: 9.5, color: '#A0AAB8', margin: '3px 0 0' }}>{new Date(n.created_at).toLocaleString()}</p>
                    </button>
                  ))}
                </div>
                <div style={{ padding: '8px 14px', borderTop: '1px solid #F1F5F9' }}>
                  <button onClick={() => { setShowNotif(false); navigate('/portal/notifications'); }} style={{ width: '100%', textAlign: 'center', fontSize: 12, fontWeight: 700, borderRadius: 8, padding: '6px 0', color: '#059669', border: 'none', cursor: 'pointer', background: 'transparent' }}>
                    View all
                  </button>
                </div>
              </div>
            )}
          </div>

          <div ref={ddRef} style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowDD(!showDD); setShowNotif(false); }}
              aria-label="Account menu"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg, #34D399, #0F2C59)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 700, boxShadow: '0 2px 8px -2px rgba(15,44,89,0.4)' }}>
                {(user?.full_name || user?.email || 'C').charAt(0).toUpperCase()}
              </div>
            </button>
            {showDD && (
              <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)', zIndex: 200, width: 190, overflow: 'hidden', padding: 6, animation: 'modalIn .15s ease' }}>
                <div style={{ padding: '6px 10px 8px', borderBottom: '1px solid #F1F5F9', marginBottom: 4 }}>
                  <p style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', margin: 0, lineHeight: 1.3 }}>{user?.full_name || 'Customer'}</p>
                  <p style={{ fontSize: 11, color: '#94A3B8', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email || ''}</p>
                </div>
                <button onClick={() => { setShowDD(false); navigate('/portal/profile'); }} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 500, color: '#475569' }}>
                  <User size={13} style={{ color: '#94A3B8' }} /> Profile
                </button>
                <button onClick={logout_} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 500, color: '#DC2626' }}>
                  <LogOut size={13} /> Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes modalIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </header>
  );
};

export default PortalHeader;
