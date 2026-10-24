import React, { useState, useMemo } from "react";
import {
  X,
  ChevronRight,
  Banknote,
  CreditCard,
  Smartphone,
  FileText,
  Send,
} from "lucide-react";
import { SupplierPayment, Supplier } from "../../../types";
import { useFinance } from "../../../context/FinanceContext";
import { useProcurement } from "../../../context/ProcurementContext";
import { useAuth } from "../../../context/AuthContext";
import { computeOwnBalances } from "../../../services/accountingEngine";
import { DEFAULT_ACCOUNTS } from "../../../constants";
import { generateNextId } from "../../../utils/helpers";
import { ensureDocumentVerificationToken } from "../../../utils/documentVerification";
import { getDefaultDate } from "../../../utils/financialYearUtils";

const teal: Record<string, string> = {
  50: "#eef7f6",
  100: "#d3ece9",
  200: "#a6d9d3",
  300: "#72c0b7",
  400: "#3fa294",
  500: "#1f8577",
  600: "#146b60",
  700: "#0f544c",
  800: "#0b3e39",
  900: "#082e2a",
};
const amber: Record<string, string> = {
  100: "#fbead0",
  300: "#eec27a",
  500: "#d99a3f",
  600: "#b97e2b",
};
const paper = "#FEFDFB";
const ink = "#23282A";
const inkSoft = "#5c6567";
const hairline = "#e4ddd1";
const danger = "#b5493f";

interface NewSupplierPaymentModalProps {
  onClose: () => void;
  onSuccess?: (payment: SupplierPayment) => void;
}

const PAYMENT_METHODS: Array<{
  value: string;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "Bank", label: "Bank Transfer", icon: <Banknote size={16} /> },
  { value: "Cash", label: "Cash", icon: <Banknote size={16} /> },
  { value: "Cheque", label: "Cheque", icon: <CreditCard size={16} /> },
  {
    value: "Mobile Money",
    label: "Mobile Money",
    icon: <Smartphone size={16} />,
  },
];

export const NewSupplierPaymentModal: React.FC<
  NewSupplierPaymentModalProps
