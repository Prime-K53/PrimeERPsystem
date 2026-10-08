const { buildCustomerPaymentsQuery } = require('../services/customerPaymentQuery.cjs');

describe('buildCustomerPaymentsQuery', () => {
  it('builds a safe default query with a 500-row cap', () => {
    const q = buildCustomerPaymentsQuery({});
    expect(q.sql).toContain('SELECT * FROM customer_payments');
    expect(q.sql).toContain('ORDER BY date DESC');
    expect(q.sql).toContain('LIMIT 500');
    expect(q.paginated).toBe(false);
  });

  it('applies search/method/status/date/amount filters with bound params', () => {
    const q = buildCustomerPaymentsQuery({
      search: 'Acme', method: 'Cash', status: 'Cleared',
      dateFrom: '2026-01-01', dateTo: '2026-12-31',
      minAmount: '100', maxAmount: '500',
    });
    expect(q.sql).toContain('customer_name LIKE ?');
    expect(q.sql).toContain('payment_method = ?');
    expect(q.sql).toContain('status = ?');
    expect(q.sql).toContain('amount >= ?');
    expect(q.sql).toContain('amount <= ?');
    // No string interpolation of user input into SQL.
    expect(q.sql).not.toContain('Acme');
    expect(q.params).toContain('%Acme%');
    expect(q.params).toContain('Cash');
  });

  it('paginates and whitelists sort columns/directions', () => {
    const q = buildCustomerPaymentsQuery({ page: '2', pageSize: '25', sortBy: 'amount', sortDir: 'asc' });
    expect(q.sql).toContain('ORDER BY amount ASC');
    expect(q.sql).toContain('LIMIT ? OFFSET ?');
    expect(q.params.slice(-2)).toEqual([25, 25]);
    expect(q.page).toBe(2);

    const evil = buildCustomerPaymentsQuery({ sortBy: 'date; DROP TABLE x', sortDir: 'evil' });
    expect(evil.sql).toContain('ORDER BY date DESC');
    expect(evil.sql).not.toContain('DROP');
  });

  it('derives a matching count query without limit params', () => {
    const q = buildCustomerPaymentsQuery({ search: 'Beta', page: '1', pageSize: '10' });
    expect(q.countSql).toContain('SELECT COUNT(*) AS total');
    expect(q.countSql).toContain('customer_name LIKE ?');
    expect(q.countSql).not.toContain('LIMIT');
    expect(q.countParams).toHaveLength(q.params.length - 2);
  });
});
