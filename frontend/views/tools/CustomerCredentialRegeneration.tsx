import React, { useState } from 'react';
import { Key, Play, AlertTriangle, CheckCircle, XCircle, RefreshCw, Download, Copy, Mail, UserPlus } from 'lucide-react';
import { adminLifecycle, type BulkRegenerateResult, type BulkRegenerateResultRow } from '../../services/adminPortalClient';
import { ConfirmDialog, type ConfirmDialogType } from '../../components/ConfirmDialog';
import { useSalesStore } from '../../stores/salesStore';

const t = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39' };
const amber = { 100: '#fbead0', 500: '#d99a3f' };
const paper = '#FEFDFB', ink = '#23282A', inkSoft = '#5c6567', hairline = '#e4ddd1', danger = '#b5493f';

const CustomerCredentialRegeneration: React.FC = () => {
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<BulkRegenerateResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; confirmText?: string; type?: ConfirmDialogType; onConfirm?: () => void }>({ open: false, title: '', message: '' });

    const handleRun = () => {
        setConfirmState({
            open: true, title: 'Regenerate ALL customer credentials',
            message: 'This overwrites every customer\'s portal login email with the standard derived address (e.g. name@primeportal.com) and issues a fresh 30‑minute invitation code. Customers without a portal account will be created (invited).\n\nTheir old login email will stop working immediately. This cannot be undone.\n\nContinue?',
            type: 'warning', confirmText: 'Regenerate All',
            onConfirm: async () => {
                setRunning(true); setResult(null); setError(null);
                try {
                    const data = await adminLifecycle.users.bulkRegenerateCredentials();
                    setResult(data);
                    // Reflect the new portal login emails immediately in the customer
                    // list and any open customer card (both read from salesStore).
                    const emailById = new Map<string, string>();
                    (data.results || []).forEach((r: BulkRegenerateResultRow) => emailById.set(r.customer_id, r.email));
                    if (emailById.size > 0) {
                        useSalesStore.setState((state) => ({
                            customers: (state.customers || []).map((c) =>
                                emailById.has(c.id)
                                    ? { ...c, email: emailById.get(c.id)!, portalEmail: emailById.get(c.id)! }
                                    : c
                            ),
                        }));
                    }
                } catch (err: any) {
                    setError(err?.message || 'Bulk regeneration failed');
                } finally { setRunning(false); }
            }
        });
    };

    const copy = (text: string, key: string) => {
        try {
            navigator.clipboard.writeText(text).then(() => {
                setCopied(key);
                setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
            }).catch(() => {});
        } catch { /* ignore */ }
    };

    const handleExport = () => {
        if (!result) return;
        const rows = result.results.map((r: BulkRegenerateResultRow) => [
            r.customer_id,
            `"${String(r.customer_name).replace(/"/g, '""')}"`,
            r.previous_email || '',
            r.email,
            r.invite_code,
            r.created ? 'created' : 'updated',
        ].join(','));
        const csv = [['Customer ID', 'Name', 'Previous Email', 'New Email', 'Invite Code', 'Status'].join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `customer-credentials-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const CopyBtn: React.FC<{ value: string; id: string }> = ({ value, id }) => (
        <button
            onClick={() => copy(value, id)}
            title="Copy"
            style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer', color: copied === id ? t[500] : inkSoft, padding: 0, verticalAlign: 'middle' }}
        >
            {copied === id ? <CheckCircle size={13} /> : <Copy size={13} />}
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: paper, borderRadius: 14, border: `1.4px solid ${hairline}`, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1.4px solid ${hairline}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ padding: 8, background: t[50], color: t[500], borderRadius: 8 }}><Key size={24} /></div>
                    <div>
                        <h2 style={{ fontSize: 20, fontWeight: 700, color: ink, margin: 0 }}>Customer Portal Credentials</h2>
                        <p style={{ fontSize: 13, color: inkSoft, margin: '2px 0 0' }}>Regenerate every customer's portal login email and invitation code in one action</p>
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
                <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
                    <div style={{ background: '#fef7ed', borderRadius: 14, padding: 16, border: `1.4px solid #fde6c8`, display: 'flex', gap: 12 }}>
                        <AlertTriangle size={20} style={{ color: amber[500], flexShrink: 0, marginTop: 1 }} />
                        <div style={{ fontSize: 13, color: '#7c4a03', lineHeight: 1.5 }}>
                            <strong>Heads up:</strong> This action rewrites all customer portal login emails and rotates their invitation codes. The previous login email for each customer stops working right away. New codes expire in 30 minutes — share them with customers promptly (or use the portal invitation flow).
                        </div>
                    </div>

                    {!running && !result && !error && (
                        <button className="prime-btn" onClick={handleRun} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '14px 24px', background: amber[500], color: '#fff', borderRadius: 14, border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer', boxShadow: `0 6px 20px -6px rgba(217,154,63,.5)`, transition: 'all .15s ease' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#c0842b'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = amber[500]; }}
                        ><Play size={20} /> Regenerate All Customer Credentials</button>
                    )}

                    {running && (
                        <div style={{ background: t[50], borderRadius: 14, padding: 28, border: `1.4px solid ${hairline}`, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <RefreshCw size={32} style={{ margin: '0 auto', color: amber[500] }} className="animate-spin" />
                            <div><p style={{ fontWeight: 700, color: ink, margin: 0 }}>Regenerating credentials…</p><p style={{ fontSize: 13, color: inkSoft, marginTop: 4 }}>Processing every customer. This may take a moment.</p></div>
                        </div>
                    )}

                    {error && (
                        <div style={{ background: '#fef0ee', borderRadius: 14, padding: 16, border: `1px solid #fecaca`, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <XCircle size={20} style={{ color: danger, flexShrink: 0 }} />
                            <p style={{ fontSize: 13, color: danger, margin: 0 }}>{error}</p>
                        </div>
                    )}

                    {result && !running && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
                                {[
                                    { label: 'Processed', value: result.processed, color: t[500], bg: t[100], icon: <CheckCircle size={20} /> },
                                    { label: 'Created', value: result.created, color: '#6366f1', bg: '#eef2ff', icon: <UserPlus size={20} /> },
                                    { label: 'Failed', value: result.failed, color: danger, bg: '#fef0ee', icon: <XCircle size={20} /> },
                                    { label: 'Total Customers', value: result.total, color: inkSoft, bg: hairline, icon: <Mail size={20} /> },
                                ].map((c, i) => (
                                    <div key={i} style={{ background: c.bg, borderRadius: 14, padding: 14, textAlign: 'center', border: `1px solid ${hairline}` }}>
                                        <div style={{ color: c.color, marginBottom: 4 }}>{c.icon}</div>
                                        <p style={{ fontSize: 22, fontWeight: 800, color: c.color, margin: 0 }}>{c.value}</p>
                                        <p style={{ fontSize: 10, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{c.label}</p>
                                    </div>
                                ))}
                            </div>

                            {result.failed > 0 && (
                                <div style={{ background: '#fef0ee', borderRadius: 14, padding: 14, border: `1px solid #fecaca` }}>
                                    <h4 style={{ fontSize: 13, fontWeight: 700, color: danger, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={16} /> Failures</h4>
                                    <div style={{ maxHeight: 140, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        {result.errors.map((e, i) => (<p key={i} style={{ fontSize: 12, color: danger, margin: 0 }}>{e.customer_name} ({e.customer_id}): {e.error}</p>))}
                                    </div>
                                </div>
                            )}

                            <div style={{ background: paper, borderRadius: 14, border: `1.4px solid ${hairline}`, overflow: 'hidden' }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1.4px solid ${hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <h4 style={{ fontSize: 14, fontWeight: 700, color: ink, margin: 0 }}>Results</h4>
                                    <span style={{ fontSize: 11, color: inkSoft }}>{result.results.length} customers · codes expire in 30 min</span>
                                </div>
                                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                        <thead style={{ position: 'sticky', top: 0, background: '#f8fafc' }}>
                                            <tr style={{ textAlign: 'left', color: inkSoft }}>
                                                <th style={{ padding: '8px 12px', fontWeight: 700 }}>Customer</th>
                                                <th style={{ padding: '8px 12px', fontWeight: 700 }}>Previous Email</th>
                                                <th style={{ padding: '8px 12px', fontWeight: 700 }}>New Login Email</th>
                                                <th style={{ padding: '8px 12px', fontWeight: 700 }}>Invite Code</th>
                                                <th style={{ padding: '8px 12px', fontWeight: 700 }}>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.results.map((r) => (
                                                <tr key={r.customer_id} style={{ borderTop: `1px solid ${hairline}` }}>
                                                    <td style={{ padding: '8px 12px' }}>
                                                        <div style={{ fontWeight: 600, color: ink }}>{r.customer_name || '—'}</div>
                                                        <div style={{ fontSize: 10, color: inkSoft, fontFamily: 'monospace' }}>{r.customer_id}</div>
                                                    </td>
                                                    <td style={{ padding: '8px 12px', color: inkSoft }}>{r.previous_email || <span style={{ color: '#94a3b8' }}>—</span>}</td>
                                                    <td style={{ padding: '8px 12px', color: ink, fontFamily: 'monospace' }}>
                                                        {r.email}<CopyBtn value={r.email} id={`email-${r.customer_id}`} />
                                                    </td>
                                                    <td style={{ padding: '8px 12px', color: ink, fontFamily: 'monospace', fontWeight: 700 }}>
                                                        {r.invite_code}<CopyBtn value={r.invite_code} id={`code-${r.customer_id}`} />
                                                    </td>
                                                    <td style={{ padding: '8px 12px' }}>
                                                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: r.created ? '#eef2ff' : t[50], color: r.created ? '#4338ca' : t[700] }}>
                                                            {r.created ? 'Created' : 'Updated'}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: 12 }}>
                                <button className="prime-btn" onClick={handleRun} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 20px', background: amber[500], color: '#fff', borderRadius: 14, border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}><RefreshCw size={16} /> Run Again</button>
                                <button className="prime-btn-secondary" onClick={handleExport} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 20px', background: t[50], color: ink, borderRadius: 14, border: `1.4px solid ${hairline}`, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}><Download size={16} /> Export CSV</button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <ConfirmDialog
                open={confirmState.open}
                onOpenChange={(open) => !open && setConfirmState((c) => ({ ...c, open: false }))}
                onConfirm={() => { confirmState.onConfirm?.(); setConfirmState((c) => ({ ...c, open: false })); }}
                onCancel={() => setConfirmState((c) => ({ ...c, open: false }))}
                title={confirmState.title}
                message={confirmState.message}
                confirmText={confirmState.confirmText}
                type={confirmState.type || 'warning'}
            />
        </div>
    );
};

export default CustomerCredentialRegeneration;
