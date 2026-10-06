import { describe, expect, it } from 'vitest';
import { getPaymentAccountOptions, PAYMENT_ACCOUNT_CODES } from '../../constants';

describe('getPaymentAccountOptions (canonical payment-account set)', () => {
  it('exposes Cash in Hand plus the four Bank Accounts children in code order', () => {
    expect(PAYMENT_ACCOUNT_CODES).toEqual(['11110', '11210', '11220', '11230', '11240']);
    const opts = getPaymentAccountOptions([]);
    expect(opts.map((o) => o.id)).toEqual(PAYMENT_ACCOUNT_CODES);
    expect(opts.map((o) => o.code)).toEqual(PAYMENT_ACCOUNT_CODES);
  });

  it('labels the cash posting account Cash in Hand', () => {
    const cash = getPaymentAccountOptions([])[0];
    expect(cash).toMatchObject({ id: '11110', code: '11110', name: 'Cash in Hand' });
  });

  it('falls back to seed names without live data', () => {
    const byId = Object.fromEntries(getPaymentAccountOptions().map((o) => [o.id, o.name]));
    expect(byId['11240']).toBe('Mobile Money');
    expect(byId['11210']).toBe('National Bank');
  });

  it('prefers live COA names so renames propagate to every payment modal', () => {
    const live = [
      { id: 'ACC-11220', account_number: '11220', name: 'FCB Bank' },
      { id: 'ACC-11230', account_number: '11230', name: 'Standard Bank' },
    ];
    const byId = Object.fromEntries(getPaymentAccountOptions(live).map((o) => [o.id, o.name]));
    expect(byId['11220']).toBe('FCB Bank');
    expect(byId['11230']).toBe('Standard Bank');
    // Untouched rows keep seed names; values stay codes.
    expect(byId['11240']).toBe('Mobile Money');
    expect(byId['11110']).toBe('Cash in Hand');
  });

  it('matches live rows by code, account_number, or id', () => {
    const byCode = getPaymentAccountOptions([{ code: '11220', name: 'FCB Bank' }]);
    expect(byCode[2].name).toBe('FCB Bank');
    const byId = getPaymentAccountOptions([{ id: '11220', name: 'FCB Bank' }]);
    expect(byId[2].name).toBe('FCB Bank');
  });
});
