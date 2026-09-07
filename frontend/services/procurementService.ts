/**
 * Procurement Service
 * 
 * Phase 3: Module for procurement and purchase management
 * Handles:
 * - Supplier management
 * - Purchase orders
 * - Goods receipts
 * - Purchase invoices with posting to 51100 (Purchases), 51300 (Freight), 42200 (Discounts Received)
 * - Purchase payments to AP (21110)
 */

import { dbService } from './db';
import { Supplier, PurchaseOrder, PurchaseOrderItem, GoodsReceipt, PurchaseInvoice, SupplierPayment } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const SUPPLIER_STORE = 'suppliers';
const PO_STORE = 'purchaseOrders';
const GR_STORE = 'goodsReceipts';
const PI_STORE = 'purchaseInvoices';
const PP_STORE = 'supplierPayments';

function getConfig() {
    return getGLConfig();
}

export const procurementService = {
    SUPPLIER_STORE,
    PO_STORE,
    GR_STORE,
    PI_STORE,
    PP_STORE,

    async getAllSuppliers(): Promise<Supplier[]> {
        try {
            const all = await dbService.getAll<Supplier>(SUPPLIER_STORE);
            return all.sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
            logger.error('Failed to get suppliers', error);
            return [];
        }
    },

    async getSupplier(id: string): Promise<Supplier | null> {
        try {
            return await dbService.getById<Supplier>(SUPPLIER_STORE, id);
        } catch (error) {
            logger.error(`Failed to get supplier ${id}`, error);
            return null;
        }
    },

    async createSupplier(supplier: Omit<Supplier, 'id' | 'created_at' | 'updated_at'>): Promise<Supplier> {
        const all = await this.getAllSuppliers();
        const code = `SUP-${String(all.length + 1).padStart(4, '0')}`;

        const newSupplier: Supplier = {
            ...supplier,
            id: code,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        await dbService.put(SUPPLIER_STORE, newSupplier);
        return newSupplier;
    },

    async updateSupplier(id: string, updates: Partial<Supplier>): Promise<Supplier | null> {
        const existing = await this.getSupplier(id);
        if (!existing) return null;

        const updated: Supplier = {
            ...existing,
            ...updates,
            id: existing.id,
            updated_at: new Date().toISOString(),
        };

        await dbService.put(SUPPLIER_STORE, updated);
        return updated;
    },

    async createPurchaseOrder(
        supplierId: string,
        items: Omit<PurchaseOrderItem, 'id'>[],
        orderDate: string,
        expectedDeliveryDate: string | undefined,
        notes: string = '',
        accounts: any[] = []
    ): Promise<PurchaseOrder | null> {
        const subtotal = items.reduce((sum, item) => sum + item.total, 0);
        const totalAmount = subtotal;

        try {
            const order: PurchaseOrder = {
                id: generateId('PO'),
                supplier_id: supplierId,
                order_number: `PO-${generateId('PO')}`,
                order_date: orderDate,
                expected_delivery_date: expectedDeliveryDate,
                status: 'draft',
                items: items.map((item, idx) => ({
                    ...item,
                    id: `POI-${idx}`,
                })),
                subtotal,
                tax_amount: 0,
                freight_amount: 0,
                discount_amount: 0,
                total_amount: totalAmount,
                notes,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            await dbService.put(PO_STORE, order);
            return order;
        } catch (error) {
            logger.error('Failed to create purchase order', error);
            return null;
        }
    },

    async postPurchaseInvoice(
        supplierId: string,
        invoiceNumber: string,
        invoiceDate: string,
        dueDate: string,
        items: { item_name: string; quantity: number; unit_price: number; total: number }[],
        freightAmount: number = 0,
        discountAmount: number = 0,
        taxAmount: number = 0,
        accounts: any[] = []
    ): Promise<PurchaseInvoice | null> {
        const config = getConfig();
        const accts = accounts;

        const purchasesAccountId = resolveAccountForPosting(config.purchasesAccount, accts) || config.purchasesAccount;
        const freightAccountId = resolveAccountForPosting(config.freightAccount, accts) || config.freightAccount;
        const discountReceivedAccountId = resolveAccountForPosting(config.otherIncomeAccount, accts) || config.otherIncomeAccount;
        const accountsPayableId = resolveAccountForPosting(config.accountsPayable, accts) || config.accountsPayable;

        const subtotal = items.reduce((sum, item) => sum + item.total, 0);
        const totalAmount = subtotal + taxAmount + freightAmount - discountAmount;

        try {
            const lines: any[] = [];

            lines.push({
                debitAccountId: purchasesAccountId,
                creditAccountId: accountsPayableId,
                amount: subtotal,
                description: `Purchase: ${invoiceNumber}`,
            });

            if (freightAmount > 0) {
                lines.push({
                    debitAccountId: freightAccountId,
                    creditAccountId: accountsPayableId,
                    amount: freightAmount,
                    description: `Freight charges: ${invoiceNumber}`,
                });
            }

            if (discountAmount > 0) {
                lines.push({
                    debitAccountId: accountsPayableId,
                    creditAccountId: discountReceivedAccountId,
                    amount: discountAmount,
                    description: `Purchase discount: ${invoiceNumber}`,
                });
            }

            if (lines.length > 0) {
                await ledgerService.createJournalEntry({
                    date: invoiceDate,
                    description: `Purchase Invoice: ${invoiceNumber}`,
                    reference: `PI-${invoiceNumber}`,
                    lines,
                    entryType: 'PURCHASE_INVOICE',
                });
            }

            const invoice: PurchaseInvoice = {
                id: generateId('PI'),
                supplier_id: supplierId,
                invoice_number: invoiceNumber,
                invoice_date: invoiceDate,
                due_date: dueDate,
                status: 'pending',
                items,
                subtotal,
                tax_amount: taxAmount,
                freight_amount: freightAmount,
                discount_amount: discountAmount,
                total_amount: totalAmount,
                paid_amount: 0,
                notes: '',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            await dbService.put(PI_STORE, invoice);
            return invoice;
        } catch (error) {
            logger.error('Failed to post purchase invoice', error);
            return null;
        }
    },

    async processSupplierPayment(
        supplierId: string,
        amount: number,
        paymentDate: string,
        paymentMethod: 'cash' | 'bank_transfer' | 'cheque' | 'mobile_money',
        bankAccountId: string,
        reference: string = '',
        accounts: any[] = []
    ): Promise<SupplierPayment | null> {
        const config = getConfig();
        const accts = accounts;

        const accountsPayableId = resolveAccountForPosting(config.accountsPayable, accts) || config.accountsPayable;
        let paymentAccountId: string;

        switch (paymentMethod) {
            case 'cash':
                paymentAccountId = resolveAccountForPosting(config.cashDrawerAccount, accts) || config.cashDrawerAccount;
                break;
            case 'bank_transfer':
            case 'cheque':
                paymentAccountId = bankAccountId || resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;
                break;
            case 'mobile_money':
                paymentAccountId = resolveAccountForPosting(config.mobileMoneyAccount, accts) || config.mobileMoneyAccount;
                break;
            default:
                paymentAccountId = resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;
        }

        try {
            await ledgerService.createJournalEntry({
                date: paymentDate,
                description: `Payment to supplier ${supplierId}`,
                reference: reference || `PP-${generateId('PP')}`,
                lines: [
                    {
                        debitAccountId: accountsPayableId,
                        creditAccountId: paymentAccountId,
                        amount,
                        description: `Payment for invoice(s): ${reference}`,
                    }
                ],
                entryType: 'SUPPLIER_PAYMENT',
            });

            const payment: SupplierPayment = {
                id: generateId('SP'),
                supplier_id: supplierId,
                payment_date: paymentDate,
                amount,
                payment_method: paymentMethod,
                bank_account_id: bankAccountId,
                reference,
                created_at: new Date().toISOString(),
            };

            await dbService.put(PP_STORE, payment);
            return payment;
        } catch (error) {
            logger.error('Failed to process supplier payment', error);
            return null;
        }
    },

    async getPurchaseInvoices(startDate?: string, endDate?: string): Promise<PurchaseInvoice[]> {
        try {
            const all = await dbService.getAll<PurchaseInvoice>(PI_STORE);
            return all.filter(inv => {
                if (startDate && inv.invoice_date < startDate) return false;
                if (endDate && inv.invoice_date > endDate) return false;
                return true;
            }).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
        } catch (error) {
            logger.error('Failed to get purchase invoices', error);
            return [];
        }
    },

    async getPurchaseSummary(year?: number): Promise<{
        totalPurchases: number;
        totalFreight: number;
        totalDiscounts: number;
        totalPaid: number;
        invoiceCount: number;
    }> {
        const invoices = await this.getPurchaseInvoices();
        const filtered = invoices.filter(inv => {
            if (year) {
                const d = new Date(inv.invoice_date);
                return d.getFullYear() === year;
            }
            return true;
        });

        return {
            totalPurchases: filtered.reduce((sum, inv) => sum + inv.subtotal, 0),
            totalFreight: filtered.reduce((sum, inv) => sum + inv.freight_amount, 0),
            totalDiscounts: filtered.reduce((sum, inv) => sum + inv.discount_amount, 0),
            totalPaid: filtered.reduce((sum, inv) => sum + inv.paid_amount, 0),
            invoiceCount: filtered.length,
        };
    },

    async initializeStores(): Promise<void> {
        try { await dbService.createObjectStore(SUPPLIER_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(PO_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(GR_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(PI_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(PP_STORE, { keyPath: 'id' }); } catch { }
    },
};

export default procurementService;
