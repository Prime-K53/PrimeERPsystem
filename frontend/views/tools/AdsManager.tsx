import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { dbService } from '../../services/db'
import type { PortalAd, PortalAdStatus } from '../../types/ads'
import { useAuth } from '../../context/AuthContext'
import { aiService } from '../../services/aiService'
import { uploadAdImage } from '../../services/adminPortalClient'
import {
  BANNER_SPEC,
  aspectConformance,
  buildBannerValidation,
  formatBannerBytes,
  getImageDimensions,
  isConformantMeta,
  loadImageFile,
  loadImageUrl,
  prepareBannerBlob,
  preparedBannerFile,
  validateBannerFile,
} from '../../services/bannerImage'
import { BannerCropModal } from '../../components/ui/BannerCropModal'
import {
  Plus, Search, Pencil, Trash2, X, Play, Pause, Megaphone, Sparkles, Clock,
  CheckCircle2, CheckCircle, AlertTriangle, Calendar, Wand2, Eye, Layers, Loader2,
  ImagePlus, UploadCloud, Link2, Scissors, ShieldCheck, FileWarning,
} from 'lucide-react'

const teal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a'
}
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' }
const paper = '#FEFDFB', ink = '#23282A', inkSoft = '#5c6567', hairline = '#e4ddd1', danger = '#b5493f'
const violet = { 50: '#f3f0ff', 100: '#e4dcff', 500: '#7c5cf0', 700: '#5b3fd4' }

const STATUSES: PortalAdStatus[] = ['draft', 'scheduled', 'active', 'paused', 'expired']

const GRADIENT_PRESETS = [
  { name: 'Portal Teal', value: 'linear-gradient(135deg, #0b3e39 0%, #1f8577 100%)' },
  { name: 'Deep Navy', value: 'linear-gradient(135deg, #0F2C59 0%, #1E3A8A 100%)' },
  { name: 'Emerald', value: 'linear-gradient(135deg, #065F46 0%, #059669 100%)' },
  { name: 'Amber Deal', value: 'linear-gradient(135deg, #7C2D12 0%, #D97706 100%)' },
  { name: 'Royal Purple', value: 'linear-gradient(135deg, #312E81 0%, #7C5CF0 100%)' },
  { name: 'Rose', value: 'linear-gradient(135deg, #831843 0%, #DB2777 100%)' },
]

const EMOJI_PRESETS = ['🎯', '✨', '🏷️', '🎁', '👑', '🚀', '🔥', '💰', '📦', '🖨️', '📣', '⭐']

const CTA_TARGETS = [
  { value: '/portal/orders', label: 'Browse Catalog / Orders' },
  { value: '/portal/new-request', label: 'New Request / Quote' },
  { value: '/portal/quotations', label: 'Quotations' },
  { value: '/portal/invoices', label: 'Invoices & Payments' },
  { value: '/portal/wallet', label: 'Wallet' },
  { value: '/portal/referrals', label: 'Referrals' },
  { value: '/portal/loyalty', label: 'Loyalty & Rewards' },
  { value: '/portal/deliveries', label: 'Deliveries' },
  { value: '/portal/account-statements', label: 'Account Statements' },
]

const fmtInt = (v: any) => Number(v || 0).toLocaleString()

const deriveStatus = (ad: any, now = new Date()): PortalAdStatus => {
  if (!ad) return 'draft'
  if (ad.status === 'paused') return 'paused'
  if (ad.status === 'draft') return 'draft'
  const ts = now.getTime()
  const start = ad.startsAt ? new Date(ad.startsAt).getTime() : null
  const end = ad.endsAt ? new Date(ad.endsAt).getTime() : null
  if (start !== null && !Number.isNaN(start) && ts < start) return 'scheduled'
  if (end !== null && !Number.isNaN(end) && ts > end) return 'expired'
  if (ad.isActive === false) return 'draft'
  return 'active'
}

const STATUS_META: Record<PortalAdStatus, { bg: string; fg: string; dot: string }> = {
  draft: { bg: hairline, fg: inkSoft, dot: '#94a3b8' },
  scheduled: { bg: violet[100], fg: violet[700], dot: '#7c5cf0' },
  active: { bg: teal[100], fg: teal[700], dot: '#1f8577' },
  paused: { bg: amber[100], fg: '#92400e', dot: '#d99a3f' },
  expired: { bg: '#fef0ee', fg: danger, dot: '#b5493f' },
}

const emptyForm = (): Partial<PortalAd> => ({
  title: '',
  subtitle: '',
  description: '',
  badge: 'Special Offer',
  ctaLabel: 'Order Now',
  ctaTarget: '/portal/orders',
  gradient: GRADIENT_PRESETS[0].value,
  emoji: '🎯',
  priority: 0,
  isActive: true,
  status: 'draft',
  startsAt: new Date().toISOString().slice(0, 16),
  endsAt: '',
})

const toCanonical = (f: Partial<PortalAd>): PortalAd => ({
  id: f.id || `AD_${Date.now()}`,
  title: String(f.title || '').trim(),
  subtitle: f.subtitle ? String(f.subtitle).trim() : '',
  badge: f.badge ? String(f.badge).trim() : '',
  ctaLabel: f.ctaLabel ? String(f.ctaLabel).trim() : 'Order Now',
  ctaTarget: f.ctaTarget || '/portal/orders',
  imageUrl: f.imageUrl ? String(f.imageUrl).trim() : '',
  imageMeta: f.imageMeta,
  gradient: f.gradient || GRADIENT_PRESETS[0].value,
  emoji: f.emoji || '🎯',
  description: f.description || '',
  priority: Number(f.priority ?? 0) || 0,
  startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : new Date().toISOString(),
  endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : '',
  isActive: f.isActive !== undefined ? !!f.isActive : true,
  status: f.status || 'draft',
  createdAt: f.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: f.createdBy,
  companyId: f.companyId,
  aiGenerated: f.aiGenerated || false,
  aiPrompt: f.aiPrompt,
})

// Banners pasted as a plain URL bypass the 3:1 preparation pipeline, so they
// carry no dimension metadata. Probe the actual asset so the API metadata the
// portal receives always matches the real image; the portal can then decide
// cover/contain without a runtime dimension probe. Failures are non-fatal —
// the metadata is left absent and the portal probes dimensions itself.
const resolveUrlImageMeta = async (f: Partial<PortalAd>): Promise<Partial<PortalAd>> => {
  const url = f.imageUrl && String(f.imageUrl).trim()
  if (!url || f.imageMeta) return f
  try {
    const d = await getImageDimensions(url)
    if (!Number.isFinite(d.width) || !Number.isFinite(d.height) || d.width <= 0 || d.height <= 0) return f
    const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase()
    const knownFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'bmp'])
    return {
      ...f,
      imageMeta: {
        bannerType: BANNER_SPEC.bannerType,
        width: d.width,
        height: d.height,
        aspectRatio: d.width / d.height,
        format: knownFormats.has(ext) ? ext : undefined,
        preparedAt: new Date().toISOString(),
      },
    }
  } catch {
    return f // offline / CORS-blocked — keep metadata absent
  }
}

const modalTabs = [
  { id: 'Details' as const, label: 'Ad Details', icon: Megaphone },
  { id: 'AIStudio' as const, label: 'AI Studio', icon: Wand2 },
  { id: 'Schedule' as const, label: 'Schedule & Status', icon: Calendar },
  { id: 'Preview' as const, label: 'Live Preview', icon: Eye },
]

const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600, color: teal[800],
  marginBottom: 6, letterSpacing: 0.01
}

