import { roundToCurrency } from '../../../utils/helpers';
import {
    resolveStoredCalculatedPrice,
    resolveStoredRoundingDifference,
    resolveStoredSellingPrice,
} from '../../../utils/pricing';

export type StoredPricingState = {
    price: number;
    calculatedPrice: number;
    roundingDifference: number;
    marginAmount: number;
};

/**
 * Normalize the three pricing fields that may be persisted under different
 * (or missing) keys across smart-pricing variants, legacy items and manual
 * overrides. Selling price wins when present; otherwise it is reconstructed
 * from calculated price + rounding difference so the three always reconcile.
 */
export function buildStoredPricingState(
    source: any,
    fallbackCost: number,
    adjustmentTotalValue: number
): StoredPricingState {
    const storedSellingPrice = resolveStoredSellingPrice(source);
    const storedCalculatedPrice = resolveStoredCalculatedPrice(source);
    const storedRoundingDifference = resolveStoredRoundingDifference(source);

    const normalizedPrice = storedSellingPrice > 0
        ? storedSellingPrice
        : roundToCurrency(storedCalculatedPrice + storedRoundingDifference);
    const normalizedCalculatedPrice = storedCalculatedPrice > 0
        ? storedCalculatedPrice
        : roundToCurrency(normalizedPrice - storedRoundingDifference);
    const normalizedRoundingDifference = roundToCurrency(
        storedRoundingDifference || (normalizedPrice - normalizedCalculatedPrice)
    );

    return {
        price: normalizedPrice,
        calculatedPrice: normalizedCalculatedPrice,
        roundingDifference: normalizedRoundingDifference,
        marginAmount: roundToCurrency(normalizedPrice - fallbackCost - adjustmentTotalValue - normalizedRoundingDifference)
    };
}

/** Best-effort human-readable message from an unknown thrown value. */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message || String(err);
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const anyErr = err as Record<string, unknown>;
        if (typeof anyErr.message === 'string' && anyErr.message.trim()) return anyErr.message;
        if (typeof anyErr.name === 'string' && anyErr.name.trim()) return anyErr.name;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    }
    return 'Unknown error';
}