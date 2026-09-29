/**
 * marketingMessagesCentralAI.test.ts
 *
 * Proves Marketing Messages consumes the CENTRALIZED AI configuration
 * (Settings → AI configuration, frontend/services/ai/aiService.ts) instead
 * of a hardcoded provider/model:
 *
 * 1. Uses configured model (Model A flows into the provider request).
 * 2. Configuration changes propagate dynamically (Model B after re-config).
 * 3. No hardcoded Gemma model (static source scan + runtime assertion).
 * 4. The central service is actually called by Marketing generation.
 * 5. Provider 429s are classified honestly — no silent model switch, no raw
 *    provider JSON in the UI warning.
 * 6. API credentials never leak into responses, warnings or debug info.
 * 7. The verified ERP template fallback still works on genuine failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn().mockResolvedValue('ok'),
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

import { dbService } from '../../services/db';
import { aiService as centralAI } from '../../services/ai/aiService';
import { aiService as marketingAI } from '../../services/aiService';
import {
  generateCommunicationDraft,
  classifyAIError,
  getActiveAIInfo,
} from '../../services/communication/communicationAIService';
import { buildCommunicationContext } from '../../services/communication/communicationContextBuilder';

const CUSTOMERS = [
  { id: 'C-ABC', businessName: 'ABC School', contactName: 'Jane Doe', phone: '260971000001', email: 'abc@example.com' },
];
const INVOICES = [
  { id: 'INV-1', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-001', totalAmount: 100000, paidAmount: 20000, date: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', verificationToken: 'tok123' },
  { id: 'INV-2', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-002', totalAmount: 45000, paidAmount: 0, date: '2026-09-15', dueDate: '2026-10-15', status: 'Pending', verificationToken: 'tok456' },
];

const HARDCODED_GEMMA = 'google/gemma-4-26b-a4b-it:free';

// The global setup replaces localStorage with a no-op mock, so install a real
// in-memory store (same pattern as communicationCenter.test.ts).
let store: Record<string, string> = {};

function seedSettings(aiConfig: Record<string, unknown>) {
  store['nexus_company_config'] = JSON.stringify({
    companyName: 'Prime Printing',
    aiConfig: {
      provider: 'openrouter',
      model: 'Model-A',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-TEST-KEY',
      enabled: true,
      ...aiConfig,
    },
  });
}

function jsonOk(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function stubFetch(handler: (url: string, init: any) => Promise<any>) {
  const calls: { url: string; init: any }[] = [];
  vi.stubGlobal('fetch', (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch);
  return calls;
}

function resolveSource(relativePath: string): string {
  const candidates = [
    path.join(process.cwd(), relativePath),
    path.join(process.cwd(), 'frontend', relativePath),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Source not found: ${relativePath} (cwd=${process.cwd()})`);
}

async function buildCtx() {
  return buildCommunicationContext('payment_reminder', 'C-ABC', {
    invoicesOverride: INVOICES as unknown as never,
    paymentsOverride: [],
    openingBalanceOverride: 0,
  });
}

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.mocked(dbService.getAll).mockImplementation(async (storeName: string) => {
    if (storeName === 'customers') return CUSTOMERS as unknown[];
    if (storeName === 'invoices') return INVOICES as unknown[];
    if (storeName === 'customerPayments') return [];
    if (storeName === 'customerNotificationLogs') return [];
    return [];
  });
  vi.mocked(dbService.get).mockResolvedValue(undefined as never);
  vi.mocked(dbService.put).mockResolvedValue('ok');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Test 1 — Marketing uses the Settings-configured model', () => {
  it('sends Model A to the provider for both central and Marketing entry points', async () => {
    seedSettings({ model: 'Model-A' });
    const calls = stubFetch(async () =>
      jsonOk({ choices: [{ message: { content: 'Polished draft A' } }] }),
    );

    const direct = await centralAI.generateTextStrict('Write a reminder', 'You are helpful');
    expect(direct).toBe('Polished draft A');
    expect(JSON.parse(calls[0].init.body).model).toBe('Model-A');

    const viaMarketing = await marketingAI.generateAIResponse('Write a reminder', 'You are helpful');
    expect(viaMarketing).toBe('Polished draft A');
    expect(JSON.parse(calls[1].init.body).model).toBe('Model-A');
  });
});

describe('Test 2 — Settings changes propagate dynamically to Marketing', () => {
  it('uses Model B after reconfiguration, including through the Marketing facade', async () => {
    seedSettings({ model: 'Model-A' });
    const calls = stubFetch(async (_url: string, init: any) => {
      const model = JSON.parse(init.body).model;
      return jsonOk({ choices: [{ message: { content: `draft for ${model}` } }] });
    });

    expect(await centralAI.generateTextStrict('hi')).toBe('draft for Model-A');

    // Administrator changes Settings → AI configuration to Model B.
    centralAI.saveConfig({ provider: 'openrouter', model: 'Model-B' });

    expect(await centralAI.generateTextStrict('hi')).toBe('draft for Model-B');
    expect(JSON.parse(calls[1].init.body).model).toBe('Model-B');

    // The Marketing Messages facade observes the same store (no own config).
    const marketingConfig = await marketingAI.getConfig();
    expect(marketingConfig.model).toBe('Model-B');
    expect(await marketingAI.generateAIResponse('hi')).toBe('draft for Model-B');
    expect(JSON.parse(calls[2].init.body).model).toBe('Model-B');
  });
});

describe('Test 3 — No hardcoded Gemma model in Marketing Messages', () => {
  it('contains no hardcoded gemma/google model literals in the AI path sources', () => {
    const sources = [
      resolveSource('services/communication/communicationAIService.ts'),
      resolveSource('services/aiService.ts'),
      resolveSource('services/ai/aiService.ts'),
      resolveSource('views/tools/MarketingMessages.tsx'),
    ];
    for (const src of sources) {
      const content = readFileSync(src, 'utf8');
      expect(content.toLowerCase()).not.toContain('gemma-4-26b');
      expect(content).not.toContain(HARDCODED_GEMMA);
    }
    // The Marketing facade performs no direct provider HTTP itself (except the
    // legacy Anthropic path); OpenAI-compatible traffic goes via central.
    const facade = readFileSync(resolveSource('services/aiService.ts'), 'utf8');
    expect(facade).not.toContain('/chat/completions');
    expect(facade).not.toContain('openrouter.ai/api');
  });

  it('never sends the previously failing Gemma model at runtime', async () => {
    seedSettings({ model: 'Model-B' });
    const calls = stubFetch(async () =>
      jsonOk({ choices: [{ message: { content: 'ok' } }] }),
    );
    await marketingAI.generateAIResponse('hello');
    const sentModel = JSON.parse(calls[0].init.body).model;
    expect(sentModel).toBe('Model-B');
    expect(sentModel).not.toBe(HARDCODED_GEMMA);
  });
});

describe('Test 4 — Marketing generation calls the central AI service', () => {
  it('routes generateCommunicationDraft through central generateTextStrict', async () => {
    seedSettings({ model: 'Model-A' });
    const spy = vi.spyOn(centralAI, 'generateTextStrict').mockResolvedValue('Dear ABC School, settled.');
    const ctx = await buildCtx();
    const res = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('ABC School');
    expect(res.aiGenerated).toBe(true);
  });
});

describe('Test 5 — Provider 429 is handled honestly', () => {
  it('reports rate-limit cleanly with no silent model switch and no raw JSON', async () => {
    seedSettings({ model: 'Model-A' });
    const rawProviderError = `OpenRouter error 429: {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"${HARDCODED_GEMMA} is temporarily rate-limited upstream"}}}`;
    const spy = vi.spyOn(centralAI, 'generateTextStrict').mockRejectedValue(new Error(rawProviderError));

    const ctx = await buildCtx();
    const res = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });

    expect(res.aiGenerated).toBe(false);
    expect(res.errorCode).toBe('rate_limited');
    // Clean user-facing message: no raw JSON, no model internals.
    expect(res.warning).toMatch(/rate-limited|temporarily unavailable/i);
    expect(res.warning).not.toContain('{');
    expect(res.warning).not.toContain('gemma');
    expect(res.warning).toMatch(/Settings/);
    // Legitimate business fallback with verified ERP facts still delivered.
    expect(res.text).toContain('ABC School');
    expect(res.text).toContain('K145,000.00');
    // No hardcoded alternative model was silently selected: the reported
    // model is still the configured one, and no model override was passed.
    expect(res.model).toBe('Model-A');
    expect(res.provider).toBe('openrouter');
    expect(spy.mock.calls[0].length).toBeLessThanOrEqual(2);

    expect(classifyAIError(new Error(rawProviderError)).code).toBe('rate_limited');
    // A 429 is transient — never misreported as a configuration failure.
    expect(res.warning).not.toMatch(/not configured correctly|invalid/i);
  });
});

describe('Test 6 — API credentials stay server-side', () => {
  it('never exposes the API key in results, warnings or debug info', async () => {
    seedSettings({ apiKey: 'sk-or-SUPER-SECRET-123', model: 'Model-A' });
    const calls = stubFetch(async () =>
      jsonOk({ choices: [{ message: { content: 'Dear ABC School, thanks.' } }] }),
    );

    const ctx = await buildCtx();
    const okRes = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(JSON.stringify(okRes)).not.toContain('sk-or-SUPER-SECRET-123');
    // The key travels only inside the Authorization header of the request.
    expect(calls[0].init.headers?.Authorization).toContain('sk-or-SUPER-SECRET-123');

    const failSpy = vi
      .spyOn(centralAI, 'generateTextStrict')
      .mockRejectedValue(new Error('OpenRouter error 401: invalid api key sk-or-SUPER-SECRET-123'));
    const failRes = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(failSpy).toHaveBeenCalled();
    expect(failRes.warning || '').not.toContain('sk-or-SUPER-SECRET-123');
    expect(JSON.stringify(failRes)).not.toContain('sk-or-SUPER-SECRET-123');

    expect(JSON.stringify(getActiveAIInfo())).not.toContain('sk-or-SUPER-SECRET-123');
    expect(JSON.stringify(centralAI.getDebugInfo())).not.toContain('sk-or-SUPER-SECRET-123');
  });
});

describe('Test 7 — Verified ERP template fallback still works', () => {
  it('delivers a deterministic template with ERP facts when AI genuinely fails', async () => {
    seedSettings({ model: 'Model-A' });
    vi.spyOn(centralAI, 'generateTextStrict').mockRejectedValue(new Error('AI not configured'));
    const ctx = await buildCtx();
    const res = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(res.aiGenerated).toBe(false);
    expect(res.text).toContain('ABC School');
    expect(res.text).toContain('K145,000.00');
    expect(res.warning).toMatch(/ERP template/i);
  });
});
