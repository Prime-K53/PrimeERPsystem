/**
 * entityRegistry.ts — Extensible capability map for the Copilot ERP query layer.
 *
 * Adding a new readable ERP entity = adding one entry here (plus wiring its
 * dataset in copilotQueryService). No Copilot redesign, no new AI handler.
 *
 * Each entry declares:
 *   - which read-only operations make semantic sense
 *   - which fields are readable / filterable / groupable / aggregatable
 *   - which date field natural-language dates apply to
 *   - which relationships can be traversed (stable-ID links, never name guessing)
 *   - which existing ERP permission gates reads
 *
 * Field names are CANONICAL. Historical spellings (total vs totalAmount,
 * customer_name vs customerName, …) are normalised in fieldResolvers.ts so
 * the registry stays clean while real-world records keep working.
 */

import { ErpQueryError } from './erpQueryTypes';
import type { ErpEntityId, ErpOperation } from './erpQueryTypes';

export interface ErpRelationshipDef {
  /** Stable key used in ErpQuery.relationship.via. */
  key: string;
  /** Entity on the other side of the link. */
  targetEntity: ErpEntityId;
  /** How the link is resolved (stable ID field preferred, name fallback documented). */
  description: string;
}

export interface ErpEntityDef {
  id: ErpEntityId;
  label: string;
  /** Key in ErpDataset carrying this entity's rows. */
  datasetKey: ErpEntityId;
  supportedOperations: ErpOperation[];
  readableFields: string[];
  filterableFields: string[];
  groupableFields: string[];
  aggregatableFields: string[];
  /** Default date field for natural-language date scoping. */
  dateField: string;
  /** All date fields that may carry a DateScope. */
  dateFields: string[];
  /** Canonical status values (lowercased) when the entity has a status concept. */
  statuses: string[];
  relationships: ErpRelationshipDef[];
  /** Existing ERP permission that gates reads (see constants.ts AVAILABLE_PERMISSIONS). */
  requiredPermission: string;
  notes: string;
}

const baseOps: ErpOperation[] = ['count', 'list', 'retrieve'];
const metricOps: ErpOperation[] = ['sum', 'average', 'minimum', 'maximum', 'group_by', 'distinct_count', 'compare'];

