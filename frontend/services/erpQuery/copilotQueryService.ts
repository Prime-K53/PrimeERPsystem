/**
 * copilotQueryService.ts — Facade between the AI Copilot UI and the
 * constrained ERP query layer.
 *
 * Flow (the LLM is never the database):
 *   user question → interpretErpQuery (NL → ErpQuery) → executeErpQuery
 *   (deterministic app-side retrieval + math) → formatCopilotAnswer
 *   (deterministic presentation) → LLM explains the result.
 *
 * CONTEXT ISOLATION: only the queried entity's result is handed to the LLM.
 * An orders question never injects invoice numbers, payment details, delivery
 * notes, verification URLs, or unrelated customer facts. Communication-centre
 * purposes (allowedFacts) are untouched — this service never builds or sends
 * communication contexts.
 */

import { ENTITY_REGISTRY } from './entityRegistry';
import { executeErpQuery } from './queryExecutor';
import { interpretErpQuery } from './queryInterpreter';
import { emptyConversation, lastTurn, recordTurn, type CopilotConversationState, type CopilotTurn } from './conversationContext';
import {
  ERP_QUERY_MAX_LIMIT,
  ErpQueryError,
  type ErpAuthContext,
  type ErpDataset,
  type ErpEntityId,
  type ErpQuery,
  type ErpQueryResult,
} from './erpQueryTypes';

export interface CopilotDatasets {
  orders?: readonly unknown[];
  quotations?: readonly unknown[];
  invoices?: readonly unknown[];
  customerPayments?: readonly unknown[];
  customers?: readonly unknown[];
  suppliers?: readonly unknown[];
  products?: readonly unknown[];
  inventoryTransactions?: readonly unknown[];
  purchases?: readonly unknown[];
  expenses?: readonly unknown[];
  sales?: readonly unknown[];
  deliveryNotes?: readonly unknown[];
  supplierPayments?: readonly unknown[];
  income?: readonly unknown[];
  goodsReceipts?: readonly unknown[];
  shipments?: readonly unknown[];
  walletTransactions?: readonly unknown[];
  referrals?: readonly unknown[];
  examinationBatches?: readonly unknown[];
  workOrders?: readonly unknown[];
  boms?: readonly unknown[];
  subscriptions?: readonly unknown[];
  // Legacy aliases accepted from existing contexts (mapped, never duplicated).
  inventory?: readonly unknown[];
  customer_payments?: readonly unknown[];
  supplier_payments?: readonly unknown[];
  delivery_notes?: readonly unknown[];
  goods_receipts?: readonly unknown[];
  wallet_transactions?: readonly unknown[];
  examination_batches?: readonly unknown[];
  work_orders?: readonly unknown[];
  customer_payments_alt?: readonly unknown[];
}

export function buildErpDataset(input: CopilotDatasets): ErpDataset {
  const pick = (...vals: Array<readonly unknown[] | undefined>): readonly unknown[] | undefined => {
    for (const v of vals) if (Array.isArray(v)) return v;
    return undefined;
  };
  const dataset: ErpDataset = {};
  const assign = (key: ErpEntityId, value: readonly unknown[] | undefined) => {
    if (Array.isArray(value)) dataset[key] = value;
  };
  assign('orders', pick(input.orders));
  assign('quotations', pick(input.quotations));
  assign('invoices', pick(input.invoices));
  assign('customer_payments', pick(input.customerPayments, input.customer_payments));
  assign('customers', pick(input.customers));
  assign('suppliers', pick(input.suppliers));
  assign('products', pick(input.products, input.inventory));
  assign('inventory_transactions', pick(input.inventoryTransactions));
  assign('purchases', pick(input.purchases));
  assign('expenses', pick(input.expenses));
  assign('sales', pick(input.sales));
  assign('delivery_notes', pick(input.deliveryNotes, input.delivery_notes));
  assign('supplier_payments', pick(input.supplierPayments, input.supplier_payments));
  assign('income', pick(input.income));
  assign('goods_receipts', pick(input.goodsReceipts, input.goods_receipts));
  assign('shipments', pick(input.shipments));
  assign('wallet_transactions', pick(input.walletTransactions, input.wallet_transactions));
  assign('referrals', pick(input.referrals));
  assign('examination_batches', pick(input.examinationBatches, input.examination_batches));
  assign('work_orders', pick(input.workOrders, input.work_orders));
  assign('boms', pick(input.boms));
  assign('subscriptions', pick(input.subscriptions));
  return dataset;
}

