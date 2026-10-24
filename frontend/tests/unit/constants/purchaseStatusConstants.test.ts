import { describe, expect, it } from "vitest";
import {
  purchaseStatus,
  purchaseStatusLabels,
  purchaseStatusColors,
  paymentStatus,
  paymentStatusLabels,
  paymentStatusColors,
} from "../../../constants/purchaseStatusConstants";

describe("purchaseStatus constants", () => {
  it("defines all expected purchase statuses", () => {
    expect(purchaseStatus.DRAFT).toBe("draft");
    expect(purchaseStatus.PENDING).toBe("pending");
    expect(purchaseStatus.PAID).toBe("paid");
    expect(purchaseStatus.PARTIAL).toBe("partial");
    expect(purchaseStatus.CANCELLED).toBe("cancelled");
  });

  it("provides human-readable labels for every status", () => {
    expect(purchaseStatusLabels[purchaseStatus.DRAFT]).toBe("Draft");
    expect(purchaseStatusLabels[purchaseStatus.PENDING]).toBe("Pending");
    expect(purchaseStatusLabels[purchaseStatus.PAID]).toBe("Paid");
    expect(purchaseStatusLabels[purchaseStatus.PARTIAL]).toBe("Partially Paid");
    expect(purchaseStatusLabels[purchaseStatus.CANCELLED]).toBe("Cancelled");
  });

  it("provides color classes for every status", () => {
    expect(purchaseStatusColors[purchaseStatus.DRAFT]).toBeTruthy();
    expect(purchaseStatusColors[purchaseStatus.PENDING]).toBeTruthy();
    expect(purchaseStatusColors[purchaseStatus.PAID]).toBeTruthy();
    expect(purchaseStatusColors[purchaseStatus.PARTIAL]).toBeTruthy();
    expect(purchaseStatusColors[purchaseStatus.CANCELLED]).toBeTruthy();
  });

  it("labels match color keys", () => {
    Object.keys(purchaseStatus).forEach((_, i) => {
      const values = Object.values(purchaseStatus);
      expect(purchaseStatusLabels[values[i]]).toBeTruthy();
      expect(purchaseStatusColors[values[i]]).toBeTruthy();
    });
  });
});

describe("paymentStatus constants", () => {
  it("defines all expected payment statuses", () => {
    expect(paymentStatus.UNPAID).toBe("Unpaid");
    expect(paymentStatus.PARTIAL).toBe("Partial");
    expect(paymentStatus.PAID).toBe("Paid");
    expect(paymentStatus.CANCELLED).toBe("Cancelled");
  });

  it("provides labels for every payment status", () => {
    expect(paymentStatusLabels[paymentStatus.UNPAID]).toBe("Unpaid");
    expect(paymentStatusLabels[paymentStatus.PARTIAL]).toBe("Partially Paid");
    expect(paymentStatusLabels[paymentStatus.PAID]).toBe("Paid");
    expect(paymentStatusLabels[paymentStatus.CANCELLED]).toBe("Cancelled");
  });

  it("provides color classes for every payment status", () => {
    expect(paymentStatusColors[paymentStatus.UNPAID]).toContain("bg-rose");
    expect(paymentStatusColors[paymentStatus.PARTIAL]).toContain("bg-blue");
    expect(paymentStatusColors[paymentStatus.PAID]).toContain("bg-emerald");
    expect(paymentStatusColors[paymentStatus.CANCELLED]).toContain("bg-slate");
  });
});
