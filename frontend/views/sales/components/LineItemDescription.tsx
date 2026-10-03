/**
 * LineItemDescription — the Description cell shared by every sales-flow
 * "view detail" modal.
 *
 * Renders the item name, then the item number. The number is a link to the
 * inventory item detail page whenever the line can be matched to a real
 * inventory record; otherwise it renders as plain text so it never implies a
 * destination that does not exist.
 *
 * Using one component across invoices, quotations and orders is the point:
 * the number, its styling and its behaviour stay identical everywhere.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  resolveLineItemIdentity,
  itemDetailPath,
  LineItemLike,
  InventoryItemLike,
} from './lineItemIdentity';

const teal: Record<string, string> = {
  50: '#eef7f6',
  100: '#d3ece9',
  600: '#146b60',
  700: '#0f544c',
};
const ink = '#23282A';
const inkSoft = '#5c6567';

export interface LineItemDescriptionProps {
  line: LineItemLike;
  inventory?: InventoryItemLike[];
  /** Item name; falls back to a neutral label when absent. */
  name?: string | null;
  /** Optional free-text description shown under the number. */
  description?: string | null;
  /** Closes the modal before navigating, so the detail page is not stacked. */
  onClose?: () => void;
  /** Overridable so callers can theme to their own palette. */
  accentColor?: string;
  /** Renders the optional `type` badge beneath the description. */
  type?: string | null;
}

export const LineItemDescription: React.FC<LineItemDescriptionProps> = ({
  line,
  inventory,
  name,
  description,
  onClose,
  accentColor = teal[600],
  type,
}) => {
  const navigate = useNavigate();
  const { itemNumberText, itemDetailId } = resolveLineItemIdentity(line, inventory);
  const label = name || (line?.name as string) || 'Unnamed item';

  return (
    <div>
      <p style={{ margin: 0, fontWeight: 600, color: ink, fontSize: 12 }}>{label}</p>
      {itemNumberText && (
        itemDetailId ? (
          <button
            onClick={() => {
              onClose?.();
              navigate(itemDetailPath(itemDetailId));
            }}
            title={`Open item ${itemNumberText} details`}
            style={{
              display: 'block', margin: '2px 0 0', padding: 0, border: 'none',
              background: 'transparent', cursor: 'pointer', fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace", color: accentColor,
              fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 2,
              textAlign: 'left',
            }}
          >
            #{itemNumberText}
          </button>
        ) : (
          <p style={{ margin: '2px 0 0', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}>
            #{itemNumberText}
          </p>
        )
      )}
      {description && <p style={{ margin: '2px 0 0', fontSize: 11, color: inkSoft }}>{description}</p>}
      {type && (
        <span style={{ display: 'inline-block', marginTop: 4, padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.04, background: teal[50], color: teal[700] }}>
          {type}
        </span>
      )}
    </div>
  );
};

export default LineItemDescription;
