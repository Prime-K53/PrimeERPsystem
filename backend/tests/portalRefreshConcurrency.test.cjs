/**
 * Portal refresh-token concurrency regression tests — hermetic.
 *
 * Defect under test: the old rotation order (revoke presented token, then
 * issue the replacement) meant two concurrent refreshes presenting the same
 * valid token destroyed each other — the loser received 401 and the frontend
 * wiped a perfectly valid session, bouncing the customer to login.
 *
 * Fixed order (create-before-revoke): the replacement is issued FIRST, so
 * concurrent duplicates each receive a valid, distinct token pair and the
 * presented token ends up revoked either way. Single-use semantics,
 * revocation, and expiry are preserved.
 *
 * Runs the REAL routes/portalAuth.cjs + services/portalAuthService.cjs chain
 * against the in-memory repo stub — no network, no database.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-portal-refresh-concurrency';

const SAVED_ENV = {};
function takeEnv(keys) {
  for (const key of keys) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
takeEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_SECRET_KEY']);

jest.mock('../services/supabaseRepository.cjs', () =>
  require('./helpers/supabaseRepoStub.cjs').repo
);

const express = require('express');
const request = require('supertest');

const repoStub = require('./helpers/supabaseRepoStub.cjs');

let app;
let server;
let port;
let globalHandlerHits;

beforeAll((done) => {
  const portalAuthRoutes = require('../routes/portalAuth.cjs');
  app = express();
  app.use(express.json());
  app.use('/api/portal/auth', (err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    next(err);
  });
  app.use('/api/portal/auth', portalAuthRoutes);
  app.use((err, req, res, next) => {
    globalHandlerHits.push(err && err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  });
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  restoreEnv();
  if (!server) return done();
  server.close(() => done());
});

beforeEach(() => {
  globalHandlerHits = [];
  repoStub.reset();
  repoStub.seedUser();
});

const postRefresh = (token) =>
  request(app)
    .post('/api/portal/auth/refresh')
    .send({ refresh_token: token });

describe('Portal refresh-token concurrency (create-before-revoke rotation)', () => {
  test('two concurrent refreshes with the same valid token BOTH succeed', async () => {
    repoStub.seedSession('shared-valid-token');
    const [a, b] = await Promise.all([
      postRefresh('shared-valid-token'),
      postRefresh('shared-valid-token'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body.access_token).toBe('string');
    expect(typeof b.body.access_token).toBe('string');
    expect(typeof a.body.refresh_token).toBe('string');
    expect(typeof b.body.refresh_token).toBe('string');
    expect(a.body.refresh_token).not.toBe('shared-valid-token');
    expect(b.body.refresh_token).not.toBe('shared-valid-token');
    // Distinct replacement pairs: neither racer stole the other's session.
    expect(a.body.refresh_token).not.toBe(b.body.refresh_token);
    expect(globalHandlerHits).toHaveLength(0);
  });

  test('both replacement tokens from a race remain usable', async () => {
    repoStub.seedSession('race-token');
    const [a, b] = await Promise.all([
      postRefresh('race-token'),
      postRefresh('race-token'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const reuseA = await postRefresh(a.body.refresh_token);
    const reuseB = await postRefresh(b.body.refresh_token);
    expect(reuseA.status).toBe(200);
    expect(reuseB.status).toBe(200);
    expect(globalHandlerHits).toHaveLength(0);
  });

  test('a rotated token has exactly one grace use, then single-use is restored', async () => {
    repoStub.seedSession('one-time-token');
    const first = await postRefresh('one-time-token');
    expect(first.status).toBe(200);
    // The recorded rotation grants the presented token exactly one grace
    // use (covers the concurrent duplicate that lost the race).
    const grace = await postRefresh('one-time-token');
    expect(grace.status).toBe(200);
    expect(grace.body.refresh_token).not.toBe(first.body.refresh_token);
    // Afterwards the old token is dead again: no replay window.
    const replay = await postRefresh('one-time-token');
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('Invalid or expired refresh token');
    expect(globalHandlerHits).toHaveLength(0);
  });

  test('unknown tokens are still rejected without side effects', async () => {
    const res = await postRefresh('never-existed-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired refresh token');
    expect(globalHandlerHits).toHaveLength(0);
  });
});
