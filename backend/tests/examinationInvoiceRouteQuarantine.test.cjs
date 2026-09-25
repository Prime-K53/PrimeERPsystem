/**
 * examinationInvoiceRouteQuarantine.test.cjs — P2 route-gate behaviour.
 *
 * Proves the HTTP layer refuses backend examination-invoice creation BEFORE
 * any database write (no tokenless invoice can be inserted through the
 * route), while the emergency bypass still reaches the service untouched.
 * Service module is mocked — no database, no network.
 */
jest.mock('../services/examinationService.cjs', () => ({
  generateInvoice: jest.fn(async () => ({ success: true, invoiceId: 1 })),
  regenerateInvoice: jest.fn(async () => ({ success: true, invoiceId: 2 })),
}));

const express = require('express');
const request = require('supertest');

const BYPASS_ENV = 'ALLOW_QUARANTINED_EXAMINATION_INVOICE';

function mountApp() {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line global-require
  app.use('/api/examination', require('../routes/examination.cjs'));
  return app;
}

describe('backend examination invoice route quarantine', () => {
  let original;

  beforeEach(() => {
    original = process.env[BYPASS_ENV];
    delete process.env[BYPASS_ENV];
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[BYPASS_ENV];
    else process.env[BYPASS_ENV] = original;
  });

  test('POST /batches/:id/invoice is refused before any service call', async () => {
    const app = mountApp();
    // eslint-disable-next-line global-require
    const service = require('../services/examinationService.cjs');
    const res = await request(app).post('/api/examination/batches/B1/invoice').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EXAMINATION_INVOICE_QUARANTINED');
    expect(res.body.quarantined).toBe(true);
    expect(service.generateInvoice).not.toHaveBeenCalled();
  });

  test('POST /batches/:id/regenerate-invoice is refused before any service call', async () => {
    const app = mountApp();
    // eslint-disable-next-line global-require
    const service = require('../services/examinationService.cjs');
    const res = await request(app).post('/api/examination/batches/B1/regenerate-invoice').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EXAMINATION_INVOICE_QUARANTINED');
    expect(service.regenerateInvoice).not.toHaveBeenCalled();
  });

  test('explicit bypass env reaches the service untouched', async () => {
    process.env[BYPASS_ENV] = 'true';
    const app = mountApp();
    // eslint-disable-next-line global-require
    const service = require('../services/examinationService.cjs');
    const res = await request(app).post('/api/examination/batches/B1/invoice').send({});
    expect(res.status).toBe(200);
    expect(service.generateInvoice).toHaveBeenCalledTimes(1);
  });
});
