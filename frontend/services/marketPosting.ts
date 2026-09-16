/**
 * marketPosting.ts (Phase 2 / B2)
 *
 * Single source of truth for "should this market-adjustment amount be split
 * to the dedicated market-adjustment account, or kept inside revenue?"
 *
 * Rule (fixes unbalanced P&L when the account is unset/invalid):
 *  - split ONLY when market mode is on, amount > 0, AND the configured
 *    account resolves to a real postable account;
 *  - otherwise keep the full amount in revenue and report `unpostedAmount`
 *    so callers can audit instead of silently understating revenue.
 */

export interface MarketPostingInput {
  isMarketMode: boolean;
  adjustmentTotal: unknown;
  configuredAccountId?: string | null;
  resolveAccount: (id: string) => string | null;
}

export interface MarketPostingDecision {
  /** Amount to split to the market account (0 when not splittable). */
  marketAmount: number;
  /** Resolved market account id, or null when revenue keeps the full amount. */
  marketAccountId: string | null;
  /** Amount that stayed inside revenue because no valid account existed. */
  unpostedAmount: number;
}

const toPositiveMoney = (value: unknown): number => {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

export function decideMarketPosting(input: MarketPostingInput): MarketPostingDecision {
  const marketAmount = input.isMarketMode ? toPositiveMoney(input.adjustmentTotal) : 0;
  if (marketAmount <= 0) {
    return { marketAmount: 0, marketAccountId: null, unpostedAmount: 0 };
  }
  const configured = String(input.configuredAccountId || '').trim();
  if (!configured) {
    return { marketAmount: 0, marketAccountId: null, unpostedAmount: marketAmount };
  }
  let resolved: string | null = null;
  try {
    resolved = input.resolveAccount(configured);
  } catch {
    resolved = null;
  }
  if (!resolved) {
    return { marketAmount: 0, marketAccountId: null, unpostedAmount: marketAmount };
  }
  return { marketAmount, marketAccountId: resolved, unpostedAmount: 0 };
}