export const ENTITY_REGISTRY: Record<ErpEntityId, ErpEntityDef> = {
  orders: {
    id: 'orders',
    label: 'Sales orders',
    datasetKey: 'orders',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'orderNumber', 'customerId', 'customerName', 'date', 'orderDate', 'status', 'paymentStatus', 'invoiceStatus', 'totalAmount', 'subtotal', 'paidAmount', 'remainingBalance', 'itemCount'],
    filterableFields: ['id', 'orderNumber', 'customerId', 'customerName', 'status', 'paymentStatus', 'date', 'orderDate', 'totalAmount'],
    groupableFields: ['status', 'paymentStatus', 'customerName', 'dateMonth'],
    aggregatableFields: ['totalAmount', 'paidAmount', 'remainingBalance', 'itemCount'],
    dateField: 'date',
    dateFields: ['date', 'orderDate'],
    statuses: ['pending', 'confirmed', 'fulfilled', 'completed', 'paid', 'partially paid', 'converted', 'cancelled', 'invoiced'],
    relationships: [
      { key: 'order_items', targetEntity: 'order_items', description: 'Order → its line items via the order items array (stable productId first).' },
      { key: 'item_order', targetEntity: 'order_items', description: 'Alias: line → parent order (accepted when querying order lines by order).' },
      { key: 'customer_orders', targetEntity: 'customers', description: 'Alias: customer → orders (accepted when querying orders by customer).' },
      { key: 'order_customer', targetEntity: 'customers', description: 'Order → customer via customerId, businessName fallback.' },
      { key: 'order_invoice', targetEntity: 'invoices', description: 'Order → related invoice via order/invoice linkage where present.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Canonical sales orders (salesOrders store, legacy Orders projection). Totals use totalAmount.',
  },
  order_items: {
    id: 'order_items',
    label: 'Order lines',
    datasetKey: 'order_items',
    supportedOperations: ['count', 'list', 'sum', 'average', 'minimum', 'maximum', 'group_by', 'distinct_count', 'compare'],
    readableFields: ['id', 'orderId', 'productId', 'productName', 'quantity', 'unitPrice', 'subtotal', 'orderDate', 'customerName', 'customerId', 'orderStatus'],
    filterableFields: ['orderId', 'productId', 'productName', 'customerId', 'customerName', 'orderStatus', 'orderDate'],
    groupableFields: ['productName', 'productId', 'customerName', 'orderStatus'],
    aggregatableFields: ['quantity', 'subtotal'],
    dateField: 'orderDate',
    dateFields: ['orderDate'],
    statuses: [],
    relationships: [
      { key: 'item_order', targetEntity: 'orders', description: 'Line → parent order via orderId.' },
      { key: 'item_product', targetEntity: 'products', description: 'Line → product via stable productId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Virtual entity flattened from order.items arrays. Powers "total their quantities" style aggregations.',
  },
  quotations: {
    id: 'quotations',
    label: 'Quotations',
    datasetKey: 'quotations',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'customerId', 'customerName', 'date', 'validUntil', 'status', 'totalAmount', 'itemCount'],
    filterableFields: ['id', 'customerId', 'customerName', 'status', 'date'],
    groupableFields: ['status', 'customerName', 'dateMonth'],
    aggregatableFields: ['totalAmount', 'itemCount'],
    dateField: 'date',
    dateFields: ['date', 'validUntil'],
    statuses: ['draft', 'pending', 'sent', 'approved', 'converted', 'rejected', 'expired', 'cancelled'],
    relationships: [
      { key: 'quotation_customer', targetEntity: 'customers', description: 'Quotation → customer via customerId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Quotation totals use total/totalAmount canonical total.',
  },
  invoices: {
    id: 'invoices',
    label: 'Invoices',
    datasetKey: 'invoices',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'invoiceNumber', 'customerId', 'customerName', 'date', 'dueDate', 'status', 'totalAmount', 'paidAmount', 'outstanding', 'itemCount'],
    filterableFields: ['id', 'invoiceNumber', 'customerId', 'customerName', 'status', 'date', 'dueDate', 'totalAmount', 'outstanding'],
    groupableFields: ['status', 'customerName', 'dateMonth'],
    aggregatableFields: ['totalAmount', 'paidAmount', 'outstanding', 'itemCount'],
    dateField: 'date',
    dateFields: ['date', 'dueDate'],
    statuses: ['draft', 'unpaid', 'partial', 'partially paid', 'paid', 'overdue', 'cancelled', 'void', 'voided', 'credit_note'],
    relationships: [
      { key: 'invoice_items', targetEntity: 'invoice_items', description: 'Invoice → its line items.' },
      { key: 'invoice_customer', targetEntity: 'customers', description: 'Invoice → customer via customerId.' },
      { key: 'customer_invoices', targetEntity: 'customers', description: 'Alias: customer → invoices (accepted when querying invoices by customer).' },
      { key: 'invoice_payments', targetEntity: 'customer_payments', description: 'Invoice → payments via payment allocation lines (authoritative).' },
      { key: 'order_invoice', targetEntity: 'orders', description: 'Alias: order → invoice linkage (accepted when querying invoices by order).' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Authoritative invoice data. Outstanding = totalAmount − paidAmount (customerLedger rules for customer scope).',
  },
  invoice_items: {
    id: 'invoice_items',
    label: 'Invoice lines',
    datasetKey: 'invoice_items',
    supportedOperations: ['count', 'list', 'sum', 'average', 'minimum', 'maximum', 'group_by', 'distinct_count'],
    readableFields: ['id', 'invoiceId', 'productId', 'productName', 'quantity', 'unitPrice', 'subtotal', 'invoiceDate', 'customerName', 'customerId'],
    filterableFields: ['invoiceId', 'productId', 'productName', 'customerId', 'customerName', 'invoiceDate'],
    groupableFields: ['productName', 'productId', 'customerName'],
    aggregatableFields: ['quantity', 'subtotal'],
    dateField: 'invoiceDate',
    dateFields: ['invoiceDate'],
    statuses: [],
    relationships: [
      { key: 'line_invoice', targetEntity: 'invoices', description: 'Line → parent invoice via invoiceId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Virtual entity flattened from invoice.items arrays.',
  },
  customer_payments: {
    id: 'customer_payments',
    label: 'Customer payments / receipts',
    datasetKey: 'customer_payments',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'customerId', 'customerName', 'date', 'amount', 'paymentMethod', 'reference', 'status', 'allocatedTotal', 'invoiceId'],
    filterableFields: ['id', 'customerId', 'customerName', 'date', 'paymentMethod', 'status', 'reference', 'invoiceId'],
    groupableFields: ['customerName', 'paymentMethod', 'status', 'dateMonth'],
    aggregatableFields: ['amount', 'allocatedTotal'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['cleared', 'pending', 'cancelled', 'voided'],
    relationships: [
      { key: 'payment_customer', targetEntity: 'customers', description: 'Payment → customer via customerId.' },
      { key: 'customer_payments', targetEntity: 'customers', description: 'Alias: customer → payments (accepted when querying payments by customer).' },
      { key: 'payment_invoices', targetEntity: 'invoices', description: 'Payment → invoices via allocation lines (authoritative).' },
      { key: 'invoice_payments', targetEntity: 'invoices', description: 'Alias: invoice → payments (accepted when querying payments by invoice).' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Uses the ERP allocation model (allocations[].invoiceId/amount). paymentCredit() is authoritative for settlement value.',
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    datasetKey: 'customers',
    supportedOperations: ['count', 'list', 'retrieve', 'group_by', 'distinct_count'],
    readableFields: ['id', 'businessName', 'contactName', 'email', 'phone', 'status', 'outstandingBalance', 'totalSpent'],
    filterableFields: ['id', 'businessName', 'contactName', 'email', 'phone', 'status'],
    groupableFields: ['status'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: [],
    statuses: ['active', 'inactive'],
    relationships: [
      { key: 'customer_orders', targetEntity: 'orders', description: 'Customer → orders via customerId.' },
      { key: 'customer_quotations', targetEntity: 'quotations', description: 'Customer → quotations via customerId.' },
      { key: 'customer_invoices', targetEntity: 'invoices', description: 'Customer → invoices via customerId.' },
      { key: 'customer_payments', targetEntity: 'customer_payments', description: 'Customer → payments via customerId.' },
      { key: 'customer_wallet', targetEntity: 'wallet_transactions', description: 'Customer → wallet records via customerId.' },
      { key: 'customer_referrals', targetEntity: 'referrals', description: 'Customer → referral records via referrer id.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Canonical identity is businessName/business_name (contactName is the contact person only).',
  },
  suppliers: {
    id: 'suppliers',
    label: 'Suppliers',
    datasetKey: 'suppliers',
    supportedOperations: ['count', 'list', 'retrieve', 'group_by', 'distinct_count'],
    readableFields: ['id', 'name', 'email', 'phone', 'status', 'totalSpend'],
    filterableFields: ['id', 'name', 'email', 'phone', 'status'],
    groupableFields: ['status'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: [],
    statuses: ['active', 'inactive'],
    relationships: [
      { key: 'supplier_purchases', targetEntity: 'purchases', description: 'Supplier → purchases via supplierId.' },
      { key: 'supplier_payments', targetEntity: 'supplier_payments', description: 'Supplier → payments via supplierId.' },
    ],
    requiredPermission: 'procurement.view',
    notes: 'Supplier identity is stable id first, name second.',
  },
  products: {
    id: 'products',
    label: 'Products / items',
    datasetKey: 'products',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'name', 'sku', 'type', 'category', 'stock', 'cost', 'price', 'reorderPoint', 'inventoryValue', 'isStockBearing', 'status'],
    filterableFields: ['id', 'name', 'sku', 'type', 'category', 'stock', 'status'],
    groupableFields: ['type', 'category'],
    aggregatableFields: ['stock', 'inventoryValue', 'cost', 'price'],
    dateField: 'date',
    dateFields: [],
    statuses: ['active', 'inactive'],
    relationships: [
      { key: 'product_movements', targetEntity: 'inventory_transactions', description: 'Product → stock movements via itemId.' },
      { key: 'product_supplier', targetEntity: 'suppliers', description: 'Product → preferred supplier via preferredSupplierId.' },
    ],
    requiredPermission: 'inventory.view',
    notes: 'Respects stock-bearing vs service distinction (isInventoryBearingItem). Valuation = qty × cost, never selling price.',
  },
  inventory_transactions: {
    id: 'inventory_transactions',
    label: 'Stock movements',
    datasetKey: 'inventory_transactions',
    supportedOperations: ['count', 'list', 'sum', 'average', 'minimum', 'maximum', 'group_by', 'distinct_count', 'compare'],
    readableFields: ['id', 'itemId', 'itemName', 'type', 'quantity', 'date', 'warehouseId', 'reference'],
    filterableFields: ['itemId', 'itemName', 'type', 'date', 'warehouseId', 'reference'],
    groupableFields: ['itemName', 'type', 'warehouseId'],
    aggregatableFields: ['quantity'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: [],
    relationships: [
      { key: 'movement_product', targetEntity: 'products', description: 'Movement → product via itemId.' },
    ],
    requiredPermission: 'inventory.view',
    notes: 'OUT deductions and IN additions from inventoryTransactionService records.',
  },
  purchases: {
    id: 'purchases',
    label: 'Purchase orders / bills',
    datasetKey: 'purchases',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'supplierId', 'supplierName', 'date', 'status', 'totalAmount', 'itemCount'],
    filterableFields: ['id', 'supplierId', 'supplierName', 'status', 'date'],
    groupableFields: ['status', 'supplierName', 'dateMonth'],
    aggregatableFields: ['totalAmount', 'itemCount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['draft', 'pending', 'approved', 'received', 'partial', 'cancelled', 'paid', 'partially paid', 'unpaid'],
    relationships: [
      { key: 'purchase_supplier', targetEntity: 'suppliers', description: 'Purchase → supplier via supplierId.' },
    ],
    requiredPermission: 'procurement.view',
    notes: 'Purchase totals use getPurchaseTotal() semantics (totalAmount preferred, total fallback).',
  },
  expenses: {
    id: 'expenses',
    label: 'Expenses',
    datasetKey: 'expenses',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'date', 'description', 'category', 'amount', 'paymentMethod', 'status'],
    filterableFields: ['id', 'description', 'category', 'paymentMethod', 'status', 'date', 'amount'],
    groupableFields: ['category', 'paymentMethod', 'status', 'dateMonth'],
    aggregatableFields: ['amount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['approved', 'paid', 'pending approval', 'pending'],
    relationships: [],
    requiredPermission: 'accounts.view',
    notes: 'Expense amounts are authoritative as stored.',
  },
  sales: {
    id: 'sales',
    label: 'POS / counter sales',
    datasetKey: 'sales',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'customerId', 'customerName', 'date', 'totalAmount', 'status', 'itemCount'],
    filterableFields: ['id', 'customerId', 'customerName', 'status', 'date'],
    groupableFields: ['status', 'customerName', 'dateMonth'],
    aggregatableFields: ['totalAmount', 'itemCount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['completed', 'refunded', 'voided', 'cancelled'],
    relationships: [
      { key: 'sale_customer', targetEntity: 'customers', description: 'Sale → customer via customerId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'POS sale records. Distinct from invoices and orders.',
  },
  delivery_notes: {
    id: 'delivery_notes',
    label: 'Delivery notes',
    datasetKey: 'delivery_notes',
    supportedOperations: [...baseOps, 'group_by', 'distinct_count'],
    readableFields: ['id', 'invoiceId', 'customerName', 'date', 'status'],
    filterableFields: ['id', 'invoiceId', 'customerName', 'status', 'date'],
    groupableFields: ['status', 'customerName'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['pending', 'in transit', 'delivered', 'cancelled'],
    relationships: [
      { key: 'delivery_invoice', targetEntity: 'invoices', description: 'Delivery note → invoice via invoiceId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Delivery notes link to invoices where present.',
  },
  supplier_payments: {
    id: 'supplier_payments',
    label: 'Supplier payments',
    datasetKey: 'supplier_payments',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'supplierId', 'date', 'amount', 'paymentMethod', 'reference', 'status'],
    filterableFields: ['supplierId', 'date', 'paymentMethod', 'status', 'reference'],
    groupableFields: ['supplierId', 'paymentMethod', 'status', 'dateMonth'],
    aggregatableFields: ['amount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: [],
    relationships: [
      { key: 'supplier_payment_supplier', targetEntity: 'suppliers', description: 'Payment → supplier via supplierId.' },
    ],
    requiredPermission: 'procurement.view',
    notes: 'Outbound supplier payments (distinct from customer receipts).',
  },
  income: {
    id: 'income',
    label: 'Other income / receipts',
    datasetKey: 'income',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'date', 'description', 'category', 'amount'],
    filterableFields: ['id', 'description', 'category', 'date'],
    groupableFields: ['category', 'dateMonth'],
    aggregatableFields: ['amount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: [],
    relationships: [],
    requiredPermission: 'accounts.view',
    notes: 'Non-invoice income records.',
  },
  goods_receipts: {
    id: 'goods_receipts',
    label: 'Goods receipts (GRN)',
    datasetKey: 'goods_receipts',
    supportedOperations: [...baseOps, 'group_by', 'distinct_count'],
    readableFields: ['id', 'purchaseId', 'date', 'status', 'itemCount'],
    filterableFields: ['id', 'purchaseId', 'status', 'date'],
    groupableFields: ['status'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['pending', 'completed', 'cancelled', 'verified'],
    relationships: [
      { key: 'grn_purchase', targetEntity: 'purchases', description: 'GRN → purchase via purchaseId.' },
    ],
    requiredPermission: 'inventory.view',
    notes: 'Goods receipt notes verifying purchase receipts.',
  },
  shipments: {
    id: 'shipments',
    label: 'Shipments',
    datasetKey: 'shipments',
    supportedOperations: [...baseOps, 'group_by', 'distinct_count'],
    readableFields: ['id', 'orderId', 'customerName', 'date', 'status', 'trackingNumber'],
    filterableFields: ['id', 'orderId', 'customerName', 'status', 'date'],
    groupableFields: ['status', 'customerName'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['pending', 'in transit', 'delivered', 'cancelled'],
    relationships: [
      { key: 'shipment_order', targetEntity: 'orders', description: 'Shipment → order via orderId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Shipment/delivery tracking records.',
  },
  wallet_transactions: {
    id: 'wallet_transactions',
    label: 'Wallet records',
    datasetKey: 'wallet_transactions',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'customerId', 'date', 'amount', 'type', 'reference'],
    filterableFields: ['customerId', 'type', 'date', 'reference'],
    groupableFields: ['type', 'customerId'],
    aggregatableFields: ['amount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: [],
    relationships: [
      { key: 'wallet_customer', targetEntity: 'customers', description: 'Wallet record → customer via customerId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Wallet liability movements (top-ups excluded from receivable settlement).',
  },
  referrals: {
    id: 'referrals',
    label: 'Referrals / rewards',
    datasetKey: 'referrals',
    supportedOperations: ['count', 'list', 'retrieve', 'sum', 'average', 'group_by', 'distinct_count'],
    readableFields: ['id', 'referredById', 'referredByName', 'date', 'status', 'rewardAmount'],
    filterableFields: ['referredById', 'referredByName', 'status', 'date'],
    groupableFields: ['status', 'referredByName'],
    aggregatableFields: ['rewardAmount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: ['active', 'converted', 'pending', 'cancelled'],
    relationships: [
      { key: 'referral_referrer', targetEntity: 'customers', description: 'Referral → referrer via referredById.' },
    ],
    requiredPermission: 'referrals.view',
    notes: 'Referral and reward records.',
  },
  examination_batches: {
    id: 'examination_batches',
    label: 'Examination records',
    datasetKey: 'examination_batches',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'name', 'schoolId', 'customerName', 'date', 'status', 'totalAmount', 'learnerCount'],
    filterableFields: ['id', 'name', 'schoolId', 'customerName', 'status', 'date'],
    groupableFields: ['status', 'customerName'],
    aggregatableFields: ['totalAmount', 'learnerCount'],
    dateField: 'date',
    dateFields: ['date'],
    statuses: [],
    relationships: [
      { key: 'exam_customer', targetEntity: 'customers', description: 'Batch → school/customer via schoolId.' },
    ],
    requiredPermission: 'production.view',
    notes: 'Examination batches (school printing jobs).',
  },
  work_orders: {
    id: 'work_orders',
    label: 'Work orders / production',
    datasetKey: 'work_orders',
    supportedOperations: [...baseOps, 'group_by', 'distinct_count'],
    readableFields: ['id', 'productName', 'customerName', 'status', 'quantityPlanned', 'quantityCompleted', 'dueDate'],
    filterableFields: ['id', 'productName', 'customerName', 'status', 'dueDate'],
    groupableFields: ['status', 'productName'],
    aggregatableFields: ['quantityPlanned', 'quantityCompleted'],
    dateField: 'dueDate',
    dateFields: ['dueDate'],
    statuses: ['draft', 'scheduled', 'in progress', 'on hold', 'qa', 'completed', 'cancelled'],
    relationships: [
      { key: 'wo_bom', targetEntity: 'boms', description: 'Work order → BOM via bomId.' },
    ],
    requiredPermission: 'production.view',
    notes: 'Production work orders. Quantities aggregate deterministically.',
  },
  boms: {
    id: 'boms',
    label: 'Bills of materials',
    datasetKey: 'boms',
    supportedOperations: ['count', 'list', 'retrieve', 'group_by', 'distinct_count'],
    readableFields: ['id', 'name', 'productId', 'productName', 'status', 'componentCount'],
    filterableFields: ['id', 'name', 'productId', 'productName', 'status'],
    groupableFields: ['status'],
    aggregatableFields: [],
    dateField: 'date',
    dateFields: [],
    statuses: ['active', 'draft', 'archived'],
    relationships: [],
    requiredPermission: 'production.view',
    notes: 'BOM recipes (components counted, never costed here — costing lives in production services).',
  },
  subscriptions: {
    id: 'subscriptions',
    label: 'Subscriptions / recurring invoices',
    datasetKey: 'subscriptions',
    supportedOperations: [...baseOps, ...metricOps],
    readableFields: ['id', 'customerId', 'customerName', 'status', 'totalAmount', 'frequency', 'nextRunDate'],
    filterableFields: ['id', 'customerId', 'customerName', 'status', 'frequency'],
    groupableFields: ['status', 'frequency'],
    aggregatableFields: ['totalAmount'],
    dateField: 'nextRunDate',
    dateFields: ['nextRunDate'],
    statuses: ['active', 'paused', 'expired', 'cancelled'],
    relationships: [
      { key: 'subscription_customer', targetEntity: 'customers', description: 'Subscription → customer via customerId.' },
    ],
    requiredPermission: 'sales.view',
    notes: 'Recurring billing profiles (subscriptions). Totals use total/totalAmount.',
  },
};

export function getEntityDef(entity: string): ErpEntityDef {
  const def = (ENTITY_REGISTRY as Record<string, ErpEntityDef>)[entity];
  if (!def) {
    throw new ErpQueryError('unsupported_entity', `Unsupported entity "${entity}". Ask about orders, invoices, payments, customers, products, inventory, quotations, purchases, expenses, or another registered ERP entity.`);
  }
  return def;
}

export function listRegisteredEntities(): ErpEntityId[] {
  return Object.keys(ENTITY_REGISTRY) as ErpEntityId[];
}

export function assertOperationSupported(entity: ErpEntityId, operation: string): void {
  const def = ENTITY_REGISTRY[entity];
  if (!def.supportedOperations.includes(operation as ErpOperation)) {
    throw new ErpQueryError(
      'unsupported_operation',
      `Operation "${operation}" is not meaningful for ${def.label}. Supported: ${def.supportedOperations.join(', ')}.`,
    );
  }
}

export function assertFieldReadable(entity: ErpEntityId, field: string): void {
  const def = ENTITY_REGISTRY[entity];
  if (!def.readableFields.includes(field)) {
    throw new ErpQueryError('unsupported_field', `Field "${field}" is not readable on ${def.label}. Readable: ${def.readableFields.join(', ')}.`);
  }
}

export function assertFieldFilterable(entity: ErpEntityId, field: string): void {
  const def = ENTITY_REGISTRY[entity];
  if (!def.filterableFields.includes(field)) {
    throw new ErpQueryError('unsupported_field', `Cannot filter ${def.label} by "${field}". Filterable: ${def.filterableFields.join(', ')}.`);
  }
}
