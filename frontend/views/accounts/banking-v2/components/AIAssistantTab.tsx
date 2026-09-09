/**
 * AI Banking Assistant Tab.
 *
 * Reuses the existing `aiService` (configured through Settings → Marketing
 * Messages → AI Settings). No new AI provider, no new API key storage, no
 * new auth — just a banking-specific context + question presets.
 *
 * Per the spec:
 *   - Read-only analysis
 *   - Every output is labelled "AI Suggestion"
 *   - AI can NEVER post / modify / delete / reconcile / reverse anything
 *   - User confirms via existing ERP actions
 */

import React, { useState, useMemo } from 'react';
import { Sparkles, Send, AlertCircle, Wand2 } from 'lucide-react';
import { aiService } from '../../../../services/aiService';
import { logger } from '../../../../services/logger';
import { roundFinancial } from '../../../../utils/helpers';

interface Props {
  accounts: any[];
  transactions: any[];
  reconciliations: any[];
  scheduledPayments: any[];
  currency: string;
  coaBalances: Record<string, number>;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  isAiSuggestion?: boolean;
}

const QUICK_PROMPTS = [
  { label: 'Current cash position?', prompt: 'What is our current cash position across all bank and cash accounts? Summarize balances and any concerns.' },
  { label: 'Unreconciled transactions?', prompt: 'List all unreconciled bank transactions grouped by account, with age in days.' },
  { label: 'Unusual transactions this month', prompt: 'Find unusual or atypical bank transactions this month: outliers in amount, unfamiliar counterparties, weekend postings, or duplicates.' },
  { label: 'Why does bank ≠ ledger?', prompt: 'Explain likely reasons the book balance and bank statement balance could differ for our active bank accounts.' },
  { label: 'Biggest withdrawals this month', prompt: 'What were our 10 biggest bank withdrawals this month? Include counterparty and purpose.' },
  { label: 'Total bank spend this month', prompt: 'How much did we spend through the bank in total this month? Break down by transaction type.' },
  { label: 'Supplier payments this week', prompt: 'Which suppliers received payments through the bank this week?' },
  { label: 'Upcoming scheduled payments', prompt: 'List upcoming scheduled bank payments due in the next 30 days, sorted by date.' },
  { label: 'Possible duplicates', prompt: 'Find possible duplicate bank transactions (same amount and date, similar description).' },
  { label: 'Missing account mappings', prompt: 'Identify bank transactions that may be missing counterparty account mappings (deposits with no income account, withdrawals with no expense account).' },
  { label: 'Reconciliation explanation', prompt: 'Explain what a bank reconciliation difference typically means and how to investigate it.' },
  { label: 'August summary', prompt: 'Summarize banking activity for the most recent complete month: inflows, outflows, net movement, top accounts.' },
];

