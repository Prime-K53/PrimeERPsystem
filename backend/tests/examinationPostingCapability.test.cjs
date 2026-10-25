/**
 * Server capability probe for the authoritative Examination posting boundary.
 *
 * The browser cannot infer a server feature flag, and the old local setting was
 * never written — so the boundary was unreachable. These tests pin the public
 * endpoint contract and the environment gate it reports.
 */
const express = require('express');
const request = require('supertest');

const router = require('../routes/examination.cjs');

const app = express();
app.use('/api/examination', router);

const ENABLE_ENV = 'EXAMINATION_AUTHORITATIVE_POSTING';

describe('GET /api/examination/posting/capability', () => {
  afterEach(() => {
    delete process.env[ENABLE_ENV];
  });

  it('reports disabled when the authoritative boundary is off', async () => {
    delete process.env[ENABLE_ENV];

    const res = await request(app).get('/api/examination/posting/capability');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, boundary: 'examination' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports enabled exactly when the server feature flag is on', async () => {
    process.env[ENABLE_ENV] = 'true';

    const res = await request(app).get('/api/examination/posting/capability');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, boundary: 'examination' });
  });

  it('treats any value other than true as disabled', async () => {
    process.env[ENABLE_ENV] = '1';

    const res = await request(app).get('/api/examination/posting/capability');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('is reachable without authentication (public QR / pre-login probe)', async () => {
    const res = await request(app).get('/api/examination/posting/capability');
    expect(res.status).toBe(200);
  });
});
