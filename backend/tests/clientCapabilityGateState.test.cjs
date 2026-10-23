/**
 * clientCapabilityGateState.test.cjs — the capability state machine and its
 * cache, exercised directly.
 *
 * The SETTINGS TRANSPORT is mocked; the parsing, the cache and the fault
 * handling are the real service code. The clock is injected through jest's
 * fake timers, so the 15 s cache window and the expiry/failure race are
 * deterministic (no sleeps).
 */
const state = {
  /** the settings row returned for required_client_capability (null = absent) */
  setting: null,
  /** when set, the settings read fails with this error */
  readError: null,
  /** how many times the capability setting was read */
  reads: 0,
};

jest.mock('axios', () => {
  const handler = async (config) => {
    const url = String(config.url || '');
    const params = config.params || {};
    if (url.includes('/rest/v1/settings') && String(params.id || '').includes('required_client_capability')) {
      state.reads += 1;
      if (state.readError) throw state.readError;
      if (state.setting === null) return { status: 200, data: [] };
      return { status: 200, data: [{ id: 'required_client_capability', data: state.setting }] };
    }
    return { status: 200, data: [] };
  };
  const instance = {
    get: jest.fn(async (url, config) => handler({ method: 'get', url, ...(config || {}) })),
    post: jest.fn(async (url, data, config) => handler({ method: 'post', url, data, ...(config || {}) })),
    patch: jest.fn(async (url, data, config) => handler({ method: 'patch', url, data, ...(config || {}) })),
    delete: jest.fn(async (url, config) => handler({ method: 'delete', url, ...(config || {}) })),
  };
  const mock = () => instance;
  mock.create = () => instance;
  return mock;
});

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SECRET_KEY = 'test-secret';

const load = () => {
  jest.resetModules();
  return require('../services/cloudSyncStore.cjs');
};

const NOW = 1_700_000_000_000;

beforeEach(() => {
  state.setting = null;
  state.readError = null;
  state.reads = 0;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('capability state — the setting is absent or zero', () => {
  it('is not_configured when the row is absent', async () => {
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('not_configured');
    expect(s.value).toBe(0);
    expect(s.enforce).toBe(false);
  });

  it('is not_configured when the value is the number 0', async () => {
    state.setting = { value: 0 };
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('not_configured');
    expect(s.enforce).toBe(false);
  });
});

describe('capability state — a valid requirement', () => {
  it('is required for a positive integer', async () => {
    state.setting = { value: 2 };
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('required');
    expect(s.value).toBe(2);
    expect(s.enforce).toBe(true);
  });

  it('accepts the documented maximum', async () => {
    state.setting = { value: 1000 };
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('required');
    expect(s.value).toBe(1000);
  });
});

describe('capability state — malformed configuration', () => {
  const invalid = [
    ['a numeric string', { value: '2' }],
    ['a non-numeric string', { value: 'abc' }],
    ['null', { value: null }],
    ['a negative number', { value: -1 }],
    ['a fractional number', { value: 1.5 }],
    ['a boolean', { value: true }],
    ['above the supported range', { value: 1001 }],
    ['a settings payload that is not an object', 'not-an-object'],
    ['a settings object without a value', { other: 1 }],
  ];

  for (const [label, setting] of invalid) {
    it(`is invalid for ${label} — never an inactive gate`, async () => {
      state.setting = setting;
      const svc = load();
      const s = await svc.getRequiredClientCapabilityState();
      expect(s.state).toBe('invalid');
      expect(s.enforce).toBe(false);
      expect(s.reason).toBeTruthy();
    });
  }
});

describe('capability state — an unreadable setting', () => {
  it('is unavailable on a read failure and is never not_configured', async () => {
    state.readError = new Error('connection refused');
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('unavailable');
    expect(s.enforce).toBe(false);
    expect(s.reason).toBeTruthy();
  });

  it('is unavailable on a timeout', async () => {
    const timeout = new Error('timeout of 8000ms exceeded');
    timeout.code = 'ECONNABORTED';
    state.readError = timeout;
    const svc = load();
    const s = await svc.getRequiredClientCapabilityState();
    expect(s.state).toBe('unavailable');
  });
});

describe('capability state — the cache', () => {
  it('serves a successful read from the cache for 15 s', async () => {
    state.setting = { value: 2 };
    const svc = load();
    await svc.getRequiredClientCapabilityState();
    await svc.getRequiredClientCapabilityState();
    jest.setSystemTime(NOW + 14_999);
    await svc.getRequiredClientCapabilityState();
    expect(state.reads).toBe(1);
  });

  it('re-reads after the cache window', async () => {
    state.setting = { value: 2 };
    const svc = load();
    await svc.getRequiredClientCapabilityState();
    jest.setSystemTime(NOW + 15_001);
    await svc.getRequiredClientCapabilityState();
    expect(state.reads).toBe(2);
  });

  it('caches a read FAILURE as unavailable, never as not_configured', async () => {
    state.readError = new Error('connection refused');
    const svc = load();
    const first = await svc.getRequiredClientCapabilityState();
    const second = await svc.getRequiredClientCapabilityState();
    expect(first.state).toBe('unavailable');
    expect(second.state).toBe('unavailable');
    expect(state.reads).toBe(1);
  });
});

describe('capability state — the expiry/failure race', () => {
  it('keeps the last known requirement when the read fails after the cache expires', async () => {
    state.setting = { value: 2 };
    const svc = load();
    const primed = await svc.getRequiredClientCapabilityState();
    expect(primed.state).toBe('required');

    // the cache expires and the settings read now fails
    jest.setSystemTime(NOW + 15_001);
    state.readError = new Error('connection refused');
    const afterFailure = await svc.getRequiredClientCapabilityState();

    expect(afterFailure.state).toBe('unavailable');
    // the last known requirement is preserved for the caller
    expect(afterFailure.value).toBe(2);
    expect(afterFailure.lastKnownState).toBe('required');
    // and the fault is never downgraded to an inactive gate
    expect(afterFailure.enforce).toBe(false);
  });

  it('recovers to the configured requirement after a later successful read', async () => {
    state.setting = { value: 2 };
    const svc = load();
    await svc.getRequiredClientCapabilityState();

    jest.setSystemTime(NOW + 15_001);
    state.readError = new Error('connection refused');
    expect((await svc.getRequiredClientCapabilityState()).state).toBe('unavailable');

    jest.setSystemTime(NOW + 30_002);
    state.readError = null;
    const recovered = await svc.getRequiredClientCapabilityState();
    expect(recovered.state).toBe('required');
    expect(recovered.value).toBe(2);
    expect(recovered.enforce).toBe(true);
  });
});