const modalInputStyle: React.CSSProperties = {
  width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5,
  color: ink, background: paper,
  border: `1.4px solid ${hairline}`, borderRadius: 9,
  padding: '9px 12px', outline: 'none',
  transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease'
}

const modalSelectStyle: React.CSSProperties = {
  ...modalInputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 30,
  cursor: 'pointer'
}

const sectionLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 14px'
}

export const AdsManager: React.FC = () => {
  const [ads, setAds] = useState<PortalAd[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState<Partial<PortalAd>>(emptyForm())
  const [activeTab, setActiveTab] = useState<typeof modalTabs[number]['id']>('Details')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [deleteTarget, setDeleteTarget] = useState<PortalAd | null>(null)
  const [saving, setSaving] = useState(false)
  const [notify, setNotify] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const { companyConfig } = useAuth()

  // ── AI Studio state ──
  const [aiBrief, setAiBrief] = useState('')
  const [aiAudience, setAiAudience] = useState('all customers')
  const [aiTone, setAiTone] = useState('friendly')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [subtitleGenerating, setSubtitleGenerating] = useState(false)

  // ── Image upload state ──
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageMode, setImageMode] = useState<'upload' | 'url'>('upload')
  const [dragOver, setDragOver] = useState(false)
  const [cropTarget, setCropTarget] = useState<{
    image: HTMLImageElement
    /** Still-live blob URL for rendering inside the crop modal. */
    blobUrl: string
    sourceName: string
    onDone: (blob: Blob, output: { width: number; height: number }) => void
  } | null>(null)
  const [urlPreviewStatus, setUrlPreviewStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [urlPreviewDims, setUrlPreviewDims] = useState<{ w: number; h: number } | null>(null)
  // ad id → banner is 3:1 conformant (checked lazily for legacy banners)
  const [conformance, setConformance] = useState<Record<string, boolean>>({})

  const openNew = () => { setEditingId(null); setForm(emptyForm()); setActiveTab('Details'); setShowNew(true) }

  const load = useCallback(async () => {
    try {
      const data = await dbService.getAll<PortalAd>('portalAds')
      setAds([...data].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)))
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to load ads' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const effective = useMemo(
    () => ads.map((a) => ({ ...a, _effectiveStatus: deriveStatus(a) })),
    [ads]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return effective.filter((a) => {
      if (statusFilter !== 'all') {
        const s = a._effectiveStatus
        // The "Draft / Paused" KPI card filters both states.
        if (statusFilter === 'draft-paused') {
          if (s !== 'draft' && s !== 'paused') return false
        } else if (s !== statusFilter) {
          return false
        }
      }
      if (q && !`${a.title} ${a.subtitle || ''} ${a.badge || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [effective, search, statusFilter])

  const stats = useMemo(() => {
    const counts: Record<string, number> = { active: 0, scheduled: 0, draft: 0, paused: 0, expired: 0 }
    for (const a of effective) {
      const s = a._effectiveStatus || deriveStatus(a)
      if (counts[s] !== undefined) counts[s] += 1
    }
    const aiCount = ads.filter((a) => a.aiGenerated).length
    return { counts, aiCount }
  }, [effective, ads])

  const saveNew = async () => {
    const hasTitle = Boolean(form.title && String(form.title).trim())
    const hasImage = Boolean(form.imageUrl && String(form.imageUrl).trim())
    if (!hasTitle && !hasImage) {
      setNotify({ kind: 'error', text: 'Add a title, or upload an image for this ad.' })
      return
    }
    setSaving(true)
    try {
      const record = toCanonical({ ...await resolveUrlImageMeta(form), companyId: companyConfig?.id })
      await dbService.put('portalAds', record)
      setShowNew(false)
      setForm(emptyForm())
      setNotify({ kind: 'success', text: `Ad "${record.title || (record.imageUrl ? 'Image ad' : 'Untitled ad')}" created — it will appear on the portal banner when active.` })
      await load()
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to create ad' })
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (ad: PortalAd) => {
    setEditingId(ad.id)
    setForm({
      ...ad,
      startsAt: (ad.startsAt || new Date().toISOString()).slice(0, 16),
      endsAt: ad.endsAt ? ad.endsAt.slice(0, 16) : '',
    })
    setAiBrief(ad.aiPrompt || '')
    setActiveTab('Details')
    setShowNew(true)
  }

  const saveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const existing = ads.find((a) => a.id === editingId)
      const record = toCanonical({ ...await resolveUrlImageMeta({ ...existing, ...form, id: editingId }), companyId: companyConfig?.id })
      await dbService.put('portalAds', record)
      setShowNew(false)
      setEditingId(null)
      setForm(emptyForm())
      setNotify({ kind: 'success', text: 'Ad updated.' })
      await load()
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Failed to update ad' })
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (ad: PortalAd) => {
    const current = deriveStatus(ad)
    const next: PortalAdStatus = current === 'active' ? 'paused' : 'active'
    await dbService.put('portalAds', {
      ...ad,
      status: next,
      isActive: next === 'active',
      updatedAt: new Date().toISOString(),
    } as PortalAd)
    setNotify({ kind: 'success', text: next === 'active' ? 'Ad activated.' : 'Ad paused.' })
    await load()
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    await dbService.delete('portalAds', deleteTarget.id)
    setDeleteTarget(null)
    setNotify({ kind: 'success', text: `Ad "${deleteTarget.title}" deleted.` })
    await load()
  }

  // ── Banner image pipeline: validate → crop/prepare → upload → preview ──
  // Every banner is prepared as an exact 3:1 asset (1500 × 500 WebP) so the
  // portal banner area never stretches or distorts it. Non-3:1 sources open
  // the interactive crop tool; the backend re-validates on upload.

  const applyUploadedBanner = (url: string, meta: any) =>
    setForm((p) => ({ ...p, imageUrl: url, imageMeta: meta }))

  const doUpload = async (blob: Blob) => {
    const result = await uploadAdImage(preparedBannerFile(blob))
    return result
  }

  const handleImageUpload = async (file: File | undefined) => {
    if (!file) return
    const gate = validateBannerFile(file)
    if (!gate.ok) {
      setNotify({ kind: 'error', text: gate.error || 'Invalid image.' })
      return
    }
    setUploadingImage(true)
    try {
      const { img, blobUrl } = await loadImageFile(file)
      const report = buildBannerValidation(img.naturalWidth, img.naturalHeight)
      if (!report.ok) {
        URL.revokeObjectURL(blobUrl)
        setNotify({ kind: 'error', text: report.error || 'Invalid image.' })
        return
      }
      if (report.conformant) {
        // Already 3:1 → prepare directly (resize + WebP), no crop needed.
        const blob = await prepareBannerBlob(img)
        URL.revokeObjectURL(blobUrl) // done with the source
        const result = await doUpload(blob)
        applyUploadedBanner(result.url, result.meta)
        setNotify({
          kind: 'success',
          text: `Banner prepared as 3:1 ${result.meta.format.toUpperCase()} (${result.meta.width} × ${result.meta.height} px) and uploaded.`,
        })
      } else {
        // Not 3:1 → interactive crop with safe-area guide.
        setCropTarget({
          image: img,
          blobUrl,
          sourceName: file.name,
          onDone: async (blob, output) => {
            setUploadingImage(true)
            try {
              const result = await doUpload(blob)
              applyUploadedBanner(result.url, result.meta)
              setNotify({
                kind: 'success',
                text: `Banner cropped to 3:1 (${output.width} × ${output.height} px), prepared as WebP and uploaded.`,
              })
            } catch (err: any) {
              setNotify({ kind: 'error', text: err?.message || 'Upload failed after cropping. Please try again.' })
            } finally {
              setUploadingImage(false)
            }
          },
        })
      }
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Image upload failed. Check your connection and try again.' })
    } finally {
      setUploadingImage(false)
    }
  }

  // Re-crop an existing (possibly legacy / non-3:1) banner asset.
  const handleRecrop = async (ad: PortalAd) => {
    if (!ad.imageUrl) return
    setUploadingImage(true)
    try {
      const img = await loadImageUrl(ad.imageUrl)
      setCropTarget({
        image: img,
        sourceName: ad.title || 'banner',
        onDone: async (blob) => {
          setUploadingImage(true)
          try {
            const result = await doUpload(blob)
            await dbService.put('portalAds', {
              ...ad,
              imageUrl: result.url,
              imageMeta: result.meta,
              updatedAt: new Date().toISOString(),
            } as PortalAd)
            setNotify({ kind: 'success', text: 'Banner re-cropped to 3:1 and replaced.' })
            await load()
          } catch (err: any) {
            setNotify({ kind: 'error', text: err?.message || 'Re-crop failed. Please try again.' })
          } finally {
            setUploadingImage(false)
          }
        },
      })
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'Could not load the banner image for re-cropping.' })
    } finally {
      setUploadingImage(false)
    }
  }

  // Flag legacy banners that do not conform to the 3:1 spec.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const next: Record<string, boolean> = {}
      const withImages = ads.filter((a) => a.imageUrl && String(a.imageUrl).trim())
      await Promise.all(withImages.map(async (a) => {
        const url = String(a.imageUrl).trim()
        if (a.imageMeta?.width && a.imageMeta?.height) {
          next[a.id] = aspectConformance(a.imageMeta.width, a.imageMeta.height)
          return
        }
        try {
          const d = await getImageDimensions(url)
          next[a.id] = aspectConformance(d.width, d.height)
        } catch {
          next[a.id] = true // unreadable (offline/blocked) — do not nag
        }
      }))
      if (!cancelled) setConformance(next)
    }
    run()
    return () => { cancelled = true }
  }, [ads])

  const nonConformingAds = useMemo(
    () => ads.filter((a) => a.imageUrl && conformance[a.id] === false),
    [ads, conformance]
  )

  // ── AI generation ──
  const runAIGenerate = async () => {
    if (!aiBrief.trim()) {
      setAiError('Describe the ad first — e.g. "20% off all business cards this month".')
      return
    }
    setAiBusy(true)
    setAiError('')
    try {
      const result = await aiService.generateAdCopy({ description: aiBrief, audience: aiAudience, tone: aiTone })
      if (result) {
        setForm((prev) => ({
          ...prev,
          title: result.title,
          subtitle: result.subtitle,
          description: result.description,
          badge: result.badge,
          ctaLabel: result.ctaLabel,
          emoji: result.emoji,
          gradient: result.gradient,
          aiGenerated: true,
          aiPrompt: aiBrief,
        }))
        setActiveTab('Preview')
      }
    } catch (err: any) {
      setAiError(err?.message || 'AI generation failed. Try again or write the copy manually.')
    } finally {
      setAiBusy(false)
    }
  }

  const handleGenerateSubtitle = async () => {
    const title = (form.title || '').trim()
    if (!title) {
      setNotify({ kind: 'error', text: 'Enter an ad title first so the AI has context.' })
      return
    }
    setSubtitleGenerating(true)
    try {
      const prompt = `Generate a medium-length subtitle (1-2 sentences, 80-120 characters) for a banner ad with this headline:\n\n"${title}"\n\nThe subtitle should complement the headline, highlight a key benefit or create urgency, and be suitable for a printing business. Do not repeat the headline. No quotes, no markdown.`
      const result = await aiService.generateAIResponse(prompt, 'You are a concise marketing copywriter. Write a single subtitle line. Do not use quotes or markdown. No disclaimers.')
      setForm(prev => ({ ...prev, subtitle: result.trim() }))
      setNotify({ kind: 'success', text: 'Subtitle generated.' })
    } catch (err: any) {
      setNotify({ kind: 'error', text: err?.message || 'AI generation failed.' })
    } finally {
      setSubtitleGenerating(false)
    }
  }

  // Portal-style banner preview (mirrors CustomerDashboard carousel slide).
  // The container enforces the SAME 3:1 ratio the customer portal uses, so
  // the preview shows exactly the proportions customers see.
  const BannerPreview = ({ ad, compact = false }: { ad: Partial<PortalAd>; compact?: boolean }) => {
    const title = ad.title || 'Your ad title'
    const subtitle = ad.subtitle || 'Your supporting message appears here.'
    const badge = ad.badge || 'Special Offer'
    const emoji = ad.emoji || '🎯'
    const ctaLabel = ad.ctaLabel || 'Order Now'
    const imageUrl = ad.imageUrl && String(ad.imageUrl).trim()
    const hasText = Boolean(String(ad.title || '').trim() || String(ad.subtitle || '').trim())

    const frame: React.CSSProperties = {
      borderRadius: 14, overflow: 'hidden', position: 'relative',
      aspectRatio: '3 / 1', minHeight: compact ? 84 : 96,
      width: '100%',
    }

    // Image-only ad — full-bleed image, no text overlay.
    if (imageUrl && !hasText) {
      return (
        <div style={{ ...frame, background: ad.gradient || GRADIENT_PRESETS[0].value }}>
          <img
            src={imageUrl}
            alt={ad.title || 'Banner ad'}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
      )
    }

    // Image + text ad — image background with a scrim for legibility.
    if (imageUrl) {
      return (
        <div style={{
          ...frame,
          color: '#fff', boxShadow: '0 10px 26px -12px rgba(11,62,57,.5)',
        }}>
          <img src={imageUrl} alt={ad.title || 'Banner ad'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(8,30,28,.82) 0%, rgba(8,30,28,.55) 55%, rgba(8,30,28,.12) 100%)' }} />
          <div style={{ position: 'relative', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: compact ? 34 : 40, height: compact ? 34 : 40, borderRadius: 11, flexShrink: 0,
              background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.24)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? 17 : 20,
            }}>{emoji}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {!compact && (
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(255,255,255,.72)', marginBottom: 2 }}>
                  {badge}
                </div>
              )}
              <div style={{ fontSize: compact ? 13 : 15, fontWeight: 800, lineHeight: 1.25 }}>{title}</div>
              {!compact && subtitle && (
                <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.8)', marginTop: 1, lineHeight: 1.45 }}>{subtitle}</div>
              )}
            </div>
            {!compact && (
              <button style={{
                flexShrink: 0, padding: '7px 12px', borderRadius: 9, border: 'none',
                background: '#fff', color: '#0b3e39', fontSize: 11.5, fontWeight: 800, cursor: 'default',
                boxShadow: '0 4px 10px -4px rgba(0,0,0,.35)',
              }}>{ctaLabel}</button>
            )}
          </div>
        </div>
      )
    }

    // Text-only ad — gradient banner.
    return (
      <div style={{
        ...frame,
        background: ad.gradient || GRADIENT_PRESETS[0].value, color: '#fff',
        boxShadow: '0 10px 26px -12px rgba(11,62,57,.5)',
      }}>
        <div style={{ position: 'absolute', right: -40, top: -60, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,.07)' }} />
        <div style={{ position: 'absolute', left: -50, bottom: -90, width: 200, height: 200, borderRadius: '50%', background: 'rgba(255,255,255,.05)' }} />
        <div style={{ position: 'relative', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: compact ? 34 : 40, height: compact ? 34 : 40, borderRadius: 11, flexShrink: 0,
            background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.24)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? 17 : 20,
          }}>{emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {!compact && (
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(255,255,255,.72)', marginBottom: 2 }}>
                {badge}
              </div>
            )}
            <div style={{ fontSize: compact ? 13 : 15, fontWeight: 800, lineHeight: 1.25 }}>{title}</div>
            {!compact && subtitle && (
              <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.8)', marginTop: 1, lineHeight: 1.45 }}>{subtitle}</div>
            )}
          </div>
          {!compact && (
            <button style={{
              flexShrink: 0, padding: '7px 12px', borderRadius: 9, border: 'none',
              background: '#fff', color: '#0b3e39', fontSize: 11.5, fontWeight: 800, cursor: 'default',
              boxShadow: '0 4px 10px -4px rgba(0,0,0,.35)',
            }}>{ctaLabel}</button>
          )}
        </div>
      </div>
    )
  }

  const KpiCard = ({ kpiId, label, value, icon, iconBg, iconColor, borderColor }: any) => {
    const active = kpiId === 'all' ? statusFilter === 'all' : statusFilter === kpiId
    const onClick = () => {
      if (kpiId === 'all') { setStatusFilter('all'); return }
      setStatusFilter(prev => prev === kpiId ? 'all' : kpiId)
    }
    return (
      <div onClick={onClick} style={{
        cursor: 'pointer', padding: '14px 16px', borderRadius: 14,
        background: paper, border: `1.4px solid ${hairline}`,
        borderLeft: `4px solid ${borderColor}`,
        display: 'flex', alignItems: 'flex-start', gap: 14,
        transition: 'transform .15s ease, box-shadow .15s ease',
        transform: active ? 'scale(1.01)' : 'scale(1)',
        boxShadow: active ? '0 8px 20px -8px rgba(0,0,0,.12)' : '0 1px 3px rgba(0,0,0,.04)'
      }}>
        <div style={{ padding: 10, borderRadius: 10, background: iconBg, color: iconColor, display: 'inline-flex' }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px' }}>{label}</p>
          <p style={{ fontSize: 18, fontWeight: 600, color: '#111827', margin: 0, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{value}</p>
        </div>
      </div>
    )
  }

  const StatusBadge = ({ status }: { status: PortalAdStatus }) => {
    const m = STATUS_META[status] || STATUS_META.draft
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: m.bg, color: m.fg }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.dot }} />
        {status}
      </span>
    )
  }

  const stepNumber = modalTabs.findIndex(t => t.id === activeTab) + 1
  const totalSteps = modalTabs.length

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto', background: teal[50], minHeight: '100%' }}>
      {/* ── Header ── */}
      <div style={{
        borderRadius: 16, padding: '22px 24px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 20,
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', right: -40, top: -60, width: 220, height: 220, borderRadius: '50%', background: 'rgba(255,255,255,.05)' }} />
        <div style={{ position: 'absolute', right: 60, bottom: -80, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,.04)' }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: teal[100], display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,.2)' }}>
              <Megaphone size={22} color={teal[700]} />
            </div>
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: teal[900], margin: 0, letterSpacing: 0.2 }}>Portal Ads</h2>
              <p style={{ fontSize: 12, color: inkSoft, margin: '2px 0 0', lineHeight: 1.4 }}>
                Banner ads that appear on the customer portal — generate, schedule and manage them here.
              </p>
            </div>
          </div>
        </div>
        <button onClick={openNew} style={{
          position: 'relative', zIndex: 1, padding: '10px 16px', background: '#fff', color: teal[700], borderRadius: 10,
          border: 'none', fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
          boxShadow: '0 6px 16px -6px rgba(0,0,0,.35)', transition: 'transform .15s ease, box-shadow .15s ease',
        }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 10px 22px -8px rgba(0,0,0,.4)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(0,0,0,.35)' }}
        >
          <Plus size={15} strokeWidth={3} /> New Ad
        </button>
      </div>

      {notify && !showNew && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: notify.kind === 'success' ? teal[100] : '#fef0ee',
          border: `1.4px solid ${notify.kind === 'success' ? teal[200] : '#f3c1bd'}`,
          color: notify.kind === 'success' ? teal[700] : danger, fontSize: 12.5, fontWeight: 600,
        }}>
          {notify.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span style={{ flex: 1 }}>{notify.text}</span>
          <button onClick={() => setNotify(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><X size={14} /></button>
        </div>
      )}

      {!showNew && nonConformingAds.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10, marginBottom: 14,
          background: '#fdf6e3', border: `1.4px solid ${amber[300]}`, color: '#92400e', fontSize: 12.5, fontWeight: 600,
          flexWrap: 'wrap',
        }}>
          <FileWarning size={16} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 220 }}>
            {nonConformingAds.length} banner{nonConformingAds.length > 1 ? 's' : ''} don&apos;t match the 3:1 spec — they may appear cropped or distorted on the portal. Re-crop to fix.
          </span>
          <button onClick={() => setStatusFilter('all')} style={{ background: 'transparent', border: 'none', color: '#92400e', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>
            Re-crop banners
          </button>
        </div>
      )}

      {/* ── Money bar ── */}
      <div className="customers-money-bar" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard kpiId="active" label="Active" value={fmtInt(stats.counts.active)}
          icon={<CheckCircle size={20} />} iconBg={teal[100]} iconColor={teal[600]} borderColor={teal[500]} />
        <KpiCard kpiId="scheduled" label="Scheduled" value={fmtInt(stats.counts.scheduled)}
          icon={<Clock size={20} />} iconBg={amber[100]} iconColor={amber[500]} borderColor={amber[500]} />
        <KpiCard kpiId="draft-paused" label="Draft / Paused" value={fmtInt(stats.counts.draft + stats.counts.paused)}
          icon={<Layers size={20} />} iconBg={violet[50]} iconColor={violet[500]} borderColor={violet[500]} />
        <KpiCard kpiId="all" label="AI Generated" value={fmtInt(stats.aiCount)}
          icon={<Sparkles size={20} />} iconBg={teal[50]} iconColor={teal[500]} borderColor={teal[500]} />
      </div>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#8a9496', zIndex: 1 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ads by title, subtitle or badge..."
            style={{ width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: ink, background: paper, border: `1.4px solid ${hairline}`, borderRadius: 9, padding: '8px 10px 8px 34px', outline: 'none' }}
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...modalSelectStyle, width: 160 }}>
          <option value="all">All Status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: inkSoft, fontWeight: 600, marginLeft: 'auto' }}>
          <Megaphone size={13} /> {filtered.length} of {ads.length}
        </span>
      </div>

      {/* ── Ad list ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: inkSoft, fontSize: 13 }}>Loading ads…</div>
      ) : filtered.length === 0 ? (
        <div className="prime-card" style={{ textAlign: 'center', padding: 48, borderRadius: 14, border: `1.4px dashed ${hairline}`, background: paper }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: teal[50], margin: '0 auto 14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Megaphone size={26} style={{ color: teal[500] }} />
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: ink }}>{ads.length === 0 ? 'No portal ads yet' : 'No ads match your filters'}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: inkSoft }}>
            {ads.length === 0 ? 'Create your first banner ad — or let AI write one for you.' : 'Try clearing the search or filters.'}
          </p>
          {ads.length === 0 && (
            <button onClick={openNew} style={{ marginTop: 18, padding: '9px 16px', background: teal[500], color: '#fff', borderRadius: 9, border: 'none', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> Create Ad
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((ad) => {
            const status = ad._effectiveStatus as PortalAdStatus
            return (
              <div key={ad.id} className="prime-card" style={{
                background: paper, borderRadius: 12, border: `1.4px solid ${hairline}`, padding: '14px 16px',
                transition: 'box-shadow .15s ease, transform .15s ease',
                boxShadow: '0 1px 2px rgba(0,0,0,.03)',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 8px 20px -10px rgba(11,62,57,.25)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,.03)'; e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 320px', minWidth: 280 }}>
                    <BannerPreview ad={ad} compact />
                  </div>
                  <div style={{ minWidth: 180, flex: '1 1 200px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 800, color: ink }}>{ad.title || (ad.imageUrl ? 'Image Ad' : 'Untitled Ad')}</span>
                      <StatusBadge status={status} />
                      {ad.imageUrl && conformance[ad.id] === false && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: amber[100], color: '#92400e' }}>
                          <FileWarning size={11} /> Not 3:1
                        </span>
                      )}
                      {ad.imageUrl && conformance[ad.id] === true && isConformantMeta(ad.imageMeta) && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: teal[100], color: teal[700] }}>
                          <ShieldCheck size={11} /> 3:1 &middot; {ad.imageMeta.width} × {ad.imageMeta.height}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: inkSoft, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Calendar size={11} />
                        {new Date(ad.startsAt || new Date().toISOString()).toLocaleDateString()} → {ad.endsAt ? new Date(ad.endsAt).toLocaleDateString() : '∞'}
                      </span>
                      {Number(ad.priority || 0) > 0 && <span>Priority {ad.priority}</span>}
                      {ad.aiGenerated && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: violet[700], background: violet[50], padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}>
                          <Sparkles size={10} /> AI
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                    <button title={status === 'active' ? 'Pause' : 'Activate'} onClick={() => toggleStatus(ad)}
                      style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: status === 'active' ? amber[100] : teal[100], color: status === 'active' ? '#92400e' : teal[700], display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                    >
                      {status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    {ad.imageUrl && conformance[ad.id] === false && (
                      <button title="Re-crop to 3:1" onClick={() => handleRecrop(ad)}
                        style={{ height: 32, padding: '0 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: amber[100], color: '#92400e', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, transition: 'transform .12s ease' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                      >
                        <Scissors size={12} /> Re-crop
                      </button>
                    )}
                    <button title="Edit" onClick={() => startEdit(ad)}
                      style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f1f2f4', color: inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button title="Delete" onClick={() => setDeleteTarget(ad)}
                      style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(181,73,63,.08)', color: danger, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .12s ease' }}
                      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Create / Edit modal ── */}
      {showNew && (
        <div className="client-modal-overlay" style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.6)',
          padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
        }}>
          <div className="client-modal-content" style={{
            width: 920, maxWidth: '100%', maxHeight: '92vh',
            background: paper, borderRadius: 14,
            boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative'
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)` }} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 28px 18px', borderBottom: `1px solid ${hairline}`, background: paper }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 10px -3px rgba(15,84,76,.6)`, flexShrink: 0 }}>
                  <Megaphone size={19} color="#fff" />
                </div>
                <div>
                  <h1 style={{ fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400, fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2 }}>
                    {editingId ? `Edit Ad: ${form.title || '—'}` : 'Create Banner Ad'}
                  </h1>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>
                    Smart Operations &mdash; customer portal banner campaigns
                  </p>
                </div>
              </div>
              <button onClick={() => { setShowNew(false); setEditingId(null); setForm(emptyForm()) }} aria-label="Close" style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all .15s ease', fontSize: 16 }}
                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
              >
                <X size={15} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {/* Horizontal Tab Bar */}
              <div style={{ display: 'flex', gap: 0, padding: '0 24px', borderBottom: `1.4px solid ${hairline}`, background: paper, flexShrink: 0, overflowX: 'auto' }}>
                {modalTabs.map((tab) => {
                  const isActive = activeTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7,
                      padding: '11px 18px', border: 'none', borderBottom: `2px solid ${isActive ? teal[600] : 'transparent'}`,
                      background: 'transparent', cursor: 'pointer', fontFamily: "'Inter', sans-serif",
                      fontSize: 12.5, fontWeight: isActive ? 700 : 500,
                      color: isActive ? teal[700] : inkSoft,
                      transition: 'all .12s', whiteSpace: 'nowrap',
                    }}
                      onMouseEnter={e => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = teal[600]; (e.currentTarget as HTMLElement).style.borderBottomColor = teal[200]; }}}
                      onMouseLeave={e => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = inkSoft; (e.currentTarget as HTMLElement).style.borderBottomColor = 'transparent'; }}}
                    >
                      <Icon size={14} style={{ flexShrink: 0 }} />
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* Form Area */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '24px 30px 8px' }}>
                <form id="ad-form" onSubmit={(e) => { e.preventDefault(); editingId ? saveEdit() : saveNew() }}>

                  {notify && notify.kind === 'error' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 16, background: '#fef0ee', border: `1.4px solid #f3c1bd`, color: danger, fontSize: 12.5, fontWeight: 600 }}>
                      <AlertTriangle size={15} />
                      <span style={{ flex: 1 }}>{notify.text}</span>
                    </div>
                  )}

                  {/* Details Tab */}
                  {activeTab === 'Details' && (
                    <>
                      <div style={sectionLabelStyle}><span>Content</span></div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Ad Title</label>
                        <input type="text" value={form.title || ''}
                          onChange={(e) => setForm(p => ({ ...p, title: e.target.value }))}
                          placeholder="e.g. 20% Off Business Cards"
                          style={modalInputStyle} />
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Subtitle</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <textarea
                            value={form.subtitle || ''}
                            onChange={(e) => setForm(p => ({ ...p, subtitle: e.target.value }))}
                            rows={2}
                            placeholder="One supporting line customers see under the headline..."
                            style={{ ...modalInputStyle, resize: 'none', minHeight: 52, lineHeight: 1.5, flex: 1 }} />
                          <button
                            type="button"
                            onClick={handleGenerateSubtitle}
                            disabled={subtitleGenerating}
                            title="Generate subtitle with AI"
                            style={{
                              fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 700,
                              padding: '5px 11px', borderRadius: 8, border: 'none',
                              background: `linear-gradient(135deg, ${violet[500]}, #6D44B8)`,
                              color: '#fff', cursor: subtitleGenerating ? 'not-allowed' : 'pointer',
                              display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                              flexShrink: 0, opacity: subtitleGenerating ? 0.5 : 1,
                              marginTop: 1,
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                              {subtitleGenerating
                                ? <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                : <><path d="M12 3l1.6 4.9L18.5 9.5 13.6 11 12 16l-1.6-5-4.9-1.5 4.9-1.6L12 3z" fill="currentColor"/><path d="M8 18h8M10 21h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></>
                              }
                            </svg>
                            {subtitleGenerating ? 'Generating…' : 'AI'}
                          </button>
                        </div>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Description <span style={{ fontSize: 10, color: inkSoft, fontWeight: 400 }}>(rich ad copy — AI auto-fills this)</span></label>
                        <textarea
                          value={form.description || ''}
                          onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
                          rows={5}
                          placeholder="Premium paragraph description of the offer. AI generates this automatically when you click 'Generate Ad with AI'."
                          style={{ ...modalInputStyle, resize: 'vertical', minHeight: 110, lineHeight: 1.6, fontSize: 12.5 }} />
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                          <label style={labelStyle}>Badge Label</label>
                          <input type="text" value={form.badge || ''}
                            onChange={(e) => setForm(p => ({ ...p, badge: e.target.value }))}
                            placeholder="Limited Time / New Arrival"
                            style={modalInputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>CTA Button Text</label>
                          <input type="text" value={form.ctaLabel || ''}
                            onChange={(e) => setForm(p => ({ ...p, ctaLabel: e.target.value }))}
                            placeholder="Order Now / Learn More"
                            style={modalInputStyle} />
                        </div>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Tap Target (portal page)</label>
                        <select value={form.ctaTarget || '/portal/orders'}
                          onChange={(e) => setForm(p => ({ ...p, ctaTarget: e.target.value }))}
                          style={modalSelectStyle}>
                          {CTA_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Emoji Icon</label>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {EMOJI_PRESETS.map((em) => (
                            <button key={em} type="button" onClick={() => setForm(p => ({ ...p, emoji: em }))} style={{
                              width: 38, height: 38, borderRadius: 9, fontSize: 18, cursor: 'pointer',
                              border: (form.emoji || '🎯') === em ? `2px solid ${teal[500]}` : `1.4px solid ${hairline}`,
                              background: (form.emoji || '🎯') === em ? teal[50] : paper,
                              transition: 'all .12s ease',
                            }}>{em}</button>
                          ))}
                        </div>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Banner Gradient</label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                          {GRADIENT_PRESETS.map((g) => (
                            <button key={g.name} type="button" onClick={() => setForm(p => ({ ...p, gradient: g.value }))} style={{
                              height: 44, borderRadius: 9, cursor: 'pointer', background: g.value,
                              border: (form.gradient || '') === g.value ? `2px solid ${amber[500]}` : '1px solid rgba(0,0,0,.08)',
                              position: 'relative', overflow: 'hidden',
                            }}>
                              <span style={{ position: 'absolute', bottom: 4, left: 8, fontSize: 9, fontWeight: 700, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,.5)' }}>{g.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <label style={{ ...labelStyle, marginBottom: 0 }}>Banner Image (optional)</label>
                          <div style={{ display: 'flex', gap: 4, padding: 3, background: '#f1f2f4', borderRadius: 8 }}>
                            <button type="button" onClick={() => { setImageMode('upload'); setUrlPreviewStatus('idle'); setUrlPreviewDims(null) }} style={{
                              padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', gap: 5,
                              background: imageMode === 'upload' ? '#fff' : 'transparent', color: imageMode === 'upload' ? teal[700] : inkSoft,
                              boxShadow: imageMode === 'upload' ? '0 1px 4px rgba(0,0,0,.12)' : 'none',
                            }}>
                              <UploadCloud size={12} /> Upload
                            </button>
                            <button type="button" onClick={() => { setImageMode('url'); setUrlPreviewStatus('idle'); setUrlPreviewDims(null) }} style={{
                              padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', gap: 5,
                              background: imageMode === 'url' ? '#fff' : 'transparent', color: imageMode === 'url' ? teal[700] : inkSoft,
                              boxShadow: imageMode === 'url' ? '0 1px 4px rgba(0,0,0,.12)' : 'none',
                            }}>
                              <Link2 size={12} /> Paste URL
                            </button>
                          </div>
                        </div>

                        {imageMode === 'upload' ? (
                          form.imageUrl ? (
                            <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: `1.4px solid ${hairline}`, background: '#f8fafc' }}>
                              <img src={form.imageUrl} alt="Banner preview" style={{ width: '100%', aspectRatio: '4 / 1', minHeight: 96, objectFit: 'cover', display: 'block' }} />
                              <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 6 }}>
                                <button type="button" onClick={() => setImageMode('url')} title="Replace image"
                                  style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(15,23,42,.6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <ImagePlus size={14} />
                                </button>
                                <button type="button" onClick={() => setForm(p => ({ ...p, imageUrl: '', imageMeta: undefined }))} title="Remove image"
                                  style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(181,73,63,.85)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <Trash2 size={13} />
                                </button>
                              </div>
                              {form.imageMeta && (
                                <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: 'rgba(15,23,42,.72)', color: '#fff' }}>
                                    <ShieldCheck size={11} color={teal[300]} /> 3:1 prepared &middot; {form.imageMeta.width} × {form.imageMeta.height} &middot; {form.imageMeta.format.toUpperCase()} &middot; {formatBannerBytes(form.imageMeta.fileSize)}
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div style={{ marginBottom: 8, padding: '9px 12px', borderRadius: 9, background: teal[50], border: `1px solid ${teal[200]}`, display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                                <ShieldCheck size={15} style={{ color: teal[600], flexShrink: 0, marginTop: 1 }} />
                                <div style={{ fontSize: 11.5, color: teal[800], lineHeight: 1.55 }}>
                                  <b>Recommended size: {BANNER_SPEC.recommendedWidth} × {BANNER_SPEC.recommendedHeight} px</b> &nbsp;&middot;&nbsp; <b>Aspect ratio: 3:1</b>
                                  <br />
                                  Minimum {BANNER_SPEC.minWidth} × {BANNER_SPEC.minHeight} px &middot; WebP preferred (JPG/PNG accepted) &middot; up to 2 MB.
                                  Images that aren&apos;t 3:1 open a crop tool — banners are never stretched.
                                </div>
                              </div>
                              <label
                                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={(e) => { e.preventDefault(); setDragOver(false); handleImageUpload(e.dataTransfer.files?.[0]) }}
                                style={{
                                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                                  minHeight: 120, borderRadius: 10, cursor: uploadingImage ? 'default' : 'pointer',
                                  border: `1.6px dashed ${dragOver ? teal[500] : hairline}`,
                                  background: dragOver ? teal[50] : '#faf9f6',
                                  transition: 'all .15s ease', textAlign: 'center', padding: 16,
                                }}
                              >
                                {uploadingImage ? (
                                  <>
                                    <Loader2 size={22} className="animate-spin" style={{ color: teal[600] }} />
                                    <span style={{ fontSize: 12, color: inkSoft, fontWeight: 600 }}>Preparing banner…</span>
                                  </>
                                ) : (
                                  <>
                                    <div style={{ width: 40, height: 40, borderRadius: 10, background: teal[100], color: teal[600], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                      <ImagePlus size={19} />
                                    </div>
                                    <span style={{ fontSize: 12.5, color: ink, fontWeight: 600 }}>Click to choose an image, or drag &amp; drop here</span>
                                    <span style={{ fontSize: 10.5, color: inkSoft }}>WebP, JPG or PNG — up to 2 MB</span>
                                  </>
                                )}
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp"
                                  disabled={uploadingImage}
                                  onChange={(e) => { handleImageUpload(e.target.files?.[0]); e.target.value = '' }}
                                  style={{ display: 'none' }}
                                />
                              </label>
                            </>
                          )
                        ) : (
                          <>
                            {/* URL input row */}
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input
                                type="text"
                                value={form.imageUrl || ''}
                                onChange={(e) => {
                                  const url = e.target.value
                                  setForm(p => ({ ...p, imageUrl: url, imageMeta: undefined }))
                                  if (!url.trim()) { setUrlPreviewStatus('idle'); setUrlPreviewDims(null); return }
                                  setUrlPreviewStatus('loading')
                                  setUrlPreviewDims(null)
                                  const img = new Image()
                                  img.onload = () => {
                                    setUrlPreviewStatus('ok')
                                    setUrlPreviewDims({ w: img.naturalWidth, h: img.naturalHeight })
                                  }
                                  img.onerror = () => { setUrlPreviewStatus('error'); setUrlPreviewDims(null) }
                                  img.src = url
                                }}
                                placeholder="https://… (leave empty to use the gradient)"
                                style={{ ...modalInputStyle, flex: 1 }}
                              />
                              {form.imageUrl && (
                                <button
                                  type="button"
                                  title="Remove image URL"
                                  onClick={() => {
                                    setForm(p => ({ ...p, imageUrl: '', imageMeta: undefined }))
                                    setUrlPreviewStatus('idle')
                                    setUrlPreviewDims(null)
                                  }}
                                  style={{
                                    width: 34, height: 34, borderRadius: 8, border: 'none', flexShrink: 0,
                                    cursor: 'pointer', background: 'rgba(181,73,63,.1)', color: danger,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  }}
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </div>

                            {/* Live preview panel */}
                            {urlPreviewStatus === 'loading' && (
                              <div style={{
                                marginTop: 10, borderRadius: 10, border: `1.4px dashed ${hairline}`,
                                background: '#faf9f6', display: 'flex', alignItems: 'center',
                                justifyContent: 'center', gap: 8, padding: '18px 0',
                                color: inkSoft, fontSize: 12,
                              }}>
                                <Loader2 size={16} className="animate-spin" style={{ color: teal[500] }} />
                                Loading preview…
                              </div>
                            )}

                            {urlPreviewStatus === 'error' && (
                              <div style={{
                                marginTop: 10, borderRadius: 10, border: `1.4px solid #f3c1bd`,
                                background: '#fef0ee', display: 'flex', alignItems: 'center',
                                gap: 8, padding: '10px 14px', color: danger, fontSize: 12, fontWeight: 600,
                              }}>
                                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                                Could not load image — check the URL or use the Upload tab instead.
                              </div>
                            )}

                            {urlPreviewStatus === 'ok' && form.imageUrl && (
                              <div style={{
                                marginTop: 10, borderRadius: 10, overflow: 'hidden',
                                border: `1.4px solid ${teal[200]}`, position: 'relative', background: '#0d1420',
                              }}>
                                <img
                                  src={form.imageUrl}
                                  alt="Banner preview"
                                  style={{
                                    width: '100%', aspectRatio: '4 / 1', minHeight: 80,
                                    objectFit: 'cover', display: 'block',
                                  }}
                                />
                                {/* Overlay badges */}
                                <div style={{
                                  position: 'absolute', inset: 0, pointerEvents: 'none',
                                  background: 'linear-gradient(to top, rgba(0,0,0,.45) 0%, transparent 55%)',
                                }} />
                                {urlPreviewDims && (
                                  <div style={{
                                    position: 'absolute', bottom: 8, left: 8,
                                    display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                                  }}>
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 5,
                                      fontSize: 10, fontWeight: 700, padding: '3px 9px',
                                      borderRadius: 20, background: 'rgba(15,23,42,.72)', color: '#fff',
                                    }}>
                                      {urlPreviewDims.w} × {urlPreviewDims.h} px
                                    </span>
                                    {aspectConformance(urlPreviewDims.w, urlPreviewDims.h) ? (
                                      <span style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 5,
                                        fontSize: 10, fontWeight: 700, padding: '3px 9px',
                                        borderRadius: 20, background: teal[600], color: '#fff',
                                      }}>
                                        <ShieldCheck size={10} /> 3:1 ✓
                                      </span>
                                    ) : (
                                      <span style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 5,
                                        fontSize: 10, fontWeight: 700, padding: '3px 9px',
                                        borderRadius: 20, background: amber[500], color: '#fff',
                                      }}>
                                        <AlertTriangle size={10} /> Not 3:1 — may appear cropped
                                      </span>
                                    )}
                                  </div>
                                )}
                                <button
                                  type="button"
                                  title="Remove image"
                                  onClick={() => {
                                    setForm(p => ({ ...p, imageUrl: '', imageMeta: undefined }))
                                    setUrlPreviewStatus('idle')
                                    setUrlPreviewDims(null)
                                  }}
                                  style={{
                                    position: 'absolute', top: 8, right: 8,
                                    width: 28, height: 28, borderRadius: 7, border: 'none',
                                    cursor: 'pointer', background: 'rgba(181,73,63,.85)', color: '#fff',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            )}
                          </>
                        )}

                        <div style={{ marginTop: 8, fontSize: 11, color: inkSoft, lineHeight: 1.5 }}>
                          <b style={{ color: ink }}>Text only</b> — no image. &nbsp;<b style={{ color: ink }}>Image only</b> — leave the title and subtitle empty. &nbsp;<b style={{ color: ink }}>Image + text</b> — your text appears over the image with a legibility scrim.
                        </div>
                      </div>
                    </>
                  )}

                  {/* AI Studio Tab */}
                  {activeTab === 'AIStudio' && (
                    <>
                      <div style={sectionLabelStyle}><span>AI Studio</span></div>
                      <div style={{ padding: 14, background: violet[50], borderRadius: 9, border: `1px solid ${violet[100]}`, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                        <div style={{ padding: 8, borderRadius: 8, background: violet[500], color: '#fff', display: 'inline-flex' }}>
                          <Wand2 size={18} />
                        </div>
                        <div style={{ fontSize: 12, color: inkSoft, fontWeight: 500, lineHeight: 1.5 }}>
                          Describe your offer in one line and the AI will draft a headline, subtitle, badge, CTA, emoji and banner gradient. Edit anything afterwards.
                        </div>
                      </div>

                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Your Offer / Brief</label>
                        <textarea
                          value={aiBrief}
                          onChange={(e) => { setAiBrief(e.target.value); setAiError('') }}
                          rows={4}
                          placeholder={'e.g. "20% off business cards for returning corporate clients this November — premium stock, fast turnaround, available to businesses with an existing account."'}
                          style={{ ...modalInputStyle, resize: 'none', minHeight: 90, lineHeight: 1.5 }} />
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                          <label style={labelStyle}>Audience</label>
                          <select value={aiAudience} onChange={(e) => setAiAudience(e.target.value)} style={modalSelectStyle}>
                            <option value="all customers">All customers</option>
                            <option value="new customers">New customers</option>
                            <option value="existing customers">Existing customers</option>
                            <option value="loyalty members">Loyalty members</option>
                            <option value="corporate clients">Corporate clients</option>
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle}>Tone</label>
                          <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} style={modalSelectStyle}>
                            <option value="friendly">Friendly</option>
                            <option value="professional">Professional</option>
                            <option value="urgent">Urgent / Scarcity</option>
                            <option value="premium">Premium</option>
                            <option value="festive">Festive</option>
                          </select>
                        </div>
                      </div>

                      {aiError && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14, background: '#fef0ee', border: `1.4px solid #f3c1bd`, color: danger, fontSize: 12.5, fontWeight: 600 }}>
                          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{aiError}</span>
                        </div>
                      )}

                      <button type="button" onClick={runAIGenerate} disabled={aiBusy} style={{
                        width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none', cursor: aiBusy ? 'default' : 'pointer',
                        background: `linear-gradient(135deg, ${violet[500]}, ${violet[700]})`, color: '#fff', fontSize: 13.5, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        boxShadow: '0 8px 20px -8px rgba(124,92,240,.55)', transition: 'transform .15s ease',
                      }}
                        onMouseEnter={(e) => { if (!aiBusy) e.currentTarget.style.transform = 'translateY(-1px)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
                      >
                        {aiBusy ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                        {aiBusy ? 'Writing your ad…' : 'Generate Ad with AI'}
                      </button>
                      <p style={{ fontSize: 10.5, color: inkSoft, marginTop: 10, lineHeight: 1.5 }}>
                        Uses your configured AI provider (OpenAI / OpenRouter / Anthropic / Ollama). Not configured? It falls back to smart templates, and you can still fine-tune everything manually.
                      </p>
                    </>
                  )}

                  {/* Schedule Tab */}
                  {activeTab === 'Schedule' && (
                    <>
                      <div style={sectionLabelStyle}><span>Schedule &amp; Status</span></div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                          <label style={labelStyle}>Status</label>
                          <select value={form.status || 'draft'}
                            onChange={(e) => setForm(p => ({ ...p, status: e.target.value as PortalAdStatus }))}
                            style={modalSelectStyle}>
                            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
                          <button type="button" onClick={() => setForm(p => ({ ...p, isActive: !(p.isActive !== false) }))} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
                            <span style={{ width: 38, height: 21, borderRadius: 20, position: 'relative', transition: 'all .18s ease', flexShrink: 0, background: form.isActive !== false ? teal[500] : '#d6dadd' }}>
                              <span style={{ position: 'absolute', top: 2, left: form.isActive !== false ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'all .18s ease', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }} />
                            </span>
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: ink }}>Active</span>
                          </button>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                          <label style={labelStyle}>Start Date / Time</label>
                          <input type="datetime-local" value={form.startsAt || ''}
                            onChange={(e) => setForm(p => ({ ...p, startsAt: e.target.value }))}
                            style={modalInputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>End Date / Time</label>
                          <input type="datetime-local" value={form.endsAt || ''}
                            onChange={(e) => setForm(p => ({ ...p, endsAt: e.target.value }))}
                            style={modalInputStyle} />
                        </div>
                      </div>
                      <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Priority (higher shows first)</label>
                        <input type="number" value={form.priority || 0}
                          onChange={(e) => setForm(p => ({ ...p, priority: parseInt(e.target.value) || 0 }))}
                          placeholder="0"
                          style={modalInputStyle} />
                      </div>
                      <div style={{ padding: 14, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                        <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[600], display: 'inline-flex' }}>
                          <Clock size={18} />
                        </div>
                        <div style={{ fontSize: 12, color: inkSoft, fontWeight: 500, lineHeight: 1.5 }}>
                          Only ads with status <b style={{ color: teal[800] }}>active</b> (and within the date window) are served to the portal banner.
                        </div>
                      </div>
                    </>
                  )}

                  {/* Preview Tab */}
                  {activeTab === 'Preview' && (
                    <>
                      <div style={sectionLabelStyle}><span>Live Preview</span></div>
                      <p style={{ fontSize: 12, color: inkSoft, margin: '0 0 14px', lineHeight: 1.5 }}>
                        Exactly how this ad renders in the customer portal banner carousel — the preview uses the same 3:1 banner area as the portal.
                      </p>
                      <BannerPreview ad={form} />
                      {form.imageMeta && aspectConformance(form.imageMeta.width, form.imageMeta.height) && (
                        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 9, background: teal[50], border: `1px solid ${teal[200]}`, fontSize: 11.5, color: teal[800], fontWeight: 600 }}>
                          <ShieldCheck size={14} style={{ color: teal[600], flexShrink: 0 }} />
                          <span>
                            3:1 compliant &middot; {form.imageMeta.width} × {form.imageMeta.height} px &middot; aspect {form.imageMeta.aspectRatio}:1
                            {form.imageMeta.format ? ` &middot; ${form.imageMeta.format.toUpperCase()}` : ''}
                            {typeof form.imageMeta.fileSize === 'number' ? ` &middot; ${formatBannerBytes(form.imageMeta.fileSize)}` : ''}
                          </span>
                        </div>
                      )}
                      {form.imageUrl && (!form.imageMeta || !aspectConformance(form.imageMeta.width, form.imageMeta.height)) && (
                        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 9, background: '#fdf6e3', border: `1.4px solid ${amber[300]}`, fontSize: 11.5, color: '#92400e', fontWeight: 600 }}>
                          <FileWarning size={14} style={{ flexShrink: 0 }} />
                          <span>This banner is not 3:1 compliant — re-crop it so it displays correctly on the portal.</span>
                        </div>
                      )}
                      <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: '#f8fafc', border: `1px solid ${hairline}`, fontSize: 11.5, color: inkSoft, lineHeight: 1.6 }}>
                          <b style={{ color: ink }}>Details</b>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span>Format: <b style={{ color: ink }}>{form.imageUrl ? (String(form.title || '').trim() || String(form.subtitle || '').trim() ? 'Image + Text' : 'Image only') : 'Text only'}</b></span>
                            <span>Title: <b style={{ color: ink }}>{form.title || '—'}</b></span>
                            <span>Badge: <b style={{ color: ink }}>{form.badge || '—'}</b></span>
                            <span>CTA: <b style={{ color: ink }}>{form.ctaLabel || '—'}</b> → <b style={{ color: teal[700] }}>{form.ctaTarget || '/portal/orders'}</b></span>
                            <span>Emoji: <b style={{ color: ink }}>{form.emoji || '—'}</b></span>
                            <span>Priority: <b style={{ color: ink }}>{form.priority || 0}</b></span>
                            {form.description && (
                              <span style={{ marginTop: 4 }}>Description: <b style={{ color: ink, fontWeight: 400, fontStyle: 'italic' }}>{form.description.slice(0, 120)}{form.description.length > 120 ? '…' : ''}</b></span>
                            )}
                          </div>
                        </div>
                    </>
                  )}

                  {/* Footer */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 26, paddingBottom: 22, gap: 10 }}>
                    <button type="button" onClick={() => { setShowNew(false); setEditingId(null); setForm(emptyForm()) }} style={{ padding: '10px 16px', borderRadius: 10, border: `1.4px solid ${hairline}`, fontWeight: 600, fontSize: 13, color: ink, background: 'transparent', cursor: 'pointer', lineHeight: 1.4 }}>
                      Cancel
                    </button>
                    <button type="submit" disabled={saving} style={{
                      padding: '10px 20px', borderRadius: 10, fontWeight: 600, fontSize: 13,
                      border: 'none', cursor: saving ? 'default' : 'pointer',
                      background: `linear-gradient(135deg, ${teal[500]}, ${teal[700]})`, color: '#fff', lineHeight: 1.4,
                      display: 'flex', alignItems: 'center', gap: 8,
                      boxShadow: '0 8px 20px -8px rgba(15,84,76,.55)',
                    }}>
                      {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                      {saving ? 'Saving…' : (editingId ? 'Save Changes' : 'Create Ad')}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: paper, borderRadius: 14, width: '100%', maxWidth: 400, boxShadow: '0 30px 70px -20px rgba(0,0,0,.55)', padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(181,73,63,.1)', color: danger, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 size={16} />
              </div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: ink }}>Delete this ad?</h3>
            </div>
            <p style={{ fontSize: 12.5, color: inkSoft, margin: '0 0 18px', lineHeight: 1.5 }}>
              "{deleteTarget.title}" will be removed from the portal banner immediately. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ padding: '9px 16px', borderRadius: 9, border: `1.4px solid ${hairline}`, fontWeight: 600, fontSize: 12.5, color: ink, background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmDelete} style={{ padding: '9px 16px', borderRadius: 9, border: 'none', fontWeight: 600, fontSize: 12.5, background: danger, color: '#fff', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Interactive 3:1 crop tool ── */}
      {cropTarget && (
        <BannerCropModal
          image={cropTarget.image}
          blobUrl={cropTarget.blobUrl}
          sourceName={cropTarget.sourceName}
          onCancel={() => {
            URL.revokeObjectURL(cropTarget.blobUrl)
            setCropTarget(null)
          }}
          onConfirm={(blob, output) => {
            URL.revokeObjectURL(cropTarget.blobUrl)
            cropTarget.onDone(blob, output)
            setCropTarget(null)
          }}
        />
      )}
    </div>
  )
}

export default AdsManager
