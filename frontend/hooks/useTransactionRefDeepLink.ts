/**
 * useTransactionRefDeepLink — bridge between the URL contract defined in
 * `utils/transactionRef` and the per-module detail views.
 *
 * Each destination view (invoices, quotations, payments, purchases, shipping,
 * examination…) calls `useTransactionRefTarget()` and then feeds the result to
 * `lookupRecordByRef`. When the reference cannot be opened safely the helper
 * reports `missing` / `ambiguous` so the view can surface a message and leave
 * the user where they are — it never navigates anywhere as a fallback.
 *
 * Read-only by construction: nothing here writes to any store or service.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from 'react-router-dom';
import {
  ParsedTransactionRef,
  RefLookupOptions,
  RefLookupResult,
  lookupRecordByRef,
  readTransactionRefFromSearch,
} from '../utils/transactionRef';

/**
 * Current transaction-ref payload from the address bar, or `null`.
 * Re-reads on every router navigation so back/forward works.
 */
export function useTransactionRefTarget(): ParsedTransactionRef | null {
  const routerLocation = useContext(UNSAFE_LocationContext);
  const navigation = useContext(UNSAFE_NavigationContext);
  const [hashRef, setHashRef] = useState<ParsedTransactionRef | null>(null);

  // Views mounted outside a Router (standalone unit tests) still pick the
  // reference up from the raw URL, matching ShippingManager's deep-link style.
  useEffect(() => {
    if (routerLocation?.location) return;
    const read = () => {
      try {
        const hash = window.location.hash || '';
        const qIdx = hash.indexOf('?');
        if (qIdx < 0) {
          setHashRef(null);
          return;
        }
        setHashRef(readTransactionRefFromSearch(hash.slice(qIdx + 1)));
      } catch {
        setHashRef(null);
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [routerLocation]);

  const fromRouter = useMemo(
    () => (routerLocation?.location ? readTransactionRefFromSearch(routerLocation.location.search || '') : null),
    [routerLocation],
  );

  return fromRouter ?? hashRef;
}

/** Stable identity for a parsed reference, usable in effect dependency arrays. */
export function transactionRefKey(ref: ParsedTransactionRef | null): string {
  if (!ref) return '';
  return `${ref.type}|${ref.id}|${ref.number}`;
}

export interface OpenTransactionRefOptions<T> extends RefLookupOptions<T> {
  /** Restrict the lookup to this reference type (guards against mismatches). */
  expectType?: string;
}

export interface OpenTransactionRefOutcome<T> {
  status: 'none' | 'ok' | 'missing' | 'ambiguous';
  record?: T;
  ref?: ParsedTransactionRef;
}

/**
 * Resolve a URL transaction reference against a module's records.
 *
 * Returns `status: 'none'` when there is nothing to do, so callers can simply
 * early-return inside their existing effect.
 */
export function openTransactionRef<T>(
  records: readonly T[] | null | undefined,
  ref: ParsedTransactionRef | null,
  options: OpenTransactionRefOptions<T> = {},
): OpenTransactionRefOutcome<T> {
  if (!ref) return { status: 'none' };
  if (options.expectType && ref.type !== options.expectType) {
    return { status: 'none', ref };
  }
  const result: RefLookupResult<T> = lookupRecordByRef(records, ref, options);
  return { status: result.status, record: result.record, ref };
}

/** Message text shared by every destination view so failures read the same. */
export function transactionRefUnavailableMessage(
  outcome: OpenTransactionRefOutcome<unknown>,
): string {
  const number = outcome.ref?.number || outcome.ref?.id || '';
  const suffix = number ? ` ${number}` : '';
  if (outcome.status === 'ambiguous') {
    return `More than one record matches${suffix}. Open it from its own list to be safe.`;
  }
  return `That record${suffix} is no longer available.`;
}