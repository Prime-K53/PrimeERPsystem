import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/Dialog';
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

/**
 * PriceCardModal — fast "price asked → professional image" workflow (ERP only).
 *
 * Product → optional quantity / customer → live preview → Generate Image →
 * Download / native Share (Android share sheet → WhatsApp).
 *
 * Informational only: previewing and generating never write sales,
 * quotations, orders, invoices, payments, ledger, stock, or balances.
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

  return (
    <Dialog open={open} onClose={onClose} title="Price Card">
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Price Card</DialogTitle>
        </DialogHeader>
        <p style={{ fontSize: 12.5, color: '#5c6567', margin: '0 0 14px' }}>
          Professional price image for customers — informational only. Never creates a sale, quotation, or invoice.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
          {/* ── controls ── */}
          <div style={{ minWidth: 0 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Products ({lines.length}/{PRICE_CARD_MAX_LINES})
            </label>
            <div style={{ position: 'relative', marginTop: 6 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#94a3b8' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, SKU, category…"
                disabled={lines.length >= PRICE_CARD_MAX_LINES}
                style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #e4ddd1', borderRadius: 9, fontSize: 13, outline: 'none', background: '#fff' }}
              />
              {results.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e4ddd1', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.12)', overflow: 'hidden' }}>
                  {results.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addItem(item)}
                      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <Tag size={13} style={{ color: '#0f544c', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#23282a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
                        <span style={{ display: 'block', fontSize: 11, color: '#8a9494' }}>{item.sku || item.category || ''}</span>
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f544c', whiteSpace: 'nowrap' }}>
                        {formatPriceCardAmount(resolveStoredSellingPrice(item as any), currency)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {lines.map((line) => {
                const variants = Array.isArray(line.item.variants) ? line.item.variants : [];
                return (
                  <div key={line.key} style={{ border: '1px solid #e4ddd1', borderRadius: 10, padding: '8px 10px', background: '#FEFDFB' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#23282a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.item.name}</div>
                        <div style={{ fontSize: 11, color: '#8a9494' }}>{line.item.sku || line.item.unit || ''}</div>
                      </div>
                      <button type="button" onClick={() => removeLine(line.key)} title="Remove" aria-label="Remove product" style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', padding: 4 }}>
                        <X size={14} />
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      {variants.length > 0 && (
                        <select
                          value={line.variantId ?? ''}
                          onChange={(e) => updateLine(line.key, { variantId: e.target.value || undefined })}
                          style={{ flex: 1, minWidth: 120, padding: '6px 8px', border: '1px solid #e4ddd1', borderRadius: 8, fontSize: 12.5, background: '#fff' }}
                        >
                          <option value="">Standard</option>
                          {variants.map((v: any) => (
                            <option key={v.id} value={v.id}>{String(v.name ?? v.attribute ?? v.id)}</option>
                          ))}
                        </select>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11.5, color: '#5c6567' }}>Qty</span>
                        <button type="button" onClick={() => updateLine(line.key, { quantity: Math.max(1, line.quantity - 1) })} style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #e4ddd1', background: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Decrease quantity">
                          <Minus size={13} />
                        </button>
                        <span style={{ minWidth: 26, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{line.quantity}</span>
                        <button type="button" onClick={() => updateLine(line.key, { quantity: Math.min(999, line.quantity + 1) })} style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #e4ddd1', background: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Increase quantity">
                          <Plus size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {lines.length === 0 && (
                <div style={{ fontSize: 12.5, color: '#8a9494', border: '1px dashed #e4ddd1', borderRadius: 10, padding: '14px 12px', textAlign: 'center' }}>
                  Search and add up to {PRICE_CARD_MAX_LINES} products.
                </div>
              )}
            </div>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14 }}>
              Customer (optional)
            </label>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              style={{ width: '100%', marginTop: 6, padding: '8px 10px', border: '1px solid #e4ddd1', borderRadius: 9, fontSize: 13, background: '#fff' }}
            >
              <option value="">Walk-in — standard price</option>
              {customers.map((c) => {
                const { displayName } = resolveCustomerDisplay(c as any);
                return <option key={c.id} value={c.id}>{displayName || c.name || c.id}</option>;
              })}
            </select>
            {selectedCustomer && (
              <div style={{ fontSize: 11.5, color: '#8a9494', marginTop: 4 }}>
                Prepared for {resolveCustomerDisplay(selectedCustomer as any).displayName}. Tier pricing applies automatically when configured.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!cardData || generating}
                style={{
                  flex: 1, minWidth: 150, minHeight: 44, padding: '10px 16px', borderRadius: 10, border: 'none',
                  background: !cardData || generating ? '#cbd5e1' : 'linear-gradient(155deg, #1f8577, #0f544c)',
                  color: '#fff', fontSize: 14, fontWeight: 700, cursor: !cardData || generating ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {generating ? <Loader2 size={16} className="animate-spin" /> : null}
                {generating ? 'Generating…' : 'Generate Image'}
              </button>
            </div>
            {imageBlob && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleDownload}
                  style={{ flex: 1, minWidth: 130, minHeight: 44, padding: '10px 14px', borderRadius: 10, border: '1.4px solid #0f544c', background: '#fff', color: '#0f544c', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
                >
                  <Download size={15} /> Download
                </button>
                <button
                  type="button"
                  onClick={handleShare}
                  style={{ flex: 1, minWidth: 130, minHeight: 44, padding: '10px 14px', borderRadius: 10, border: '1.4px solid #e4ddd1', background: '#FEFDFB', color: '#23282a', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
                >
                  <Share2 size={15} /> {canNativeShare ? 'Share' : 'Share / Save'}
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              style={{ marginTop: 14, background: 'none', border: 'none', color: '#5c6567', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <History size={13} /> Recent price cards ({history.length})
            </button>
            {showHistory && (
              <div style={{ marginTop: 8, border: '1px solid #e4ddd1', borderRadius: 10, overflow: 'hidden' }}>
                {history.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#8a9494' }}>No price cards generated yet on this device.</div>}
                {history.slice(0, 10).map((h) => (
                  <div key={h.reference} style={{ padding: '8px 10px', borderBottom: '1px solid #f1ede4', fontSize: 12.5 }}>
                    <div style={{ fontWeight: 700, color: '#23282a' }}>{h.reference}</div>
                    <div style={{ color: '#5c6567', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.productNames.join(', ')}</div>
                    <div style={{ color: '#8a9494', fontSize: 11.5 }}>{formatPriceCardAmount(h.grandTotal, h.currency)} • {new Date(h.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── preview ── */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Preview
            </div>
            <div style={{ background: '#f1ede4', borderRadius: 12, padding: 12, overflow: 'hidden' }}>
              {building && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 40, color: '#5c6567', fontSize: 13 }}>
                  <Loader2 size={16} className="animate-spin" /> Loading price…
                </div>
              )}
              {!building && buildError && (
                <div style={{ padding: 24, fontSize: 13, color: '#b91c1c', background: '#fef2f2', borderRadius: 10, lineHeight: 1.5 }}>{buildError}</div>
              )}
              {!building && !buildError && !cardData && (
                <div style={{ padding: 40, fontSize: 13, color: '#8a9494', textAlign: 'center' }}>Add a product to see the preview.</div>
              )}
              {cardData && (
                <div style={{ overflow: 'hidden', borderRadius: 8, height: 675 * PREVIEW_SCALE, boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
                  <div style={{ transform: `scale(${PREVIEW_SCALE})`, transformOrigin: 'top left', width: 540, height: 675 }}>
                    <PriceCardView data={cardData} />
                  </div>
                </div>
              )}
            </div>
            {cardData && (
              <div style={{ fontSize: 11.5, color: '#8a9494', marginTop: 6, textAlign: 'center' }}>
                {cardData.reference} • exports at 1080 × 1350 PNG
              </div>
            )}
          </div>
        </div>

        {/* Hidden natural-size render used ONLY for pixel-accurate capture. */}
        <div aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0, pointerEvents: 'none' }}>
          {cardData ? <PriceCardView data={cardData} cardRef={captureRef} /> : <div ref={captureRef} />}
        </div>
      </DialogContent>
    </Dialog>
  );
};
