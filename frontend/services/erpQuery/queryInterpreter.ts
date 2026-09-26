/**
 * queryInterpreter.ts — Natural language → constrained ErpQuery.
 *
 * GENERAL (not a collection of hard-coded question handlers): a single
 * pipeline — entity detection → operation detection → filter extraction →
 * aggregation inference → registry validation — serves every registered
 * entity. Adding an entity means adding its synonyms + default metric in
 * ENTITY_SYNONYMS / ENTITY_DEFAULT_METRIC below (and its registry entry),
 * never a new handler.
 *
 * The interpreter never touches data and never emits SQL. It only produces
 * a validated ErpQuery. Ambiguous or unsupported questions raise
 * ErpQueryError('ambiguous_query' | 'unsupported_*') so the Copilot can ask
 * a concise clarification instead of fabricating an answer.
 */

import { ENTITY_REGISTRY, getEntityDef } from './entityRegistry';
import { resolveDateScope, previousPeriod } from './dateScope';
import { ErpQueryError, type DateScope, type ErpEntityId, type ErpFilter, type ErpOperation, type ErpQuery, type ErpRelationship } from './erpQueryTypes';
import { inheritScope, type CopilotConversationState } from './conversationContext';

interface EntitySynonyms {
  entity: ErpEntityId;
  /** Scored phrases — higher weight wins. */
  phrases: Array<{ text: string; weight: number }>;
}

const ENTITY_SYNONYMS: EntitySynonyms[] = [
  { entity: 'orders', phrases: [
    { text: 'sales order', weight: 5 }, { text: 'sales orders', weight: 5 },
    { text: 'order', weight: 3 }, { text: 'orders', weight: 3 },
    { text: 'so-', weight: 4 },
  ]},
  { entity: 'order_items', phrases: [
    { text: 'order line', weight: 4 }, { text: 'order item', weight: 4 },
    { text: 'items in the order', weight: 5 }, { text: 'items in orders', weight: 5 },
    { text: 'line item', weight: 2 },
  ]},
  { entity: 'quotations', phrases: [
    { text: 'quotation', weight: 4 }, { text: 'quotations', weight: 4 },
    { text: 'quote', weight: 3 }, { text: 'quotes', weight: 3 },
  ]},
  { entity: 'invoices', phrases: [
    { text: 'invoice', weight: 4 }, { text: 'invoices', weight: 4 },
    { text: 'inv-', weight: 4 }, { text: 'invoiced value', weight: 3 },
    { text: 'billed', weight: 2 },
  ]},
  { entity: 'invoice_items', phrases: [
    { text: 'invoice line', weight: 4 }, { text: 'invoice item', weight: 4 },
    { text: 'items in the invoice', weight: 4 },
  ]},
  { entity: 'customer_payments', phrases: [
    { text: 'customer payment', weight: 5 }, { text: 'customer payments', weight: 5 },
    { text: 'payment received', weight: 4 }, { text: 'payments received', weight: 4 },
    { text: 'receipt', weight: 2 }, { text: 'receipts', weight: 2 },
    { text: 'payment', weight: 2 }, { text: 'payments', weight: 2 },
    { text: 'paid', weight: 1 }, { text: 'collection', weight: 2 },
    { text: 'money received', weight: 4 }, { text: 'money', weight: 2 },
    { text: 'received', weight: 2 }, { text: 'receive', weight: 1 },
  ]},
  { entity: 'customers', phrases: [
    { text: 'customer', weight: 4 }, { text: 'customers', weight: 4 },
    { text: 'client', weight: 3 }, { text: 'clients', weight: 3 },
  ]},
  { entity: 'suppliers', phrases: [
    { text: 'supplier', weight: 4 }, { text: 'suppliers', weight: 4 },
    { text: 'vendor', weight: 3 }, { text: 'vendors', weight: 3 },
  ]},
  { entity: 'products', phrases: [
    { text: 'product', weight: 3 }, { text: 'products', weight: 3 },
    { text: 'item', weight: 2 }, { text: 'items', weight: 2 },
    { text: 'stock', weight: 2 }, { text: 'inventory', weight: 3 },
  ]},
  { entity: 'inventory_transactions', phrases: [
    { text: 'stock movement', weight: 6 }, { text: 'stock movements', weight: 6 },
    { text: 'inventory transaction', weight: 5 }, { text: 'stock transaction', weight: 5 },
    { text: 'movement', weight: 2 },
  ]},
  { entity: 'purchases', phrases: [
    { text: 'purchase order', weight: 6 }, { text: 'purchase orders', weight: 6 },
    { text: 'purchase', weight: 3 }, { text: 'purchases', weight: 3 },
    { text: 'po-', weight: 4 }, { text: 'procurement', weight: 2 },
    { text: 'bought from supplier', weight: 3 },
  ]},
  { entity: 'expenses', phrases: [
    { text: 'expense', weight: 4 }, { text: 'expenses', weight: 4 },
    { text: 'expenditure', weight: 3 }, { text: 'spent', weight: 1 },
  ]},
  { entity: 'sales', phrases: [
    { text: 'pos sale', weight: 5 }, { text: 'pos sales', weight: 5 },
    { text: 'counter sale', weight: 4 },
    { text: 'sale', weight: 2 }, { text: 'sales', weight: 2 },
    { text: 'revenue', weight: 2 }, { text: 'sold', weight: 2 },
  ]},
  { entity: 'delivery_notes', phrases: [
    { text: 'delivery note', weight: 6 }, { text: 'delivery notes', weight: 6 },
    { text: 'delivery', weight: 2 }, { text: 'deliveries', weight: 2 },
    { text: 'dn-', weight: 4 },
  ]},
  { entity: 'supplier_payments', phrases: [
    { text: 'supplier payment', weight: 7 }, { text: 'supplier payments', weight: 7 },
    { text: 'paid to supplier', weight: 5 }, { text: 'payable', weight: 2 },
  ]},
  { entity: 'income', phrases: [
    { text: 'other income', weight: 5 }, { text: 'income', weight: 3 },
  ]},
  { entity: 'goods_receipts', phrases: [
    { text: 'goods receipt', weight: 6 }, { text: 'grn', weight: 5 },
    { text: 'goods received', weight: 4 },
  ]},
  { entity: 'shipments', phrases: [
    { text: 'shipment', weight: 5 }, { text: 'shipments', weight: 5 },
    { text: 'shipping', weight: 2 },
  ]},
  { entity: 'wallet_transactions', phrases: [
    { text: 'wallet', weight: 5 },
  ]},
  { entity: 'referrals', phrases: [
    { text: 'referral', weight: 5 }, { text: 'referrals', weight: 5 },
  ]},
  { entity: 'examination_batches', phrases: [
    { text: 'examination', weight: 5 }, { text: 'examinations', weight: 5 },
    { text: 'exam batch', weight: 5 }, { text: 'exam', weight: 3 },
    { text: 'school', weight: 2 },
  ]},
  { entity: 'work_orders', phrases: [
    { text: 'work order', weight: 6 }, { text: 'work orders', weight: 6 },
    { text: 'production', weight: 2 }, { text: 'job ticket', weight: 3 },
  ]},
  { entity: 'boms', phrases: [
    { text: 'bom', weight: 6 }, { text: 'boms', weight: 6 },
    { text: 'bill of material', weight: 6 }, { text: 'recipe', weight: 2 },
  ]},
  { entity: 'subscriptions', phrases: [
    { text: 'subscription', weight: 5 }, { text: 'subscriptions', weight: 5 },
    { text: 'recurring', weight: 4 },
  ]},
];

