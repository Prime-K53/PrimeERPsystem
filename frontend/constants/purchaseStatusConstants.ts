export const purchaseStatus = {
  DRAFT: "draft",
  PENDING: "pending",
  PAID: "paid",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
} as const;

export const purchaseStatusLabels: Record<string, string> = {
  [purchaseStatus.DRAFT]: "Draft",
  [purchaseStatus.PENDING]: "Pending",
  [purchaseStatus.PAID]: "Paid",
  [purchaseStatus.PARTIAL]: "Partially Paid",
  [purchaseStatus.CANCELLED]: "Cancelled",
};

export const purchaseStatusColors: Record<string, string> = {
  [purchaseStatus.DRAFT]: "bg-slate-100 text-slate-600 border-slate-200",
  [purchaseStatus.PENDING]: "bg-amber-100 text-amber-800 border-amber-200",
  [purchaseStatus.PARTIAL]: "bg-blue-100 text-blue-800 border-blue-200",
  [purchaseStatus.PAID]: "bg-emerald-100 text-emerald-800 border-emerald-200",
  [purchaseStatus.CANCELLED]: "bg-rose-100 text-rose-800 border-rose-200",
};

export type PurchaseStatusCode =
  (typeof purchaseStatus)[keyof typeof purchaseStatus];

export const paymentStatus = {
  UNPAID: "Unpaid",
  PARTIAL: "Partial",
  PAID: "Paid",
  CANCELLED: "Cancelled",
} as const;

export const paymentStatusLabels: Record<string, string> = {
  [paymentStatus.UNPAID]: "Unpaid",
  [paymentStatus.PARTIAL]: "Partially Paid",
  [paymentStatus.PAID]: "Paid",
  [paymentStatus.CANCELLED]: "Cancelled",
};

export const paymentStatusColors: Record<string, string> = {
  [paymentStatus.UNPAID]: "bg-rose-100 text-rose-800 border-rose-200",
  [paymentStatus.PARTIAL]: "bg-blue-100 text-blue-800 border-blue-200",
  [paymentStatus.PAID]: "bg-emerald-100 text-emerald-800 border-emerald-200",
  [paymentStatus.CANCELLED]: "bg-slate-100 text-slate-600 border-slate-200",
};

export type PaymentStatusCode =
  (typeof paymentStatus)[keyof typeof paymentStatus];
