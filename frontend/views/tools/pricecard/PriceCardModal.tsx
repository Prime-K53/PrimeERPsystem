import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../../components/Toast';
import { logger } from '../../../services/logger';
import { dbService } from '../../../services/db';
import { useAuth } from '../../../context/AuthContext';
import { useInventory } from '../../../context/InventoryContext';
import { currencyService } from '../../../services/currencyService';
import { resolveStoredSellingPrice } from '../../../utils/pricing';
import { resolveCustomerDisplay } from '../../../utils/customerDisplay';
import {
  Download,
  History,
  Loader2,
  Minus,
  Plus,
  Search,
  Share2,
  Tag,
  X,
  ChevronRight,
  Image as ImageIcon,
} from 'lucide-react';
import type { Customer, Item } from '../../../types';
import {
  PRICE_CARD_MAX_LINES,
  PriceCardData,
  PriceCardError,
  PriceCardHistoryEntry,
  buildPriceCardData,
  buildPriceCardFileName,
  formatPriceCardAmount,
  generatePriceCardReference,
  loadPriceCardHistory,
  recordPriceCardHistory,
  type PriceCardBusiness,
} from '../../../services/priceCardService';
import { PriceCardView } from './PriceCardView';
import { downloadBlob, renderPriceCardPng, shareImageFile } from './priceCardImage';
import {
  teal, amber, paper, ink, inkSoft, hairline, danger,
  labelStyle, inputStyle, selectStyle,
  btnGhostStyle, btnPrimaryStyle,
  modalOverlayStyle, modalShell, AccentStripe, ModalHeader, SectionLabel,
} from './priceCardChrome';

/**
 * PriceCardModal — fast "price asked → professional image" workflow (ERP only).
 *
 * Product → optional quantity / customer → live preview → Generate Image →
 * Download / native Share (Android share sheet → WhatsApp).
 *
 * Informational only: previewing and generating never write sales,
 * quotations, orders, invoices, payments, ledger, stock, or balances.
 *
 * Chrome mirrors the Clients "Add Customer" modal (ClientModal.tsx):
 * overlay, accent stripe, icon-tile serif header, styled controls,
 * footer with step hint + ghost/gradient actions.
 */

interface Props {
  open: boolean;
  initialItem?: Item | null;
  onClose: () => void;
}

interface CardLineState {
  key: string;
  item: Item;
  variantId?: string;
  quantity: number;
}

let lineKeySeq = 0;
const nextLineKey = () => `pc-line-${Date.now()}-${lineKeySeq++}`;

const PREVIEW_SCALE = 0.58;

