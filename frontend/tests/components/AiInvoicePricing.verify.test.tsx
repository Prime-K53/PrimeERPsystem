import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OrderForm } from '../../views/sales/components/OrderForm';
import { calculateLineProfit } from '../../utils/saleProfit';

/**
 * FINAL CONTROLLED VERIFICATION — AI Invoice pricing/profit fix.
 *
 * Exercises the REAL OrderForm component (real AIGeneratorCard, real
 * onPopulate → buildAiOrderFormLine boundary, real analysis/profit memo,
 * real price/qty inputs, real save/reload path). Only the network boundary
 * (aiService.generateAIResponse) and adjacent discount-tier lookups are
 * stubbed; no pricing engine, resolver, or component logic is mocked.
 */

const mocks = vi.hoisted(() => ({
  mockCompanyConfig: { currencySymbol: 'K' },
  mockUser: { name: 'Tester', username: 'tester' },
  mockNotify: vi.fn(),
  mockFinance: { invoices: [], recurringInvoices: [], accounts: [], ledger: [] },
  mockSales: {
    quotations: [],
    customerPayments: [],
    customers: [
      { id: 'C-1', name: 'Acme Ltd', segment: 'Retail', phone: '', email: '', billingAddress: '' },
    ],
    addCustomer: vi.fn(),
  },
  mockInventoryCtx: {
    inventory: [
      {
        id: 'PROD-001',
        name: 'Scheme Pad',
        sku: 'SP-001',
        cost: 100,
        cost_price: 100,
        price: 150,
        selling_price: 150,
        type: 'Product',
        category: 'Stationery',
        stock: 50,
      },
    ],
    marketAdjustments: [],
    updateReservedStock: vi.fn(),
    addItem: vi.fn(),
  },
  mockProcurement: { suppliers: [], addSupplier: vi.fn() },
  mockOrders: { createOrder: vi.fn(), orders: [] },
  mockPreview: { handlePreview: vi.fn() },
  mockAI: {
    loading: {},
    errors: {},
    suggestItems: vi.fn(),
    optimisePrice: vi.fn(),
    detectAnomalies: vi.fn(),
    generateDescription: vi.fn(),
    optimiseDiscount: vi.fn(),
  },
  mockNavigate: vi.fn(),
  mockGenerateAIResponse: vi.fn(),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: mocks.mockCompanyConfig,
    notify: mocks.mockNotify,
    user: mocks.mockUser,
  }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => mocks.mockFinance,
}));

vi.mock('../../context/SalesContext', () => ({
  useSales: () => mocks.mockSales,
}));

vi.mock('../../context/InventoryContext', () => ({
  useInventory: () => mocks.mockInventoryCtx,
}));

vi.mock('../../context/ProcurementContext', () => ({
  useProcurement: () => mocks.mockProcurement,
}));

vi.mock('../../context/OrdersContext', () => ({
  useOrders: () => mocks.mockOrders,
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => mocks.mockPreview,
}));

vi.mock('../../hooks/useOrderFormAI', () => ({
  useOrderFormAI: () => mocks.mockAI,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, useNavigate: () => mocks.mockNavigate };
});

vi.mock('../../views/pos/components/PosModals', () => ({
  VariantSelectorModal: () => null,
  ServiceCalculatorModal: () => null,
}));

vi.mock('../../components/QuickPrintModal', () => ({
  default: () => null,
}));

vi.mock('../../components/items/ItemModal', () => ({
  ItemModal: () => null,
}));

vi.mock('../../views/inventory/components/InventoryTransactionHistory', () => ({
  default: () => null,
}));

// Network boundary only: canned LLM JSON. The real
// generateQuoteFromDescription + parseAIResponse still run.
vi.mock('../../services/ai/aiService', () => ({
  aiService: {
    generateAIResponse: (...args: any[]) => mocks.mockGenerateAIResponse(...args),
    extractFileData: vi.fn(),
    extractInvoiceData: vi.fn(),
    performOCR: vi.fn(),
    suggestProductPricing: vi.fn(),
  },
}));

