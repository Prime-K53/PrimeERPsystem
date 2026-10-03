/**
 * TransactionRefLink — the single, ERP-wide clickable transaction reference.
 *
 * Renders a transaction/document number (invoice, quotation, order, payment,
 * receipt, purchase, delivery note, examination batch, …) as a subtle link that
 * navigates to that record's existing detail view. Nothing is written: the
 * component only issues a router navigation.
 *
 * Behaviour:
 *  • Renders **plain text** when the reference cannot be addressed safely
 *    (unknown type, or neither an id nor a number) — it never falls back to
 *    "open something plausible".
 *  • Renders plain text on the destination page itself, where the surrounding
 *    row/card already opens the record (avoids a conflicting double-click).
 *    Pass `alwaysLink` for report/statement contexts that need it clickable
 *    even when rendered on the owning route.
 *  • `stopPropagation` keeps an enclosing clickable table row from firing.
 *  • Keyboard accessible: a real `<a href>`, so Enter works, focus rings are
 *    visible, and middle-click / "open in new tab" behave natively.
 */

import React, { useContext, useMemo } from 'react';
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from 'react-router-dom';
import {
  TransactionRefType,
  resolveTransactionDestination,
  transactionRefLabel,
} from '../utils/transactionRef';

export interface TransactionRefLinkProps {
  /** Explicit transaction type. Never inferred from the displayed number. */
  type: TransactionRefType | string;
  /** Authoritative internal record id — always preferred over `number`. */
  id?: string;
  /** Displayed document number (falls back to `label` when omitted). */
  number?: string;
  /** Text shown to the user. Defaults to `number`. */
  label?: string;
  /** Extra classes merged onto the rendered element. */
  className?: string;
  /** Overrides the default `Open <label> <number>` accessible name. */
  ariaLabel?: string;
  /** Keep the link clickable even when rendered on the destination route. */
  alwaysLink?: boolean;
  /** Query string already present on the destination route, kept on arrival. */
  preserveSearch?: string;
  /** Notified when the user activates a reference that cannot be resolved. */
  onUnavailable?: (reason: string) => void;
}

const LINK_BASE =
  'inline-flex items-baseline font-mono font-bold text-blue-600 cursor-pointer ' +
  'hover:text-blue-800 hover:underline underline-offset-2 no-underline ' +
  'transition-colors duration-150 rounded-sm ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1';

const TEXT_BASE = 'font-mono font-bold';

export const TransactionRefLink: React.FC<TransactionRefLinkProps> = ({
  type,
  id,
  number,
  label,
  className = '',
  ariaLabel,
  alwaysLink = false,
  preserveSearch,
  onUnavailable,
}) => {
  // `useContext` never throws, so views rendered outside a Router (a few unit
  // tests mount them standalone) simply degrade to plain text.
  const navigation = useContext(UNSAFE_NavigationContext);
  const routerLocation = useContext(UNSAFE_LocationContext);

  const displayText = (label ?? number ?? '').trim();
  const destination = useMemo(
    () => resolveTransactionDestination({ type, id, number, preserveSearch }),
    [type, id, number, preserveSearch],
  );

  if (!destination || !displayText) {
    return <span className={[TEXT_BASE, className].filter(Boolean).join(' ')}>{displayText}</span>;
  }

  // On the destination page the row/card itself opens the record; a link here
  // would be a duplicate control (and would swallow the row click).
  if (!alwaysLink && routerLocation?.location?.pathname === destination.pathname) {
    return <span className={[TEXT_BASE, className].filter(Boolean).join(' ')}>{displayText}</span>;
  }

  const typeLabel = transactionRefLabel(type);
  const accessibleName = ariaLabel ?? `Open ${typeLabel} ${displayText}`;
  const href = navigation?.navigator?.createHref
    ? navigation.navigator.createHref({ pathname: destination.pathname, search: destination.search })
    : `#${destination.pathname}${destination.search}`;

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Never let the enclosing clickable row/card react to a reference click.
    event.stopPropagation();

    if (!navigation?.navigator?.push) {
      if (onUnavailable) onUnavailable(`${typeLabel} navigation is unavailable`);
      return;
    }
    // Let modified clicks (new tab/window) fall through to the browser.
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigation.navigator.push(`${destination.pathname}${destination.search}`);
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      title={`Go to ${typeLabel} ${displayText}`}
      aria-label={accessibleName}
      data-tx-ref-type={destination.type}
      data-tx-ref-target={destination.to}
      className={[LINK_BASE, className].filter(Boolean).join(' ')}
    >
      {displayText}
    </a>
  );
};

export default TransactionRefLink;