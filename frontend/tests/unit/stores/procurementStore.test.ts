import { beforeEach, describe, expect, it, vi } from "vitest";

const suppliersApi = {
  getAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteSupplier: vi.fn(),
};

const procurementApi = {
  getPurchases: vi.fn(),
  getGoodsReceipts: vi.fn(),
  getSubcontractOrders: vi.fn(),
  savePurchase: vi.fn(),
  saveGoodsReceipt: vi.fn(),
  deleteGoodsReceipt: vi.fn(),
  saveSubcontractOrder: vi.fn(),
  deleteSubcontractOrder: vi.fn(),
};

const procurementServiceApi = {
  getPurchaseInvoices: vi.fn(),
  initializeStores: vi.fn(),
};

const dbServiceMock = {
  put: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  get: vi.fn(),
};

vi.mock("../../../services/api", () => ({
  api: {
    procurement: procurementApi,
    suppliers: suppliersApi,
  },
}));

vi.mock("../../../services/transactionService", () => ({
  transactionService: {
    approvePurchaseOrder: vi.fn(),
    cancelPurchaseOrder: vi.fn(),
    processGoodsReceipt: vi.fn(),
  },
}));

vi.mock("../../../services/procurementService", () => ({
  procurementService: procurementServiceApi,
}));

vi.mock("../../../services/db", () => ({
  dbService: dbServiceMock,
}));

vi.mock("../../../utils/helpers", () => ({
  generateNextId: vi.fn(() => "SUP-NEW"),
}));

vi.mock("@/services/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("useProcurementStore supplier workflows", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const { useProcurementStore } =
      await import("../../../stores/procurementStore");
    useProcurementStore.setState({
      purchases: [],
      goodsReceipts: [],
      subcontractOrders: [],
      suppliers: [],
      purchaseInvoices: [],
      isLoading: false,
    });
  });

  it("creates a new supplier without overwriting an existing supplier when a stale id is supplied", async () => {
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");

    const existingSupplier = {
      id: "SUP-001",
      name: "Legacy Supplier",
      status: "Active",
    };

    useProcurementStore.setState({ suppliers: [existingSupplier] });
    suppliersApi.create.mockResolvedValue({ id: "SUP-NEW" });

    const createdSupplier = await useProcurementStore.getState().addSupplier({
      id: "SUP-001",
      name: "Fresh Supplier",
      status: "Active",
    } as any);

    expect(createdSupplier).toEqual({
      id: "SUP-NEW",
      name: "Fresh Supplier",
      status: "Active",
    });
    expect(suppliersApi.create).toHaveBeenCalledWith({
      id: "SUP-NEW",
      name: "Fresh Supplier",
      status: "Active",
    });
    expect(useProcurementStore.getState().suppliers).toEqual([
      existingSupplier,
      {
        id: "SUP-NEW",
        name: "Fresh Supplier",
        status: "Active",
      },
    ]);
  });

  it("updates an existing supplier in place without creating a duplicate", async () => {
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");

    useProcurementStore.setState({
      suppliers: [
        {
          id: "SUP-001",
          name: "Legacy Supplier",
          status: "Active",
          phone: "111",
        },
      ],
    });

    suppliersApi.update.mockResolvedValue({ id: "SUP-001" });

    await useProcurementStore.getState().updateSupplier({
      id: "SUP-001",
      name: "Legacy Supplier",
      status: "Inactive",
      phone: "222",
    } as any);

    expect(suppliersApi.update).toHaveBeenCalledWith({
      id: "SUP-001",
      name: "Legacy Supplier",
      status: "Inactive",
      phone: "222",
    });
    expect(useProcurementStore.getState().suppliers).toEqual([
      {
        id: "SUP-001",
        name: "Legacy Supplier",
        status: "Inactive",
        phone: "222",
      },
    ]);
  });
});

describe("useProcurementStore purchase invoices", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");
    useProcurementStore.setState({
      purchases: [],
      goodsReceipts: [],
      subcontractOrders: [],
      suppliers: [],
      purchaseInvoices: [],
      isLoading: false,
    });
  });

  it("fetches purchase invoices and stores them in state", async () => {
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");

    const invoices = [
      {
        id: "PINV-001",
        invoice_number: "INV-001",
        supplier_id: "SUP-1",
        invoice_date: "2026-01-15",
        due_date: "2026-02-15",
        status: "paid",
        total_amount: 1000,
        paid_amount: 1000,
        created_at: "2026-01-15",
        updated_at: "2026-01-15",
      },
      {
        id: "PINV-002",
        invoice_number: "INV-002",
        supplier_id: "SUP-2",
        invoice_date: "2026-01-20",
        due_date: "2026-02-20",
        status: "partial",
        total_amount: 2000,
        paid_amount: 1000,
        created_at: "2026-01-20",
        updated_at: "2026-01-20",
      },
    ];
    procurementServiceApi.getPurchaseInvoices.mockResolvedValue(invoices);

    await useProcurementStore.getState().fetchProcurementData();

    expect(procurementServiceApi.getPurchaseInvoices).toHaveBeenCalled();
    expect(useProcurementStore.getState().purchaseInvoices).toEqual(invoices);
  });

  it("adds a purchase invoice to state and persists via dbService", async () => {
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");

    const newInvoice = {
      id: "",
      supplier_id: "SUP-1",
      invoice_number: "INV-003",
      invoice_date: "2026-02-01",
      due_date: "2026-03-01",
      status: "draft" as const,
      subtotal: 500,
      tax_amount: 0,
      freight_amount: 0,
      discount_amount: 0,
      total_amount: 500,
      paid_amount: 0,
      created_at: "2026-02-01",
      updated_at: "2026-02-01",
    };

    dbServiceMock.put.mockResolvedValue(undefined);

    await useProcurementStore.getState().addPurchaseInvoice(newInvoice);

    expect(useProcurementStore.getState().purchaseInvoices.length).toBe(1);
    expect(useProcurementStore.getState().purchaseInvoices[0].id).toBe(
      "SUP-NEW",
    );
    expect(
      useProcurementStore.getState().purchaseInvoices[0].invoice_number,
    ).toBe("INV-003");
    expect(dbServiceMock.put).toHaveBeenCalledWith(
      "purchaseInvoices",
      expect.objectContaining({
        id: "SUP-NEW",
        invoice_number: "INV-003",
      }),
    );
  });

  it("rolls back state on dbService.put failure", async () => {
    const { useProcurementStore } =
      await import("../../../stores/procurementStore");

    const invoice = {
      id: "",
      supplier_id: "SUP-1",
      invoice_number: "INV-003",
      invoice_date: "2026-02-01",
      due_date: "2026-03-01",
      status: "draft" as const,
      subtotal: 500,
      tax_amount: 0,
      freight_amount: 0,
      discount_amount: 0,
      total_amount: 500,
      paid_amount: 0,
      created_at: "2026-02-01",
      updated_at: "2026-02-01",
    };

    dbServiceMock.put.mockRejectedValue(new Error("DB error"));

    await expect(
      useProcurementStore.getState().addPurchaseInvoice(invoice),
    ).rejects.toThrow("DB error");
    expect(useProcurementStore.getState().purchaseInvoices.length).toBe(0);
  });
});