/** Default numeric field for sum/average when the question says "total value" etc. */
const ENTITY_DEFAULT_METRIC: Partial<Record<ErpEntityId, string>> = {
  orders: 'totalAmount',
  order_items: 'quantity',
  quotations: 'totalAmount',
  invoices: 'totalAmount',
  invoice_items: 'quantity',
  customer_payments: 'amount',
  products: 'stock',
  inventory_transactions: 'quantity',
  purchases: 'totalAmount',
  expenses: 'amount',
  sales: 'totalAmount',
  supplier_payments: 'amount',
  income: 'amount',
  wallet_transactions: 'amount',
  referrals: 'rewardAmount',
  examination_batches: 'totalAmount',
  work_orders: 'quantityPlanned',
  subscriptions: 'totalAmount',
};

function detectEntities(question: string): Array<{ entity: ErpEntityId; score: number }> {
  const lower = ` ${question.toLowerCase()} `;
  const scores = new Map<ErpEntityId, number>();
  for (const syn of ENTITY_SYNONYMS) {
    let score = 0;
    for (const p of syn.phrases) {
      if (lower.includes(p.text.toLowerCase())) score += p.weight;
    }
    if (score > 0) scores.set(syn.entity, score);
  }
  return [...scores.entries()].map(([entity, score]) => ({ entity, score })).sort((a, b) => b.score - a.score);
}

