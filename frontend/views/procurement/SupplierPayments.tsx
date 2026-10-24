import React, { useState, useMemo, useRef, useEffect } from "react";
import { logger } from "@/services/logger";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Banknote,
  Plus,
  Trash2,
  Search,
  Eye,
  MoreVertical,
  ChevronRight,
  X,
  Download,
  Filter,
  TrendingUp,
  Wallet,
  CheckCircle,
  XCircle,
  AlertCircle,
  BarChart3,
  Smartphone,
  AlertTriangle,
  FileBarChart,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useFinance } from "../../context/FinanceContext";
import { useProcurement } from "../../context/ProcurementContext";
import { useModuleRefresh } from "../../hooks/useModuleRefresh";
import { REFRESH_INTERVAL } from "../../context/DataContext";
import { SupplierPayment } from "../../types";
import { ACCOUNT_IDS } from "../../constants";
import {
  ensureDocumentVerificationToken,
  buildDocumentVerificationUrl,
} from "../../utils/documentVerification";
import { TransactionRefLink } from "../../components/TransactionRefLink";
import { format, parseISO } from "date-fns";
import {
  openTransactionRef,
  transactionRefKey,
  useTransactionRefTarget,
} from "../../hooks/useTransactionRefDeepLink";
import { NewSupplierPaymentModal } from "./components/NewSupplierPaymentModal";
import { buildSupplierPaymentDoc } from "../../services/receiptCalculationService";
import { useDocumentPreview } from "../../hooks/useDocumentPreview";
import { PreviewModal } from "../shared/components/PDF/PreviewModal";
import { pdf } from "@react-pdf/renderer";
import { PrimeDocument } from "../shared/components/PDF/PrimeDocument";
import { initializePrimePdfFonts } from "../shared/components/PDF/templateSettings";