/**
 * Build an authorization context from the ERP's existing permission check.
 * Pass the AuthContext checkPermission straight through — no parallel auth.
 */
export function buildAuthContext(opts: {
  userId?: string;
  role?: string;
  isAdmin?: boolean;
  checkPermission?: (permissionId: string) => boolean;
}): ErpAuthContext {
  const permissionFor = (entity: ErpEntityId): string => ENTITY_REGISTRY[entity]?.requiredPermission || 'dashboard.view';
  return {
    userId: opts.userId,
    role: opts.role,
    isAdmin: opts.isAdmin,
    canRead: (entity) => {
      if (opts.isAdmin) return true;
      try {
        if (typeof opts.checkPermission === 'function') return !!opts.checkPermission(permissionFor(entity));
      } catch {
        return false;
      }
      // No permission checker supplied (tests): allow reads so the deterministic
      // layer can be verified; production always supplies checkPermission.
      return true;
    },
  };
}

export interface CopilotAnswer {
  /** Deterministic plain-text answer (already formatted, no LLM needed). */
  text: string;
  /** The constrained query that produced it (for debugging / follow-ups). */
  query: ErpQuery | null;
  result: ErpQueryResult | null;
  /** Minimal isolated context for the LLM to explain the result (queried entity only). */
  llmContext: string | null;
  /** Updated conversation state (pass back on the next question). */
  conversation: CopilotConversationState;
  /** True when the question was answered deterministically (no LLM fallback needed). */
  answered: boolean;
  clarification: string | null;
}

function fmtMoney(n: number | null, symbol: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unavailable';
  return `${symbol} ${Math.round(n).toLocaleString('en-US')}`;
}

function fmtNum(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unavailable';
  return Number(n).toLocaleString('en-US');
}

function entityNoun(entity: ErpEntityId, count: number): string {
  const labels: Record<ErpEntityId, [string, string]> = {
    orders: ['order', 'orders'],
    order_items: ['order line', 'order lines'],
    quotations: ['quotation', 'quotations'],
    invoices: ['invoice', 'invoices'],
    invoice_items: ['invoice line', 'invoice lines'],
    customer_payments: ['payment', 'payments'],
    customers: ['customer', 'customers'],
    suppliers: ['supplier', 'suppliers'],
    products: ['product', 'products'],
    inventory_transactions: ['stock movement', 'stock movements'],
    purchases: ['purchase order', 'purchase orders'],
    expenses: ['expense', 'expenses'],
    sales: ['sale', 'sales'],
    delivery_notes: ['delivery note', 'delivery notes'],
    supplier_payments: ['supplier payment', 'supplier payments'],
    income: ['income record', 'income records'],
    goods_receipts: ['goods receipt', 'goods receipts'],
    shipments: ['shipment', 'shipments'],
    wallet_transactions: ['wallet record', 'wallet records'],
    referrals: ['referral', 'referrals'],
    examination_batches: ['examination record', 'examination records'],
    work_orders: ['work order', 'work orders'],
    boms: ['BOM', 'BOMs'],
    subscriptions: ['subscription', 'subscriptions'],
  };
  const [one, many] = labels[entity] || [entity, entity];
  return count === 1 ? one : many;
}

