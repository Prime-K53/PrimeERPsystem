import React from 'react';
import {
  formatPriceCardTimestamp,
  type PriceCardData,
} from '../../../services/priceCardService';

/**
 * PriceCardView — the standalone Price Card composition (540 × 675 px,
 * exported at 2× = 1080 × 1350 PNG via html2canvas).
 *
 * Editorial cream/gold/serif design: paper card, double gold frame with
 * corner accents, monogram mark, letterspaced labels, large serif price
 * with gold currency, meta row, contact line and verification seal.
 *
 * This exact DOM node is both the on-screen preview and the export source,
 * so preview and image always match. Inline styles only (html2canvas-safe:
 * hex colors, Georgia/serif fallback stack, no external CSS, no oklch).
 *
 * Receives ONLY the customer-safe PriceCardData DTO — never full product or
 * customer records — so internal fields cannot leak into the image.
 */

export const PRICE_CARD_EXPORT_WIDTH = 540;
export const PRICE_CARD_EXPORT_HEIGHT = 675;

const PAPER = '#FBF8F0';
const INK = '#142138';
const SOFT = '#566076';
const FAINT = '#8891A0';
const GOLD = '#A2812E';
const GOLD_LINE = '#C7AC6A';
const RULE = '#DCD6C6';
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

interface Props {
  data: PriceCardData;
  cardRef?: React.Ref<HTMLDivElement>;
}

const formatAmount = (value: number): string =>
  (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatIssued = (iso?: string): string =>
  `Issued ${formatPriceCardTimestamp(iso).replace('•', '·')}`;

const Corner: React.FC<{ position: React.CSSProperties }> = ({ position }) => (
  <div style={{ position: 'absolute', width: 15, height: 15, border: '1.5px solid #A2812E', ...position }} />
);

const BrandMark: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const initial = (String(data.business.name || 'P').trim().charAt(0) || 'P').toUpperCase();
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%', border: `1px solid ${GOLD}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px',
      }}>
        <span style={{ fontFamily: SERIF, fontSize: 20, color: GOLD, lineHeight: 1 }}>{initial}</span>
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 500, letterSpacing: '0.02em', color: INK, lineHeight: 1.15 }}>
        {data.business.name}
      </div>
      <div style={{ fontSize: 10, letterSpacing: '0.22em', color: SOFT, marginTop: 6, textTransform: 'uppercase' }}>
        Official price card
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '62%', margin: '22px auto' }}>
        <div style={{ flex: 1, height: 1, background: RULE }} />
        <div style={{ width: 4, height: 4, background: GOLD, transform: 'rotate(45deg)', flexShrink: 0 }} />
        <div style={{ flex: 1, height: 1, background: RULE }} />
      </div>
    </div>
  );
};

const PriceFigure: React.FC<{ amount: number; currency: string; size?: number }> = ({ amount, currency, size = 46 }) => (
  <div style={{ fontFamily: SERIF, fontSize: size, fontWeight: 500, color: INK, lineHeight: 1, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
    <span style={{ fontSize: '0.42em', verticalAlign: '0.32em', color: GOLD, marginRight: 4 }}>{currency}</span>
    {formatAmount(amount)}
  </div>
);

const CardFooter: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const contactBits = [data.business.phone, data.business.address].filter(Boolean);
  return (
    <div>
      <div style={{ fontSize: 10.5, color: FAINT, textAlign: 'center', lineHeight: 1.55, maxWidth: '85%', margin: '0 auto 20px' }}>
        Price valid at time of issue. Subject to change without notice.
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', width: '100%',
        paddingTop: 14, borderTop: `1px solid ${RULE}`, fontSize: 10.5, color: SOFT,
      }}>
        <span style={{ fontWeight: 600, color: INK, letterSpacing: '0.03em' }}>{data.reference}</span>
        <span>{formatIssued(data.issuedAt)}</span>
      </div>
      {contactBits.length > 0 ? (
        <div style={{ fontSize: 10, color: FAINT, textAlign: 'center', marginTop: 10, lineHeight: 1.6 }}>
          {contactBits.join('  ·  ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
        <div style={{
          width: 22, height: 22, borderRadius: '50%', background: GOLD,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <span style={{ fontFamily: SERIF, fontSize: 11, color: PAPER, lineHeight: 1 }}>
            {(String(data.business.name || 'P').trim().charAt(0) || 'P').toUpperCase()}
          </span>
        </div>
        <span style={{ fontSize: 9.5, letterSpacing: '0.03em', color: FAINT }}>
          Verify with {data.business.name} before payment
        </span>
      </div>
    </div>
  );
};

const SingleProduct: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const line = data.lines[0];
  const cur = (data.business.currency || 'K').trim() || 'K';
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 400, color: INK, lineHeight: 1.25 }}>
        {line.productName}
      </div>
      <div style={{ margin: '26px 0 24px' }}>
        <PriceFigure amount={line.unitPrice} currency={cur} />
        {line.unit ? (
          <div style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: SOFT, marginTop: 10 }}>
            per {line.unit}
          </div>
        ) : null}
      </div>
      {line.quantity > 1 ? (
        <div style={{ fontSize: 11, color: FAINT, fontVariantNumeric: 'tabular-nums' }}>
          {line.quantity} × {cur} {formatAmount(line.unitPrice)} = {cur} {formatAmount(line.lineTotal)}
        </div>
      ) : null}
    </div>
  );
};

