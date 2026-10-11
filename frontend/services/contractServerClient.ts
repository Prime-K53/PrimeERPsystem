/**
 * contractServerClient.ts — Phase 2 §3.1 server-authoritative caller.
 *
 * Status model (never conflate local with cloud):
 * - `accepted`: server RPC committed (authoritative).
 * - `pending`: network/cloud unavailable or RPC not deployed — operation is
 *   recorded locally via the existing durable sync queue and MUST be shown as
 *   "Pending server confirmation", never as confirmed.
 * - `rejected`: server refused (validation / closed period / duplicate /
 *   insufficient). Local optimistic rows must be reconciled, never left as
 *   confirmed. Closed-period rejections carry adjustmentRequired.
 */

export type ContractServerStatus = 'accepted' | 'pending' | 'rejected';

export interface ContractServerResult {
  status: ContractServerStatus;
  result?: unknown;
  error?: string;
  adjustmentRequired?: boolean;
  duplicate?: boolean;
  retryable?: boolean;
}

const json = async (res: Response) => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

async function postJson(path: string, body: unknown): Promise<{ httpOk: boolean; status: number; body: any }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    credentials: 'include',
  });
  return { httpOk: res.ok, status: res.status, body: await json(res) };
}

export const contractServerClient = {
  async reserveViaServer(args: {
    contractId: string; itemId: string; item?: Record<string, unknown>; price?: number; businessDate?: string;
  }): Promise<ContractServerResult> {
    try {
      const { httpOk, body } = await postJson('/api/printing-contracts/reserve', args);
      if (httpOk && body?.ok) return { status: 'accepted', result: body.result };
      if (body?.duplicate) return { status: 'rejected', error: String(body?.error || 'duplicate'), duplicate: true, retryable: false };
      return {
        status: 'rejected',
        error: String(body?.error || `reserve rejected (http)`),
        adjustmentRequired: Boolean(body?.adjustmentRequired),
        retryable: false,
      };
    } catch (e: any) {
      // Network / RPC-not-deployed / cloud-unconfigured → local pending queue owns it.
      return { status: 'pending', error: String(e?.message || 'server unreachable — recorded locally as pending'), retryable: true };
    }
  },

  async consumeViaServer(args: {
    contractId: string; itemId: string; idempotencyKey?: string; businessDate?: string;
  }): Promise<ContractServerResult> {
    try {
      const { httpOk, body } = await postJson('/api/printing-contracts/consume', args);
      if (httpOk && body?.ok) return { status: 'accepted', result: body.result };
      if (body?.duplicate) return { status: 'rejected', error: String(body?.error || 'duplicate'), duplicate: true, retryable: false };
      return {
        status: 'rejected',
        error: String(body?.error || 'consume rejected (http)'),
        adjustmentRequired: Boolean(body?.adjustmentRequired),
        retryable: false,
      };
    } catch (e: any) {
      return { status: 'pending', error: String(e?.message || 'server unreachable — recorded locally as pending'), retryable: true };
    }
  },

  async health(): Promise<{ reachable: boolean; rpcDeployed?: boolean; error?: string }> {
    try {
      const res = await fetch('/api/printing-contracts/health', { credentials: 'include' });
      const body = await json(res);
      return { reachable: res.ok, rpcDeployed: Boolean((body as any)?.rpcDeployed), error: (body as any)?.error };
    } catch (e: any) {
      return { reachable: false, error: String(e?.message || e) };
    }
  },
};