export function formatCopilotAnswer(query: ErpQuery, result: ErpQueryResult, currencySymbol = 'K'): string {
  const lines: string[] = [];
  const scope = result.scopeLabel ? ` ${result.scopeLabel}` : '';
  const noun = (n: number) => entityNoun(query.entity, n);

  if (query.operation === 'compare' && result.comparisonResult) {
    const c = result.comparisonResult;
    const metric = query.aggregates[0]?.field || 'records';
    lines.push(`Comparison (${metric}): ${c.current !== null ? fmtNum(c.current) : 'unavailable'} vs ${c.previous !== null ? fmtNum(c.previous) : 'unavailable'}.`);
    if (c.delta !== null) {
      const dir = c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'unchanged';
      lines.push(`Change: ${dir} by ${fmtNum(Math.abs(c.delta))}${c.deltaPercent !== null ? ` (${c.deltaPercent > 0 ? '+' : ''}${c.deltaPercent}%)` : ''}.`);
    }
    lines.push(`Scope: ${result.scopeLabel || 'compared periods'}.`);
    return lines.join('\n');
  }

  if (query.operation === 'count') {
    if (result.totalCount === 0) return `You have no ${noun(0)}${scope ? ` ${scope}` : ''}.`;
    return `You have ${fmtNum(result.totalCount)} ${noun(result.totalCount)}${scope ? ` ${scope}` : ''}.`;
  }

  if (query.operation === 'distinct_count') {
    const field = query.aggregates[0]?.field || 'records';
    if ((result.scalar || 0) === 0) return `No distinct ${field} found${scope ? ` ${scope}` : ''}.`;
    return `There are ${fmtNum(result.scalar)} distinct ${field}${scope ? ` ${scope}` : ''} across ${fmtNum(result.totalCount)} ${noun(result.totalCount)}.`;
  }

  if (query.operation === 'sum' || query.operation === 'average' || query.operation === 'minimum' || query.operation === 'maximum') {
    const field = query.aggregates[0]?.field || 'value';
    const moneyFields = new Set(['totalAmount', 'paidAmount', 'outstanding', 'amount', 'subtotal', 'inventoryValue', 'rewardAmount']);
    const rendered = moneyFields.has(field) ? fmtMoney(result.scalar, currencySymbol) : fmtNum(result.scalar);
    const verb = query.operation === 'sum' ? 'Total' : query.operation === 'average' ? 'Average' : query.operation === 'minimum' ? 'Minimum' : 'Maximum';
    if (result.totalCount === 0) return `No ${noun(0)} found${scope ? ` ${scope}` : ''}, so there is nothing to total.`;
    // Special-case the canonical order-lines example shape.
    if (query.entity === 'order_items' && field === 'quantity') {
      lines.push(`${verb} quantity across ${fmtNum(result.totalCount)} order lines${scope ? ` ${scope}` : ''}: ${rendered}.`);
      return lines.join('\n');
    }
    lines.push(`${verb} ${field} across ${fmtNum(result.totalCount)} ${noun(result.totalCount)}${scope ? ` ${scope}` : ''}: ${rendered}.`);
    return lines.join('\n');
  }

  if (query.operation === 'group_by') {
    if (result.groups.length === 0) return `No ${noun(0)} found${scope ? ` ${scope}` : ''}.`;
    const groupField = query.groupBy[0] || 'group';
    const agg = query.aggregates[0];
    const aggLabel = agg ? `${agg.operation}(${agg.field})` : 'count';
    lines.push(`${result.groups.length} ${groupField} group${result.groups.length === 1 ? '' : 's'}${scope ? ` ${scope}` : ''} (${aggLabel}):`);
    const shown = result.groups.slice(0, 10);
    for (const g of shown) {
      const name = String(g.key[groupField] || 'Unknown');
      const val = agg ? g.aggregates[agg.as || `${agg.operation}_${agg.field}`] : g.count;
      const moneyFields = new Set(['totalAmount', 'paidAmount', 'outstanding', 'amount', 'subtotal', 'inventoryValue']);
      const rendered = agg && moneyFields.has(agg.field) ? fmtMoney(Number(val), currencySymbol) : fmtNum(Number(val));
      lines.push(`  ${name}: ${rendered} (${fmtNum(g.count)} ${g.count === 1 ? 'record' : 'records'})`);
    }
    if (agg && shown.length > 0) {
      const total = shown.reduce((s, g) => s + Number(g.aggregates[agg.as || `${agg.operation}_${agg.field}`] || 0), 0);
      const moneyFields = new Set(['totalAmount', 'paidAmount', 'outstanding', 'amount', 'subtotal', 'inventoryValue']);
      // Only emit a grand total for additive sum aggregations.
      if (agg.operation === 'sum') {
        lines.push(`Total ${agg.field}: ${moneyFields.has(agg.field) ? fmtMoney(total, currencySymbol) : fmtNum(total)}.`);
      }
    }
    if (result.truncated) lines.push(`Showing ${shown.length} of ${fmtNum(result.totalCount)} groups.`);
    return lines.join('\n');
  }

  // list / retrieve
  if (result.totalCount === 0) {
    return `No ${noun(0)} found${scope ? ` ${scope}` : ''}.`;
  }
  const shown = result.rows.slice(0, 10);
  lines.push(`${fmtNum(result.totalCount)} ${noun(result.totalCount)}${scope ? ` ${scope}` : ''}:`);
  for (const row of shown) {
    lines.push(`  ${summarizeRow(query.entity, row, currencySymbol)}`);
  }
  if (result.truncated) {
    lines.push(`Showing ${shown.length} of ${fmtNum(result.totalCount)}. Narrow the question (e.g. add a customer, status, or date) to see more.`);
  } else if (result.totalCount > shown.length) {
    lines.push(`... and ${fmtNum(result.totalCount - shown.length)} more.`);
  }
  return lines.join('\n');
}

