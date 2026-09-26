/**
 * conversationContext.ts — Conversational follow-up memory for the Copilot.
 *
 * Reuses the existing Copilot message flow (no separate conversation system):
 * the Copilot component keeps one CopilotConversationState and passes it with
 * every question. Elliptical follow-ups ("what items were in them?", "what
 * invoices were those payments allocated to?") inherit the relevant
 * entity/date/customer context from the previous turn.
 */

import type { DateScope, ErpEntityId, ErpFilter, ErpRelationship } from './erpQueryTypes';

export interface CopilotTurn {
  question: string;
  entity: ErpEntityId;
  filters: ErpFilter[];
  dateScope: DateScope | null;
  relationship: ErpRelationship | null;
  searchHint?: string;
}

export interface CopilotConversationState {
  turns: CopilotTurn[];
}

export function emptyConversation(): CopilotConversationState {
  return { turns: [] };
}

export function recordTurn(state: CopilotConversationState, turn: CopilotTurn): CopilotConversationState {
  const turns = [...state.turns, turn].slice(-6);
  return { turns };
}

export function lastTurn(state: CopilotConversationState | null | undefined): CopilotTurn | null {
  if (!state || state.turns.length === 0) return null;
  return state.turns[state.turns.length - 1];
}

const PRONOUNS = /\b(them|they|those|these|it|that|this)\b/i;
const ELLIPTICAL = /^(what|which|how|show|list).{0,40}(in them|in those|in these|were they|are they|was it|were those|for them|from them|of them|allocated to|about them)\b/i;

/** True when the question likely refers to the previous turn's scope. */
export function isFollowUp(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (PRONOUNS.test(q)) return true;
  if (ELLIPTICAL.test(q)) return true;
  // Very short questions with no entity noun are treated as follow-ups when history exists.
  if (q.split(/\s+/).length <= 6 && !/(order|invoice|payment|customer|supplier|product|stock|inventory|quotation|purchase|expense|sale|delivery|wallet|referral|exam|work order|bom|subscription|receipt|income)/.test(q)) {
    return true;
  }
  return false;
}

/**
 * Inherit scope from the previous turn when the current question is elliptical.
 * Returns inherited { filters, dateScope, relationship, searchHint } or null.
 */
export function inheritScope(
  question: string,
  state: CopilotConversationState | null | undefined,
): Pick<CopilotTurn, 'filters' | 'dateScope' | 'relationship' | 'searchHint'> | null {
  const prev = lastTurn(state);
  if (!prev) return null;
  if (!isFollowUp(question)) return null;
  return {
    filters: [...prev.filters],
    dateScope: prev.dateScope,
    relationship: prev.relationship,
    searchHint: prev.searchHint,
  };
}