const MultiProduct: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const cur = (data.business.currency || 'K').trim() || 'K';
  return (
    <div>
      <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, color: INK, textAlign: 'center', marginBottom: 2 }}>
        Price List
      </div>
      <div style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: FAINT, textAlign: 'center', marginBottom: 12 }}>
        {data.lines.length} items
      </div>
      <div>
        {data.lines.map((line, i) => (
          <div key={i} style={{ padding: '9px 2px', borderTop: `1px solid ${RULE}`, borderBottom: i === data.lines.length - 1 ? `1px solid ${RULE}` : undefined }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: SERIF, fontSize: 16, color: INK, lineHeight: 1.3 }}>{line.productName}</div>
                {line.unit ? <div style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: FAINT, marginTop: 2 }}>per {line.unit}</div> : null}
              </div>
              <div style={{ fontSize: 17, fontWeight: 500, fontFamily: SERIF, color: INK, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontSize: '0.55em', color: GOLD, marginRight: 3 }}>{cur}</span>
                {formatAmount(line.unitPrice)}
              </div>
            </div>
            {line.quantity > 1 ? (
              <div style={{ fontSize: 11, color: FAINT, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                {line.quantity} × {cur} {formatAmount(line.unitPrice)} = {cur} {formatAmount(line.lineTotal)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 12, padding: '0 2px' }}>
        <div style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: SOFT }}>Total</div>
        <div style={{ fontSize: 24, fontWeight: 500, fontFamily: SERIF, color: INK, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: '0.55em', color: GOLD, marginRight: 3 }}>{cur}</span>
          {formatAmount(data.grandTotal)}
        </div>
      </div>
    </div>
  );
};

export const PriceCardView: React.FC<Props> = ({ data, cardRef }) => {
  return (
    <div
      ref={cardRef}
      style={{
        width: PRICE_CARD_EXPORT_WIDTH,
        height: PRICE_CARD_EXPORT_HEIGHT,
        background: PAPER,
        color: INK,
        fontFamily: SANS,
        padding: 30,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 2,
      }}
    >
      <div style={{
        height: '100%',
        border: `1px solid ${GOLD_LINE}`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        padding: '34px 30px 26px',
      }}>
        <div style={{ position: 'absolute', top: 7, left: 7, right: 7, bottom: 7, border: `1px solid ${RULE}`, pointerEvents: 'none' }} />
        <Corner position={{ top: -1, left: -1, borderRight: 'none', borderBottom: 'none' }} />
        <Corner position={{ top: -1, right: -1, borderLeft: 'none', borderBottom: 'none' }} />
        <Corner position={{ bottom: -1, left: -1, borderRight: 'none', borderTop: 'none' }} />
        <Corner position={{ bottom: -1, right: -1, borderLeft: 'none', borderTop: 'none' }} />

        <BrandMark data={data} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
          {data.lines.length === 1 ? <SingleProduct data={data} /> : <MultiProduct data={data} />}
        </div>

        <CardFooter data={data} />
      </div>
    </div>
  );
};
