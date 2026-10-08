/**
 * customerPaymentQuery.cjs
 *
 * Shared query builder for GET /api/customer-payments.
 * Pure function (no DB access) so it is unit-testable.
 *
 * Supported filters: search, customer, method, status, dateFrom, dateTo,
 * minAmount, maxAmount, reconciled, invoiceId (allocation lines),
 * sortBy (date|amount|customer_name|status), sortDir, page, pageSize.
 */

const SORT_COLUMNS = {
  date: 'date',
  amount: 'amount',
  customer_name: 'customer_name',
  status: 'status',
};

function toInt(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildCustomerPaymentsQuery(query = {}) {
  const where = [];
  const params = [];

  const like = (col, value) => {
    where.push(`${col} LIKE ?`);
    params.push(`%${value}%`);
  };

  if (query.search) {
    where.push('(id LIKE ? OR customer_name LIKE ? OR reference LIKE ? OR notes LIKE ?)');
    const s = `%${query.search}%`;
    params.push(s, s, s, s);
  }
  if (query.customer) like('customer_name', query.customer);
  if (query.method) {
    where.push('payment_method = ?');
    params.push(query.method);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.dateFrom) {
    where.push('date(date) >= date(?)');
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    where.push('date(date) <= date(?)');
    params.push(query.dateTo);
  }
  const min = toNum(query.minAmount);
  if (min != null) {
    where.push('amount >= ?');
    params.push(min);
  }
  const max = toNum(query.maxAmount);
  if (max != null) {
    where.push('amount <= ?');
    params.push(max);
  }
  if (query.reconciled === 'true' || query.reconciled === '1') {
    where.push('reconciled = 1');
  } else if (query.reconciled === 'false' || query.reconciled === '0') {
    where.push('(reconciled = 0 OR reconciled IS NULL)');
  }
  if (query.invoiceId) {
    where.push(`id IN (SELECT payment_id FROM payment_allocations WHERE id IN (SELECT allocation_id FROM payment_allocation_lines WHERE invoice_id LIKE ?))`);
    params.push(`%${query.invoiceId}%`);
  }

  const sortCol = SORT_COLUMNS[String(query.sortBy || 'date')] || 'date';
  const sortDir = String(query.sortDir || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  let sql = 'SELECT * FROM customer_payments';
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${sortCol} ${sortDir}`;

  const page = Math.max(1, toInt(query.page, 1));
  const pageSize = Math.max(1, Math.min(200, toInt(query.pageSize, 50)));
  const paginated = query.page != null || query.pageSize != null;
  if (paginated) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(pageSize, (page - 1) * pageSize);
  } else {
    sql += ' LIMIT 500';
  }

  let countSql = 'SELECT COUNT(*) AS total FROM customer_payments';
  if (where.length > 0) countSql += ` WHERE ${where.join(' AND ')}`;

  return { sql, params, countSql, countParams: params.slice(0, params.length - (paginated ? 2 : 0)), page, pageSize, paginated, sortCol, sortDir };
}

module.exports = { buildCustomerPaymentsQuery };