function detectOperation(question: string, entity: ErpEntityId): ErpOperation {
  const lower = question.toLowerCase();
  if (/compare| vs\.? | versus |this month (with|vs)|last month/.test(lower) && /compare|vs|with last|with previous/.test(lower)) return 'compare';
  if (/how many (different|distinct|unique)/.test(lower)) return 'distinct_count';
  if (/\baverage\b|\bavg\b|average .*per/.test(lower)) return 'average';
  if (/\b(minimum|lowest|smallest|least)\b/.test(lower)) return 'minimum';
  if (/\b(maximum|highest|largest|most|top|best)\b/.test(lower) && /(group|each|per|by|product|customer|item)/.test(lower)) return 'group_by';
  if (/\b(maximum|highest|largest)\b/.test(lower)) return 'maximum';
  if (/(for each|per |each |by |grouped by|breakdown|which .* most|top \d+|best卖)/.test(lower)) {
    if (/(each|per |by |breakdown|most|top|best seller|best selling)/.test(lower)) return 'group_by';
  }
  if (/\b(total|sum|how much|total value|total quantity|worth|value of|amount of)\b/.test(lower)) {
    // "list ... and total" is an aggregation over lines, not a plain list.
    if (/(total|sum)/.test(lower)) return 'sum';
    return 'sum';
  }
  if (/\b(how many|count|number of|how much .* owe|outstanding)\b/.test(lower)) {
    if (/\b(how much|total|owe|owing|outstanding|balance)\b/.test(lower) && entity !== 'customers' && entity !== 'suppliers') return 'sum';
    return 'count';
  }
  if (/\b(list|show|display|give me|all|find|get|what|which)\b/.test(lower)) {
    // "what is the total ..." already handled above; default to list.
    return 'list';
  }
  // Detail lookup with an explicit id → retrieve, else list.
  if (/[a-z]{2,4}[-_]\d{2,}/i.test(question)) return 'retrieve';
  return 'list';
}

function detectId(question: string): string | null {
  const m = question.match(/\b([A-Z]{2,5}[-_][A-Z0-9][-A-Z0-9_]*\d[A-Z0-9-]*)\b/);
  if (m) return m[1].toUpperCase();
  return null;
}

function detectStatusFilter(question: string, entity: ErpEntityId): ErpFilter | null {
  const lower = question.toLowerCase();
  const def = getEntityDef(entity);
  const has = (...words: string[]) => words.some((w) => lower.includes(w));
  if (entity === 'invoices') {
    if (has('unpaid') || (has('outstanding') && has('invoice')) || has('still owe', 'still owes', 'owe us')) return { field: 'status', operator: 'eq', value: 'unpaid' };
    if (has('overdue')) return { field: 'status', operator: 'eq', value: 'overdue' };
    if (has('paid') && !has('unpaid')) return { field: 'status', operator: 'eq', value: 'paid' };
    if (has('partial')) return { field: 'status', operator: 'eq', value: 'partial' };
    if (has('cancelled') || has('canceled')) return { field: 'status', operator: 'eq', value: 'cancelled' };
    void def;
    return null;
  }
  if (entity === 'orders') {
    for (const s of ['pending', 'confirmed', 'fulfilled', 'completed', 'paid', 'converted', 'cancelled']) {
      if (lower.includes(s)) return { field: 'status', operator: 'eq', value: s };
    }
    if (has('partially paid')) return { field: 'status', operator: 'eq', value: 'partially paid' };
    return null;
  }
  if (entity === 'products') {
    if (has('low stock', 'low in stock', 'need reorder', 'below reorder', 'reorder level')) return { field: 'status', operator: 'eq', value: 'low_stock' };
    if (has('out of stock', 'zero stock', 'no stock')) return { field: 'stock', operator: 'eq', value: 0 };
    if (has('in stock', 'currently in stock', 'on hand')) return { field: 'stock', operator: 'gt', value: 0 };
    return null;
  }
  for (const s of def.statuses) {
    if (s && lower.includes(s)) return { field: 'status', operator: 'eq', value: s };
  }
  return null;
}