export const PriceCardModal: React.FC<Props> = ({ open, initialItem, onClose }) => {
  const { companyConfig, notify, addAuditLog, user } = useAuth();
  const { inventory } = useInventory();

  const [lines, setLines] = useState<CardLineState[]>([]);
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reference, setReference] = useState('');
  const [cardData, setCardData] = useState<PriceCardData | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState('');
  const [history, setHistory] = useState<PriceCardHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const currency = companyConfig?.currencySymbol
    || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol
    || 'K';

  const business: PriceCardBusiness = useMemo(() => {
    const address = [companyConfig?.addressLine1, companyConfig?.city, companyConfig?.country]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(', ');
    return {
      name: String(companyConfig?.companyName ?? '').trim() || 'Prime Printing Services',
      phone: String(companyConfig?.phone ?? companyConfig?.whatsappNumber ?? '').trim() || undefined,
      address: address || undefined,
      logoUrl: String(companyConfig?.logoBase64 ?? companyConfig?.logo ?? '').trim() || undefined,
      currency,
    };
  }, [companyConfig, currency]);

  /* ── open / reset ─────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    setLines(initialItem ? [{ key: nextLineKey(), item: initialItem, quantity: 1 }] : []);
    setSearch('');
    setCustomerId('');
    setCardData(null);
    setBuildError(null);
    setImageBlob(null);
    setFileName('');
    setShowHistory(false);
    setReference(generatePriceCardReference(loadPriceCardHistory()));
    setHistory(loadPriceCardHistory());
    let cancelled = false;
    dbService.getAll<Customer>('customers')
      .then((rows) => { if (!cancelled) setCustomers(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setCustomers([]); });
    return () => { cancelled = true; };
  }, [open, initialItem]);

  /* ── Escape to close (mirrors Add Customer modal behaviour) ── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => String(c?.id) === customerId) ?? null,
    [customers, customerId],
  );

  /* ── live preview (rebuilt from authoritative pricing on every change) ── */
  useEffect(() => {
    if (!open || lines.length === 0) {
      setCardData(null);
      if (lines.length === 0) setBuildError(null);
      return;
    }
    let cancelled = false;
    setBuilding(true);
    buildPriceCardData(
      {
        lines: lines.map((l) => ({ item: l.item, variantId: l.variantId, quantity: l.quantity })),
        customer: selectedCustomer,
        business,
        reference,
      },
    )
      .then((data) => {
        if (cancelled) return;
        setCardData(data);
        setBuildError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setCardData(null);
        setBuildError(error instanceof PriceCardError ? error.message : 'Could not build the preview.');
      })
      .finally(() => { if (!cancelled) setBuilding(false); });
    return () => { cancelled = true; };
  }, [open, lines, selectedCustomer, business, reference]);

  // Any input change invalidates a previously generated image.
  useEffect(() => {
    setImageBlob(null);
  }, [cardData]);

  /* ── product search ───────────────────────────────────────── */
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const pool = Array.isArray(inventory) ? inventory : [];
    return pool
      .filter((item) => {
        if (!item || item.status === 'Inactive') return false;
        if (lines.some((l) => l.item.id === item.id)) return false;
        return [item.name, item.sku, item.category].some((v) => String(v ?? '').toLowerCase().includes(q));
      })
      .slice(0, 8);
  }, [search, inventory, lines]);

  const addItem = useCallback((item: Item) => {
    setLines((prev) => {
      if (prev.length >= PRICE_CARD_MAX_LINES || prev.some((l) => l.item.id === item.id)) return prev;
      return [...prev, { key: nextLineKey(), item, quantity: 1 }];
    });
    setSearch('');
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<CardLineState>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  /* ── generate / download / share ──────────────────────────── */
  const tell = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    try {
      if (notify) notify(message, type as 'success' | 'error' | 'info' | 'warning');
      else toast[type](message);
    } catch {
      toast[type](message);
    }
  }, [notify]);

  const handleGenerate = useCallback(async () => {
    const el = captureRef.current;
    if (!el || !cardData) {
      tell('Add a product with an available price first.', 'error');
      return;
    }
    setGenerating(true);
    try {
      const blob = await renderPriceCardPng(el);
      const name = buildPriceCardFileName(cardData);
      setImageBlob(blob);
      setFileName(name);
      setHistory(recordPriceCardHistory(cardData));
      try {
        addAuditLog?.({
          action: 'GENERATE',
          entityType: 'PriceCard',
          entityId: cardData.reference,
          details: `Price card ${cardData.reference} generated for ${cardData.lines.map((l) => l.productName).join(', ')} (${formatPriceCardAmount(cardData.grandTotal, cardData.business.currency)}) by ${user?.username ?? user?.id ?? 'staff'}.`,
        });
      } catch { /* audit is best-effort */ }
      tell('Price card image ready', 'success');
    } catch (error) {
      logger.error('[PriceCard] Image generation failed:', error);
      tell('Failed to generate the image. Please try again.', 'error');
    } finally {
      setGenerating(false);
    }
  }, [cardData, addAuditLog, tell, user]);

  const handleDownload = useCallback(() => {
    if (!imageBlob) return;
    downloadBlob(imageBlob, fileName || 'price-card.png');
    tell('Price card downloaded', 'success');
  }, [imageBlob, fileName, tell]);

  const handleShare = useCallback(async () => {
    if (!imageBlob || !cardData) return;
    const outcome = await shareImageFile(
      imageBlob,
      fileName || 'price-card.png',
      `Price Card ${cardData.reference}`,
      `${cardData.lines.map((l) => `${l.productName} — ${formatPriceCardAmount(l.unitPrice, cardData.business.currency)}`).join(', ')}`,
    );
    (outcome === 'shared' ? tell('Price card shared', 'success') : tell('Price card downloaded', 'success'));
  }, [imageBlob, fileName, cardData, tell]);

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (!open) return null;

  const footerHint = cardData
    ? `${cardData.reference} · exports at 1080 × 1350 PNG · informational only`
    : 'Informational only — never creates a sale, quotation, or invoice';

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(1020)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<Tag size={19} color="#fff" />}
          title="New Price Card"
          subtitle="Professional price image for customers — informational only · Never creates a sale, quotation, or invoice"
          onClose={onClose}
        />

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 30px 8px', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
            {/* ── controls ── */}
            <div style={{ minWidth: 0 }}>
              <SectionLabel>Products · {lines.length}/{PRICE_CARD_MAX_LINES}</SectionLabel>
              <div style={{ position: 'relative', marginTop: 6 }}>
                <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, SKU, category…"
                  disabled={lines.length >= PRICE_CARD_MAX_LINES}
                  style={{ ...inputStyle, paddingLeft: 34 }}
                />
                {results.length > 0 && (
                  <div style={{
                    position: 'absolute', zIndex: 40, left: 0, right: 0, top: '100%', marginTop: 4,
                    borderRadius: 10, boxShadow: '0 16px 36px -12px rgba(0,0,0,.28)',
                    background: paper, border: `1.4px solid ${hairline}`,
                    maxHeight: 280, overflowY: 'auto', overflowX: 'hidden',
                  }}>
                    {results.map((item, idx) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => addItem(item)}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        style={{
                          display: 'flex', width: '100%', alignItems: 'center', gap: 10,
                          padding: '10px 14px', background: 'transparent', border: 'none',
                          borderBottom: idx < results.length - 1 ? `1px solid ${hairline}` : 'none',
                          cursor: 'pointer', textAlign: 'left', transition: 'background .1s ease',
                        }}
                      >
                        <span style={{
                          width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                          background: teal[100], color: teal[700],
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Tag size={13} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
                          <span style={{ display: 'block', fontSize: 11, color: inkSoft }}>{item.sku || item.category || ''}</span>
                        </span>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: teal[700], whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
                          {formatPriceCardAmount(resolveStoredSellingPrice(item as any), currency)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                {lines.map((line) => {
                  const variants = Array.isArray(line.item.variants) ? line.item.variants : [];
                  return (
                    <div
                      key={line.key}
                      style={{ padding: 16, background: paper, border: `1px solid ${hairline}`, borderRadius: 12, position: 'relative', transition: 'border-color .15s ease' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = teal[200]; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = hairline; }}
                    >
                      <button
                        type="button" onClick={() => removeLine(line.key)} title="Remove" aria-label="Remove product"
                        style={{ position: 'absolute', top: 10, right: 10, padding: 6, background: 'transparent', border: 'none', color: inkSoft, cursor: 'pointer', borderRadius: 6 }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = danger; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = inkSoft; }}
                      >
                        <X size={14} />
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 28 }}>
                        <div style={{
                          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                          background: teal[100], color: teal[700],
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Tag size={14} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: teal[800], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.item.name}</div>
                          <div style={{ fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{line.item.sku || line.item.unit || ''}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                        {variants.length > 0 && (
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <select
                              value={line.variantId ?? ''}
                              onChange={(e) => updateLine(line.key, { variantId: e.target.value || undefined })}
                              style={{ ...selectStyle, fontSize: 12.5, padding: '7px 30px 7px 10px' }}
                            >
                              <option value="">Standard</option>
                              {variants.map((v: any) => (
                                <option key={v.id} value={v.id}>{String(v.name ?? v.attribute ?? v.id)}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: teal[800] }}>Qty</span>
                          <button type="button" onClick={() => updateLine(line.key, { quantity: Math.max(1, line.quantity - 1) })} aria-label="Decrease quantity"
                            style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s ease' }}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <Minus size={13} />
                          </button>
                          <span style={{ minWidth: 26, textAlign: 'center', fontSize: 13, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{line.quantity}</span>
                          <button type="button" onClick={() => updateLine(line.key, { quantity: Math.min(999, line.quantity + 1) })} aria-label="Increase quantity"
                            style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s ease' }}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <Plus size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {lines.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 32, border: `2px dashed ${teal[100]}`, borderRadius: 12, background: teal[50] }}>
                    <ImageIcon size={28} style={{ margin: '0 auto 10', color: teal[200] }} />
                    <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>No products added yet</p>
                    <p style={{ fontSize: 11.5, color: inkSoft, margin: '6px 0 0' }}>Search and add up to {PRICE_CARD_MAX_LINES} products.</p>
                  </div>
                )}
              </div>

              <div style={{ marginTop: 18 }}>
                <SectionLabel>Customer · Optional</SectionLabel>
                <label style={labelStyle}>Price tier</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={selectStyle}>
                  <option value="">Walk-in — standard price</option>
                  {customers.map((c) => {
                    const { displayName } = resolveCustomerDisplay(c as any);
                    return <option key={c.id} value={c.id}>{displayName || c.name || c.id}</option>;
                  })}
                </select>
                {selectedCustomer && (
                  <div style={{ fontSize: 11.5, color: inkSoft, marginTop: 6, lineHeight: 1.5 }}>
                    Prepared for <b style={{ color: teal[700] }}>{resolveCustomerDisplay(selectedCustomer as any).displayName}</b>. Tier pricing applies automatically when configured.
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                style={{ marginTop: 16, background: 'none', border: 'none', color: teal[700], fontSize: 12.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0 }}
              >
                <History size={13} /> Recent price cards ({history.length})
              </button>
              {showHistory && (
                <div style={{ marginTop: 8, border: `1.4px solid ${hairline}`, borderRadius: 10, overflow: 'hidden', background: paper }}>
                  {history.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: inkSoft, textAlign: 'center' }}>No price cards generated yet on this device.</div>}
                  {history.slice(0, 10).map((h, idx) => (
                    <div key={h.reference} style={{ padding: '10px 14px', borderTop: idx > 0 ? `1px solid ${hairline}` : 'none', fontSize: 12.5 }}>
                      <div style={{ fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{h.reference}</div>
                      <div style={{ color: inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.productNames.join(', ')}</div>
                      <div style={{ color: inkSoft, fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace" }}>{formatPriceCardAmount(h.grandTotal, h.currency)} • {new Date(h.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── preview ── */}
            <div style={{ minWidth: 0 }}>
              <SectionLabel>Live Preview</SectionLabel>
              <div style={{ background: teal[50], border: `1.4px solid ${hairline}`, borderRadius: 12, padding: 12, overflow: 'hidden' }}>
                {building && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 48, color: teal[700], fontSize: 13, fontWeight: 600 }}>
                    <Loader2 size={16} className="animate-spin" /> Loading price…
                  </div>
                )}
                {!building && buildError && (
                  <div style={{ padding: 16, fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, lineHeight: 1.5 }}>{buildError}</div>
                )}
                {!building && !buildError && !cardData && (
                  <div style={{ textAlign: 'center', padding: 48, border: `2px dashed ${teal[100]}`, borderRadius: 12, background: paper }}>
                    <ImageIcon size={28} style={{ margin: '0 auto 10', color: teal[200] }} />
                    <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>No preview yet</p>
                    <p style={{ fontSize: 11.5, color: inkSoft, margin: '6px 0 0' }}>Add a product to see the customer-facing image.</p>
                  </div>
                )}
                {cardData && (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: 540 * PREVIEW_SCALE, height: 675 * PREVIEW_SCALE, overflow: 'hidden', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.18)', background: '#fff', flexShrink: 0 }}>
                      <div style={{ width: 540, height: 675, transform: `scale(${PREVIEW_SCALE})`, transformOrigin: 'top left' }}>
                        <PriceCardView data={cardData} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {cardData && (
                <div style={{ fontSize: 11, color: inkSoft, marginTop: 8, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
                  {cardData.reference} • exports at 1080 × 1350 PNG
                </div>
              )}
            </div>
          </div>

          {/* Hidden natural-size render used ONLY for pixel-accurate capture. */}
          <div aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0, pointerEvents: 'none' }}>
            {cardData ? <PriceCardView data={cardData} cardRef={captureRef} /> : <div ref={captureRef} />}
          </div>
        </div>

        {/* Footer — Add Customer language: amber-dot hint + ghost/gradient actions */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 14, padding: '16px 28px',
          borderTop: `1px solid ${hairline}`, background: paper, flexShrink: 0, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: inkSoft, minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: amber[500], flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{footerHint}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose}
              style={btnGhostStyle}
              onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
              Cancel
            </button>
            {imageBlob && (
              <button type="button" onClick={handleDownload}
                style={btnGhostStyle}
                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                <Download size={14} /> Download
              </button>
            )}
            {imageBlob ? (
              <button type="button" onClick={handleShare}
                style={btnPrimaryStyle}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 20px -6px rgba(15,84,76,.65)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(15,84,76,.55)'; }}>
                <Share2 size={14} /> {canNativeShare ? 'Share' : 'Share / Save'} <ChevronRight size={14} />
              </button>
            ) : (
              <button type="button" onClick={handleGenerate} disabled={!cardData || generating}
                style={{ ...btnPrimaryStyle, opacity: !cardData || generating ? 0.6 : 1, cursor: !cardData || generating ? 'not-allowed' : 'pointer' }}
                onMouseEnter={e => { if (cardData && !generating) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 20px -6px rgba(15,84,76,.65)'; } }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(15,84,76,.55)'; }}>
                {generating ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                {generating ? 'Generating…' : 'Generate Image'} <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
