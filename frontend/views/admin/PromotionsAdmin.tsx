import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { dbService } from '../../services/db'
import {
  Promotion, PromotionChannel, PromotionStatus, PromotionDiscountType,
  PromotionCalculationResult, PromotionAnalytics,
} from '../../types/engagement'
import {
  Plus, Search, Pencil, Trash2, Save, X, Play, Pause, Tag, Percent,
  Calendar, Users, Package, Award, TrendingUp, BadgePercent, Layers,
  CheckCircle2, AlertTriangle, Filter, Sparkles, Gift, Clock,
} from 'lucide-react'
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { API_BASE_URL } from '../../config/api.js'
import { ensureSessionAuthState } from '../../services/authSession'

const t = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39' }
const amber = { 100: '#fbead0', 500: '#d99a3f' }
const paper = '#FEFDFB', ink = '#23282A', inkSoft = '#5c6567', hairline = '#e4ddd1', danger = '#b5493f'
const violet = { 50: '#f3f0ff', 100: '#e4dcff', 500: '#7c5cf0', 700: '#5b3fd4' }

const CHANNELS: PromotionChannel[] = ['PORTAL', 'ERP', 'BOTH']
const DISCOUNT_TYPES: PromotionDiscountType[] = ['percentage', 'fixed_amount', 'fixed_price', 'buy_x_get_y', 'coupon', 'tiered']
const STATUSES: PromotionStatus[] = ['draft', 'scheduled', 'active', 'paused', 'expired', 'cancelled']

