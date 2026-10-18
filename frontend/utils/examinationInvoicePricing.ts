import { Invoice } from '../types';

const toNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toSnapshotArray = (value: unknown): any[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeKey = (value: unknown) => String(value || '').trim().toLowerCase();

const addLookupKey = (keys: Set<string>, value: unknown) => {
  const key = normalizeKey(value);
  if (!key) return;

  keys.add(key);
  if (key.startsWith('exm-batch-')) {
    keys.add(key.slice('exm-batch-'.length));
  }
};

const allocateAmounts = (totals: number[], target: number) => {
  if (totals.length === 0) return [];

  const safeTarget = toNumber(target, 0);
  const baseTotal = totals.reduce((sum, value) => sum + value, 0);
  let running = 0;

  return totals.map((value, index) => {
    const allocation = index === totals.length - 1
      ? Number((safeTarget - running).toFixed(2))
      : Number(((baseTotal > 0 ? value / baseTotal : 1 / totals.length) * safeTarget).toFixed(2));
    running = Number((running + allocation).toFixed(2));
    return allocation;
  });
};

export const getExaminationBatchLookupKeys = (source: any): string[] => {
  const keys = new Set<string>();

  addLookupKey(keys, source?.batchId);
  addLookupKey(keys, source?.linkedBatchId);
  addLookupKey(keys, source?.originBatchId);
  addLookupKey(keys, source?.origin_batch_id);
  addLookupKey(keys, source?.batchReference);
  addLookupKey(keys, source?.reference);
  addLookupKey(keys, source?.conversionDetails?.sourceNumber);

  return Array.from(keys);
};

export const getBatchLookupKeys = (batch: any): string[] => {
  const keys = new Set<string>();

  addLookupKey(keys, batch?.id);
  addLookupKey(keys, batch?.batch_number);
  addLookupKey(keys, batch?.batchNumber);
  addLookupKey(keys, batch?.name);

  if (batch?.id) {
    addLookupKey(keys, `EXM-BATCH-${String(batch.id).trim()}`);
  }

  return Array.from(keys);
};

export const findMatchingExaminationBatch = (source: any, batches: any[] = []) => {
  const lookupKeys = getExaminationBatchLookupKeys(source);
  if (lookupKeys.length === 0) return undefined;

  return (Array.isArray(batches) ? batches : []).find((batch) => {
    const batchKeys = new Set(getBatchLookupKeys(batch));
    return lookupKeys.some((key) => batchKeys.has(key));
  });
};

export const enrichInvoiceWithBatchPricing = (
  invoice: Invoice & Record<string, unknown>,
  batch: any,
  snapshot?: Record<string, any> | null
) => {
  const classes = Array.isArray(batch?.classes) ? batch.classes : [];
  if (classes.length === 0) return invoice;

  // The APPROVED SNAPSHOT is the committed pricing decision. When it is present
  // its per-class figures win over the live class rows, so this enrichment can
  // never reintroduce a repriced amount that the invoice was not approved for.
  const frozenResult = (snapshot && typeof snapshot === 'object' && snapshot.result && typeof snapshot.result === 'object')
    ? (snapshot.result as Record<string, any>)
    : null;
  const frozenByClass = new Map<string, Record<string, any>>(
    (Array.isArray(frozenResult?.classes) ? (frozenResult?.classes as Array<Record<string, any>>) : [])
      .map((row) => [String(row?.classId || ''), row] as [string, Record<string, any>])
      .filter(([key]) => key !== '')
  );
  const frozenTotal = Number(frozenResult?.totalAmount);

  const frozenMaterialTotal = Number(frozenResult?.materialTotal);
  const materialTotal = Number(
    (Number.isFinite(frozenMaterialTotal)
      ? frozenMaterialTotal
      : classes.reduce((sum: number, cls: any) => sum + toNumber(cls?.material_total_cost, 0), 0)
    ).toFixed(2)
  );
  const frozenAdjustmentTotal = Number(frozenResult?.adjustmentTotal);
  const frozenRoundingTotal = Number(
    (Array.isArray(frozenResult?.classes) ? (frozenResult?.classes as Array<Record<string, any>>) : [])
      .reduce((sum: number, row) => sum + (Number(row?.roundingAdjustment) || 0), 0)
  );
  const marketAdjustmentTotal = Number(
    (Number.isFinite(frozenAdjustmentTotal)
      ? frozenAdjustmentTotal
      : classes.reduce((sum: number, cls: any) => sum + toNumber(cls?.market_adjustment_total ?? cls?.adjustment_total_cost, 0), 0)
    ).toFixed(2)
  );
  const roundingAdjustmentTotal = Number(
    (Number.isFinite(frozenRoundingTotal) && frozenRoundingTotal !== 0
      ? frozenRoundingTotal
      : classes.reduce((sum: number, cls: any) => sum + toNumber(cls?.rounding_adjustment, 0), 0)
    ).toFixed(2)
  );
  const roundingTotal = roundingAdjustmentTotal !== 0
    ? roundingAdjustmentTotal
    : toNumber(
        invoice.roundingTotal
        ?? invoice.roundingDifference
        ?? invoice.rounding_total
        ?? invoice.rounding_difference,
        0
      );

  const classTotals = classes.map((cls: any) => {
    const frozen = frozenByClass.get(String(cls?.id || '')) || null;
    const learners = Math.max(1, toNumber(frozen?.learners ?? cls?.number_of_learners, 1));
    return toNumber(
      frozen?.liveTotal,
      toNumber(
        frozen?.finalFee ?? frozen?.expectedFee ?? cls?.final_fee_per_learner ?? cls?.price_per_learner,
        0
      ) * learners
    );
  });
  // A snapshot total is authoritative and must not be silently recomputed away.
  const classTotalsSum = classTotals.reduce((sum: number, value: number) => sum + value, 0);
  const totalRevenue = Number(
    (Number.isFinite(frozenTotal) && frozenTotal > 0 ? frozenTotal : classTotalsSum).toFixed(2)
  );
  const roundedAllocations = roundingAdjustmentTotal === 0 ? allocateAmounts(classTotals, roundingTotal) : [];
  const totalAdjustmentBase = marketAdjustmentTotal > 0 ? marketAdjustmentTotal : classTotals.reduce((sum, value) => sum + value, 0);

  const batchSnapshots = toSnapshotArray(batch?.adjustmentSnapshots);
  const legacyBatchSnapshots = toSnapshotArray(batch?.adjustment_snapshots);
  const invoiceSnapshots = toSnapshotArray(invoice.adjustmentSnapshots);
  const rawSnapshots = batchSnapshots.length > 0
    ? batchSnapshots
    : legacyBatchSnapshots.length > 0
      ? legacyBatchSnapshots
      : invoiceSnapshots;

  const items = classes.map((cls: any, index: number) => {
    const frozen = frozenByClass.get(String(cls?.id || '')) || null;
    const quantity = Math.max(1, toNumber(frozen?.learners ?? cls?.number_of_learners, 1));
    const revenue = Number(classTotals[index].toFixed(2));
    const material = Number(toNumber(frozen?.bomCost ?? cls?.material_total_cost, 0).toFixed(2));
    const adjustment = Number(toNumber(cls?.market_adjustment_total ?? cls?.adjustment_total_cost, 0).toFixed(2));
    const rounding = roundingAdjustmentTotal !== 0
      ? Number(toNumber(cls?.rounding_adjustment, 0).toFixed(2))
      : Number((roundedAllocations[index] || 0).toFixed(2));
    const profit = Number((revenue - material - adjustment - rounding).toFixed(2));
    const adjustmentWeight = totalAdjustmentBase > 0
      ? adjustment / totalAdjustmentBase
      : (totalRevenue > 0 ? revenue / totalRevenue : 0);
    const scaledAdjustmentSnapshots = rawSnapshots.map((snapshot: any) => ({
      ...snapshot,
      calculatedAmount: Number(
        (
          toNumber(
            snapshot?.calculatedAmount
            ?? snapshot?.amount
            ?? snapshot?.value
            ?? snapshot?.total_amount
            ?? snapshot?.totalAmount,
            0
          ) * adjustmentWeight
        ).toFixed(2)
      )
    }));

    const manualOverrideAmount = Number(toNumber(cls?.manual_override_amount, 0).toFixed(2));

    return {
      id: String(cls?.id || `EXM-ITEM-${invoice.id}-${index + 1}`),
      itemId: String(cls?.id || `EXM-ITEM-${invoice.id}-${index + 1}`),
      name: String(cls?.class_name || `Class ${index + 1}`),
      sku: `EXM-CLASS-${String(cls?.id || index + 1)}`,
      description: `${Array.isArray(cls?.subjects) ? cls.subjects.length : 0} subject(s)`,
      category: 'Examination',
      type: 'Service' as const,
      unit: 'learner',
      minStockLevel: 0,
      stock: 0,
      reserved: 0,
      price: Number((quantity > 0 ? revenue / quantity : revenue).toFixed(2)),
      cost: Number((quantity > 0 ? material / quantity : material).toFixed(2)),
      quantity,
      total: revenue,
      adjustmentSnapshots: scaledAdjustmentSnapshots,
      adjustmentTotal: Number((quantity > 0 ? adjustment / quantity : adjustment).toFixed(2)),
      manual_override_amount: manualOverrideAmount,
      pricingBreakdown: {
        paperCost: 0,
        tonerCost: 0,
        finishingCost: 0,
        baseMaterialCost: Number((quantity > 0 ? material / quantity : material).toFixed(2)),
        costPrice: Number((quantity > 0 ? material / quantity : material).toFixed(2)),
        sellingPrice: Number((quantity > 0 ? revenue / quantity : revenue).toFixed(2)),
        profitAmount: Number((quantity > 0 ? profit / quantity : profit).toFixed(2)),
        profitMargin: Number((quantity > 0 ? material / quantity : material).toFixed(2)) > 0
          ? Number((((profit / quantity) / (material / quantity)) * 100).toFixed(2))
          : 0,
        minimumMargin: 0,
        adjustmentTotal: Number((quantity > 0 ? adjustment / quantity : adjustment).toFixed(2)),
        adjustmentLines: scaledAdjustmentSnapshots.map((snapshot: any) => ({
          name: String(snapshot?.name || 'Adjustment'),
          type: String(snapshot?.type || 'FIXED'),
          value: toNumber(snapshot?.value ?? snapshot?.percentage ?? snapshot?.calculatedAmount, 0)
        })),
        profitMarginAmount: Number((quantity > 0 ? profit / quantity : profit).toFixed(2)),
        marginType: 'fixed_amount' as const,
        marginValue: Number((quantity > 0 ? profit / quantity : profit).toFixed(2)),
        roundingDifference: Number((quantity > 0 ? rounding / quantity : rounding).toFixed(2)),
        wasRounded: Math.abs(rounding) > 0.0001,
        roundingMethod: String(invoice.roundingMethod || invoice.rounding_method || batch?.rounding_method || 'nearest_50'),
        copies: quantity
      }
    };
  });

  const snapshotAuthoritative = Number.isFinite(frozenTotal) && frozenTotal > 0;
  const preservedPreRounding = Number(toNumber(
    invoice.preRoundingTotalAmount ?? invoice.subtotal ?? totalRevenue,
    totalRevenue
  ).toFixed(2));

  return {
    ...invoice,
    items,
    adjustmentSnapshots: rawSnapshots,
    materialTotal,
    adjustmentTotal: marketAdjustmentTotal,
    profitMarginTotal: Number((totalRevenue - materialTotal - marketAdjustmentTotal - roundingTotal).toFixed(2)),
    roundingTotal,
    roundingDifference: snapshotAuthoritative
      ? Number(toNumber(invoice.roundingDifference ?? roundingTotal, roundingTotal).toFixed(2))
      : roundingTotal,
    total: totalRevenue,
    totalAmount: totalRevenue,
    total_amount: totalRevenue,
    // With an approved snapshot the pre-rounding figure comes from the same
    // frozen calculation, so it is preserved rather than collapsed onto the total.
    preRoundingTotalAmount: snapshotAuthoritative ? preservedPreRounding : totalRevenue,
    subtotal: snapshotAuthoritative ? preservedPreRounding : totalRevenue
  };
};
