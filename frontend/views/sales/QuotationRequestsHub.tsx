import React, { useEffect, useState, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox, FileText, PackageCheck, HandCoins, History, Search, Users, Calendar, Plus, Loader2 } from 'lucide-react';
import GenericHub from '../GenericHub';
import QuotationRequests from './QuotationRequests';
import { adminLifecycle } from '../../services/adminPortalClient';
import { getJsonRequestHeaders } from '../../services/requestHeaders';
import { API_BASE_URL } from '../../config/api.js';
import { markAlertsReadForActionUrl } from '../../services/systemAlertService';
import { formatDate } from '../../utils/formatters';

const QUOTATION_STATUSES = ['submitted', 'assigned', 'under_review', 'waiting_for_customer', 'ready_for_conversion'];
const HISTORY_STATUSES = ['rejected', 'cancelled', 'converted'];

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  submitted: { label: 'New', color: '#1d4ed8', bg: '#eff6ff' },
  assigned: { label: 'Assigned', color: '#0f766e', bg: '#f0fdfa' },
  under_review: { label: 'Review', color: '#b45309', bg: '#fffbeb' },
  waiting_for_customer: { label: 'Waiting', color: '#7c3aed', bg: '#f5f3ff' },
  ready_for_conversion: { label: 'Ready', color: '#047857', bg: '#ecfdf5' },
  converted: { label: 'Converted', color: '#0f766e', bg: '#f0fdfa' },
  rejected: { label: 'Rejected', color: '#b91c1c', bg: '#fef2f2' },
  cancelled: { label: 'Cancelled', color: '#64748b', bg: '#f1f5f9' },
};

const QuotationRequestsHub: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const targetTab = (location.state as any)?.tab;

  const [inboxCount, setInboxCount] = useState(0);
  const [quotationCount, setQuotationCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  const [paymentCount, setPaymentCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [allRequests, setAllRequests] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await adminLifecycle.requests.markInboxRead().catch(() => {});
        await markAlertsReadForActionUrl('/sales-flow/requests').catch(() => {});

        const [reqs, inboxReqs, quotes, orderList, paymentReqs, staff] = await Promise.all([
          adminLifecycle.requests.list(),
          adminLifecycle.requests.inbox().catch(() => []),
          adminLifecycle.quotations.list(),
          adminLifecycle.orders.list().catch(() => []),
          fetch(`${API_BASE_URL}/payment-requests`, { headers: await getJsonRequestHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []),
          adminLifecycle.staff.list().catch(() => []),
        ]);
        if (cancelled) return;
        setAllRequests(reqs || []);
        setInboxCount((inboxReqs || []).length);
        setQuotationCount((quotes || []).length);
        setOrderCount((orderList || []).length);
        setPaymentCount(Array.isArray(paymentReqs) ? paymentReqs.length : 0);
        setHistoryCount((reqs || []).filter((r: any) => HISTORY_STATUSES.includes(String(r.status || ''))).length);
        setStaffList(staff || []);
      } catch {
        if (!cancelled) {
          setInboxCount(0);
          setQuotationCount(0);
          setOrderCount(0);
          setPaymentCount(0);
          setHistoryCount(0);
        }
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const urgentInbox = useMemo(() =>
    (allRequests.filter((r: any) => r.status === 'submitted')).length,
    [allRequests]
  );

  const assignedCount = useMemo(() =>
    (allRequests.filter((r: any) => QUOTATION_STATUSES.includes(r.status) && r.assigned_to)).length,
    [allRequests]
  );

  const unassignedCount = useMemo(() =>
    (allRequests.filter((r: any) => QUOTATION_STATUSES.includes(r.status) && !r.assigned_to)).length,
    [allRequests]
  );

  const pendingPayment = useMemo(() =>
    (allRequests.filter((r: any) => r.status === 'waiting_for_customer')).length,
    [allRequests]
  );

  if (targetTab) {
    return <QuotationRequests />;
  }

  const options = [
    {
      label: 'Inbox',
      description: 'Review new customer requests, assign staff, and triage submissions.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'inbox' } }),
      icon: Inbox,
      badge: inboxCount || undefined,
      badgeColor: urgentInbox > 0 ? '#1d4ed8' : undefined,
      urgentCount: urgentInbox > 0 ? urgentInbox : undefined,
    },
    {
      label: 'Quotations',
      description: 'Review official quotations, track versions, signatures, and conversions.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'quotations' } }),
      icon: FileText,
      badge: quotationCount || undefined,
      badgeColor: pendingPayment > 0 ? '#b45309' : undefined,
    },
    {
      label: 'Orders',
      description: 'Manage sales orders, track fulfillment status, and advance production milestones.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'orders' } }),
      icon: PackageCheck,
      badge: orderCount || undefined,
    },
    {
      label: 'Payment Requests',
      description: 'Manage bank-transfer payment intents linked to requests and orders.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'payments' } }),
      icon: HandCoins,
      badge: paymentCount || undefined,
      badgeColor: paymentCount > 0 ? '#b45309' : undefined,
    },
    {
      label: 'Staff Assignments',
      description: 'View and manage requests grouped by assigned salesperson.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'assignments' } }),
      icon: Users,
      badge: assignedCount || undefined,
      badgeSecondary: unassignedCount > 0 ? `${unassignedCount} unassigned` : undefined,
    },
    {
      label: 'Timeline',
      description: 'View all requests chronologically with status tracking.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'timeline' } }),
      icon: Calendar,
      badge: allRequests.length || undefined,
    },
    {
      label: 'History',
      description: 'Audit trail of rejected, cancelled, and converted requests.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'history' } }),
      icon: History,
      badge: historyCount || undefined,
    },
  ];

  return (
    <GenericHub
      title="Requests"
      subtitle="Review customer requests, issue quotations, and convert accepted quotes into orders."
      options={options}
      accentColor="#146b60"
      extraContent={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  await adminLifecycle.requests.markInboxRead().catch(() => {});
                  await markAlertsReadForActionUrl('/sales-flow/requests').catch(() => {});
                  window.dispatchEvent(new CustomEvent('primeerp:notification-update'));
                  setInboxCount(0);
                }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 9, cursor: 'pointer',
                  background: 'transparent', border: `1.4px solid #e4ddd1`, color: '#5c6567',
                  fontSize: 12, fontWeight: 600, transition: 'all .15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#eef7f6'; e.currentTarget.style.color = '#0f544c'; e.currentTarget.style.borderColor = '#3fa294'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#5c6567'; e.currentTarget.style.borderColor = '#e4ddd1'; }}
              >
                <Inbox size={14} /> Mark All Read
              </button>
              <button
                onClick={() => navigate('/portal/requests/new')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 9, cursor: 'pointer',
                  background: 'linear-gradient(155deg, #1f8577, #0f544c)',
                  border: '1.4px solid transparent', color: '#fff',
                  fontSize: 12, fontWeight: 600, boxShadow: '0 4px 10px -3px rgba(15,84,76,.5)',
                  transition: 'all .15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 14px -3px rgba(15,84,76,.6)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 4px 10px -3px rgba(15,84,76,.5)'; }}
              >
                <Plus size={14} /> New Request
              </button>
            </div>
            <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 400 }}>
              <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#5c6567', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder="Search requests by customer, number, or item..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13,
                  color: '#23282A', background: '#FEFDFB',
                  border: `1.4px solid #e4ddd1`, borderRadius: 9,
                  padding: '9px 12px 9px 34px', outline: 'none',
                  transition: 'border-color .15s ease, box-shadow .15s ease',
                }}
                onFocus={e => { (e.target as HTMLInputElement).style.borderColor = '#3fa294'; (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px #eef7f6'; }}
                onBlur={e => { (e.target as HTMLInputElement).style.borderColor = '#e4ddd1'; (e.target as HTMLInputElement).style.boxShadow = 'none'; }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none', cursor: 'pointer', color: '#5c6567',
                    display: 'flex', padding: 2,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {search && (
            <div style={{
              background: '#FEFDFB', border: `1.4px solid #e4ddd1`, borderRadius: 12,
              padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.06 }}>
                Search Results for "{search}"
              </div>
              <SearchResults requests={allRequests} search={search} staffList={staffList} />
            </div>
          )}

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
          }}>
            <QuickStat label="Total Requests" value={allRequests.length} color="#1f8577" bg="#eef7f6" />
            <QuickStat label="Pending Action" value={urgentInbox} color="#1d4ed8" bg="#eff6ff" />
            <QuickStat label="Waiting on Customer" value={pendingPayment} color="#7c3aed" bg="#f5f3ff" />
            <QuickStat label="Unassigned" value={unassignedCount} color="#b45309" bg="#fffbeb" />
          </div>
        </div>
      }
    />
  );
};