const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const teal = { 50: '#eef7f6', 100: '#d4ebe3', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c' };

function maskAccountNumber(num: string): string {
  if (!num || num.length < 4) return num || '';
  return `••••${num.slice(-4)}`;
}

export const AIAssistantTab: React.FC<Props> = ({ accounts, transactions, reconciliations, scheduledPayments, currency }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ enabled: boolean; provider: string; model: string } | null>(null);

  React.useEffect(() => {
    aiService.getConfig().then((c) => setConfig({ enabled: c.enabled, provider: c.provider, model: c.model })).catch(() => setConfig({ enabled: false, provider: '—', model: '—' }));
  }, []);

  const context = useMemo(() => {
    const active = accounts.filter((a: any) => a.status === 'Active');
    const totalBank = active.reduce((s, a: any) => s + roundFinancial(a.balance || 0), 0);
    const unreconciled = transactions.filter((t) => !t.reconciled && t.status !== 'Draft' && t.status !== 'Reversed').length;
    const today = new Date().toISOString().slice(0, 10);
    const last30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const monthTxns = transactions.filter((t) => t.date >= last30 && t.date <= today && t.status !== 'Draft' && t.status !== 'Reversed');
    const monthIn = monthTxns.filter((t) => ['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
    const monthOut = monthTxns.filter((t) => !['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);

    return {
      asOf: today,
      accounts: active.map((a: any) => ({
        name: a.name,
        bank: a.bankName,
        accountNumberMasked: maskAccountNumber(a.accountNumber || ''),
        balance: roundFinancial(a.balance || 0),
        status: a.status,
      })),
      totals: { totalBankBalance: totalBank, unreconciledCount: unreconciled, monthInflows: monthIn, monthOutflows: monthOut, netMovement: monthIn - monthOut },
      recentTransactions: transactions.slice(0, 30).map((t: any) => ({
        date: t.date,
        type: t.type,
        amount: roundFinancial(t.amount),
        description: t.description,
        account: accounts.find((a: any) => a.id === t.bankAccountId)?.name || '—',
        reconciled: t.reconciled,
        status: t.status,
      })),
      scheduledDueIn30Days: scheduledPayments
        .filter((s) => s.status === 'Active' && s.nextPaymentDate <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
        .map((s) => ({ name: s.name, nextRun: s.nextPaymentDate, amount: roundFinancial(s.amount), counterparty: s.counterparty?.name || '' })),
      reconciliationHistoryCount: reconciliations.length,
    };
  }, [accounts, transactions, reconciliations, scheduledPayments]);

  const systemInstruction = `You are the AI Banking Assistant for Prime ERP. You operate in read-only analysis mode. You MUST NOT recommend, suggest, or take any financial action that posts, modifies, deletes, reconciles, or reverses a transaction. Always frame outputs as "AI Suggestion" — observations and explanations, not actions.

When asked about specific transactions, refer to them by date, account, and amount. When you identify anomalies, explain the heuristic used (e.g., "amount is more than 2 standard deviations above the account's 30-day mean"). When asked to explain reconciliations, cover: uncleared deposits/cheques, bank charges/interest not yet booked, timing differences, and posting errors.

Currency: ${currency}. Mask account numbers; never expose credentials or API keys.`;

  const ask = async (prompt: string) => {
    if (!prompt.trim()) return;
    setError(null);
    setLoading(true);
    const userMsg: Message = { role: 'user', content: prompt };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    try {
      const ctxStr = JSON.stringify(context, null, 2);
      const fullPrompt = `Banking context (read-only, masked):\n${ctxStr}\n\nUser question:\n${prompt}`;
      const reply = await aiService.generateAIResponse(fullPrompt, systemInstruction);
      setMessages((m) => [...m, { role: 'assistant', content: reply, isAiSuggestion: true }]);
    } catch (err) {
      logger.error('AI assistant failed', err);
      const errMsg = (err as Error).message || 'AI request failed';
      setError(errMsg);
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${errMsg}`, isAiSuggestion: true }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, color: ink, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={18} color={teal[600]} /> AI Banking Assistant
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft }}>
            Analysis only. Suggestions are clearly labelled and never post, modify, or reconcile financial transactions.
          </p>
        </div>
        {config && (
          <div style={{ fontSize: 11, color: inkSoft, padding: '6px 10px', background: paper, border: `1px solid ${hairline}`, borderRadius: 8 }}>
            Provider: <strong>{config.provider}</strong> · Model: <strong>{config.model}</strong> · {config.enabled ? 'Enabled' : '⚠️ Disabled'}
          </div>
        )}
      </div>

      {!config?.enabled && (
        <div style={{ padding: 12, borderRadius: 10, background: '#fef9e7', border: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={16} color="#b45309" />
          <span style={{ fontSize: 12, color: ink }}>
            AI is not configured. Go to <strong>Settings → Marketing Messages → AI Settings</strong> to configure your provider.
          </span>
        </div>
      )}

      {/* Quick actions */}
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Wand2 size={14} color={teal[700]} />
          <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Quick Actions</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p.label}
              onClick={() => ask(p.prompt)}
              disabled={loading || !config?.enabled}
              style={{
                padding: '6px 12px', borderRadius: 16, border: `1px solid ${hairline}`, background: paper,
                color: teal[700], cursor: (loading || !config?.enabled) ? 'not-allowed' : 'pointer',
                fontSize: 11, fontWeight: 600, opacity: (loading || !config?.enabled) ? 0.5 : 1,
              }}
            >{p.label}</button>
          ))}
        </div>
      </div>

      {/* Conversation */}
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 280 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: inkSoft, fontSize: 12, padding: 40 }}>
            Ask a question or pick a quick action above to begin.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            padding: '10px 14px', borderRadius: 12,
            background: m.role === 'user' ? teal[600] : '#eef7f6',
            color: m.role === 'user' ? '#fff' : ink,
            fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
            border: m.isAiSuggestion ? `1px dashed ${teal[600]}` : 'none',
          }}>
            {m.isAiSuggestion && (
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, color: teal[700], marginBottom: 4, textTransform: 'uppercase' }}>AI Suggestion</div>
            )}
            {m.content}
          </div>
        ))}
        {loading && <div style={{ alignSelf: 'flex-start', color: inkSoft, fontSize: 12, padding: 8 }}>Thinking…</div>}
        {error && <div style={{ color: '#991b1b', fontSize: 12, padding: 8 }}>{error}</div>}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder="Ask about cash position, reconciliations, anomalies, cash flow…"
          disabled={loading || !config?.enabled}
          style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: `1px solid ${hairline}`, fontSize: 13, background: paper, outline: 'none' }}
        />
        <button
          onClick={() => ask(input)}
          disabled={loading || !input.trim() || !config?.enabled}
          style={{
            padding: '10px 16px', borderRadius: 10, border: 'none',
            background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`,
            color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 6,
            opacity: (loading || !input.trim() || !config?.enabled) ? 0.5 : 1,
          }}
        ><Send size={14} /> Ask AI</button>
      </div>
    </div>
  );
};

export default AIAssistantTab;