// Adjacent lookups only (discount semantics covered by unit tests;
// these hit IndexedDB-backed stores irrelevant to the pricing fix).
vi.mock('../../services/customerPricingService', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getApplicableDiscounts: vi.fn(async () => []),
    getCustomerPricingTier: vi.fn(async () => null),
  };
});

const aiInvoiceJson = (items: any[]) =>
  JSON.stringify({
    documentType: 'invoice',
    customer: { name: 'Acme Ltd', email: '', phone: '', address: '' },
    items,
    discount: { type: 'percentage', value: 0 },
    notes: '',
    dueDate: '',
    paymentTerms: '',
  });

const KNOWN_ITEM_AI = { description: 'Scheme pads', quantity: 2, unitPrice: 0, taxRate: 0 };
const UNKNOWN_ITEM_AI = { description: 'Unobtainium Widget', quantity: 1, unitPrice: 0, taxRate: 0 };

const flat = (el: Element | null) => (el?.textContent || '').replace(/,/g, '');

async function populateViaAiCard(description: string, aiItems: any[]) {
  mocks.mockGenerateAIResponse.mockResolvedValueOnce(aiInvoiceJson(aiItems));
  fireEvent.click(screen.getByRole('button', { name: /AI Invoice/i }));
  fireEvent.click(screen.getByText('AI Quote / Invoice Generator'));
  fireEvent.change(screen.getByPlaceholderText(/Describe the work/i), {
    target: { value: description },
  });
  fireEvent.click(screen.getByRole('button', { name: /Generate Invoice/i }));
}

function gridNumberInputs(container: Element): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('tbody input[type="number"]')) as HTMLInputElement[];
}

function profitBlock(): string {
  return flat(screen.getByText('Profit').parentElement);
}