function summarizeRow(entity: ErpEntityId, row: Record<string, unknown>, currencySymbol: string): string {
  const s = (v: unknown) => String(v ?? '-');
  switch (entity) {
    case 'orders':
      return `${s(row.orderNumber || row.id)} | ${s(row.customerName)} | ${s(row.status)} | ${fmtMoney(Number(row.totalAmount), currencySymbol)}`;
    case 'order_items':
    case 'invoice_items':
      return `${s(row.productName)}: ${fmtNum(Number(row.quantity))} units (${fmtMoney(Number(row.subtotal), currencySymbol)})`;
    case 'invoices':
      return `${s(row.invoiceNumber || row.id)} | ${s(row.customerName)} | ${s(row.status)} | total ${fmtMoney(Number(row.totalAmount), currencySymbol)} | outstanding ${fmtMoney(Number(row.outstanding), currencySymbol)}`;
    case 'customer_payments':
      return `${s(row.id)} | ${s(row.customerName)} | ${fmtMoney(Number(row.amount), currencySymbol)} | ${s(row.paymentMethod)} | ${s(row.date ? String(row.date).slice(0, 10) : '-')}`;
    case 'customers':
      return `${s(row.businessName)}${row.contactName ? ` (contact: ${s(row.contactName)})` : ''}`;
    case 'suppliers':
      return `${s(row.name)}`;
    case 'products':
      return `${s(row.name)} | stock ${fmtNum(Number(row.stock))} | cost ${fmtMoney(Number(row.cost), currencySymbol)}`;
    case 'quotations':
      return `${s(row.id)} | ${s(row.customerName)} | ${s(row.status)} | ${fmtMoney(Number(row.totalAmount), currencySymbol)}`;
    case 'purchases':
      return `${s(row.id)} | ${s(row.supplierName)} | ${s(row.status)} | ${fmtMoney(Number(row.totalAmount), currencySymbol)}`;
    case 'expenses':
    case 'income':
      return `${s(row.date ? String(row.date).slice(0, 10) : '-')} | ${s(row.description)} | ${fmtMoney(Number(row.amount), currencySymbol)}`;
    case 'sales':
      return `${s(row.id)} | ${s(row.customerName)} | ${fmtMoney(Number(row.totalAmount), currencySymbol)}`;
    case 'delivery_notes':
    case 'shipments':
      return `${s(row.id)} | ${s(row.status)}`;
    case 'supplier_payments':
      return `${s(row.id)} | ${fmtMoney(Number(row.amount), currencySymbol)}`;
    case 'inventory_transactions':
      return `${s(row.itemName || row.itemId)} | ${s(row.type)} ${fmtNum(Number(row.quantity))}`;
    default:
      return s(row.name || row.id);
  }
}