function detectCustomerRef(question: string): { id?: string; name?: string } | null {
  const patterns = [
    /from customer\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$|\s+(?:this|last|today|yesterday|in|for|with|and))/i,
    /for customer\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$|\s+(?:this|last|today|yesterday|in|for|with|and))/i,
    /customer\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:'s|\s+paid|\s+owes?|\s+bought|\s+has|\s+have|[?.,;]|$)/i,
    /\b([A-Z][A-Za-z .&'-]{2,60}?)(?:'s)\s+(?:orders?|invoices?|payments?|purchases?|balance|owe)/,
    /what did\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+buy/i,
    /how much (?:has|did)\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+paid?/i,
    /how much does\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+owe/i,
    /payments? from\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$)/i,
    /orders? from\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$)/i,
    /purchases? from\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$)/i,
    /orders? does\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+have/i,
    /invoices? does\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+have/i,
    /payments? does\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+have/i,
    /what (?:orders?|invoices?|payments?|quotations?) does\s+([A-Za-z][A-Za-z .&'-]{1,60}?)\s+have/i,
  ];
  for (const rx of patterns) {
    const m = question.match(rx);
    if (m && m[1]) {
      let name = m[1].trim().replace(/\s+(this|last|today|yesterday)$/i, '').trim();
      // Strip a leading role noun captured by generic "from X" patterns.
      name = name.replace(/^(customer|client|supplier|vendor)\s+/i, '').trim();
      if (name.length >= 2 && !/^(this|last|the|all|our|my|today|month|year|week)$/i.test(name)) return { name };
    }
  }
  return null;
}