> = ({ onClose, onSuccess }) => {
  const { notify, companyConfig, addAuditLog } = useAuth();
  const {
    recordSupplierPayment,
    fetchFinanceData,
    accounts = [],
    ledger = [],
  } = useFinance();
  const { suppliers = [], purchases = [] } = useProcurement();
  const currency = companyConfig?.currencySymbol || "$";

  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(getDefaultDate());
  const [paymentMethod, setPaymentMethod] = useState("Bank");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("11210");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const accountBalances = computeOwnBalances(accounts || [], ledger || []);

  const paymentAccountIds: string[] = [
    "11110",
    "11100",
    "11120",
    "11210",
    "11220",
    "11230",
    "11240",
  ];
  const paymentAccounts = DEFAULT_ACCOUNTS.filter((a) =>
    paymentAccountIds.includes(a.id),
  );

  const liveAccountByCode: Record<string, any> = {};
  (accounts || []).forEach((acc) => {
    const code = String(acc.account_number || acc.code || "").trim();
    if (code) liveAccountByCode[code] = acc;
  });

  const selectedAccount =
    paymentAccounts.find((a) => a.id === selectedAccountId) ||
    paymentAccounts[0];
  const liveAccount = liveAccountByCode[selectedAccountId] || selectedAccount;
  const selectedBalance = accountBalances[selectedAccount?.id || ""] || 0;

  const supplierOptions = useMemo(() => {
    return (suppliers || []).filter((s) => s.status !== "inactive");
  }, [suppliers]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!supplierId) newErrors.supplier = "Please select a supplier";
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
      newErrors.amount = "Please enter a valid positive amount";
    if (!paymentDate) newErrors.paymentDate = "Date is required";
    if (!selectedAccountId)
      newErrors.account = "Please select a payment account";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      const now = new Date().toISOString();
      const paymentId = generateNextId("SP", []);
      const paymentMethodValue =
        paymentMethod === "Cheque"
          ? "Cheque"
          : paymentMethod === "Mobile Money"
            ? "Mobile Money"
            : paymentMethod === "Cash"
              ? "Cash"
              : "Bank";
      const payment = {
        id: paymentId,
        supplierId: supplierId,
        supplier_id: supplierId,
        amount: roundFinancial(Number(amount)),
        date: paymentDate,
        payment_date: paymentDate,
        method: paymentMethodValue,
        paymentMethod: paymentMethodValue,
        bank_account_id: selectedAccountId,
        accountId: selectedAccountId,
        reference: reference.trim(),
        notes: notes.trim(),
        status: "Cleared",
        reconciled: false,
        created_at: now,
        verificationToken: undefined as any,
      } as unknown as SupplierPayment;

      const withToken = ensureDocumentVerificationToken(payment as any);
      await recordSupplierPayment(withToken as any);
      await fetchFinanceData();

      notify(
        `Payment of ${currency}${Number(amount).toLocaleString()} recorded for supplier`,
        "success",
      );
      addAuditLog({
        action: "CREATE",
        entityType: "SupplierPayment",
        entityId: paymentId,
        details: `Recorded supplier payment of ${amount} via ${paymentMethod}`,
        newValue: withToken,
      });

      onSuccess?.(withToken as any);
      onClose();
    } catch (err: any) {
      notify(`Failed to record payment: ${err.message}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const roundFinancial = (n: number) => Math.round(n * 100) / 100;

  const getBalanceColor = () => {
    if (selectedBalance > 0) return "text-emerald-600";
    if (selectedBalance < 0) return "text-rose-600";
    return "text-slate-500";
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(15, 23, 42, 0.6)",
        padding: "40px 20px",
        fontFamily: "'Inter','DM Sans',sans-serif",
        fontSize: 13.5,
        color: ink,
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: "100%",
          maxHeight: "92vh",
          background: paper,
          borderRadius: 14,
          boxShadow:
            "0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`,
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "22px 28px 18px",
            borderBottom: `1px solid ${hairline}`,
            background: paper,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: `0 4px 10px -3px rgba(15,84,76,.6)`,
                flexShrink: 0,
              }}
            >
              <Send
                size={19}
                color="#fff"
                style={{ transform: "rotate(-45deg)" }}
              />
            </div>
            <div>
              <h1
                style={{
                  fontFamily: "'DM Serif Display', 'Georgia', serif",
                  fontWeight: 400,
                  fontSize: 22,
                  margin: 0,
                  color: teal[800],
                  letterSpacing: 0.2,
                }}
              >
                Record Supplier Payment
              </h1>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: 11.5,
                  color: inkSoft,
                  letterSpacing: 0.02,
                }}
              >
                Record a payment to a supplier. The payment will be applied to
                outstanding bills.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: `1px solid ${hairline}`,
              background: paper,
              color: inkSoft,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all .15s ease",
              fontSize: 16,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = teal[50];
              e.currentTarget.style.color = teal[700];
              e.currentTarget.style.borderColor = teal[200];
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = paper;
              e.currentTarget.style.color = inkSoft;
              e.currentTarget.style.borderColor = hairline;
            }}
          >
            <X size={15} />
          </button>
        </div>

        <form
          id="new-supplier-payment-form"
          onSubmit={handleSubmit}
          style={{
            padding: "22px 28px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            overflowY: "auto",
            maxHeight: "calc(92vh - 140px)",
          }}
        >
          <div>
            <label className="purchases-label">Supplier</label>
            <select
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value);
                if (errors.supplier) setErrors({ ...errors, supplier: "" });
              }}
              className="purchases-input"
              style={{
                border: errors.supplier ? `1.4px solid ${danger}` : undefined,
              }}
              required
            >
              <option value="">Select a supplier...</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.tin ? `(${s.tin})` : ""}
                </option>
              ))}
            </select>
            {errors.supplier && (
              <div style={{ color: danger, fontSize: 10, marginTop: 4 }}>
                {errors.supplier}
              </div>
            )}
          </div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div>
              <label className="purchases-label">Amount</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: inkSoft,
                    fontWeight: 700,
                    fontSize: 18,
                  }}
                >
                  {currency}
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    if (errors.amount) setErrors({ ...errors, amount: "" });
                  }}
                  placeholder="0.00"
                  className="purchases-input"
                  style={{
                    paddingLeft: 28,
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 18,
                    fontWeight: 700,
                    border: errors.amount ? `1.4px solid ${danger}` : undefined,
                  }}
                  required
                />
              </div>
              {errors.amount && (
                <div style={{ color: danger, fontSize: 10, marginTop: 4 }}>
                  {errors.amount}
                </div>
              )}
            </div>

            <div>
              <label className="purchases-label">Payment Date</label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => {
                  setPaymentDate(e.target.value);
                  if (errors.paymentDate)
                    setErrors({ ...errors, paymentDate: "" });
                }}
                className="purchases-input"
                style={{
                  border: errors.paymentDate
                    ? `1.4px solid ${danger}`
                    : undefined,
                }}
                required
              />
              {errors.paymentDate && (
                <div style={{ color: danger, fontSize: 10, marginTop: 4 }}>
                  {errors.paymentDate}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="purchases-label">Payment Method</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setPaymentMethod(m.value)}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 14px",
                    borderRadius: 9,
                    border: `1.4px solid ${paymentMethod === m.value ? teal[400] : hairline}`,
                    background: paymentMethod === m.value ? teal[50] : paper,
                    cursor: "pointer",
                    transition: "all .15s ease",
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: paymentMethod === m.value ? teal[700] : inkSoft,
                  }}
                >
                  {m.icon}
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="purchases-label">Payment Account</label>
            <select
              value={selectedAccountId}
              onChange={(e) => {
                setSelectedAccountId(e.target.value);
                if (errors.account) setErrors({ ...errors, account: "" });
              }}
              className="purchases-input"
              style={{
                border: errors.account ? `1.4px solid ${danger}` : undefined,
              }}
              required
            >
              {paymentAccounts.map((acct) => {
                const live = liveAccountByCode[acct.id];
                const displayName = live?.name || acct.name;
                const code = live?.account_number || acct.account_number;
                const balance = accountBalances[acct.id] || 0;
                return (
                  <option key={acct.id} value={acct.id}>
                    {displayName} ({code}) — {currency}
                    {balance.toLocaleString()}
                  </option>
                );
              })}
            </select>
            {errors.account && (
              <div style={{ color: danger, fontSize: 10, marginTop: 4 }}>
                {errors.account}
              </div>
            )}
            <div
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: inkSoft,
              }}
            >
              <span>
                Current balance:{" "}
                <span className={getBalanceColor()} style={{ fontWeight: 600 }}>
                  {currency}
                  {selectedBalance.toLocaleString()}
                </span>
              </span>
              {selectedAccount && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="nav-tilde">•</span>
                  {liveAccount?.subtype === "BANK"
                    ? "Bank"
                    : liveAccount?.subtype === "CASH"
                      ? "Cash"
                      : liveAccount?.subtype === "MOBILE_MONEY"
                        ? "Mobile Money"
                        : liveAccount?.subtype || "Asset"}
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="purchases-label">Reference (Optional)</label>
            <div style={{ position: "relative" }}>
              <FileText
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={14}
              />
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. Cheque #12345, Bank Transfer Ref..."
                className="purchases-input"
                style={{ paddingLeft: 32 }}
              />
            </div>
          </div>

          <div>
            <label className="purchases-label">Notes (Optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes about this payment..."
              className="purchases-input"
              style={{
                minHeight: 80,
                resize: "vertical",
                fontFamily: "inherit",
              }}
              rows={3}
            />
          </div>

          <div
            style={{
              padding: "12px 14px",
              borderRadius: 9,
              background: teal[50],
              border: `1px dashed ${teal[200]}`,
              fontSize: 11.5,
              color: inkSoft,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <Send size={12} style={{ color: teal[600] }} />
              <span style={{ fontWeight: 600, color: teal[800] }}>
                Payment will be recorded as:
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: inkSoft,
                lineHeight: 1.6,
                paddingLeft: 18,
              }}
            >
              Debit: AP (21110) — Credit:{" "}
              {liveAccount?.name || selectedAccount?.name} (
              {liveAccount?.account_number || selectedAccount?.account_number})
            </div>
          </div>
        </form>

        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "16px 28px",
            borderTop: `1px solid ${hairline}`,
            background: paper,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 13,
              fontWeight: 600,
              padding: "9px 18px",
              borderRadius: 9,
              cursor: "pointer",
              background: paper,
              border: `1.4px solid ${hairline}`,
              color: inkSoft,
              display: "flex",
              alignItems: "center",
              gap: 7,
              transition: "all .15s ease",
            }}
            onMouseEnter={(e) => {
              if (!isSubmitting) {
                e.currentTarget.style.background = teal[50];
                e.currentTarget.style.color = teal[800];
                e.currentTarget.style.borderColor = teal[200];
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = paper;
              e.currentTarget.style.color = inkSoft;
              e.currentTarget.style.borderColor = hairline;
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="new-supplier-payment-form"
            disabled={isSubmitting}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 13,
              fontWeight: 600,
              padding: "9px 18px",
              borderRadius: 9,
              cursor: "pointer",
              border: "1.4px solid transparent",
              background: isSubmitting
                ? teal[300]
                : `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              gap: 7,
              boxShadow: isSubmitting
                ? "none"
                : `0 6px 16px -6px rgba(15,84,76,.55)`,
              transition: "all .15s ease",
              flex: 1,
            }}
          >
            {isSubmitting ? (
              <>
                <div
                  style={{
                    width: 14,
                    height: 14,
                    border: "2px solid rgba(255,255,255,.4)",
                    borderTopColor: "#fff",
                    borderRadius: "50%",
                  }}
                />
                Recording...
              </>
            ) : (
              "Record Payment"
            )}
          </button>
        </div>
      </div>

      <style>{`
         .purchases-label { display: block; font-size: 12px; font-weight: 600; color: ${teal[800]}; margin-bottom: 6px; letter-spacing: .01; font-family: 'Inter','DM Sans',sans-serif; }
         .purchases-input { width: 100%; border: 1.4px solid ${hairline}; border-radius: 9px; padding: 9px 12px; background: ${paper}; font-family: 'Inter','DM Sans',sans-serif; font-size: 13.5px; color: ${ink}; outline: none; transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
         .purchases-input:focus { border-color: ${teal[400]}; box-shadow: 0 0 0 3px rgba(31,133,119,.1); }
         .purchases-input::placeholder { color: #b7afa4; opacity: .85; }
         .nav-tilde { color: ${teal[400]}; margin: 0 4px; opacity: .6; }
       `}</style>
    </div>
  );
};

export default NewSupplierPaymentModal;
