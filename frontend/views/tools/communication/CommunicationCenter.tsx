/**
 * CommunicationCenter.tsx — ERP-aware Customer Communication Center.
 *
 * Workflow: Customer → Purpose → ERP facts → AI draft → Validation →
 * Preview → Human approval → Send → Audit history.
 *
 * Reuses: useSales/useFinance customers+invoices, useAuth companyConfig,
 * customerDisplay (businessName canonical), communication/* services
 * (context builder, AI, validation, send, history). No duplicate ledger,
 * document, verification, or AI logic.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { useVoiceDictation } from '../../../hooks/useVoiceDictation';
import { useSales } from '../../../context/SalesContext';
import { useFinance } from '../../../context/FinanceContext';
import { useAuth } from '../../../context/AuthContext';
import { getCustomerDisplayName, getCustomerOptionLabel } from '../../../utils/customerDisplay';
import {
  COMMUNICATION_PURPOSES,
  CHANNEL_CAPABILITIES,
  type CommunicationChannel,
  type CommunicationContext,
  type CommunicationLength,
  type CommunicationPurposeId,
  type CommunicationTone,
  type FactValidationResult,
} from '../../../services/communication/communicationTypes';
import {
  buildCommunicationContext,
  diffFinancialFacts,
  formatMoney,
  revalidateCommunicationContext,
} from '../../../services/communication/communicationContextBuilder';
import { generateCommunicationDraft } from '../../../services/communication/communicationAIService';
import { validateDraftAgainstFacts } from '../../../services/communication/communicationValidation';
import { sendCommunication } from '../../../services/communication/communicationSendService';
import { isInvoicePurpose } from '../../../services/communication/invoiceAttachmentService';
import { createGenerationGuard } from '../../../services/communication/communicationGeneration';
import {
  findRecentInvoiceSend,
  getCustomerHistory,
  recordCommunication,
} from '../../../services/communication/communicationHistoryService';
import type { CommunicationHistoryRecord } from '../../../services/communication/communicationTypes';

type Stage = 'select' | 'context' | 'draft' | 'preview' | 'sent';

const TONES: CommunicationTone[] = ['professional', 'friendly', 'formal', 'warm', 'concise'];
const LENGTHS: CommunicationLength[] = ['short', 'standard', 'detailed'];
const CHANNELS: CommunicationChannel[] = ['whatsapp', 'sms', 'email'];

const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const teal = '#1f8577';
const tealDark = '#0f544c';
const tealBg = '#eef7f6';
const amberBg = '#fbead0';
const danger = '#b5493f';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', background: '#fff', border: `1.4px solid ${hairline}`,
  borderRadius: 8, fontSize: 13, color: ink, outline: 'none', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4, display: 'block',
};
const btnPrimary: React.CSSProperties = {
  padding: '8px 14px', background: `linear-gradient(135deg, ${teal}, ${tealDark})`, color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  padding: '8px 14px', background: paper, color: ink, border: `1.4px solid ${hairline}`,
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

function quickOutstanding(customerId: string, customerName: string, invoices: unknown[]): number {
  return (invoices as Array<{ customerId?: string; customerName?: string; status?: string; totalAmount?: number; paidAmount?: number }>)
    .filter((i) => (i.customerId === customerId || (customerName && i.customerName === customerName)) && i.status !== 'Paid' && i.status !== 'Cancelled')
    .reduce((s, i) => s + ((i.totalAmount || 0) - (i.paidAmount || 0)), 0);
}

const CommunicationCenter: React.FC = () => {
  const { customers } = useSales();
  const { invoices } = useFinance();
  const { notify, companyConfig } = useAuth();

  const [customerId, setCustomerId] = useState('');
  const [search, setSearch] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [purpose, setPurpose] = useState<CommunicationPurposeId>('payment_reminder');
  const [specificInvoiceId, setSpecificInvoiceId] = useState('');
  const [tone, setTone] = useState<CommunicationTone>('professional');
  const [length, setLength] = useState<CommunicationLength>('standard');
  const [channel, setChannel] = useState<CommunicationChannel>('whatsapp');
  const [customNote, setCustomNote] = useState('');

  const [ctx, setCtx] = useState<CommunicationContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [generatedDraft, setGeneratedDraft] = useState('');
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [validation, setValidation] = useState<FactValidationResult | null>(null);
  const [stage, setStage] = useState<Stage>('select');

  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState<string[] | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<CommunicationHistoryRecord | null>(null);
  const [history, setHistory] = useState<CommunicationHistoryRecord[]>([]);
  const [confirmingSend, setConfirmingSend] = useState(false);

  // Voice dictation (browser-native, same mechanism as AICopilot voice input).
  // Dictated text flows through the normal edit path, so validation +
  // revalidation still apply before anything can send.
  const draftRef = useRef('');
  draftRef.current = draft;
  // Generation identity: a late AI response for a superseded customer /
  // purpose / context must never overwrite the operator's current work.
  const generationGuardRef = useRef(createGenerationGuard());
  const ctxRef = useRef<CommunicationContext | null>(null);
  ctxRef.current = ctx;
  const noteVoice = useVoiceDictation((t) => setCustomNote((prev) => (prev ? `${prev} ${t}` : t)));
  const draftVoice = useVoiceDictation((t) => {
    const base = draftRef.current;
    handleEdit(base ? `${base} ${t}` : t);
  });

  const customer = useMemo(
    () => (customers as Array<{ id: string }>).find((c) => String(c.id) === String(customerId)) as Record<string, unknown> | undefined,
    [customers, customerId],
  );

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (customers || []) as Array<Record<string, unknown>>;
    if (!q) return list.slice(0, 30);
    return list.filter((c) =>
      getCustomerDisplayName({ businessName: c.businessName as string, companyName: c.companyName as string, legacyCustomerName: c.name as string }).toLowerCase().includes(q) ||
      String(c.phone || '').toLowerCase().includes(q) ||
      String(c.email || '').toLowerCase().includes(q),
    ).slice(0, 30);
  }, [customers, search]);

  const customerInvoices = useMemo(() => {
    if (!customer) return [];
    const displayName = getCustomerDisplayName({
      businessName: customer.businessName as string, companyName: customer.companyName as string, legacyCustomerName: customer.name as string,
    });
    return ((invoices || []) as Array<Record<string, unknown>>).filter((i) =>
      String(i.customerId || '') === String(customerId) ||
      (displayName && String(i.customerName || '').toLowerCase() === displayName.toLowerCase()),
    );
  }, [customer, customerId, invoices]);

  const currency = companyConfig?.currencySymbol || 'K';

  // Load ERP context whenever customer/purpose/invoice changes.
  // Customer or purpose change invalidates EVERYTHING downstream: previous
  // ERP facts, AI draft, validation, attachment selection, verification URL
  // and any purpose-specific send payload. The next generation rebuilds from
  // the new customer + new purpose (never relabels old context).
  useEffect(() => {
    if (!customerId) {
      setCtx(null);
      setStage('select');
      return;
    }
    // Invalidate synchronously so no stale draft/preview can send meanwhile.
    setDraft('');
    setGeneratedDraft('');
    setAiGenerated(false);
    setAiWarning(null);
    setValidation(null);
    setSendResult(null);
    setConfirmingSend(false);
    setDuplicateWarning(null);
    setStaleWarning(null);
    let cancelled = false;
    setCtxLoading(true);
    setCtxError(null);
    setStaleWarning(null);
    buildCommunicationContext(purpose, customerId, { invoiceId: specificInvoiceId || null })
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        setStage('context');
        setValidation(null);
        getCustomerHistory(customerId, 20).then(setHistory).catch(() => setHistory([]));
      })
      .catch((e) => {
        if (cancelled) return;
        setCtxError(e instanceof Error ? e.message : 'Failed to load ERP context.');
        setCtx(null);
      })
      .finally(() => {
        if (!cancelled) setCtxLoading(false);
      });
    return () => { cancelled = true; };
  }, [customerId, purpose, specificInvoiceId]);

  // Duplicate-send warning for invoice purposes.
  useEffect(() => {
    const focalId = ctx?.specificInvoice?.id || (ctx?.purpose === 'send_latest_invoice' ? ctx?.latestInvoice?.id : null);
    if (!ctx || !focalId) {
      setDuplicateWarning(null);
      return;
    }
    findRecentInvoiceSend(ctx.customer.id, focalId).then(setDuplicateWarning).catch(() => setDuplicateWarning(null));
  }, [ctx]);

  const handleGenerate = async () => {
    if (!ctx) return;
    // Capture generation identity BEFORE the async call: a response that
    // arrives after the customer/purpose/context moved on is discarded.
    const token = generationGuardRef.current.next(ctx.customer.id, ctx.purpose, ctx.contextVersion);
    const requestCtx = ctx;
    setGenerating(true);
    setAiWarning(null);
    try {
      const res = await generateCommunicationDraft(requestCtx, { tone, length, customNote: customNote.trim() || undefined });
      const current = ctxRef.current;
      if (!generationGuardRef.current.isCurrent(token)) return;
      if (!current || current.snapshotId !== requestCtx.snapshotId) return;
      setDraft(res.text);
      setGeneratedDraft(res.text);
      setAiGenerated(res.aiGenerated);
      setAiWarning(res.warning);
      setValidation(validateDraftAgainstFacts(res.text, current));
      setStage('draft');
    } finally {
      const current = ctxRef.current;
      if (generationGuardRef.current.isCurrent(token) && current && current.snapshotId === requestCtx.snapshotId) {
        setGenerating(false);
      }
    }
  };

  const handleEdit = (value: string) => {
    setDraft(value);
    if (ctx) setValidation(validateDraftAgainstFacts(value, ctx));
    if (stage === 'draft' || stage === 'preview') setStage('preview');
  };

  const handleSend = async () => {
    if (!ctx || !customer) return;
    // Last-moment revalidation: re-fetch ERP facts before transmission.
    setSending(true);
    setSendResult(null);
    try {
      const fresh = await revalidateCommunicationContext(purpose, customerId, { invoiceId: specificInvoiceId || null });
      const diff = diffFinancialFacts(ctx, fresh);
      if (diff.changed) {
        setCtx(fresh);
        setStaleWarning(diff.messages);
        setValidation(validateDraftAgainstFacts(draft, fresh));
        setSending(false);
        setConfirmingSend(false);
        notify('ERP facts changed since generation — review updated facts before sending.', 'warning');
        return;
      }
      const check = validateDraftAgainstFacts(draft, fresh);
      setValidation(check);
      if (!check.ok) {
        setSending(false);
        setConfirmingSend(false);
        notify('Validation failed — fix the mismatches before sending.', 'error');
        return;
      }
      const focal = fresh.specificInvoice || fresh.latestInvoice;
      // Invoice linkage is recorded ONLY for invoice purposes — a receipt /
      // quotation / order / delivery send must never inherit invoice identity,
      // attachment flags, or verification URLs from incidental invoice data.
      const invoicePurpose = isInvoicePurpose(purpose);
      // sendCommunication re-validates the EXACT final payload at the boundary,
      // so an edited message can never bypass validation.
      const res = await sendCommunication({
        channel,
        recipientPhone: fresh.customer.phone,
        recipientEmail: fresh.customer.email,
        message: draft.trim(),
        ctx: fresh,
      });
      // Audit records the EXACT final message transmitted (post-edit), the
      // original AI draft, the honest provider status and attachment truth.
      await recordCommunication({
        customerId: fresh.customer.id,
        businessName: fresh.customer.businessName,
        purpose,
        channel,
        tone,
        aiDraft: generatedDraft,
        finalMessage: draft.trim(),
        invoiceId: invoicePurpose ? focal?.id || null : null,
        invoiceNumber: invoicePurpose ? focal?.invoiceNumber || null : null,
        verificationUrl: invoicePurpose ? focal?.verificationUrl || null : null,
        hadAttachment: res.attachmentIncluded,
        attachmentFilename: res.attachmentFilename,
        attachmentIncluded: res.attachmentIncluded,
        status: res.status,
        failureReason: res.ok ? null : res.detail,
        providerMessageId: res.providerMessageId,
        aiGenerated,
        snapshotId: fresh.snapshotId,
        factsSnapshot: JSON.stringify({
          outstandingBalance: fresh.outstandingBalance,
          invoice: invoicePurpose && focal ? { id: focal.id, number: focal.invoiceNumber, total: focal.total, paid: focal.paid, outstanding: focal.outstanding } : null,
          verificationUrl: invoicePurpose ? focal?.verificationUrl || null : null,
          payment: fresh.lastPayment ? { id: fresh.lastPayment.id, receiptNumber: fresh.lastPayment.receiptNumber, amount: fresh.lastPayment.amount, allocatedInvoices: fresh.lastPayment.allocatedInvoiceNumbers } : null,
          quotation: fresh.quotation ? { id: fresh.quotation.id, number: fresh.quotation.number, total: fresh.quotation.total } : null,
          order: fresh.order ? { id: fresh.order.id, number: fresh.order.number, total: fresh.order.total, status: fresh.order.status } : null,
          delivery: fresh.delivery ? { id: fresh.delivery.id, status: fresh.delivery.status } : null,
          fetchedAt: fresh.fetchedAt,
        }),
      });
      setSendResult(`[${res.status}] ${res.detail}`);
      notify(res.ok ? `Recorded (${res.status}).` : `Send failed: ${res.detail}`, res.ok ? 'success' : 'error');
      if (res.ok) {
        setStage('sent');
        getCustomerHistory(customerId, 20).then(setHistory).catch(() => undefined);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Send failed.';
      setSendResult(msg);
      notify(msg, 'error');
    } finally {
      setSending(false);
      setConfirmingSend(false);
    }
  };

  const focal = ctx?.specificInvoice || ctx?.latestInvoice || null;
  const purposeMeta = COMMUNICATION_PURPOSES.find((p) => p.id === purpose);
  const needsInvoiceChoice = purpose === 'send_specific_invoice' || purpose === 'payment_confirmation';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#FBF8F2' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Step 1: customer + purpose */}
        <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <span style={labelStyle}>1 · Select customer</span>
              {customer ? (
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getCustomerOptionLabel(customer as { id?: string | null; name?: string | null; businessName?: string | null; companyName?: string | null })}
                    </div>
                    <div style={{ fontSize: 11, color: inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[String(customer.contactName || ''), String(customer.phone || ''), String(customer.email || '')].filter(Boolean).join(' · ') || 'No contact details'}
                      {' · '}
                      <span style={{ fontWeight: 700, color: quickOutstanding(String(customer.id), getCustomerDisplayName({ businessName: customer.businessName as string, companyName: customer.companyName as string, legacyCustomerName: customer.name as string }), (invoices || []) as unknown[]) > 0 ? danger : teal }}>
                        {currency}{quickOutstanding(String(customer.id), getCustomerDisplayName({ businessName: customer.businessName as string, companyName: customer.companyName as string, legacyCustomerName: customer.name as string }), (invoices || []) as unknown[]).toLocaleString()} {quickOutstanding(String(customer.id), getCustomerDisplayName({ businessName: customer.businessName as string, companyName: customer.companyName as string, legacyCustomerName: customer.name as string }), (invoices || []) as unknown[]) > 0 ? 'outstanding' : 'settled'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => { setCustomerId(''); setSpecificInvoiceId(''); setDraft(''); setGeneratedDraft(''); setSendResult(null); setSearch(''); }} style={{ ...btnGhost, padding: '6px 10px', flexShrink: 0 }}>Change</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }} onBlur={() => setTimeout(() => setCustomerDropdownOpen(false), 150)}>
                  <input
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setCustomerDropdownOpen(true); }}
                    onFocus={() => setCustomerDropdownOpen(true)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setCustomerDropdownOpen(false); }}
                    placeholder="Search by business name, phone, email…"
                    style={inputStyle}
                    aria-label="Search customers"
                  />
                  {customerDropdownOpen && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, maxHeight: 240, overflow: 'auto', background: '#fff', border: `1.4px solid ${hairline}`, borderRadius: 8, boxShadow: '0 12px 28px rgba(0,0,0,0.12)' }}>
                      {filteredCustomers.length === 0 && (
                        <div style={{ padding: 12, fontSize: 12, color: inkSoft }}>No customers found.</div>
                      )}
                      {filteredCustomers.map((c) => {
                        const id = String(c.id);
                        const name = getCustomerOptionLabel(c as { id?: string | null; name?: string | null; businessName?: string | null; companyName?: string | null });
                        const debt = quickOutstanding(id, getCustomerDisplayName({ businessName: c.businessName as string, companyName: c.companyName as string, legacyCustomerName: c.name as string }), (invoices || []) as unknown[]);
                        return (
                          <button
                            key={id}
                            onClick={() => { setCustomerId(id); setSpecificInvoiceId(''); setDraft(''); setGeneratedDraft(''); setSendResult(null); setSearch(''); setCustomerDropdownOpen(false); }}
                            style={{
                              width: '100%', textAlign: 'left', padding: '7px 10px', cursor: 'pointer',
                              background: 'transparent', border: 'none', borderBottom: `1px solid ${hairline}`,
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = tealBg}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: debt > 0 ? danger : teal, flexShrink: 0 }}>
                                {currency}{debt.toLocaleString()} {debt > 0 ? 'outstanding' : 'settled'}
                              </div>
                            </div>
                            <div style={{ fontSize: 11, color: inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {[String(c.contactName || ''), String(c.phone || ''), String(c.email || '')].filter(Boolean).join(' · ') || 'No contact details'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <span style={labelStyle}>2 · Communication purpose</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {COMMUNICATION_PURPOSES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setPurpose(p.id); setSpecificInvoiceId(''); setDraft(''); setGeneratedDraft(''); setSendResult(null); }}
                    title={p.description}
                    style={{
                      padding: '7px 8px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
                      background: purpose === p.id ? teal : '#fff', color: purpose === p.id ? '#fff' : ink,
                      border: `1.4px solid ${purpose === p.id ? teal : hairline}`,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                <div>
                  <span style={labelStyle}>Tone</span>
                  <select value={tone} onChange={(e) => setTone(e.target.value as CommunicationTone)} style={inputStyle}>
                    {TONES.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Length</span>
                  <select value={length} onChange={(e) => setLength(e.target.value as CommunicationLength)} style={inputStyle}>
                    {LENGTHS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Channel</span>
                  <select value={channel} onChange={(e) => setChannel(e.target.value as CommunicationChannel)} style={inputStyle}>
                    {CHANNELS.map((x) => <option key={x} value={x}>{CHANNEL_CAPABILITIES[x].label}</option>)}
                  </select>
                </div>
              </div>
              {purpose === 'custom' && (
                <div style={{ marginTop: 8 }}>
                  <span style={labelStyle}>Custom note (what is this about? — type or dictate)</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                    <input value={customNote} onChange={(e) => setCustomNote(e.target.value)} placeholder="e.g. Price list update for schools" style={{ ...inputStyle, flex: 1 }} aria-label="Custom message note" />
                    <button
                      onClick={noteVoice.toggle}
                      title={noteVoice.supported ? (noteVoice.listening ? 'Stop dictation' : 'Dictate the note by voice') : 'Voice input — check support'}
                      aria-label="Dictate custom note by voice"
                      style={{ ...btnGhost, padding: '7px 10px', flexShrink: 0, borderColor: noteVoice.listening ? danger : hairline, color: noteVoice.listening ? danger : ink }}
                    >
                      <Mic size={15} />
                    </button>
                  </div>
                  {noteVoice.listening && <div style={{ fontSize: 11, color: danger, marginTop: 4 }}>Listening… speak now, or press the mic again to stop.</div>}
                  {noteVoice.error && <div style={{ fontSize: 11, color: inkSoft, marginTop: 4 }}>{noteVoice.error}</div>}
                </div>
              )}
              {needsInvoiceChoice && (
                <div style={{ marginTop: 8 }}>
                  <span style={labelStyle}>Specific invoice</span>
                  <select value={specificInvoiceId} onChange={(e) => setSpecificInvoiceId(e.target.value)} style={inputStyle}>
                    <option value="">Select invoice…</option>
                    {customerInvoices.map((i) => (
                      <option key={String(i.id)} value={String(i.id)}>
                        {String(i.invoiceNumber || i.id)} · K{Number(i.totalAmount || 0).toLocaleString()} · {String(i.status || '')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Step 2: ERP context */}
        <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
          <span style={labelStyle}>3 · ERP facts (authoritative — AI cannot change these)</span>
          {!customerId && <div style={{ fontSize: 13, color: inkSoft }}>Select a customer to load ERP context.</div>}
          {ctxLoading && <div style={{ fontSize: 13, color: inkSoft }}>Loading ERP facts…</div>}
          {ctxError && <div style={{ fontSize: 13, color: danger }}>{ctxError}</div>}
          {ctx && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 12 }}>
              <div style={{ background: tealBg, borderRadius: 8, padding: 8 }}>
                <div style={{ fontWeight: 700, color: ink }}>{ctx.customer.businessName}</div>
                <div style={{ color: inkSoft }}>{[ctx.customer.contactName, ctx.customer.phone, ctx.customer.email].filter(Boolean).join(' · ') || 'No contact details'}</div>
                {(purpose === 'payment_reminder' || purpose === 'outstanding_balance' || purpose === 'send_latest_invoice' || purpose === 'send_specific_invoice') && (
                  <div style={{ marginTop: 4, fontWeight: 700 }}>Outstanding: {formatMoney(ctx.outstandingBalance)}</div>
                )}
              </div>
              <div style={{ background: '#fff', border: `1px solid ${hairline}`, borderRadius: 8, padding: 8 }}>
                {isInvoicePurpose(purpose) ? (
                  focal ? (
                    <>
                      <div style={{ fontWeight: 700, color: ink }}>Invoice {focal.invoiceNumber} found</div>
                      <div style={{ color: inkSoft }}>Date: {focal.date ? new Date(focal.date).toLocaleDateString() : '—'} · Due: {focal.dueDate ? new Date(focal.dueDate).toLocaleDateString() : '—'}</div>
                      <div>Total {formatMoney(focal.total)} · Paid {formatMoney(focal.paid)} · Outstanding {formatMoney(focal.outstanding)}</div>
                      <div style={{ marginTop: 4, wordBreak: 'break-all' }}>
                        Verification: {focal.verificationUrl ? <a href={focal.verificationUrl} target="_blank" rel="noreferrer">{focal.verificationUrl}</a> : 'unavailable — will not guess a link'}
                      </div>
                      <div>Attachment: actual ERP invoice document (PDF via document viewer)</div>
                    </>
                  ) : (
                    <div style={{ color: inkSoft }}>
                      {purposeMeta?.requiresInvoice ? 'No invoice available for this customer.' : 'No focal invoice for this purpose.'}
                    </div>
                  )
                ) : ctx.lastPayment ? (
                  <>
                    <div style={{ fontWeight: 700, color: ink }}>Receipt {ctx.lastPayment.receiptNumber} found</div>
                    <div style={{ color: inkSoft }}>Date: {ctx.lastPayment.date ? new Date(ctx.lastPayment.date).toLocaleDateString() : '—'}{ctx.lastPayment.method ? ` · via ${ctx.lastPayment.method}` : ''}</div>
                    <div>Amount {formatMoney(ctx.lastPayment.amount)}{ctx.lastPayment.allocatedInvoiceNumbers.length > 0 ? ` · Allocated to ${ctx.lastPayment.allocatedInvoiceNumbers.join(', ')}` : ''}</div>
                    {ctx.lastPayment.remainingBalance !== null && (
                      <div>Remaining balance {formatMoney(ctx.lastPayment.remainingBalance)}</div>
                    )}
                  </>
                ) : ctx.quotation ? (
                  <>
                    <div style={{ fontWeight: 700, color: ink }}>Quotation {ctx.quotation.number} found</div>
                    <div style={{ color: inkSoft }}>Date: {ctx.quotation.date ? new Date(ctx.quotation.date).toLocaleDateString() : '—'} · Status: {ctx.quotation.status || '—'}{ctx.quotation.validUntil ? ` · Valid until ${new Date(ctx.quotation.validUntil).toLocaleDateString()}` : ''}</div>
                    <div>Total {formatMoney(ctx.quotation.total)}</div>
                    {ctx.quotation.items.length > 0 && (
                      <div style={{ color: inkSoft }}>{ctx.quotation.items.map((it) => `${it.name} × ${it.quantity}`).join('; ')}</div>
                    )}
                  </>
                ) : ctx.order ? (
                  <>
                    <div style={{ fontWeight: 700, color: ink }}>Sales order {ctx.order.number} found</div>
                    <div style={{ color: inkSoft }}>Date: {ctx.order.date ? new Date(ctx.order.date).toLocaleDateString() : '—'} · Status: {ctx.order.status || '—'}</div>
                    <div>Total {formatMoney(ctx.order.total)}</div>
                    {ctx.delivery && (
                      <div style={{ marginTop: 4 }}>Delivery {ctx.delivery.id} · {ctx.delivery.status}{ctx.delivery.trackingNumber ? ` · Tracking ${ctx.delivery.trackingNumber}` : ''}</div>
                    )}
                  </>
                ) : ctx.delivery ? (
                  <>
                    <div style={{ fontWeight: 700, color: ink }}>Delivery {ctx.delivery.id} found</div>
                    <div>Status: {ctx.delivery.status || '—'}{ctx.delivery.trackingNumber ? ` · Tracking ${ctx.delivery.trackingNumber}` : ''}</div>
                  </>
                ) : (
                  <div style={{ color: inkSoft }}>
                    {purposeMeta?.requiresInvoice ? 'No invoice available for this customer.' : 'No focal document for this purpose.'}
                  </div>
                )}
                {ctx.company.paymentMethodsSummary && (
                  <div style={{ marginTop: 4 }}>Payment: {ctx.company.paymentMethodsSummary}</div>
                )}
              </div>
              <div style={{ background: '#fff', border: `1px solid ${hairline}`, borderRadius: 8, padding: 8 }}>
                <div style={{ fontWeight: 700, color: ink }}>Channel: {CHANNEL_CAPABILITIES[channel].label}</div>
                <div style={{ color: inkSoft }}>{CHANNEL_CAPABILITIES[channel].note}</div>
                {ctx.warnings.length > 0 && (
                  <div style={{ marginTop: 6, background: amberBg, borderRadius: 6, padding: 6 }}>
                    {ctx.warnings.map((w) => <div key={w} style={{ fontSize: 12 }}>• {w}</div>)}
                  </div>
                )}
              </div>
            </div>
          )}
          {duplicateWarning && (
            <div style={{ marginTop: 8, background: amberBg, borderRadius: 8, padding: 8, fontSize: 12 }}>
              This invoice ({duplicateWarning.purpose}, {duplicateWarning.invoiceNumber || 'no number'}) was already {duplicateWarning.status} to this customer via {duplicateWarning.channel} on {new Date(duplicateWarning.createdAt).toLocaleString()}{duplicateWarning.operator ? ` by ${duplicateWarning.operator}` : ''}. Resending is allowed but confirm it is intentional.
            </div>
          )}
          {staleWarning && (
            <div style={{ marginTop: 8, background: '#fde8e6', borderRadius: 8, padding: 8, fontSize: 12, color: danger }}>
              ERP facts changed before sending:
              {staleWarning.map((m) => <div key={m}>• {m}</div>)}
              <div>Review the refreshed facts and regenerate or edit the message, then send again.</div>
            </div>
          )}
        </div>

        {/* Step 3: generate / preview / validate / send */}
        <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
          <span style={labelStyle}>4 · Generate → preview → validate → send (generate never sends)</span>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button onClick={handleGenerate} disabled={!ctx || generating || ctxLoading} style={{ ...btnPrimary, opacity: !ctx || generating ? 0.5 : 1 }}>
              {generating ? 'Generating…' : draft ? 'Regenerate' : 'Generate message'}
            </button>
            {draft && <button onClick={() => setStage('preview')} style={btnGhost}>Preview</button>}
          </div>
          {aiWarning && <div style={{ fontSize: 12, color: inkSoft, marginBottom: 6 }}>{aiWarning}</div>}
          {draft && (
            <>
              <span style={labelStyle}>Preview (editable — {aiGenerated ? 'AI draft' : 'ERP template'}) · {purposeMeta?.label} · {tone} · {channel}</span>
              <textarea
                value={draft}
                onChange={(e) => handleEdit(e.target.value)}
                rows={6}
                style={{ ...inputStyle, minHeight: 120, lineHeight: 1.5, fontFamily: 'inherit' }}
                aria-label="Message preview editor"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <button
                  onClick={draftVoice.toggle}
                  title={draftVoice.supported ? (draftVoice.listening ? 'Stop dictation' : 'Dictate into the message by voice') : 'Voice input — check support'}
                  aria-label="Dictate into the message by voice"
                  style={{ ...btnGhost, padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: draftVoice.listening ? danger : hairline, color: draftVoice.listening ? danger : ink }}
                >
                  <Mic size={14} /> {draftVoice.listening ? 'Listening… press to stop' : 'Dictate'}
                </button>
                {draftVoice.error && <span style={{ fontSize: 11, color: inkSoft }}>{draftVoice.error}</span>}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, padding: 8, borderRadius: 8, background: validation?.ok ? tealBg : '#fde8e6', color: validation?.ok ? ink : danger }}>
                {validation?.ok ? 'Facts validated against ERP context.' : (validation?.issues || []).map((i) => <div key={i.code + i.message}>• {i.message}</div>)}
              </div>
              {isInvoicePurpose(purpose) && focal && (
                <div style={{ marginTop: 8, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>Document: invoice {focal.invoiceNumber} (official ERP document)</span>
                    {focal.verificationUrl && <a href={focal.verificationUrl} target="_blank" rel="noreferrer">Verification link</a>}
                  </div>
                  <div style={{ color: channel === 'email' ? teal : inkSoft }}>
                    {channel === 'email'
                      ? 'On send, the official invoice PDF is rendered server-side and attached to the SMTP payload — "attached" is reported only then.'
                      : CHANNEL_CAPABILITIES[channel].attachmentBehavior}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {!confirmingSend ? (
                  <button onClick={() => setConfirmingSend(true)} disabled={!validation?.ok || sending} style={{ ...btnPrimary, opacity: !validation?.ok || sending ? 0.5 : 1 }}>
                    Send via {CHANNEL_CAPABILITIES[channel].label}
                  </button>
                ) : (
                  <>
                    <button onClick={handleSend} disabled={sending} style={{ ...btnPrimary, opacity: sending ? 0.5 : 1 }}>
                      {sending ? 'Sending…' : `Confirm send to ${ctx?.customer.businessName}?`}
                    </button>
                    <button onClick={() => setConfirmingSend(false)} disabled={sending} style={btnGhost}>Cancel</button>
                  </>
                )}
                <button
                  onClick={() => { navigator.clipboard?.writeText(draft).then(() => notify('Message copied.', 'success')).catch(() => undefined); }}
                  style={btnGhost}
                >
                  Copy
                </button>
              </div>
              {sendResult && <div style={{ marginTop: 8, fontSize: 12, color: inkSoft }}>{sendResult}</div>}
              {stage === 'sent' && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: teal }}>Recorded in communication history below.</div>}
            </>
          )}
        </div>

        {/* Step 4: history */}
        <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
          <span style={labelStyle}>5 · Communication history {customer ? `— ${getCustomerOptionLabel(customer as { id?: string | null; name?: string | null; businessName?: string | null; companyName?: string | null })}` : ''}</span>
          {history.length === 0 ? (
            <div style={{ fontSize: 12, color: inkSoft }}>No communications recorded for this customer yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
              {history.map((h) => (
                <div key={h.id} style={{ border: `1px solid ${hairline}`, borderRadius: 8, padding: 8, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{h.purpose}</strong>
                    <span style={{ color: h.status === 'sent' || h.status === 'submitted' || h.status === 'delivered' ? teal : danger }}>{h.status}</span>
                  </div>
                  <div style={{ color: inkSoft }}>{new Date(h.createdAt).toLocaleString()} · {h.channel} · {h.aiGenerated ? 'AI draft' : 'manual'} · {h.operator || 'operator'}{h.providerMessageId ? ` · ${h.providerMessageId}` : ''}</div>
                  <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{h.finalMessage}</div>
                  {h.invoiceNumber && <div style={{ color: inkSoft }}>Invoice: {h.invoiceNumber}{h.attachmentIncluded ? ` · attached (${h.attachmentFilename || 'PDF'})` : ' · no attachment in payload'}{h.verificationUrl ? ` · ${h.verificationUrl}` : ''}</div>}
                  {h.failureReason && <div style={{ color: danger }}>Reason: {h.failureReason}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommunicationCenter;