describe('FINAL VERIFICATION — AI Invoice pricing/profit in the real Order Form', () => {
  beforeEach(() => {
    mocks.mockGenerateAIResponse.mockReset();
  });

  it('TEST A/B/C/F — AI known product, manual SP edit, quantity edits, save + reload', async () => {
    const onSave = vi.fn();
    const { container, unmount } = render(
      <OrderForm type="Invoice" onSave={onSave} onCancel={vi.fn()} />
    );

    // ---- TEST A: AI populates a known master product (AI carries NO price) ----
    await populateViaAiCard('Invoice 2 scheme pads for Acme Ltd', [KNOWN_ITEM_AI]);
    await screen.findByText('Scheme Pad');

    let [qtyInput, priceInput] = gridNumberInputs(container);
    expect(qtyInput.value).toBe('2');
    // SP resolved from the master — NOT the AI zero.
    expect(priceInput.value).toBe('150');
    // Amount = 2 × 150.
    expect(flat(container)).toContain('K300.00');
    // Profit = 2 × (150 − 100) = 100. (CP=0 would show K300.00 here.)
    expect(profitBlock()).toContain('K100.00');
    expect(profitBlock()).not.toContain('K300.00');

    const pristineSavePayload = await (async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & Finalise/i }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      return onSave.mock.calls[0][0];
    })();
    const pristineLine = pristineSavePayload.items[0];
    // Record the TEST A line.
    expect(pristineLine.productId ?? pristineLine.id).toBe('PROD-001');
    expect(pristineLine.price).toBe(150);
    expect(pristineLine.cost).toBe(100);
    expect(pristineLine.quantity).toBe(2);
    expect(pristineLine.lineTotalNet).toBe(300);
    expect(calculateLineProfit(pristineLine, 0)).toBe(100);
    expect(JSON.stringify(pristineSavePayload.items)).not.toContain('AI-');

    // ---- TEST B: manual SP 150 → 200 (CP=100, qty=2 ⇒ rev 400 / cost 200 / profit 200) ----
    fireEvent.change(priceInput, { target: { value: '200' } });
    [qtyInput, priceInput] = gridNumberInputs(container);
    expect(priceInput.value).toBe('200');
    expect(flat(container)).toContain('K400.00');
    expect(profitBlock()).toContain('K200.00');
    expect(flat(container)).not.toContain('NaN');

    // ---- TEST C: quantity 2 → 10 ⇒ rev 2000 / cost 1000 / profit 1000 ----
    fireEvent.change(qtyInput, { target: { value: '10' } });
    expect(flat(container)).toContain('K2000.00');
    expect(profitBlock()).toContain('K1000.00');
    // ... and back to 2 ⇒ rev 400 / cost 200 / profit 200.
    [qtyInput] = gridNumberInputs(container);
    fireEvent.change(qtyInput, { target: { value: '2' } });
    expect(flat(container)).toContain('K400.00');
    expect(profitBlock()).toContain('K200.00');

    // ---- TEST F: save persists identity + edited SP + CP; reload keeps them ----
    fireEvent.click(screen.getByRole('button', { name: /Save & Finalise/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const saved = onSave.mock.calls[1][0];
    const line = saved.items[0];
    expect(line.id).toBe('PROD-001');
    expect(line.productId ?? line.id).toBe('PROD-001');
    expect(line.price).toBe(200);
    expect(line.unitPrice).toBe(200);
    expect(line.selling_price).toBe(200);
    expect(line.cost).toBe(100);
    expect(line.cost_price).toBe(100);
    expect(line.quantity).toBe(2);
    expect(line.lineTotalNet).toBe(400);
    expect(calculateLineProfit(line, 0)).toBe(200);
    expect(JSON.stringify(saved.items)).not.toContain('AI-');

    // Reload/reopen through the real initialData path (first form unmounted
    // so queries observe only the reloaded form).
    unmount();
    const reloadSave = vi.fn();
    const reload = render(
      <OrderForm type="Invoice" initialData={saved} onSave={reloadSave} onCancel={vi.fn()} />
    );
    await reload.findByText('Scheme Pad');
    const [rQty, rPrice] = gridNumberInputs(reload.container);
    expect(rQty.value).toBe('2');
    // Price did NOT silently return to 0.
    expect(rPrice.value).toBe('200');
    expect(flat(reload.container)).toContain('K400.00');
    expect(flat(within(reload.container).getByText('Profit').parentElement)).toContain('K200.00');
    reload.unmount();
  }, 30000);

  it('TEST E — AI line and normal line have equivalent canonical pricing', async () => {
    // Normal path: fresh form, add the SAME product via inventory search.
    const normalSave = vi.fn();
    const normal = render(
      <OrderForm
        type="Invoice"
        initialData={{ customerName: 'Acme Ltd', customerId: 'C-1', items: [] }}
        onSave={normalSave}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(normal.getByPlaceholderText(/Search inventory/i), {
      target: { value: 'Scheme' },
    });
    const option = await normal.findByText('SP-001');
    fireEvent.click(option.closest('button') as HTMLButtonElement);
    await normal.findByDisplayValue('150');
    let [nQty, nPrice] = gridNumberInputs(normal.container);
    expect(nPrice.value).toBe('150');
    fireEvent.change(nQty, { target: { value: '2' } });

    fireEvent.click(normal.getByRole('button', { name: /Save & Finalise/i }));
    await waitFor(() => expect(normalSave).toHaveBeenCalledTimes(1));
    const normalLine = normalSave.mock.calls[0][0].items[0];
    normal.unmount();

    // AI path: pristine AI line (same product, same qty).
    const aiSave = vi.fn();
    const ai = render(<OrderForm type="Invoice" onSave={aiSave} onCancel={vi.fn()} />);
    mocks.mockGenerateAIResponse.mockResolvedValueOnce(aiInvoiceJson([KNOWN_ITEM_AI]));
    fireEvent.click(ai.getByRole('button', { name: /AI Invoice/i }));
    fireEvent.click(ai.getByText('AI Quote / Invoice Generator'));
    fireEvent.change(ai.getByPlaceholderText(/Describe the work/i), {
      target: { value: 'Invoice 2 scheme pads for Acme Ltd' },
    });
    fireEvent.click(ai.getByRole('button', { name: /Generate Invoice/i }));
    await ai.findByText('Scheme Pad');
    fireEvent.click(ai.getByRole('button', { name: /Save & Finalise/i }));
    await waitFor(() => expect(aiSave).toHaveBeenCalledTimes(1));
    const aiLine = aiSave.mock.calls[0][0].items[0];
    ai.unmount();

    // Equivalent canonical pricing behavior (metadata may differ).
    expect(aiLine.productId ?? aiLine.id).toBe(normalLine.productId ?? normalLine.id);
    expect(aiLine.productId ?? aiLine.id).toBe('PROD-001');
    expect(aiLine.price).toBe(normalLine.price);
    expect(aiLine.unitPrice).toBe(normalLine.unitPrice);
    expect(aiLine.selling_price).toBe(normalLine.selling_price);
    expect(aiLine.cost).toBe(normalLine.cost);
    expect(aiLine.cost_price).toBe(normalLine.cost_price);
    expect(aiLine.quantity).toBe(normalLine.quantity);
    expect(aiLine.lineTotalNet).toBe(normalLine.lineTotalNet);
    expect(calculateLineProfit(aiLine, 0)).toBe(calculateLineProfit(normalLine, 0));
    expect(calculateLineProfit(aiLine, 0)).toBe(100);
  }, 30000);

  it('TEST D — AI unmatched item fabricates nothing, remains manually priceable', async () => {
    const onSave = vi.fn();
    const { container } = render(
      <OrderForm type="Invoice" onSave={onSave} onCancel={vi.fn()} />
    );

    mocks.mockGenerateAIResponse.mockResolvedValueOnce(aiInvoiceJson([UNKNOWN_ITEM_AI]));
    fireEvent.click(screen.getByRole('button', { name: /AI Invoice/i }));
    fireEvent.click(screen.getByText('AI Quote / Invoice Generator'));
    fireEvent.change(screen.getByPlaceholderText(/Describe the work/i), {
      target: { value: 'Invoice 1 unobtainium widget for Acme Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate Invoice/i }));
    await screen.findByText('Unobtainium Widget');

    const [qtyInput, priceInput] = gridNumberInputs(container);
    expect(qtyInput.value).toBe('1');
    expect(priceInput.value).toBe('0');
    expect(flat(container)).toContain('K0.00');
    // No false profit from the invalid zero price.
    expect(profitBlock()).toContain('K0.00');

    fireEvent.click(screen.getByRole('button', { name: /Save & Finalise/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const line = onSave.mock.calls[0][0].items[0];
    expect(line.productId || '').toBe('');
    expect(line.cost).toBe(0);
    expect(line.price).toBe(0);
    expect(calculateLineProfit(line, 0)).toBe(0);

    // Existing workflow: user manually prices it.
    fireEvent.change(priceInput, { target: { value: '250' } });
    expect(flat(container)).toContain('K250.00');
    expect(profitBlock()).toContain('K250.00');
  }, 30000);

  it('TEST G — normal Order Form workflow regression (no AI)', async () => {
    const onSave = vi.fn();
    const { container } = render(
      <OrderForm
        type="Invoice"
        initialData={{ customerName: 'Acme Ltd', customerId: 'C-1', items: [] }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    // Normal product selection still resolves the master price.
    fireEvent.change(screen.getByPlaceholderText(/Search inventory/i), {
      target: { value: 'Scheme' },
    });
    const option = await screen.findByText('SP-001');
    fireEvent.click(option.closest('button') as HTMLButtonElement);
    await screen.findByDisplayValue('150');
    let [qtyInput, priceInput] = gridNumberInputs(container);
    expect(priceInput.value).toBe('150');
    expect(profitBlock()).toContain('K50.00');

    // Manual SP editing still works; CP untouched; profit correct.
    fireEvent.change(priceInput, { target: { value: '180' } });
    [qtyInput, priceInput] = gridNumberInputs(container);
    expect(priceInput.value).toBe('180');
    expect(flat(container)).toContain('K180.00');
    expect(profitBlock()).toContain('K80.00');

    fireEvent.click(screen.getByRole('button', { name: /Save & Finalise/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const line = onSave.mock.calls[0][0].items[0];
    expect(line.id).toBe('PROD-001');
    expect(line.price).toBe(180);
    expect(line.cost).toBe(100);
    expect(calculateLineProfit(line, 0)).toBe(80);
  }, 30000);
});