const QuickStat: React.FC<{ label: string; value: number; color: string; bg: string }> = ({ label, value, color, bg }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px', borderRadius: 10,
    background: bg, border: `1.4px solid ${color}22`,
  }}>
    <span style={{ fontSize: 20, fontWeight: 800, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
    <span style={{ fontSize: 11, fontWeight: 600, color, opacity: 0.8 }}>{label}</span>
  </div>
);

const SearchResults: React.FC<{ requests: any[]; search: string; staffList: any[] }> = ({ requests, search, staffList }) => {
  const q = search.toLowerCase();
  const filtered = useMemo(() =>
    requests.filter((r: any) => {
      if (!q) return false;
      const customerMatch = (r.customer_name || '').toLowerCase().includes(q);
      const numberMatch = (r.request_number || '').toLowerCase().includes(q);
      const itemMatch = (r.items || []).some((i: any) => (i.name || '').toLowerCase().includes(q));
      const assignedMatch = (r.assigned_to ? (staffList.find((s: any) => s.id === r.assigned_to)?.username || '').toLowerCase().includes(q) : false);
      return customerMatch || numberMatch || itemMatch || assignedMatch;
    }).slice(0, 10),
    [requests, search, staffList]
  );

  if (filtered.length === 0) {
    return <p style={{ fontSize: 13, color: '#5c6567', margin: 0 }}>No requests match "{search}"</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {filtered.map((r: any) => {
        const meta = STATUS_META[r.status] || { label: r.status, color: '#64748b', bg: '#f1f5f9' };
        const staffName = r.assigned_to ? (staffList.find((s: any) => s.id === r.assigned_to)?.username || r.assigned_to) : null;
        return (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '8px 12px', borderRadius: 8,
            background: '#fff', border: `1px solid #e4ddd1`,
            cursor: 'pointer',
          }}
            onClick={() => window.location.href = '/sales-flow/requests'}
          >
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, color: '#23282A' }}>
              {r.request_number}
            </span>
            <span style={{ fontSize: 12, color: '#5c6567', flex: 1 }}>
              {r.customer_name || 'Unknown Customer'}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.color }}>
              {meta.label}
            </span>
            {staffName && (
              <span style={{ fontSize: 11, color: '#0f766e', fontWeight: 600 }}>
                → {staffName}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default QuotationRequestsHub;