/**
 * Minimal isolated LLM context: ONLY the queried entity's deterministic
 * result. Never the whole database, never other entities' facts.
 */
export function buildIsolatedLlmContext(query: ErpQuery, result: ErpQueryResult, currencySymbol = 'K'): string {
  const def = ENTITY_REGISTRY[query.entity];
  const sample = result.rows.slice(0, 5).map((r) => JSON.stringify(r)).join('\n');
  return [
    `ERP query result (${def.label}, operation ${query.operation}).`,
    result.scopeLabel ? `Scope: ${result.scopeLabel}.` : 'Scope: all records.',
    result.scalar !== null && result.scalar !== undefined ? `Scalar: ${result.scalar}.` : null,
    result.comparisonResult ? `Comparison: current=${result.comparisonResult.current}, previous=${result.comparisonResult.previous}, delta=${result.comparisonResult.delta}.` : null,
    `Total: ${result.totalCount}${result.truncated ? ' (truncated sample below)' : ''}.`,
    sample ? `Sample rows (max 5, ${def.label} only):\n${sample}` : null,
    `Currency: ${currencySymbol}. Explain this ${def.label} result concisely. Do not invent records beyond these.`,
  ].filter(Boolean).join('\n');
}

export function answerCopilotQuestion(opts: {
  question: string;
  datasets: CopilotDatasets;
  auth?: ErpAuthContext | null;
  conversation?: CopilotConversationState | null;
  currencySymbol?: string;
  now?: Date;
}): CopilotAnswer {
  const conversation = opts.conversation || emptyConversation();
  const currencySymbol = opts.currencySymbol || 'K';
  const dataset = buildErpDataset(opts.datasets);

  let interpreted: { query: ErpQuery } | null = null;
  try {
    const out = interpretErpQuery(opts.question, conversation, opts.now);
    interpreted = { query: out.query };
  } catch (e) {
    if (e instanceof ErpQueryError) {
      return {
        text: e.message,
        query: null,
        result: null,
        llmContext: null,
        conversation,
        answered: false,
        clarification: e.code === 'ambiguous_query' ? e.message : null,
      };
    }
    return {
      text: 'The requested data could not be retrieved. Please try rephrasing the question.',
      query: null,
      result: null,
      llmContext: null,
      conversation,
      answered: false,
      clarification: null,
    };
  }

  try {
    const result = executeErpQuery(interpreted.query, dataset, opts.auth ?? null);
    const text = formatCopilotAnswer(interpreted.query, result, currencySymbol);
    const turn: CopilotTurn = {
      question: opts.question,
      entity: interpreted.query.entity,
      filters: interpreted.query.filters,
      dateScope: interpreted.query.dateScope,
      relationship: interpreted.query.relationship,
      searchHint: interpreted.query.searchHint,
    };
    return {
      text,
      query: interpreted.query,
      result,
      llmContext: buildIsolatedLlmContext(interpreted.query, result, currencySymbol),
      conversation: recordTurn(conversation, turn),
      answered: true,
      clarification: null,
    };
  } catch (e) {
    if (e instanceof ErpQueryError) {
      if (e.code === 'ambiguous_query' || e.code === 'unsupported_entity' || e.code === 'unsupported_field' || e.code === 'unsupported_operation' || e.code === 'unsupported_relationship') {
        return { text: e.message, query: interpreted.query, result: null, llmContext: null, conversation, answered: false, clarification: e.message };
      }
      if (e.code === 'authorization_denied') {
        return { text: e.message, query: interpreted.query, result: null, llmContext: null, conversation, answered: false, clarification: null };
      }
      return { text: `The requested data could not be retrieved (${e.message})`, query: interpreted.query, result: null, llmContext: null, conversation, answered: false, clarification: null };
    }
    return { text: 'The requested data could not be retrieved. Please try again.', query: interpreted?.query || null, result: null, llmContext: null, conversation, answered: false, clarification: null };
  }
}

/** Back-compat helper so callers can thread conversation state without importing the module. */
export { emptyConversation, lastTurn };
export type { CopilotConversationState };
export { ERP_QUERY_MAX_LIMIT };