const teal = {
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
const paper = "#FEFDFB";
const ink = "#23282A";
const inkSoft = "#5c6567";
const hairline = "#e4ddd1";
const danger = "#b5493f";

const PAYMENT_METHOD_ICONS: Record<string, React.ReactNode> = {
  Cash: <Wallet size={14} />,
  Bank: <Banknote size={14} />,
  "Bank Transfer": <Banknote size={14} />,
  Cheque: <FileBarChart size={14} />,
  "Mobile Money": <Smartphone size={14} />,
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  Cash: "Cash",
  Bank: "Bank",
  "Bank Transfer": "Bank Transfer",
  Cheque: "Cheque",
  "Mobile Money": "Mobile Money",
};

function getPaymentMethod(payment: SupplierPayment): string {
  return payment.paymentMethod || (payment as any).method || "Bank";
}

function formatCurrency(
  value: number | undefined | null,
  currency: string,
): string {
  if (value == null || isNaN(Number(value))) return `${currency}0.00`;
  return `${currency}${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getPaymentStatus(
  payment: SupplierPayment,
): "Cleared" | "Voided" | "Pending" {
  if (
    (payment as any).status === "Voided" ||
    (payment as any).status === "voided"
  )
    return "Voided";
  if (payment.status === "Cleared" || payment.status === "cleared")
    return "Cleared";
  return "Cleared";
}

function getPaymentDate(payment: SupplierPayment): string {
  return payment.payment_date || payment.date || "";
}

interface SupplierPaymentsProps {
  initialFilter?: "all" | "recent";
}

const SupplierPayments: React.FC<SupplierPaymentsProps> = ({
  initialFilter = "all",
}) => {
  const { notify, companyConfig, addAuditLog } = useAuth();
  const { purchases = [], suppliers = [] } = useProcurement();
  const {
    supplierPayments = [],
    accounts = [],
    recordSupplierPayment,
    voidSupplierPayment,
    fetchFinanceData,
  } = useFinance();
  const navigate = useNavigate();
  const location = useLocation();

  useModuleRefresh(fetchFinanceData, { interval: REFRESH_INTERVAL });

  const currency = companyConfig?.currencySymbol || "$";

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "Cleared" | "Voided"
  >("all");
  const [methodFilter, setMethodFilter] = useState<"all" | string>("all");
  const [dateRange, setDateRange] = useState<
    "all" | "7d" | "30d" | "90d" | "year"
  >("all");
  const [sortField, setSortField] = useState<string>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [voidConfirmId, setVoidConfirmId] = useState<string | null>(null);
  const [showRecordingModal, setShowRecordingModal] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenuId) setContextMenuId(null);
    };
    if (contextMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [contextMenuId]);

  const { handlePreview } = useDocumentPreview();

  const txRef = useTransactionRefTarget();
  const txRefKey = transactionRefKey(txRef);
  const lastTxRefKeyRef = useRef("");

  useEffect(() => {
    if (!txRef || !txRefKey || txRefKey === lastTxRefKeyRef.current) return;
    if (!txRef || txRef.type !== "supplier-payment") return;
    if (!supplierPayments || supplierPayments.length === 0) return;

    const outcome = openTransactionRef(supplierPayments as any[], txRef);
    if (outcome.status === "ok" && outcome.record) {
      navigate(`/procurement/payments/${outcome.record.id}`, { replace: true });
    }
    lastTxRefKeyRef.current = txRefKey;
  }, [txRefKey, supplierPayments]);

  const filteredSortedData = useMemo(() => {
    let data = [...(supplierPayments || [])];

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      data = data.filter((p) => {
        const supplier = suppliers.find((s) => s.id === p.supplier_id);
        const supplierName = supplier?.name || p.supplier_id || "";
        const ref = (p.reference || "").toLowerCase();
        const notes = (p.notes || "").toLowerCase();
        const paymentNum = (p.id || "").toLowerCase();
        return (
          paymentNum.includes(q) ||
          supplierName.toLowerCase().includes(q) ||
          ref.includes(q) ||
          notes.includes(q)
        );
      });
    }

    if (statusFilter !== "all") {
      data = data.filter((p) => {
        const status = getPaymentStatus(p);
        return statusFilter === status;
      });
    }

    if (methodFilter !== "all") {
      data = data.filter((p) => getPaymentMethod(p) === methodFilter);
    }

    if (dateRange !== "all") {
      const now = new Date();
      const cutoff = new Date();
      switch (dateRange) {
        case "7d":
          cutoff.setDate(now.getDate() - 7);
          break;
        case "30d":
          cutoff.setDate(now.getDate() - 30);
          break;
        case "90d":
          cutoff.setDate(now.getDate() - 90);
          break;
        case "year":
          cutoff.setFullYear(now.getFullYear() - 1);
          break;
      }
      data = data.filter((p) => {
        const d = parseISO(getPaymentDate(p));
        return d >= cutoff;
      });
    }

    data.sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "amount":
          aVal = a.amount;
          bVal = b.amount;
          break;
        case "supplier":
          aVal =
            suppliers.find((s) => s.id === a.supplier_id)?.name ||
            a.supplier_id;
          bVal =
            suppliers.find((s) => s.id === b.supplier_id)?.name ||
            b.supplier_id;
          break;
        case "method":
          aVal = getPaymentMethod(a);
          bVal = getPaymentMethod(b);
          break;
        case "status":
          aVal = getPaymentStatus(a);
          bVal = getPaymentStatus(b);
          break;
        case "date":
          aVal = a.payment_date || a.date;
          bVal = b.payment_date || b.date;
          break;
        default:
          aVal = a[sortField];
          bVal = b[sortField];
      }
      if (aVal == null) aVal = "";
      if (bVal == null) bVal = "";
      if (typeof aVal === "string" && typeof bVal === "string") {
        const cmp = aVal.localeCompare(bVal);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return data;
  }, [
    supplierPayments,
    suppliers,
    searchTerm,
    statusFilter,
    methodFilter,
    dateRange,
    sortField,
    sortDir,
  ]);

  const totalAmount = filteredSortedData.reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0,
  );
  const totalCleared = filteredSortedData
    .filter((p) => getPaymentStatus(p) === "Cleared")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const totalVoided = filteredSortedData
    .filter((p) => getPaymentStatus(p) === "Voided")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuId(id);
    const rect = e.currentTarget.getBoundingClientRect();
    setContextPos({ x: rect.left, y: rect.bottom });
  };

  const handleVoidPayment = async (id: string) => {
    try {
      await voidSupplierPayment(id);
      notify("Supplier payment voided and reversed", "success");
      addAuditLog({
        action: "VOID",
        entityType: "SupplierPayment",
        entityId: id,
        details: "Supplier payment voided",
      });
      setVoidConfirmId(null);
    } catch (err: any) {
      notify(`Failed to void payment: ${err.message}`, "error");
    }
  };

  const handleDownloadPDF = async (payment: SupplierPayment) => {
    try {
      notify("Preparing payment voucher...", "info");
      const supplier = suppliers.find((s) => s.id === payment.supplier_id);
      const supplierName = supplier?.name || payment.supplier_id || "Unknown";
      const doc = buildSupplierPaymentDoc(
        {
          ...payment,
          verificationToken: (payment as any).verificationToken,
        } as any,
        supplierName,
      );
      const blob = await pdf(
        <PrimeDocument type="SUPPLIER_PAYMENT" data={doc} />,
      ).toBlob();
      const fileName = `Supplier Payment - ${payment.id}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      notify("Payment voucher downloaded successfully", "success");
    } catch (err) {
      logger.error("PDF generation failed:", err);
      notify("Failed to generate PDF", "error");
    }
  };

  const handleCopyVerificationLink = async (payment: SupplierPayment) => {
    try {
      const url = buildDocumentVerificationUrl({
        documentType: "supplier_payment",
        documentNumber: payment.id,
        verificationToken: (payment as any).verificationToken || "",
      });
      if (!url) throw new Error("unavailable");
      await navigator.clipboard.writeText(url);
      notify("Verification link copied", "success");
    } catch {
      notify("Verification link unavailable", "error");
    }
  };

  const getPaymentBadge = (status: string) => {
    if (status === "Voided" || status === "voided")
      return "bg-slate-100 text-slate-500 border-slate-200 line-through";
    return "bg-emerald-100 text-emerald-700 border-emerald-200";
  };

  const paymentMethodOptions = Array.from(
    new Set(supplierPayments.map((p) => getPaymentMethod(p))),
  ).sort();

  return (
    <div
      className="purchases-page flex flex-col h-full relative w-full"
      style={{
        background: paper,
        color: ink,
        fontFamily: "'Inter','DM Sans',sans-serif",
        fontSize: 13.5,
      }}
    >
      <style>{`
        :root{--teal-50:#eef7f6;--teal-100:#d3ece9;--teal-200:#a6d9d3;--teal-300:#72c0b7;--teal-400:#3fa294;--teal-500:#1f8577;--teal-600:#146b60;--teal-700:#0f544c;--teal-800:#0b3e39;--teal-900:#082e2a;--amber-100:#fbead0;--amber-300:#eec27a;--amber-500:#d99a3f;--amber-600:#b97e2b;--paper:#FEFDFB;--ink:#23282A;--ink-soft:#5c6567;--hairline:#e4ddd1;--danger:#b5493f}
        .purchases-page{background:var(--paper);color:var(--ink);font-family:'Inter','DM Sans',sans-serif;font-size:13.5px;min-height:100vh;padding:20px 24px!important;max-width:1600px!important;margin:0 auto!important}
        .purchases-page *{box-sizing:border-box}
        .purchases-card{background:var(--paper);border-radius:14px;box-shadow:0 30px 70px -20px rgba(0,0,0,.55),0 8px 24px -8px rgba(0,0,0,.35);overflow:hidden;border:1.4px solid var(--hairline)}
        .purchases-input{width:100%;border:1.4px solid var(--hairline);border-radius:9px;padding:9px 12px;background:var(--paper);font-family:'Inter','DM Sans',sans-serif;font-size:13.5px;color:var(--ink);outline:none;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
        .purchases-input:focus{border-color:var(--teal-400);box-shadow:0 0 0 3px rgba(31,133,119,.1)}
        .purchases-input::placeholder{color:#b7afa4;opacity:.85}
        .purchases-btn-primary{background:linear-gradient(155deg,var(--teal-500),var(--teal-700));color:#fff;border-radius:9px;padding:9px 18px;border:none;font-family:'Inter','DM Sans',sans-serif;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 6px 16px -6px rgba(15,84,76,.55);transition:all .15s ease;display:inline-flex;align-items:center;gap:7px}
        .purchases-btn-primary:hover{transform:translateY(-1px);box-shadow:0 8px 20px -6px rgba(15,84,76,.65)}
        .purchases-btn-primary:disabled{opacity:.55;cursor:not-allowed;transform:none}
        .purchases-btn-ghost{background:var(--paper);border:1.4px solid var(--hairline);color:var(--ink-soft);border-radius:9px;padding:9px 18px;font-family:'Inter','DM Sans',sans-serif;font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s ease;display:inline-flex;align-items:center;gap:7px}
        .purchases-btn-ghost:hover{background:var(--teal-50);color:var(--teal-800);border-color:var(--teal-200)}
        .purchases-label{display:block;font-size:12px;font-weight:600;color:var(--teal-800);margin-bottom:6px;letterSpacing:.01;font-family:'Inter','DM Sans',sans-serif}
        .purchases-accent-border{border-color:var(--teal-200)!important}
        .purchases-accent-bg{background:linear-gradient(135deg,var(--teal-50) 0%,var(--paper) 100%)!important}
        .purchases-text-heading{font-family:'DM Serif Display','Georgia',serif;font-size:22px;color:var(--teal-800);font-weight:400;letter-spacing:.2}
        .purchases-text-subtitle{font-size:11.5px;color:var(--ink-soft);margin-top:2px;letterSpacing:.02;font-family:'Inter','DM Sans',sans-serif}
        .purchases-icon-teal{background:linear-gradient(155deg,var(--teal-500),var(--teal-700));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px -3px rgba(15,84,76,.6)}
        .nav-tilde{color:var(--teal-400);margin:0 4px;opacity:.6}
      `}</style>

      <div className="mb-5 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg purchases-icon-teal"
            style={{ borderRadius: 10 }}
          >
            <Banknote size={18} />
          </div>
          <div>
            <h1 className="purchases-text-heading" style={{ margin: 0 }}>
              Supplier Payments
            </h1>
            <p className="purchases-text-subtitle">
              Track and manage payments made to suppliers
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowRecordingModal(true)}
          className="purchases-btn-primary"
        >
          <Plus size={15} /> New Payment
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Total Payments
            </span>
            <BarChart3 size={16} className="text-indigo-500" />
          </div>
          <div
            className="text-2xl font-bold text-slate-900 finance-nums"
            style={{ fontFamily: "'JetBrains Mono',monospace" }}
          >
            {currency}
            {totalAmount.toLocaleString(undefined, {
              minimumFractionDigits: 2,
            })}
          </div>
          <div className="text-[11px] text-slate-500 font-medium mt-1">
            {filteredSortedData.length} payments
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Cleared
            </span>
            <CheckCircle size={16} className="text-emerald-500" />
          </div>
          <div
            className="text-2xl font-bold text-emerald-600 finance-nums"
            style={{ fontFamily: "'JetBrains Mono',monospace" }}
          >
            {currency}
            {totalCleared.toLocaleString(undefined, {
              minimumFractionDigits: 2,
            })}
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Voided
            </span>
            <XCircle size={16} className="text-slate-400" />
          </div>
          <div
            className="text-2xl font-bold text-slate-500 finance-nums"
            style={{ fontFamily: "'JetBrains Mono',monospace" }}
          >
            {currency}
            {totalVoided.toLocaleString(undefined, {
              minimumFractionDigits: 2,
            })}
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Avg Payment
            </span>
            <TrendingUp size={16} className="text-indigo-500" />
          </div>
          <div
            className="text-2xl font-bold text-slate-900 finance-nums"
            style={{ fontFamily: "'JetBrains Mono',monospace" }}
          >
            {currency}
            {(filteredSortedData.length > 0
              ? totalAmount / filteredSortedData.length
              : 0
            ).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div className="p-3 border-b border-slate-200/60 flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center bg-slate-50/30 shrink-0">
          <div className="relative w-full sm:max-w-md">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              size={14}
            />
            <input
              type="text"
              placeholder="Search payments by ID, supplier, reference..."
              className="w-full pl-9 pr-9 py-2 border border-slate-200/80 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/70 font-normal placeholder:text-slate-400"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <div className="flex items-center gap-1">
              <Filter size={12} className="text-slate-400" />
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as any)}
                className="text-[11px] border border-slate-200 rounded px-2 py-1 bg-white"
              >
                <option value="all">All Dates</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
                <option value="90d">Last 90 Days</option>
                <option value="year">Last Year</option>
              </select>
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="text-[11px] border border-slate-200 rounded px-2 py-1 bg-white"
            >
              <option value="all">All Statuses</option>
              <option value="Cleared">Cleared</option>
              <option value="Voided">Voided</option>
            </select>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              className="text-[11px] border border-slate-200 rounded px-2 py-1 bg-white"
            >
              <option value="all">All Methods</option>
              {paymentMethodOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-auto custom-scrollbar">
          <table className="w-full text-left text-[11px] md:text-[13px] table-auto md:table-fixed">
            <thead className="bg-slate-50/80 backdrop-blur text-slate-500 sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="table-header text-center hidden md:table-cell md:w-[3%]">
                  <button
                    onClick={() =>
                      setSelectedIds(
                        selectedIds.length === filteredSortedData.length
                          ? []
                          : filteredSortedData.map((p) => p.id),
                      )
                    }
                    className="inline-flex items-center justify-center w-5 h-5 rounded border border-slate-300 hover:border-blue-400 hover:bg-blue-50 transition-colors"
                  >
                    {selectedIds.length > 0 &&
                    selectedIds.length === filteredSortedData.length ? (
                      <CheckCircle size={14} className="text-blue-600" />
                    ) : (
                      <AlertCircle size={14} className="text-slate-400" />
                    )}
                  </button>
                </th>
                <th
                  className="table-header text-left md:w-[13%] cursor-pointer select-none"
                  onClick={() => handleSort("id")}
                >
                  <div className="flex items-center gap-1">
                    Payment #
                    {sortField === "id" &&
                      (sortDir === "asc" ? (
                        <ChevronRight
                          size={10}
                          className="rotate-180 transform"
                        />
                      ) : (
                        <ChevronRight size={10} />
                      ))}
                  </div>
                </th>
                <th
                  className="table-header text-left md:w-[14%] hidden sm:table-cell cursor-pointer"
                  onClick={() => handleSort("supplier")}
                >
                  <div className="flex items-center gap-1">
                    Supplier
                    {sortField === "supplier" &&
                      (sortDir === "asc" ? (
                        <ChevronRight
                          size={10}
                          className="rotate-180 transform"
                        />
                      ) : (
                        <ChevronRight size={10} />
                      ))}
                  </div>
                </th>
                <th
                  className="table-header text-left md:w-[11%] hidden md:table-cell cursor-pointer"
                  onClick={() => handleSort("date")}
                >
                  <div className="flex items-center gap-1">
                    Date
                    {sortField === "date" &&
                      (sortDir === "asc" ? (
                        <ChevronRight
                          size={10}
                          className="rotate-180 transform"
                        />
                      ) : (
                        <ChevronRight size={10} />
                      ))}
                  </div>
                </th>
                <th className="table-header text-center md:w-[9%]">Method</th>
                <th className="table-header text-center md:w-[9%]">Status</th>
                <th
                  className="table-header text-right md:w-[10%] cursor-pointer"
                  onClick={() => handleSort("amount")}
                >
                  <div className="flex items-center justify-end gap-1">
                    Amount
                    {sortField === "amount" &&
                      (sortDir === "asc" ? (
                        <ChevronRight
                          size={10}
                          className="rotate-180 transform"
                        />
                      ) : (
                        <ChevronRight size={10} />
                      ))}
                  </div>
                </th>
                <th className="table-header text-center md:w-[9%]">
                  Reference
                </th>
                <th className="table-header text-center md:w-[9%]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100/50">
              {filteredSortedData.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-3 text-slate-400">
                      <Banknote size={40} style={{ opacity: 0.3 }} />
                      <p className="text-sm font-medium">
                        No supplier payments found
                      </p>
                      <p className="text-xs">
                        {searchTerm
                          ? "Try adjusting your search"
                          : "Record your first supplier payment"}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredSortedData.map((payment: SupplierPayment) => {
                  const isSelected = selectedIds.includes(payment.id);
                  const supplier = suppliers.find(
                    (s) => s.id === payment.supplier_id,
                  );
                  const supplierName =
                    supplier?.name || payment.supplier_id || "-";
                  const status = getPaymentStatus(payment);
                  const method = getPaymentMethod(payment);
                  const paymentDate = getPaymentDate(payment);
                  const isVoided = status === "Voided";

                  return (
                    <tr
                      key={payment.id}
                      className={`transition-colors cursor-pointer group ${
                        isSelected ? "bg-blue-50/80" : "hover:bg-blue-50/50"
                      }`}
                    >
                      <td
                        className="table-body-cell text-center hidden md:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedIds((prev) =>
                              prev.includes(payment.id)
                                ? prev.filter((i) => i !== payment.id)
                                : [...prev, payment.id],
                            );
                          }}
                          aria-label={
                            isSelected
                              ? `Deselect payment ${payment.id}`
                              : `Select payment ${payment.id}`
                          }
                          className="inline-flex items-center justify-center w-5 h-5 rounded border border-slate-300 hover:border-blue-400 hover:bg-blue-50 transition-colors"
                        >
                          {isSelected ? (
                            <CheckCircle size={14} className="text-blue-600" />
                          ) : (
                            <AlertCircle size={14} className="text-slate-400" />
                          )}
                        </button>
                      </td>
                      <td className="table-body-cell text-left font-mono text-slate-500 font-bold truncate">
                        <TransactionRefLink
                          type="supplier_payment"
                          id={payment.id}
                          number={payment.id}
                          label={payment.id}
                        />
                      </td>
                      <td className="table-body-cell text-left font-medium text-slate-900 truncate hidden sm:table-cell">
                        {supplierName}
                      </td>
                      <td className="table-body-cell text-left font-normal text-slate-500 truncate hidden md:table-cell">
                        {paymentDate
                          ? format(parseISO(paymentDate), "MMM dd, yyyy")
                          : "-"}
                      </td>
                      <td className="table-body-cell text-center">
                        <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-slate-50 text-slate-600 border border-slate-200">
                          {PAYMENT_METHOD_ICONS[method] || (
                            <Banknote size={14} />
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 capitalize">
                          {method}
                        </div>
                      </td>
                      <td className="table-body-cell text-center">
                        <span
                          className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${getPaymentBadge(status)}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="table-body-cell text-right font-bold finance-nums truncate">
                        <span
                          className={
                            isVoided
                              ? "text-slate-400 line-through"
                              : "text-slate-900"
                          }
                        >
                          {currency}
                          {(Number(payment.amount) || 0).toLocaleString(
                            undefined,
                            { minimumFractionDigits: 2 },
                          )}
                        </span>
                      </td>
                      <td className="table-body-cell text-center">
                        <span className="text-[11px] text-slate-500 font-mono truncate max-w-[100px] block">
                          {payment.reference || "-"}
                        </span>
                      </td>
                      <td className="table-body-cell text-center">
                        <div className="flex justify-center gap-0.5 md:gap-1 items-center shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePreview("SUPPLIER_PAYMENT", payment);
                            }}
                            className="p-1 md:p-1.5 text-slate-500 hover:text-blue-600 bg-slate-50 hover:bg-white border border-transparent hover:border-slate-200 rounded transition-all hidden sm:flex"
                            title="Preview Payment"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadPDF(payment);
                            }}
                            className="p-1 md:p-1.5 text-slate-500 hover:text-blue-600 bg-slate-50 hover:bg-white border border-transparent hover:border-slate-200 rounded transition-all hidden sm:flex"
                            title="Download Voucher PDF"
                          >
                            <Download size={14} />
                          </button>
                          {!isVoided && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setVoidConfirmId(payment.id);
                              }}
                              className="p-1 md:p-1.5 text-slate-500 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded transition-all"
                              title="Void Payment"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleContextMenu(e, payment.id);
                            }}
                            className="p-1 md:p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
                          >
                            <MoreVertical size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {contextMenuId && contextPos && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-white border border-slate-200 rounded-xl shadow-premium overflow-hidden"
          style={{ top: contextPos.y, left: contextPos.x, minWidth: 200 }}
        >
          <div
            className="p-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider"
            style={{ padding: "8px 12px" }}
          >
            Actions
          </div>
          <button
            onClick={() => {
              const p = supplierPayments.find((sp) => sp.id === contextMenuId);
              if (p) handleCopyVerificationLink(p);
              setContextMenuId(null);
            }}
            style={{
              width: "100%",
              padding: "8px 16px",
              textAlign: "left",
              fontSize: 12,
              fontWeight: 600,
              color: "#23282A",
              cursor: "pointer",
              border: "none",
              background: "transparent",
              transition: "background .12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = teal[50])}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Copy Verification Link
          </button>
          <button
            onClick={() => {
              const p = supplierPayments.find((sp) => sp.id === contextMenuId);
              if (p) handleDownloadPDF(p);
              setContextMenuId(null);
            }}
            style={{
              width: "100%",
              padding: "8px 16px",
              textAlign: "left",
              fontSize: 12,
              fontWeight: 600,
              color: "#23282A",
              cursor: "pointer",
              border: "none",
              background: "transparent",
              transition: "background .12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = teal[50])}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Download Voucher
          </button>
          {contextMenuId &&
            getPaymentStatus(
              supplierPayments.find((sp) => sp.id === contextMenuId) as any,
            ) !== "Voided" && (
              <button
                onClick={() => {
                  setVoidConfirmId(contextMenuId);
                  setContextMenuId(null);
                }}
                style={{
                  width: "100%",
                  padding: "8px 16px",
                  textAlign: "left",
                  fontSize: 12,
                  fontWeight: 600,
                  color: danger,
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  transition: "background .12s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "#fde8e7")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                Void Payment
              </button>
            )}
        </div>
      )}

      {voidConfirmId !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setVoidConfirmId(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-12 h-12 rounded-lg bg-rose-50 flex items-center justify-center">
                  <AlertTriangle size={24} className="text-rose-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900">
                    Void Supplier Payment
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    This will reverse the payment, restore the supplier's
                    account balance, and undo the ledger entry. This action
                    cannot be undone.
                  </p>
                </div>
              </div>
              <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 mb-4">
                <p className="text-xs text-rose-700 font-medium">
                  Payment ID: {voidConfirmId}
                  <br />
                  Amount:{" "}
                  {formatCurrency(
                    supplierPayments.find((sp) => sp.id === voidConfirmId)
                      ?.amount,
                    currency,
                  )}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setVoidConfirmId(null)}
                  className="flex-1 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg font-semibold hover:bg-slate-200 transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleVoidPayment(voidConfirmId)}
                  className="flex-1 px-4 py-2 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700 transition-colors text-sm"
                >
                  Void Payment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showRecordingModal && (
        <NewSupplierPaymentModal
          onClose={() => setShowRecordingModal(false)}
          onSuccess={(payment) => {
            setShowRecordingModal(false);
          }}
        />
      )}
    </div>
  );
};

export default SupplierPayments;
