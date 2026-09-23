/**
 * communicationGeneration.ts — stale-async protection for AI draft generation.
 *
 * A generation request captures an identity (customerId + purpose +
 * contextVersion + sequence). When the async AI call resolves, the caller
 * checks the token against the CURRENT identity and discards late responses
 * from a superseded customer/purpose/context instead of letting them
 * overwrite the operator's current work.
 */
import type { CommunicationPurposeId } from './communicationTypes';

export interface GenerationToken {
  customerId: string;
  purpose: CommunicationPurposeId;
  contextVersion: number;
  sequence: number;
}

export interface GenerationGuard {
  /** Capture the identity of a new generation request. Invalidates older tokens. */
  next: (customerId: string, purpose: CommunicationPurposeId, contextVersion: number) => GenerationToken;
  /** True only when the token still matches the latest request. */
  isCurrent: (token: GenerationToken) => boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let latest: GenerationToken | null = null;
  let sequence = 0;
  return {
    next: (customerId, purpose, contextVersion) => {
      sequence += 1;
      latest = { customerId, purpose, contextVersion, sequence };
      return latest;
    },
    isCurrent: (token) =>
      latest !== null &&
      latest.sequence === token.sequence &&
      latest.customerId === token.customerId &&
      latest.purpose === token.purpose &&
      latest.contextVersion === token.contextVersion,
  };
}
