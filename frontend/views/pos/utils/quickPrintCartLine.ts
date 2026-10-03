import { CartItem, Item } from '../../../types';
import {
    buildQuickPhotocopyServiceDetails,
    calculateBillableSheets,
    calculateTotalPages,
    getQuickPhotocopyPricePerSheet,
} from '../../../services/quickPhotocopyService';
import { calculatePhotocopyCostPerPage, calculateTypePrintingCostPerPage } from '../../../utils/pricing';

export type QuickPrintCartLineInput = {
    printType: 'photocopy' | 'printing';
    quantity: number;
    pagesPerCopy: number;
    total: number;
    pinningCost?: number;
    pinningCount?: number;
    customName?: string;
    serviceItemId?: string;
    serviceName?: string;
    currencySymbol?: string;
    companyConfig: any;
    inventory: Item[];
    idSuffix?: string;
};

export function buildQuickPrintCartLine(input: QuickPrintCartLineInput): CartItem {
    const {
        printType,
        quantity,
        pagesPerCopy,
        total,
        pinningCost,
        pinningCount,
        customName,
        serviceItemId,
        serviceName,
        currencySymbol,
        companyConfig,
        inventory,
    } = input;

    const isPhotocopy = printType === 'photocopy';

    // Quick Photocopy price is ALWAYS per physical sheet from Settings (never divided).
    const pricePerPage = isPhotocopy
        ? getQuickPhotocopyPricePerSheet(companyConfig)
        : (companyConfig?.transactionSettings?.pos?.typePrintingPrice ?? 5.00);

    const costPerPage = isPhotocopy
        ? calculatePhotocopyCostPerPage(inventory)
        : calculateTypePrintingCostPerPage(inventory);

    // Billing: billableSheets = copies × ceil(pagesPerCopy / 2). The financial
    // total stays billableSheets × pricePerSheet (via the modal's `total`).
    const totalPages = isPhotocopy
        ? calculateTotalPages(pagesPerCopy, quantity)
        : pagesPerCopy * quantity;
    const totalSheets = isPhotocopy ? calculateBillableSheets(pagesPerCopy, quantity) : totalPages;
    const materialCost = costPerPage * totalPages;

    const finalPrice = total;
    const unitCostPerCopy = totalPages > 0 ? materialCost : 0;
    const suffix = input.idSuffix ?? `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    return {
        id: `QUICK-${isPhotocopy ? 'PHOTO' : 'PRINT'}-${suffix}`,
        itemId: isPhotocopy ? 'SVC-PHOTOCOPY' : (serviceItemId || 'SVC-TYPE-PRINT'),
        name: isPhotocopy ? 'Quick Photocopy' : (serviceName || 'Type & Printing'),
        sku: isPhotocopy ? 'QUICK-PHOTO' : (serviceItemId ? `SVC-PRINT-${serviceItemId.slice(-6)}` : 'QUICK-PRINT'),
        desc: isPhotocopy ? 'Quick Photocopy' : (serviceName || 'Type & Printing'),
        price: pricePerPage,
        cost: materialCost / totalSheets,
        cost_price: materialCost / totalSheets,
        quantity: totalSheets,
        pagesOverride: pagesPerCopy,
        category: 'Service',
        type: 'Service',
        unit: isPhotocopy ? 'sheet' : 'page',
        pages: pagesPerCopy,
        stock: 9999,
        minStockLevel: 0,
        adjustedPrice: finalPrice,
        priceLocked: true,
        lockedUnitPricePerCopy: finalPrice,
        lockedUnitCostPerCopy: unitCostPerCopy,
        // Preserve both concepts explicitly: pages (customer request) +
        // billableSheets (billing quantity). quantity stays sheets so the
        // existing quantity × price financial path is unchanged.
        ...(isPhotocopy
            ? {
                billableSheets: totalSheets,
                qpPages: pagesPerCopy,
                qpCopies: quantity,
            }
            : {}),
        serviceDetails: isPhotocopy
            ? {
                ...buildQuickPhotocopyServiceDetails(pagesPerCopy, quantity, pricePerPage, {
                    pinningCost,
                    pinningCount,
                    customName,
                }),
            }
            : {
                pages: pagesPerCopy,
                copies: quantity,
                pinningCost: pinningCost,
                pinningCount: pinningCount,
            },
    } as CartItem;
}