function detectSupplierRef(question: string): string | null {
  const m = question.match(/(?:from supplier|supplier)\s+([A-Za-z][A-Za-z .&'-]{1,60}?)(?:[?.,;]|$)/i);
  if (m && m[1] && m[1].trim().length >= 2) return m[1].trim();
  return null;
}

function detectProductRef(question: string): string | null {
  const patterns = [
    /(?:for|of)\s+([A-Z][A-Za-z0-9 .&'()-]{2,60}?)(?:\s+(?:in stock|are in|is in|this|last|today))?(?:[?.,;]|$)/i,
    /how many\s+([A-Z][A-Za-z0-9 .&'()-]{2,60}?)\s+are in stock/i,
    /stock movements? for\s+([A-Za-z0-9][A-Za-z0-9 .&'()-]{1,60}?)(?:[?.,;]|$)/i,
  ];
  for (const rx of patterns) {
    const m = question.match(rx);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name.length >= 2 && !/^(the|all|our|my|this|each|per|total|many|much|items?|products?|stock|inventory)$/i.test(name)) return name;
    }
  }
  return null;
}

function detectPaymentMethod(question: string): string | null {
  const m = question.match(/\b(cash|bank|mobile money|mpamba|tnm|airtel|cheque|card|transfer)\b/i);
  return m ? m[1] : null;
}

function detectLimit(question: string): number {
  const top = question.match(/\btop\s+(\d{1,3})\b/i);
  if (top) return Math.max(1, Math.min(50, parseInt(top[1], 10)));
  if (/\ball\b/.test(question.toLowerCase())) return 50;
  return 50;
}

function detectSort(question: string, entity: ErpEntityId): Array<{ field: string; direction: 'asc' | 'desc' }> {
  const lower = question.toLowerCase();
  const def = getEntityDef(entity);
  if (/highest|most|top|best|largest|biggest/.test(lower)) {
    const metric = ENTITY_DEFAULT_METRIC[entity] || 'totalAmount';
    if (def.readableFields.includes(metric)) return [{ field: metric, direction: 'desc' }];
  }
  if (/lowest|least|smallest/.test(lower)) {
    const metric = ENTITY_DEFAULT_METRIC[entity] || 'totalAmount';
    if (def.readableFields.includes(metric)) return [{ field: metric, direction: 'asc' }];
  }
  if (/(recent|latest|newest)/.test(lower)) {
    if (def.readableFields.includes(def.dateField)) return [{ field: def.dateField, direction: 'desc' }];
  }
  return [];
}

/** Relationship intent: "which invoices came from these orders", "what did X buy", "payments allocated to INV-123". */
function detectRelationship(question: string, entity: ErpEntityId, conversation: CopilotConversationState | null | undefined): ErpRelationship | null {
  const lower = question.toLowerCase();
  const id = detectId(question);

  if (entity === 'customer_payments' && /allocat/.test(lower) && id) {
    return { parentEntity: 'invoices', parentId: id, via: 'invoice_payments' };
  }
  if (entity === 'invoices' && /from (these|those|the) orders|from order/.test(lower)) {
    const prev = conversation?.turns?.[conversation.turns.length - 1];
    if (prev && prev.entity === 'orders') {
      return { parentEntity: 'orders', via: 'order_invoice', parentName: prev.searchHint };
    }
    const orderId = id;
    if (orderId) return { parentEntity: 'orders', parentId: orderId, via: 'order_invoice' };
  }
  // "what did ABC buy" → line items for that customer.
  if ((entity === 'order_items' || entity === 'invoice_items' || entity === 'invoices' || entity === 'orders') && /what did .* buy|what .* bought|purchases? by/.test(lower)) {
    const cust = detectCustomerRef(question);
    if (cust?.name) return { parentEntity: 'customers', parentName: cust.name, via: entity === 'orders' ? 'customer_orders' : entity === 'invoices' ? 'customer_invoices' : 'customer_orders' };
  }
  // "which supplier did we purchase this item from" → purchases filtered by product.
  if (entity === 'purchases' && /which supplier/.test(lower)) {
    return null; // handled as group_by supplierName instead
  }
  return null;
}

export interface InterpretedErpQuery {
  query: ErpQuery;
  warnings: string[];
  clarification: string | null;
}

export function interpretErpQuery(
  question: string,
  conversation?: CopilotConversationState | null,
  now = new Date(),
): InterpretedErpQuery {
  const q = question.trim();
  if (!q) throw new ErpQueryError('ambiguous_query', 'Please ask a question about your ERP data (e.g. "How many orders do I have?").');

  // Reject mutation intent up front — this layer is strictly read-only.
  if (/\b(create|add|update|edit|delete|remove|cancel|void|approve|post|pay|record|adjust|transfer|reconcile)\b.*\b(order|invoice|payment|stock|inventory|customer|supplier|expense)s?\b/i.test(q)
    && /^(create|add|update|edit|delete|remove|cancel|void|approve|post|make|record|adjust)/i.test(q)) {
    throw new ErpQueryError('mutation_rejected', 'The Copilot query layer is read-only. To change ERP records, use the relevant ERP screen.');
  }
  // Reject anything that looks like an attempt to run raw SQL.
  if (/;\s*(select|insert|update|delete|drop|alter)\s+/i.test(q) || /\bunion\s+select\b/i.test(q)) {
    throw new ErpQueryError('mutation_rejected', 'Arbitrary SQL is not supported. Ask in plain English and the Copilot will run a constrained ERP query.');
  }

  const inherited = inheritScope(q, conversation ?? null);
  let candidates = detectEntities(q);

  // Follow-up with no entity noun inherits the previous entity.
  const prevTurn = conversation?.turns?.[conversation.turns.length - 1];
  if (candidates.length === 0 && inherited && prevTurn) {
    candidates = [{ entity: prevTurn.entity, score: 1 }];
  }
  // "what items were in them?" after an orders question → order lines.
  if (prevTurn && /what items|which items|what was in|list.*items/.test(q.toLowerCase()) && /them|those|these|orders?/.test(q.toLowerCase())) {
    if (prevTurn.entity === 'orders') candidates = [{ entity: 'order_items', score: 10 }];
    if (prevTurn.entity === 'invoices') candidates = [{ entity: 'invoice_items', score: 10 }];
  }
  // "what invoices were those payments allocated to?" → invoices via payment.
  if (/invoices? (were|was) .* allocat|allocat.* invoice/.test(q.toLowerCase())) {
    candidates = [{ entity: 'invoices', score: 10 }];
  }
  // "which customers owe / have outstanding balances" → invoices grouped by customer.
  if (/which customers? (owe|have|with).* (owe|owe|balance|outstanding|owe us)|customers? (owe|with balances|with outstanding)/.test(q.toLowerCase())) {
    candidates = [{ entity: 'invoices', score: 10 }];
  }

  if (candidates.length === 0) {
    throw new ErpQueryError(
      'ambiguous_query',
      'I could not tell which ERP records you mean. Try "orders", "invoices", "payments", "customers", "products", "quotations", "purchases", or "expenses" — e.g. "How many orders do I have?"',
    );
  }

  // Explicit line-item phrasing wins over the generic entity score
  // ("items in the orders" is about order lines, not the orders themselves).
  const lowerPre = q.toLowerCase();
  if (/items? in (the )?orders?/.test(lowerPre)) candidates = [{ entity: 'order_items', score: 100 }];
  else if (/items? in (the )?invoices?/.test(lowerPre)) candidates = [{ entity: 'invoice_items', score: 100 }];
  // "payments allocated to invoice X" is about payments, not invoices.
  else if (/payments?.*allocat|allocat.*payments?/.test(lowerPre)) candidates = [{ entity: 'customer_payments', score: 100 }];

  // Specialize generic "items/products" when the question is really about order/invoice lines.
  let entity = candidates[0].entity;
  const lower = q.toLowerCase();
  if (entity === 'products' && /(items in the orders|items in orders|order.*quantit|total.*quantit|units .* (purchased|sold)|quantity sold|quantity.*each product)/.test(lower)) {
    entity = 'order_items';
  }
  if (entity === 'products' && /sold the most|best.?sell|highest.*sold|total quantity sold/.test(lower)) {
    entity = 'invoice_items';
  }
  if (entity === 'sales' && /sold the most|best.?sell/.test(lower)) {
    entity = 'invoice_items';
  }
  // "what did ABC buy" without an entity noun → invoice lines (what was actually billed).
  if (/what did .* buy/.test(lower) && !/(order|invoice|payment)/.test(lower)) {
    entity = 'invoice_items';
  }
  // "which customers spent the most" → invoices grouped by customer.
  if (/which customers? spent|top.*customers?|best customers?/.test(lower)) {
    entity = 'invoices';
  }
  // "which product sold the most" handled above; "which items are low in stock" stays products.
  // "how much inventory / stock do we have" → products sum.
  // "how much did ABC pay" → customer payments.
  if (/how much .* (paid|pay|payment)/.test(lower) && !/invoice|order/.test(lower)) {
    if (candidates[0].entity === 'customers' || !/(invoice|order)/.test(lower)) entity = 'customer_payments';
  }
  // "what does ABC still owe / outstanding balance" → invoices sum outstanding.
  if (/(still owe|still owes|owe us|owing|outstanding balance|how much .* owe)/.test(lower)) {
    entity = 'invoices';
  }

  const def = getEntityDef(entity);
  let operation = detectOperation(q, entity);

  // Group-by triggers that override the default operation.
  const wantsGroup =
    /(for each|per |each |grouped by|breakdown|by customer|by product|by item|by category|by status|by supplier|which .* most|top \d+.*(customer|product|item)|best.?sell)/.test(lower);
  if (wantsGroup && def.supportedOperations.includes('group_by')) {
    if (operation === 'list' || operation === 'count' || operation === 'sum' || operation === 'maximum') operation = 'group_by';
  }
  // "list all items in the orders and total their quantities" → order_items group_by productName sum quantity.
  if (entity === 'order_items' && /total.*quantit|sum.*quantit/.test(lower)) operation = 'group_by';
  if ((entity === 'order_items' || entity === 'invoice_items') && operation === 'list' && /total|each|per|group/.test(lower)) operation = 'group_by';
  // Comparison
  let comparison: InterpretedErpQuery['query']['comparison'] = null;
  if (operation === 'compare') {
    const cur = resolveDateScope(q.replace(/compare/i, ''), def.dateField, now);
    // "compare sales this month with last month": current = this month, previous = last month.
    const withLast = q.match(/with\s+(last\s+\w+|previous\s+\w+)/i);
    if (cur && withLast) {
      const prev = resolveDateScope(withLast[1], def.dateField, now) || previousPeriod(cur, def.dateField);
      comparison = { current: cur, previous: prev };
    } else if (cur) {
      comparison = { current: cur, previous: previousPeriod(cur, def.dateField) };
    } else {
      // Default: this month vs last month.
      const thisMonth: DateScope = {
        start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
        label: 'this month',
        dateField: def.dateField,
      };
      comparison = { current: thisMonth, previous: previousPeriod(thisMonth, def.dateField) };
    }
    if (!def.supportedOperations.includes('compare')) operation = 'group_by';
  }

  if (!def.supportedOperations.includes(operation)) {
    // Graceful downgrade: sum → list when the entity has no metric (customers, suppliers…).
    if ((operation === 'sum' || operation === 'average' || operation === 'minimum' || operation === 'maximum') && def.supportedOperations.includes('list')) {
      operation = 'list';
    } else {
      throw new ErpQueryError('unsupported_operation', `Operation "${operation}" is not meaningful for ${def.label}. Supported: ${def.supportedOperations.join(', ')}.`);
    }
  }

  const filters: ErpFilter[] = [];
  const statusFilter = detectStatusFilter(q, entity);
  if (statusFilter) filters.push(statusFilter);

  // "unpaid invoices" style without explicit entity status handling for customers owing.
  if (entity === 'invoices' && /which customers? (owe|have|with)/.test(lower)) {
    filters.push({ field: 'status', operator: 'eq', value: 'unpaid' });
    if (operation !== 'group_by') operation = 'group_by';
  }

  const custRef = detectCustomerRef(q);
  if (custRef?.name && def.filterableFields.includes('customerName')) {
    filters.push({ field: 'customerName', operator: 'contains', value: custRef.name });
  } else if (custRef?.name && entity === 'customers') {
    filters.push({ field: 'businessName', operator: 'contains', value: custRef.name });
  }
  const suppRef = detectSupplierRef(q);
  if (suppRef && def.filterableFields.includes('supplierName')) {
    filters.push({ field: 'supplierName', operator: 'contains', value: suppRef });
  } else if (suppRef && entity === 'suppliers') {
    filters.push({ field: 'name', operator: 'contains', value: suppRef });
  }
  const prodRef = detectProductRef(q);
  const productFilterEntities: ErpEntityId[] = ['order_items', 'invoice_items', 'products', 'inventory_transactions'];
  if (prodRef && productFilterEntities.includes(entity)) {
    const field = entity === 'products' ? 'name' : entity === 'inventory_transactions' ? 'itemName' : 'productName';
    filters.push({ field, operator: 'contains', value: prodRef });
  } else if (prodRef && (entity === 'orders' || entity === 'invoices' || entity === 'purchases')) {
    // Product-scoped document question ("show orders for Exercise Books") → keep hint; executor filters lines.
    filters.push({ field: entity === 'purchases' ? 'supplierName' : 'customerName', operator: 'contains', value: '__none__' });
    filters.pop(); // do not fabricate; record hint only
  }
  const method = detectPaymentMethod(q);
  if (method && def.filterableFields.includes('paymentMethod')) {
    filters.push({ field: 'paymentMethod', operator: 'eq', value: method });
  }
  const idRef = detectId(q);
  if (idRef && (def.filterableFields.includes('id') || def.filterableFields.includes('invoiceNumber') || def.filterableFields.includes('orderNumber'))) {
    const idField = entity === 'invoices' ? 'invoiceNumber' : entity === 'orders' ? 'orderNumber' : 'id';
    if (operation === 'retrieve' || /allocat|detail|show.*INV|payment.*for.*INV/i.test(q)) {
      filters.push({ field: idField, operator: 'eq', value: idRef });
    }
  }

  // Inherit follow-up scope (customer/date) when the new question drops it.
  if (inherited) {
    const hasCustomer = filters.some((f) => f.field === 'customerName' || f.field === 'businessName');
    const inheritedCustomer = inherited.filters.find((f) => f.field === 'customerName' || f.field === 'businessName');
    if (!hasCustomer && inheritedCustomer && def.filterableFields.includes('customerName')) {
      filters.push(inheritedCustomer);
    }
    if (!hasCustomer && inheritedCustomer && entity === 'customers' && def.filterableFields.includes('businessName')) {
      filters.push({ field: 'businessName', operator: inheritedCustomer.operator, value: inheritedCustomer.value });
    }
  }

  let dateScope: DateScope | null = null;
  try {
    dateScope = resolveDateScope(q, def.dateField, now);
  } catch (e) {
    throw e;
  }
  if (!dateScope && inherited?.dateScope && def.dateFields.includes(inherited.dateScope.dateField)) {
    dateScope = { ...inherited.dateScope, dateField: def.dateField };
  } else if (!dateScope && inherited?.dateScope && def.dateFields.length > 0) {
    dateScope = { ...inherited.dateScope, dateField: def.dateField };
  }

  // Aggregates + groupBy inference.
  const aggregates: InterpretedErpQuery['query']['aggregates'] = [];
  const groupBy: string[] = [];
  const metric = ENTITY_DEFAULT_METRIC[entity];

  if (operation === 'sum' || operation === 'average' || operation === 'minimum' || operation === 'maximum' || operation === 'compare') {
    let field = metric || '';
    if (/quantit|units|pieces|copies/.test(lower) && def.aggregatableFields.includes('quantity')) field = 'quantity';
    else if (/quantit/.test(lower) && def.aggregatableFields.includes('itemCount')) field = 'itemCount';
    else if (/(outstanding|owe|owing|balance|receivable)/.test(lower) && def.aggregatableFields.includes('outstanding')) field = 'outstanding';
    else if (/\bpaid\b|\bcollection\b|\breceived\b/.test(lower) && entity === 'invoices' && def.aggregatableFields.includes('paidAmount') && !/\bunpaid\b/.test(lower)) field = 'paidAmount';
    else if (/(expense|spent)/.test(lower) && def.aggregatableFields.includes('amount')) field = 'amount';
    else if (/(stock|inventory|on hand)/.test(lower) && def.aggregatableFields.includes('stock')) field = 'stock';
    else if (/(value|worth|total)/.test(lower) && def.aggregatableFields.includes('inventoryValue') && entity === 'products' && /value|worth|valuation/.test(lower)) field = 'inventoryValue';
    else if (metric && !def.aggregatableFields.includes(metric)) field = def.aggregatableFields[0] || '';
    if (!field) throw new ErpQueryError('unsupported_operation', `Cannot total ${def.label} — no aggregatable field.`);
    const op = operation === 'average' ? 'avg' : operation === 'minimum' ? 'min' : operation === 'maximum' ? 'max' : 'sum';
    aggregates.push({ field, operation: op as never, as: `${op}_${field}` });
  }
  if (operation === 'group_by') {
    if (/by customer|which customers?|top.*customers?|customers? spent/.test(lower) && def.groupableFields.includes('customerName')) groupBy.push('customerName');
    else if (/by product|by item|for each product|each item|which product|best.?sell|sold the most/.test(lower)) {
      if (def.groupableFields.includes('productName')) groupBy.push('productName');
      else if (def.groupableFields.includes('productId')) groupBy.push('productId');
      else if (def.groupableFields.includes('category')) groupBy.push('category');
    }
    else if (/by categor/.test(lower) && def.groupableFields.includes('category')) groupBy.push('category');
    else if (/by status/.test(lower) && def.groupableFields.includes('status')) groupBy.push('status');
    else if (/by supplier|which supplier/.test(lower) && def.groupableFields.includes('supplierName')) groupBy.push('supplierName');
    else if (/by month|monthly|per month/.test(lower) && def.groupableFields.includes('dateMonth')) groupBy.push('dateMonth');
    else if (/by payment/.test(lower) && def.groupableFields.includes('paymentMethod')) groupBy.push('paymentMethod');
    else {
      // Sensible defaults per entity.
      if (entity === 'order_items' || entity === 'invoice_items') groupBy.push('productName');
      else if (entity === 'invoices' && /customer|owe|spent/.test(lower)) groupBy.push('customerName');
      else if (def.groupableFields.includes('status')) groupBy.push('status');
      else if (def.groupableFields.length > 0) groupBy.push(def.groupableFields[0]);
    }
    // Default aggregate for the grouping.
    if (/(outstanding|owe|owing|balance)/.test(lower) && def.aggregatableFields.includes('outstanding')) {
      aggregates.push({ field: 'outstanding', operation: 'sum', as: 'sum_outstanding' });
    } else if (/quantit|units|sold|purchased/.test(lower) && def.aggregatableFields.includes('quantity')) {
      aggregates.push({ field: 'quantity', operation: 'sum', as: 'sum_quantity' });
    } else if (metric && def.aggregatableFields.includes(metric)) {
      aggregates.push({ field: metric, operation: 'sum', as: `sum_${metric}` });
    } else if (def.aggregatableFields.length > 0) {
      aggregates.push({ field: def.aggregatableFields[0], operation: 'sum', as: `sum_${def.aggregatableFields[0]}` });
    }
    if (groupBy.length === 0) throw new ErpQueryError('unsupported_field', `Cannot group ${def.label} for this question.`);
    if (aggregates.length === 0) throw new ErpQueryError('unsupported_operation', `Cannot aggregate ${def.label} for this question.`);
  }
  if (operation === 'distinct_count') {
    const field = /customer/.test(lower) && def.readableFields.includes('customerName')
      ? 'customerName'
      : /product|item/.test(lower) && def.readableFields.includes('productName')
        ? 'productName'
        : 'id';
    aggregates.push({ field, operation: 'distinct_count', as: `distinct_${field}` });
  }

  const relationship = detectRelationship(q, entity, conversation ?? null) || inherited?.relationship || null;
  // The id in an allocation question belongs to the parent (invoice), not the
  // child payment — the relationship carries it, so drop the child id filter.
  if (relationship?.parentId) {
    const parentId = relationship.parentId.trim().toLowerCase();
    for (let i = filters.length - 1; i >= 0; i--) {
      const f = filters[i];
      if ((f.field === 'id' || f.field === 'invoiceNumber' || f.field === 'orderNumber') && String(f.value).trim().toLowerCase() === parentId) {
        filters.splice(i, 1);
      }
    }
  }

  const searchHint = custRef?.name || suppRef || prodRef || idRef || undefined;

  const erpQuery: ErpQuery = {
    entity,
    operation,
    filters,
    groupBy,
    aggregates,
    sort: detectSort(q, entity),
    limit: detectLimit(q),
    dateScope,
    comparison,
    relationship,
    searchHint: searchHint || undefined,
  };

  return { query: erpQuery, warnings: [], clarification: null };
}
