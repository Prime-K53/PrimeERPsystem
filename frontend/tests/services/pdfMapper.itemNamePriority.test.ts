import { describe, expect, it } from 'vitest';
import { mapToInvoiceData } from '../../utils/pdfMapper';

describe('pdfMapper item name priority', () => {
  it('prioritizes item.name over item.description when both are present', () => {
    const mapped = mapToInvoiceData(
      {
        id: 'QTN-P726/007',
        customerName: 'Maupo Primary School',
        date: '2026-08-31',
        items: [
          {
            name: 'Chalk',
            description: 'This premium box of high-quality chalk is an essential stationery staple for classrooms...',
            qty: 5,
            price: 4000,
            total: 20000
          }
        ]
      },
      { currencySymbol: 'K' },
      'QUOTATION'
    );

    expect(mapped.items[0].desc).toBe('Chalk');
  });

  it('falls back to description when item.name is missing', () => {
    const mapped = mapToInvoiceData(
      {
        id: 'QTN-P726/008',
        customerName: 'Maupo Primary School',
        date: '2026-08-31',
        items: [
          {
            description: 'Scheme Pad - L',
            qty: 5,
            price: 7000,
            total: 35000
          }
        ]
      },
      { currencySymbol: 'K' },
      'QUOTATION'
    );

    expect(mapped.items[0].desc).toBe('Scheme Pad - L');
  });
});