const fmt = (v: any) => {
  const n = Number(v || 0)
  return `MWK ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
const fmtInt = (v: any) => Number(v || 0).toLocaleString()

// Mirrors the server-side status derivation (backend/services/promotionEngine.cjs).
const deriveStatus = (p: any, now = new Date()): PromotionStatus => {
  if (!p) return 'draft'
  if (p.cancelledAt) return 'cancelled'
  if (p.status === 'cancelled') return 'cancelled'
  if (p.pausedAt || p.status === 'paused') return 'paused'
  if (p.status === 'draft') return 'draft'
  const ts = now.getTime()
  const start = p.startsAt || p.starts_at ? new Date(p.startsAt || p.starts_at).getTime() : null
  const end = p.endsAt || p.ends_at || p.expiresAt ? new Date(p.endsAt || p.ends_at || p.expiresAt).getTime() : null
  if (start !== null && !Number.isNaN(start) && ts < start) return 'scheduled'
  if (end !== null && !Number.isNaN(end) && ts > end) return 'expired'
  if (p.isActive === false) return 'draft'
  return 'active'
}

const STATUS_META: Record<PromotionStatus, { bg: string; fg: string; dot: string }> = {
  draft: { bg: hairline, fg: inkSoft, dot: '#94a3b8' },
  scheduled: { bg: violet[100], fg: violet[700], dot: '#7c5cf0' },
  active: { bg: t[100], fg: t[700], dot: '#1f8577' },
  paused: { bg: amber[100], fg: '#92400e', dot: '#d99a3f' },
  expired: { bg: '#fef0ee', fg: danger, dot: '#b5493f' },
  cancelled: { bg: '#f1f2f4', fg: '#64748b', dot: '#94a3b8' },
}

const discountLabel = (p: any) => {
  const type = String(p.discountType || p.type || 'percentage')
  const value = Number(p.discountValue ?? p.value ?? 0)
  if (type === 'percentage' || type === 'coupon' || type === 'campaign' || type === 'category' || type === 'brand' || type === 'bundle' || type === 'tier' || type === 'tiered') return `${value}%`
  if (type === 'fixed_price') return `MWK ${value} each`
  if (type === 'buy_x_get_y') return `Buy ${p.buyXQty || 0} Get ${p.getYQty || 0}`
  return `MWK ${value} off`
}

const emptyForm = (): Partial<Promotion> => ({
  name: '',
  description: '',
  code: '',
  channel: 'PORTAL',
  discountType: 'percentage',
  discountValue: 10,
  status: 'draft',
  isActive: true,
  isAutoApply: true,
  stackable: false,
  priority: 0,
  startsAt: new Date().toISOString().slice(0, 16),
  endsAt: '',
  minimumOrderAmount: 0,
  maximumDiscountAmount: 0,
  usageLimit: 0,
  usageLimitPerCustomer: 0,
  applicableTo: 'all',
  customerScope: 'all',
  productIds: [],
  categoryIds: [],
  customerIds: [],
})

const toCanonical = (f: Partial<Promotion>): Promotion => {
  const discountType = (f.discountType || 'percentage') as PromotionDiscountType
  const discountValue = Number(f.discountValue ?? 0) || 0
  const legacyTypeMap: Record<string, string> = {
    percentage: 'percentage', fixed_amount: 'fixed', fixed_price: 'fixed',
    buy_x_get_y: 'buy_x_get_y', coupon: 'coupon', tiered: 'tier', category: 'category', brand: 'brand',
  }
  return {
    id: f.id || `PROMO_${Date.now()}`,
    name: String(f.name || '').trim(),
    description: f.description || null,
    code: f.code ? String(f.code).trim().toUpperCase() : null,
    promotionCode: f.code ? String(f.code).trim().toUpperCase() : null,
    channel: f.channel || 'PORTAL',
    discountType,
    discountValue,
    valueType: discountType === 'percentage' ? 'percentage' : 'fixed',
    // Legacy aliases so the engagement module + sales panels keep working.
    type: legacyTypeMap[discountType] as any,
    value: discountValue,
    status: f.status || 'draft',
    isActive: f.isActive !== undefined ? !!f.isActive : true,
    isAutoApply: f.isAutoApply !== undefined ? !!f.isAutoApply : true,
    stackable: !!f.stackable,
    priority: Number(f.priority ?? 0) || 0,
    startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : new Date().toISOString(),
    endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
    expiresAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
    minimumOrderAmount: Number(f.minimumOrderAmount ?? 0) || 0,
    minPurchase: Number(f.minimumOrderAmount ?? 0) || 0,
    maximumDiscountAmount: Number(f.maximumDiscountAmount ?? 0) || 0,
    maxDiscount: Number(f.maximumDiscountAmount ?? 0) || 0,
    usageLimit: Number(f.usageLimit ?? 0) || 0,
    maxUses: Number(f.usageLimit ?? 0) || 0,
    usageLimitPerCustomer: Number(f.usageLimitPerCustomer ?? 0) || 0,
    per_customer_limit: Number(f.usageLimitPerCustomer ?? 0) || 0,
    applicableTo: f.applicableTo || 'all',
    productIds: f.productIds || [],
    categoryIds: f.categoryIds || [],
    customerScope: f.customerScope || 'all',
    customerIds: f.customerIds || [],
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }
}

export const PromotionsAdmin: React.FC = () => {
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState<Partial<Promotion>>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null)
  const [analytics, setAnalytics] = useState<PromotionAnalytics | null>(null)
  const [preview, setPreview] = useState<PromotionCalculationResult | null>(null)
  const [sampleAmount, setSampleAmount] = useState(100000)
  const [saving, setSaving] = useState(false)
  const [notify, setNotify] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await dbService.getAll<Promotion>('engagementPromotions')
      setPromotions([...data].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)))
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to load promotions' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Best-effort analytics from the backend (offline-safe).
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const session = ensureSessionAuthState()
        const res = await fetch(`${API_BASE_URL}/promotions/analytics`, {
          headers: { Authorization: `Bearer ${session.accessToken || ''}` },
        })
        if (res.ok && !cancelled) setAnalytics(await res.json())
      } catch {
        /* offline — analytics stay null */
      }
    }
    run()
    return () => { cancelled = true }
  }, [promotions.length])

  const effective = useMemo(
    () => promotions.map((p) => ({ ...p, _effectiveStatus: deriveStatus(p) })),
    [promotions]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return effective.filter((p) => {
      if (statusFilter !== 'all' && p._effectiveStatus !== statusFilter) return false
      if (channelFilter !== 'all' && String(p.channel || 'BOTH') !== channelFilter) return false
      if (typeFilter !== 'all' && String(p.discountType || p.type || '') !== typeFilter) return false
      if (q && !`${p.name} ${p.code || p.promotionCode || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [effective, search, statusFilter, channelFilter, typeFilter])

  const stats = useMemo(() => {
    const counts: Record<string, number> = { active: 0, scheduled: 0, expired: 0, paused: 0, draft: 0, cancelled: 0 }
    let totalUsage = 0
    for (const p of promotions) {
      const s = p._effectiveStatus || deriveStatus(p)
      if (counts[s] !== undefined) counts[s] += 1
      totalUsage += Number(p.usedCount ?? p.currentUses ?? 0) || 0
    }
    const a = analytics?.totals
    return {
      counts,
      totalUsage,
      totalDiscount: a?.discountAmount ?? null,
      netSales: a?.netSales ?? null,
      orders: a?.orders ?? null,
      avgOrder: a?.averageOrderValue ?? null,
    }
  }, [promotions, analytics])

  // Live preview: recompute whenever the form discount changes.
  useEffect(() => {
    const type = String(form.discountType || 'percentage')
    const value = Number(form.discountValue ?? 0) || 0
    const gross = Math.max(0, Number(sampleAmount) || 0)
    let discountTotal = 0
    if (type === 'percentage' || type === 'coupon' || type === 'tiered' || type === 'category' || type === 'brand' || type === 'bundle') {
      discountTotal = gross * (value / 100)
    } else if (type === 'fixed_amount') {
      discountTotal = value
    } else if (type === 'fixed_price') {
      discountTotal = value > 0 && value < 10000 ? (10000 - value) * Math.max(1, Math.round(gross / 10000)) : 0
    }
    const maxDiscount = Number(form.maximumDiscountAmount ?? 0) || 0
    if (maxDiscount > 0) discountTotal = Math.min(discountTotal, maxDiscount)
    discountTotal = Math.min(Math.max(discountTotal, 0), gross)
    setPreview({
      applied: discountTotal > 0,
      promotions: [],
      lines: [],
      subtotal: gross,
      discountTotal: Math.round(discountTotal * 100) / 100,
      subtotalBeforeDiscount: gross,
      subtotalAfterDiscount: Math.round((gross - discountTotal) * 100) / 100,
      taxableSubtotal: Math.round((gross - discountTotal) * 100) / 100,
      grandTotal: Math.round((gross - discountTotal) * 100) / 100,
      metadata: {},
    })
  }, [form.discountType, form.discountValue, form.maximumDiscountAmount, sampleAmount])

  const saveNew = async () => {
    if (!form.name || !String(form.name).trim()) {
      setNotify({ kind: 'error', text: 'Promotion name is required.' })
      return
    }
    setSaving(true)
    try {
      const record = toCanonical(form)
      await dbService.put('engagementPromotions', record)
      setShowNew(false)
      setForm(emptyForm())
      setNotify({ kind: 'success', text: `Promotion "${record.name}" created.` })
      await load()
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to create promotion' })
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (p: Promotion) => {
    setEditingId(p.id)
    setForm({
      ...p,
      endsAt: p.endsAt || p.expiresAt ? (p.endsAt || p.expiresAt || '').slice(0, 16) : '',
      startsAt: (p.startsAt || new Date().toISOString()).slice(0, 16),
    })
    setShowNew(true)
  }

  const saveEdit = async () => {
    if (!editingId || !form.name) return
    setSaving(true)
    try {
      const existing = promotions.find((p) => p.id === editingId)
      const record = toCanonical({ ...existing, ...form, id: editingId })
      await dbService.put('engagementPromotions', record)
      setShowNew(false)
      setEditingId(null)
      setForm(emptyForm())
      setNotify({ kind: 'success', text: 'Promotion updated.' })
      await load()
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to update promotion' })
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (p: Promotion) => {
    const current = deriveStatus(p)
    const next: PromotionStatus = current === 'active' ? 'paused' : 'active'
    await dbService.put('engagementPromotions', {
      ...p,
      status: next,
      isActive: next === 'active',
      pausedAt: next === 'paused' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    } as Promotion)
    setNotify({ kind: 'success', text: next === 'active' ? 'Promotion activated.' : 'Promotion paused.' })
    await load()
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    await dbService.delete('engagementPromotions', deleteTarget.id)
    setDeleteTarget(null)
    setNotify({ kind: 'success', text: `Promotion "${deleteTarget.name}" deleted.` })
    await load()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: ink,
    background: paper, border: `1.4px solid ${hairline}`, borderRadius: 9, padding: '7px 10px', outline: 'none',
  }

  const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
    <div>
      <label className="prime-label" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: inkSoft, marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <p style={{ margin: '3px 0 0', fontSize: 10.5, color: '#8a9496', lineHeight: 1.4 }}>{hint}</p>}
    </div>
  )

  const Input = ({ value, onChange, type = 'text', placeholder }: any) => (
    <input className="prime-input" type={type} value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} style={inputStyle} />
  )

  const Select = ({ value, onChange, options }: any) => (
    <select className="prime-select" value={value} onChange={(e) => onChange(e.target.value)} style={{
      ...inputStyle, appearance: 'none', cursor: 'pointer',
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 30,
    }}>
      {options.map((o: any) => <option key={String(o.value ?? o)} value={String(o.value ?? o)}>{o.label ?? o}</option>)}
    </select>
  )

  const Toggle = ({ value, onChange, label }: any) => (
    <button type="button" onClick={() => onChange(!value)} style={{
      display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
    }}>
      <span style={{
        width: 38, height: 21, borderRadius: 20, position: 'relative', transition: 'all .18s ease', flexShrink: 0,
        background: value ? t[500] : '#d6dadd',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: value ? 19 : 2, width: 17, height: 17, borderRadius: '50%',
          background: '#fff', transition: 'all .18s ease', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
        }} />
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: ink }}>{label}</span>
    </button>
  )

  const StatCard = ({ icon, label, value, sub, accent }: any) => (
    <div className="prime-card" style={{
      background: paper, borderRadius: 14, border: `1.4px solid ${hairline}`, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 1px 3px rgba(0,0,0,.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: accent || t[50], color: t[700], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
        <span style={{ fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>{label}</span>
      </div>
      <span style={{ fontSize: 20, fontWeight: 800, color: ink, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.2, lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 10.5, color: '#8a9496' }}>{sub}</span>}
    </div>
  )

  const StatusBadge = ({ status }: { status: PromotionStatus }) => {
    const m = STATUS_META[status] || STATUS_META.draft
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: m.bg, color: m.fg }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.dot }} />
        {status}
      </span>
    )
  }

  const ChannelTag = ({ channel }: { channel?: string }) => {
    const c = String(channel || 'BOTH')
    const portal = c === 'PORTAL' || c === 'BOTH'
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
        padding: '2px 8px', borderRadius: 6,
        background: portal ? 'linear-gradient(135deg,#f0fdf9,#ecfdf5)' : '#f1f2f4',
        border: portal ? '1px solid #a7f3d0' : `1px solid ${hairline}`,
        color: portal ? '#047857' : inkSoft,
      }}>
        <Sparkles size={10} />
        {c === 'BOTH' ? 'ERP + PORTAL' : c}
      </span>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto', background: t[50], minHeight: '100%' }}>
      {/* ── Header ── */}
      <div style={{
        background: 'linear-gradient(135deg,#0b3e39 0%,#146b60 55%,#1f8577 100%)', borderRadius: 16, padding: '22px 24px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 20,
        boxShadow: '0 12px 28px -12px rgba(11,62,57,.55)', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', right: -40, top: -60, width: 220, height: 220, borderRadius: '50%', background: 'rgba(255,255,255,.05)' }} />
        <div style={{ position: 'absolute', right: 60, bottom: -80, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,.04)' }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,.2)' }}>
              <BadgePercent size={22} color="#fff" />
            </div>
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#fff', margin: 0, letterSpacing: 0.2 }}>Promotions</h2>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,.75)', margin: '2px 0 0', lineHeight: 1.4 }}>
                Portal-driven promotions — applied at transaction level, never to master prices.
              </p>
            </div>
          </div>
        </div>
        <button onClick={() => { setShowNew(true); setEditingId(null); setForm(emptyForm()) }}
          style={{
            position: 'relative', zIndex: 1, padding: '10px 16px', background: '#fff', color: t[700], borderRadius: 10,
            border: 'none', fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
            boxShadow: '0 6px 16px -6px rgba(0,0,0,.35)', transition: 'transform .15s ease, box-shadow .15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 10px 22px -8px rgba(0,0,0,.4)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(0,0,0,.35)' }}
        >
          <Plus size={15} strokeWidth={3} /> New Promotion
        </button>
      </div>

      {notify && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: notify.kind === 'success' ? t[100] : '#fef0ee',
          border: `1.4px solid ${notify.kind === 'success' ? t[200] : '#f3c1bd'}`,
          color: notify.kind === 'success' ? t[700] : danger, fontSize: 12.5, fontWeight: 600,
        }}>
          {notify.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span style={{ flex: 1 }}>{notify.text}</span>
          <button onClick={() => setNotify(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><X size={14} /></button>
        </div>
      )}

      {/* ── Dashboard stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 20 }}>
        <StatCard icon={<Award size={15} />} label="Active" value={stats.counts.active} accent={t[100]} />
        <StatCard icon={<Clock size={15} />} label="Scheduled" value={stats.counts.scheduled} accent={violet[50]} />
        <StatCard icon={<AlertTriangle size={15} />} label="Expired" value={stats.counts.expired} accent="#fef0ee" />
        <StatCard icon={<Pause size={15} />} label="Paused" value={stats.counts.paused} accent={amber[100]} />
        <StatCard icon={<Gift size={15} />} label="Total Usage" value={fmtInt(stats.totalUsage)} accent="#fdf2f8" />
        <StatCard icon={<TrendingUp size={15} />} label="Discount Given" value={stats.totalDiscount != null ? fmt(stats.totalDiscount) : '—'} accent={t[50]} />
        <StatCard icon={<BadgePercent size={15} />} label="Revenue Generated" value={stats.netSales != null ? fmt(stats.netSales) : '—'} accent={violet[50]} />
        <StatCard icon={<Users size={15} />} label="Orders w/ Promo" value={stats.orders != null ? fmtInt(stats.orders) : '—'} accent={amber[100]} />
      </div>

      {/* ── Analytics charts ── */}
      {(() => {
        const trend = (analytics?.trend || []).filter((d: any) => d.orders > 0)
        const byPromo = (analytics?.byPromotion || [])
          .filter((p) => (p.orders || 0) > 0 || (p.discountAmount || 0) > 0)
          .slice()
          .sort((a, b) => (b.discountAmount || 0) - (a.discountAmount || 0))
          .slice(0, 6)
          .map((p) => ({ name: p.name, discount: p.discountAmount, net: p.netSales }))
        if (trend.length === 0 && byPromo.length === 0) return null
        const axisTick = { fontSize: 10, fill: inkSoft } as const
        const tooltipStyle = { borderRadius: 10, border: `1px solid ${hairline}`, fontSize: 11 } as const
        const moneyTick = (v: any) => {
          const n = Number(v) || 0
          return n >= 1000 ? `K ${(n / 1000).toFixed(n >= 1_000_000 ? 1 : 0)}${n >= 1_000_000 ? 'M' : 'k'}` : String(n)
        }
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 12, marginBottom: 20 }}>
            <div className="prime-card" style={{ background: paper, borderRadius: 14, border: `1.4px solid ${hairline}`, padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: ink, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <TrendingUp size={14} style={{ color: t[600] }} /> Discount Given — Last 30 Days
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="promoDiscountGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={t[500]} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={t[500]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={hairline} strokeOpacity={0.6} />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} tick={axisTick} minTickGap={24} />
                  <YAxis axisLine={false} tickLine={false} tick={axisTick} tickFormatter={moneyTick} width={46} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} labelStyle={{ fontSize: 11, fontWeight: 700 }} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="discountAmount" stroke={t[500]} strokeWidth={2.4} fill="url(#promoDiscountGrad)" name="Discount" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="prime-card" style={{ background: paper, borderRadius: 14, border: `1.4px solid ${hairline}`, padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: ink, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Award size={14} style={{ color: violet[500] }} /> Top Promotions by Discount
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byPromo} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={hairline} strokeOpacity={0.6} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ ...axisTick, fontSize: 9 }} interval={0} angle={-14} height={46} textAnchor="end" />
                  <YAxis axisLine={false} tickLine={false} tick={axisTick} tickFormatter={moneyTick} width={46} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} labelStyle={{ fontSize: 11, fontWeight: 700 }} contentStyle={tooltipStyle} />
                  <Bar dataKey="discount" fill={violet[500]} radius={[5, 5, 0, 0]} name="Discount Given" />
                  <Bar dataKey="net" fill={t[500]} radius={[5, 5, 0, 0]} name="Net Sales" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )
      })()}

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#8a9496', zIndex: 1 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or code..."
            style={{ ...inputStyle, paddingLeft: 34, height: 38 }}
          />
        </div>
        <Select value={statusFilter} onChange={setStatusFilter} options={[{ value: 'all', label: 'All Status' }, ...STATUSES.map((s) => ({ value: s, label: s }))]} />
        <Select value={channelFilter} onChange={setChannelFilter} options={[{ value: 'all', label: 'All Channels' }, ...CHANNELS.map((c) => ({ value: c, label: c === 'BOTH' ? 'ERP + PORTAL' : c }))]} />
        <Select value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: 'All Types' }, ...DISCOUNT_TYPES.map((d) => ({ value: d, label: d.replace('_', ' ') }))]} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: inkSoft, fontWeight: 600, marginLeft: 'auto' }}>
          <Filter size={13} /> {filtered.length} of {promotions.length}
        </span>
      </div>

      {/* ── Create / Edit form ── */}
      {showNew && (
        <div className="prime-card" style={{ marginBottom: 20, borderRadius: 14, border: `1.4px solid ${t[200]}`, background: '#fff', overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', gap: 8, background: t[50] }}>
            {editingId ? <Pencil size={14} style={{ color: t[600] }} /> : <Plus size={14} style={{ color: t[600] }} />}
            <span style={{ fontSize: 13.5, fontWeight: 700, color: ink }}>{editingId ? 'Edit Promotion' : 'Create Promotion'}</span>
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
              <Field label="Name *"><Input value={form.name} onChange={(v: string) => setForm((p) => ({ ...p, name: v }))} placeholder="e.g. August Portal Promotion" /></Field>
              <Field label="Promo Code" hint="Leave blank for automatic-only promotions."><Input value={form.code || ''} onChange={(v: string) => setForm((p) => ({ ...p, code: v }))} placeholder="AUGUST10" /></Field>
              <Field label="Channel">
                <Select value={form.channel || 'PORTAL'} onChange={(v: string) => setForm((p) => ({ ...p, channel: v as PromotionChannel }))}
                  options={CHANNELS.map((c) => ({ value: c, label: c === 'BOTH' ? 'ERP + Portal (Both)' : c === 'PORTAL' ? 'Portal Only' : 'ERP Only' }))} />
              </Field>
              <Field label="Discount Type">
                <Select value={form.discountType || 'percentage'} onChange={(v: string) => setForm((p) => ({ ...p, discountType: v as PromotionDiscountType }))}
                  options={DISCOUNT_TYPES.map((d) => ({ value: d, label: d.replace('_', ' ').toUpperCase() }))} />
              </Field>
              <Field label={String(form.discountType || 'percentage').includes('percent') ? 'Discount Value (%)' : 'Discount Value (MWK)'}>
                <Input type="number" placeholder="e.g. 10" value={form.discountValue} onChange={(v: string) => setForm((p) => ({ ...p, discountValue: parseFloat(v) || 0 }))} />
              </Field>
              <Field label="Status">
                <Select value={form.status || 'draft'} onChange={(v: string) => setForm((p) => ({ ...p, status: v as PromotionStatus }))}
                  options={STATUSES.map((s) => ({ value: s, label: s }))} />
              </Field>
              <Field label="Start Date/Time"><Input type="datetime-local" value={form.startsAt || ''} onChange={(v: string) => setForm((p) => ({ ...p, startsAt: v }))} /></Field>
              <Field label="End Date/Time" hint="Empty = no expiry."><Input type="datetime-local" value={form.endsAt || ''} onChange={(v: string) => setForm((p) => ({ ...p, endsAt: v }))} /></Field>
              <Field label="Minimum Order (MWK)"><Input type="number" value={form.minimumOrderAmount} onChange={(v: string) => setForm((p) => ({ ...p, minimumOrderAmount: parseFloat(v) || 0 }))} /></Field>
              <Field label="Maximum Discount (MWK)"><Input type="number" value={form.maximumDiscountAmount} onChange={(v: string) => setForm((p) => ({ ...p, maximumDiscountAmount: parseFloat(v) || 0 }))} /></Field>
              <Field label="Usage Limit (total)" hint="0 = unlimited."><Input type="number" value={form.usageLimit} onChange={(v: string) => setForm((p) => ({ ...p, usageLimit: parseInt(v) || 0 }))} /></Field>
              <Field label="Per-Customer Limit" hint="0 = unlimited."><Input type="number" value={form.usageLimitPerCustomer} onChange={(v: string) => setForm((p) => ({ ...p, usageLimitPerCustomer: parseInt(v) || 0 }))} /></Field>
              <Field label="Priority" hint="Higher applies first."><Input type="number" value={form.priority} onChange={(v: string) => setForm((p) => ({ ...p, priority: parseInt(v) || 0 }))} /></Field>
              <Field label="Applies To">
                <Select value={form.applicableTo || 'all'} onChange={(v: string) => setForm((p) => ({ ...p, applicableTo: v as any }))}
                  options={[{ value: 'all', label: 'All Products' }, { value: 'categories', label: 'Specific Categories' }, { value: 'products', label: 'Specific Products' }]} />
              </Field>
              <Field label="Customer Scope">
                <Select value={form.customerScope || 'all'} onChange={(v: string) => setForm((p) => ({ ...p, customerScope: v as any }))}
                  options={[
                    { value: 'all', label: 'All Customers' },
                    { value: 'new_customers', label: 'New Customers (< 90 days)' },
                    { value: 'existing_customers', label: 'Existing Customers' },
                    { value: 'customers', label: 'Specific Customers' },
                  ]} />
              </Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <Field label="Description">
                <textarea value={form.description || ''} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={2}
                  style={{ ...inputStyle, resize: 'none', minHeight: 50 }} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 22, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <Toggle value={form.isAutoApply !== false} onChange={(v: boolean) => setForm((p) => ({ ...p, isAutoApply: v }))} label="Auto-apply for eligible customers" />
              <Toggle value={!!form.stackable} onChange={(v: boolean) => setForm((p) => ({ ...p, stackable: v }))} label="Stackable with other promotions" />
              <Toggle value={form.isActive !== false} onChange={(v: boolean) => setForm((p) => ({ ...p, isActive: v }))} label="Active" />
            </div>

            {/* Live discount preview */}
            <div style={{ marginTop: 16, borderRadius: 12, border: `1.4px solid ${t[200]}`, background: t[50], padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Sparkles size={14} style={{ color: t[600] }} />
                <span style={{ fontSize: 12, fontWeight: 800, color: t[700], textTransform: 'uppercase', letterSpacing: 0.06 }}>Live Preview</span>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Field label="Sample Order Amount (MWK)">
                  <Input type="number" value={sampleAmount} onChange={(v: string) => setSampleAmount(parseFloat(v) || 0)} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, flex: 1, minWidth: 420 }}>
                  <div style={{ background: paper, borderRadius: 10, border: `1px solid ${hairline}`, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.05 }}>Original Price</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(preview?.subtotal || 0)}</div>
                  </div>
                  <div style={{ background: paper, borderRadius: 10, border: `1px solid ${hairline}`, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#047857', textTransform: 'uppercase', letterSpacing: 0.05 }}>Discount</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#047857', fontFamily: "'JetBrains Mono', monospace" }}>− {fmt(preview?.discountTotal || 0)}</div>
                  </div>
                  <div style={{ background: paper, borderRadius: 10, border: `1px solid ${hairline}`, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.05 }}>Customer Saves</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#92400e', fontFamily: "'JetBrains Mono', monospace" }}>{fmt(preview?.discountTotal || 0)}</div>
                  </div>
                  <div style={{ background: 'linear-gradient(135deg,#0b3e39,#1f8577)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.7)', textTransform: 'uppercase', letterSpacing: 0.05 }}>Customer Pays</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>{fmt(preview?.grandTotal || 0)}</div>
                  </div>
                </div>
              </div>
              <p style={{ margin: '10px 0 0', fontSize: 11, color: '#8a9496', lineHeight: 1.5 }}>
                The preview is an estimate. At checkout the server re-calculates using authoritative ERP master prices — browsers never set prices or discounts.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={editingId ? saveEdit : saveNew} disabled={saving}
                style={{ padding: '9px 16px', background: t[500], color: '#fff', borderRadius: 9, border: 'none', fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1, transition: 'background .15s ease' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = t[700] }}
                onMouseLeave={(e) => { e.currentTarget.style.background = t[500] }}
              >
                {saving ? <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(255,255,255,.4)', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> : <Save size={13} />}
                {editingId ? 'Save Changes' : 'Create Promotion'}
              </button>
              <button onClick={() => { setShowNew(false); setEditingId(null); setForm(emptyForm()) }}
                style={{ padding: '9px 16px', background: paper, border: `1.4px solid ${hairline}`, borderRadius: 9, color: inkSoft, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X size={13} /> Cancel</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Promotion list ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: inkSoft, fontSize: 13 }}>Loading promotions…</div>
      ) : filtered.length === 0 ? (
        <div className="prime-card" style={{ textAlign: 'center', padding: 48, borderRadius: 14, border: `1.4px dashed ${hairline}`, background: paper }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: t[50], margin: '0 auto 14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Tag size={26} style={{ color: t[500] }} />
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: ink }}>{promotions.length === 0 ? 'No promotions yet' : 'No promotions match your filters'}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: inkSoft }}>
            {promotions.length === 0 ? 'Create your first promotion — a 10% Portal discount takes minutes.' : 'Try clearing the search or filters.'}
          </p>
          {promotions.length === 0 && (
            <button onClick={() => { setShowNew(true); setEditingId(null); setForm(emptyForm()) }}
              style={{ marginTop: 18, padding: '9px 16px', background: t[500], color: '#fff', borderRadius: 9, border: 'none', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> Create Promotion
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((p) => {
            const status = p._effectiveStatus as PromotionStatus
            const used = Number(p.usedCount ?? p.currentUses ?? 0) || 0
            const limit = Number(p.usageLimit ?? p.maxUses ?? 0) || 0
            const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
            const auto = p.isAutoApply !== false
            return (
              <div key={p.id} className="prime-card" style={{
                background: paper, borderRadius: 12, border: `1.4px solid ${hairline}`, padding: '14px 16px',
                transition: 'box-shadow .15s ease, transform .15s ease',
                boxShadow: '0 1px 2px rgba(0,0,0,.03)',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 8px 20px -10px rgba(11,62,57,.25)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,.03)'; e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 340px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: ink }}>{p.name}</span>
                      <StatusBadge status={status} />
                      <ChannelTag channel={p.channel} />
                      {auto && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, color: violet[700], background: violet[50], padding: '2px 8px', borderRadius: 6 }}>
                          <Sparkles size={10} /> AUTO
                        </span>
                      )}
                      {p.code && (
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700, color: inkSoft, background: '#f4f5f6', padding: '2px 8px', borderRadius: 6, letterSpacing: 0.08 }}>{p.code}</span>
                      )}
                    </div>
                    {p.description && <p style={{ margin: '5px 0 0', fontSize: 12, color: inkSoft, lineHeight: 1.45, maxWidth: 560 }}>{p.description}</p>}
                    <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: inkSoft, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Percent size={11} /> {discountLabel(p)}</span>
                      {Number(p.minimumOrderAmount ?? p.minPurchase ?? 0) > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Layers size={11} /> Min order {fmt(p.minimumOrderAmount ?? p.minPurchase)}</span>}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Calendar size={11} /> {new Date(p.startsAt || new Date().toISOString()).toLocaleDateString()} → {p.endsAt || p.expiresAt ? new Date(p.endsAt || p.expiresAt).toLocaleDateString() : '∞'}</span>
                      {Number(p.priority || 0) > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><TrendingUp size={11} /> Priority {p.priority}</span>}
                      {p.stackable && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Layers size={11} /> Stackable</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ textAlign: 'right', minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.05 }}>Usage</div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{used}{limit > 0 ? ` / ${limit}` : ''}</div>
                      {limit > 0 && (
                        <div style={{ width: 110, height: 5, borderRadius: 3, background: hairline, marginTop: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? danger : t[500], borderRadius: 3, transition: 'width .3s ease' }} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button title={status === 'active' ? 'Pause' : 'Activate'} onClick={() => toggleStatus(p)}
                        style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: status === 'active' ? amber[100] : t[100], color: status === 'active' ? '#92400e' : t[700], display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                      >
                        {status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <button title="Edit" onClick={() => startEdit(p)}
                        style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f1f2f4', color: inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button title="Delete" onClick={() => setDeleteTarget(p)}
                        style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(181,73,63,.08)', color: danger, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Delete confirmation ── */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(11,20,19,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: paper, borderRadius: 16, padding: '24px 24px 20px', maxWidth: 420, width: '100%', boxShadow: '0 24px 60px -16px rgba(0,0,0,.4)', animation: 'scaleIn .18s cubic-bezier(.4,0,.2,1)' }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: '#fef0ee', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
              <AlertTriangle size={22} style={{ color: danger }} />
            </div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: ink }}>Delete promotion?</h3>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: inkSoft, lineHeight: 1.55 }}>
              <b style={{ color: ink }}>{deleteTarget.name}</b> will be removed. Historical orders keep their recorded discounts — they are never recalculated.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ padding: '9px 14px', background: paper, border: `1.4px solid ${hairline}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, color: inkSoft, cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmDelete} style={{ padding: '9px 16px', background: danger, color: '#fff', borderRadius: 9, border: 'none', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Trash2 size={13} /> Delete Promotion
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes scaleIn { from { transform: scale(.96); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

export default PromotionsAdmin
