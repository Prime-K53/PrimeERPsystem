/**
 * documentVerificationRateLimit.test.cjs
 *
 * Public QR verification is unauthenticated. It needs its own bucket that
 * counts EVERY attempt (including successful ones) and cannot be exhausted by,
 * or exhaust, the portal-auth bucket.
 */
const {
  documentVerificationLimiter,
  portalAuthLimiter,
  clearAllRateLimits,
} = require('../services/redisRateLimiter.cjs');

const makeRes = () => {
  const headers = {};
  const finishHandlers = [];
  const res = {
    statusCode: 200,
    body: null,
    set(values) {
      Object.assign(headers, values);
      return res;
    },
    on(event, handler) {
      if (event === 'finish') finishHandlers.push(handler);
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    finish(statusCode = 200) {
      res.statusCode = statusCode;
      finishHandlers.forEach((handler) => handler());
    },
    headers,
  };
  return res;
};

const makeReq = (ip, path = '/verify/invoice/EXM-1') => ({
  method: 'GET',
  ip,
  path,
  connection: { remoteAddress: ip },
});

const run = async (middleware, req, res) => {
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return nextCalled;
};

describe('documentVerificationLimiter', () => {
  beforeEach(() => clearAllRateLimits());

  it('counts successful attempts (does not use the auth skip-success budget)', async () => {
    const limiter = documentVerificationLimiter({ windowMs: 60_000, maxRequests: 2 });
    const req = makeReq('203.0.113.10');

    const first = makeRes();
    expect(await run(limiter, req, first)).toBe(true);
    first.finish(200);

    const second = makeRes();
    expect(await run(limiter, req, second)).toBe(true);
    second.finish(200);

    const third = makeRes();
    expect(await run(limiter, req, third)).toBe(false);
    expect(third.statusCode).toBe(429);
    expect(third.body.error).toBe('Rate limit exceeded');
  });

  it('uses a bucket distinct from portal authentication', async () => {
    const authLimiter = portalAuthLimiter({ windowMs: 60_000, maxRequests: 1 });
    const verifyLimiter = documentVerificationLimiter({ windowMs: 60_000, maxRequests: 1 });
    const req = makeReq('203.0.113.20');

    const authRes = makeRes();
    expect(await run(authLimiter, req, authRes)).toBe(true);

    const verifyRes = makeRes();
    expect(await run(verifyLimiter, req, verifyRes)).toBe(true);

    const verifyAgain = makeRes();
    expect(await run(verifyLimiter, req, verifyAgain)).toBe(false);
    expect(verifyAgain.statusCode).toBe(429);
  });

  it('keeps separate budgets per client address', async () => {
    const limiter = documentVerificationLimiter({ windowMs: 60_000, maxRequests: 1 });

    const first = makeRes();
    expect(await run(limiter, makeReq('198.51.100.1'), first)).toBe(true);

    const second = makeRes();
    expect(await run(limiter, makeReq('198.51.100.2'), second)).toBe(true);

    const firstAgain = makeRes();
    expect(await run(limiter, makeReq('198.51.100.1'), firstAgain)).toBe(false);
  });

  it('reports the remaining budget on every response', async () => {
    const limiter = documentVerificationLimiter({ windowMs: 60_000, maxRequests: 3 });
    const res = makeRes();

    await run(limiter, makeReq('192.0.2.50'), res);

    expect(res.headers['X-RateLimit-Limit']).toBe(3);
    expect(res.headers['X-RateLimit-Remaining']).toBe(2);
  });
});
