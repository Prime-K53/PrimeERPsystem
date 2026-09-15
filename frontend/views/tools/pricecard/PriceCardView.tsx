import React from 'react';
import {
  formatPriceCardAmount,
  formatPriceCardTimestamp,
  type PriceCardData,
} from '../../../services/priceCardService';

/**
 * PriceCardView — the standalone Price Card composition (540 × 675 px,
 * exported at 2× = 1080 × 1350 PNG via html2canvas).
 *
 * This exact DOM node is both the on-screen preview and the export source,
 * so preview and image always match. Inline styles only (html2canvas-safe:
 * hex colors, system fonts, no external CSS, no oklch).
 *
 * Receives ONLY the customer-safe PriceCardData DTO — never full product or
 * customer records — so internal fields cannot leak into the image.
 */

export const PRICE_CARD_EXPORT_WIDTH = 540;
export const PRICE_CARD_EXPORT_HEIGHT = 675;

const INK = '#23282a';
const SOFT = '#5c6567';
const FAINT = '#8a9494';
const TEAL = '#0f544c';
const TEAL_LIGHT = '#eef7f6';
const PAPER = '#ffffff';
const HAIRLINE = '#e4ddd1';

interface Props {
  data: PriceCardData;
  cardRef?: React.Ref<HTMLDivElement>;
}

const BrandHeader: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const [logoOk, setLogoOk] = React.useState(true);
  const logo = data.business.logoUrl && logoOk ? data.business.logoUrl : undefined;
  return (
    <div style={{ textAlign: 'center', marginBottom: 14 }}>
      {logo ? (
        <img
          src={logo}
          alt=""
          onError={() => setLogoOk(false)}
          style={{ height: 72, width: 'auto', maxWidth: 260, objectFit: 'contain', margin: '0 auto 10px', display: 'block' }}
        />
      ) : null}
      <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 2.5, color: TEAL }}>
        {data.business.name.toUpperCase()}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1, height: 1, background: HAIRLINE }} />
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 3, color: FAINT }}>PRICE CARD</div>
        <div style={{ flex: 1, height: 1, background: HAIRLINE }} />
      </div>
    </div>
  );
};

const ProductImage: React.FC<{ url?: string; name: string; large?: boolean }> = ({ url, name, large }) => {
  const [ok, setOk] = React.useState(true);
  if (!url || !ok) return null;
  return (
    <img
      src={url}
      alt=""
      onError={() => setOk(false)}
      style={{
        width: '100%',
        height: large ? 190 : 120,
        objectFit: 'cover',
        borderRadius: 10,
        display: 'block',
        marginBottom: 12,
        background: TEAL_LIGHT,
      }}
    />
  );
};

const SingleProduct: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const line = data.lines[0];
  const cur = data.business.currency;
  return (
    <div style={{ textAlign: 'center', padding: '2px 6px' }}>
      <ProductImage url={line.imageUrl} name={line.productName} large />
      <div style={{ fontSize: 30, fontWeight: 800, color: INK, lineHeight: 1.15, letterSpacing: -0.3 }}>
        {line.productName}
      </div>
      {line.description ? (
        <div style={{ fontSize: 13.5, color: SOFT, marginTop: 6, lineHeight: 1.45 }}>{line.description}</div>
      ) : null}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: FAINT, marginTop: 16 }}>PRICE</div>
      <div style={{ fontSize: 56, fontWeight: 800, color: TEAL, letterSpacing: -1, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {formatPriceCardAmount(line.unitPrice, cur)}
      </div>
      {line.unit ? (
        <div style={{ fontSize: 13, color: SOFT, marginTop: 2 }}>per {line.unit}</div>
      ) : null}
      {line.quantity > 1 ? (
        <div style={{
          display: 'inline-block', marginTop: 12, background: TEAL_LIGHT, borderRadius: 10,
          padding: '9px 18px', fontSize: 14.5, color: INK, fontVariantNumeric: 'tabular-nums',
        }}>
          {line.quantity} × {formatPriceCardAmount(line.unitPrice, cur)}
          {' = '}
          <span style={{ fontWeight: 800 }}>{formatPriceCardAmount(line.lineTotal, cur)}</span>
        </div>
      ) : null}
    </div>
  );
};

const MultiProduct: React.FC<{ data: PriceCardData }> = ({ data }) => {
  const cur = data.business.currency;
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: INK, textAlign: 'center', marginBottom: 4, letterSpacing: 0.2 }}>
        Price List
      </div>
      <div style={{ fontSize: 12, color: FAINT, textAlign: 'center', marginBottom: 10 }}>
        {data.lines.length} items
      </div>
      <div>
        {data.lines.map((line, i) => (
          <div key={i} style={{ padding: '10px 2px', borderTop: i === 0 ? `1px solid ${HAIRLINE}` : undefined, borderBottom: `1px solid ${HAIRLINE}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17.5, fontWeight: 700, color: INK, lineHeight: 1.25 }}>{line.productName}</div>
                {line.unit ? <div style={{ fontSize: 12, color: FAINT, marginTop: 1 }}>per {line.unit}</div> : null}
              </div>
              <div style={{ fontSize: 19, fontWeight: 800, color: TEAL, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {formatPriceCardAmount(line.unitPrice, cur)}
              </div>
            </div>
            {line.quantity > 1 ? (
              <div style={{ fontSize: 12.5, color: SOFT, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                {line.quantity} × {formatPriceCardAmount(line.unitPrice, cur)} = {formatPriceCardAmount(line.lineTotal, cur)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 12, padding: '0 2px' }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: SOFT }}>Total</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: TEAL, fontVariantNumeric: 'tabular-nums' }}>
          {formatPriceCardAmount(data.grandTotal, cur)}
        </div>
      </div>
    </div>
  );
};

export const PriceCardView: React.FC<Props> = ({ data, cardRef }) => {
  const contactBits = [data.business.phone, data.business.address].filter(Boolean);
  return (
    <div
      ref={cardRef}
      style={{
        width: PRICE_CARD_EXPORT_WIDTH,
        height: PRICE_CARD_EXPORT_HEIGHT,
        background: PAPER,
        color: INK,
        fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: '30px 34px 24px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <BrandHeader data={data} />

      {data.customerName ? (
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 11.5, color: FAINT }}>Prepared for </span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{data.customerName}</span>
        </div>
      ) : null}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
        {data.lines.length === 1 ? <SingleProduct data={data} /> : <MultiProduct data={data} />}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11.5, color: FAINT, textAlign: 'center', fontStyle: 'italic' }}>
          Price valid at time of issue. Price subject to change without notice.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
          <div style={{ fontSize: 11, color: FAINT, fontVariantNumeric: 'tabular-nums' }}>{data.reference}</div>
          <div style={{ fontSize: 11, color: FAINT }}>Issued {formatPriceCardTimestamp(data.issuedAt)}</div>
        </div>
        {contactBits.length > 0 ? (
          <div style={{ fontSize: 13, fontWeight: 700, color: INK, textAlign: 'center', marginTop: 6 }}>
            {contactBits.join('  •  ')}
          </div>
        ) : null}
        <div style={{ height: 1, background: HAIRLINE, margin: '10px 0 8px' }} />
        <div style={{ fontSize: 10.5, color: FAINT, textAlign: 'center', lineHeight: 1.5 }}>
          Official price information issued by {data.business.name}. Verify before payment.
        </div>
      </div>
    </div>
  );
};
