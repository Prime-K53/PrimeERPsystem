import React, { useMemo, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { useSales } from '../../context/SalesContext';
import { format, parseISO } from 'date-fns';
import {
  Users, Printer, Search, FileSpreadsheet, Mail, Eye,
  RefreshCw, Building2, ChevronDown, AlertTriangle, CheckCircle,
  Clock, FileText, X, Info, Download, Send
} from 'lucide-react';
import { currencyService } from '../../services/currencyService';
import {
  buildLedgerFromRecords,
  type LedgerTransaction,
} from '../../services/customerLedger';
import { exportToCSV } from '../../utils/helpers';
import { useDocumentStore } from '../../stores/documentStore';
import { mapToInvoiceData } from '../../utils/pdfMapper';

interface FilterState {
  customerId: string;
  startDate: string;
  endDate: string;
  voucherType: string;
}

interface DisplaySettings {
  showCompanyDetails: boolean;
  showCustomerDetails: boolean;
  showTransactionCount: boolean;
  showOutstandingInRed: boolean;
  showNarration: boolean;
  showBillDetails: boolean;
  showPostDatedVouchers: boolean;
  showAllAccountAmounts: boolean;
}

const VOUCHER_TYPES = ['All', 'Invoice', 'Receipt', 'Credit Note', 'Debit Note', 'Adjustment'] as const;
type VoucherType = typeof VOUCHER_TYPES[number];

const CustomerStatement: React.FC = () => {
  const { companyConfig } = useAuth();
  const { invoices = [] } = useFinance();
  const { customers = [], customerPayments = [] } = useSales();
  const { safeOpenPreview } = useDocumentStore();

  const currency = companyConfig?.currencySymbol ||
    currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || 'K';

  const today = new Date();
  const defaultStart = format(new Date(today.getFullYear(), today.getMonth(), 1), 'yyyy-MM-dd');
  const defaultEnd = format(today, 'yyyy-MM-dd');

  const [filters, setFilters] = useState<FilterState>({
    customerId: '',
    startDate: defaultStart,
    endDate: defaultEnd,
    voucherType: 'All',
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>({
    showCompanyDetails: true,
    showCustomerDetails: true,
    showTransactionCount: true,
    showOutstandingInRed: true,
    showNarration: false,
    showBillDetails: false,
    showPostDatedVouchers: true,
    showAllAccountAmounts: false,
  });
  const [showSettings, setShowSettings] = useState(false);

  const selectedCustomer = useMemo(
    () => customers.find((c: any) => c.id === filters.customerId),
    [customers, filters.customerId]
  );

  const customerInvoices = useMemo(() => {
    if (!filters.customerId) return [];
    return invoices.filter((inv: any) => inv.customerId === filters.customerId);
  }, [invoices, filters.customerId]);

  const customerPaymentsList = useMemo(() => {
    if (!filters.customerId) return [];
    return customerPayments.filter((p: any) => p.customerId === filters.customerId);
  }, [customerPayments, filters.customerId]);

  const openingBalance = Number(selectedCustomer?.balance || 0);

  const canonicalLedger = useMemo(
    () => buildLedgerFromRecords({
      customerId: filters.customerId,
      invoices: customerInvoices,
      payments: customerPaymentsList,
      openingBalance,
    }),
    [filters.customerId, customerInvoices, customerPaymentsList, openingBalance]
  );

  const { startT, endT } = useMemo(() => {
    const s = filters.startDate ? new Date(filters.startDate).getTime() : null;
    const e = filters.endDate ? new Date(filters.endDate).getTime() + 86400000 - 1 : null;
    return { startT: s, endT: e };
  }, [filters.startDate, filters.endDate]);

  const todayT = useMemo(() => {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    return now.getTime();
  }, []);

  const filteredTransactions = useMemo(() => {
    if (!filters.customerId) return [];

    const invMeta = new Map(customerInvoices.map((inv: any) => [String(inv.id), inv]));
    const payMeta = new Map(customerPaymentsList.map((p: any) => [String(p.id), p]));

    const ledgerWindow: LedgerTransaction[] = [];
    let runningOpen = openingBalance;

    for (const tx of canonicalLedger.transactions) {
      const ts = tx.date ? new Date(tx.date).getTime() : null;
      if (startT != null && ts != null && ts < startT) {
        runningOpen = runningOpen + tx.debit - tx.credit;
        continue;
      }
      if (endT != null && ts != null && ts > endT) continue;
      ledgerWindow.push(tx);
    }

    const visible: Array<{
      id: string; date: string; docNumber: string; reference: string;
      description: string; debit: number; credit: number; runningBalance: number;
      status: string; type: string; outstanding: boolean; originalDate: string | null;
      items: any[];
    }> = [];

    let running = runningOpen;
    for (const tx of ledgerWindow) {
      running = running + tx.debit - tx.credit;
      const meta: any = tx.type === 'payment' ? payMeta.get(tx.id) : invMeta.get(tx.id);

      if (!displaySettings.showPostDatedVouchers) {
        const txnTs = tx.date ? new Date(tx.date).getTime() : null;
        if (txnTs !== null && txnTs > todayT) continue;
      }

      let docNumber = '';
      let reference = '';
      let originalDate: string | null = null;
      if (tx.type === 'payment') {
        docNumber = meta?.receiptNumber || tx.id;
        reference = meta?.reference || meta?.invoiceId || '';
        originalDate = meta?.date || meta?.createdAt || tx.date;
      } else if (tx.type === 'credit_note') {
        docNumber = meta?.invoiceNumber || tx.id;
        reference = meta?.reference || meta?.orderNumber || '';
        originalDate = meta?.date || tx.date;
      } else {
        docNumber = meta?.invoiceNumber || tx.id;
        reference = meta?.reference || meta?.orderNumber || '';
        originalDate = meta?.date || tx.date;
      }

      let outstanding = false;
      let txItems: any[] = [];
      if (tx.type === 'invoice') {
        const total = Number(meta?.totalAmount || 0);
        const paid = Number(meta?.paidAmount || 0);
        outstanding = total - paid > 0.01;
        txItems = Array.isArray(meta?.items) ? meta.items : [];
      }

      let voucherType = 'Other';
      if (tx.type === 'invoice') voucherType = 'Invoice';
      else if (tx.type === 'payment') voucherType = 'Receipt';
      else if (tx.type === 'credit_note') voucherType = 'Credit Note';

      visible.push({
        id: tx.id,
        date: tx.date || '',
        docNumber,
        reference,
        description: tx.description,
        debit: tx.debit,
        credit: tx.credit,
        runningBalance: running,
        status: tx.status,
        type: voucherType,
        outstanding,
        originalDate,
        items: txItems,
      });
    }

    return visible;
  }, [canonicalLedger, customerInvoices, customerPaymentsList, filters, openingBalance, startT, endT, displaySettings.showPostDatedVouchers, todayT]);

  const searchedTransactions = useMemo(() => {
    if (!searchQuery.trim()) return filteredTransactions;
    const q = searchQuery.toLowerCase();
    return filteredTransactions.filter(tx =>
      tx.docNumber.toLowerCase().includes(q) ||
      tx.description.toLowerCase().includes(q) ||
      tx.reference.toLowerCase().includes(q)
    );
  }, [filteredTransactions, searchQuery]);

  const displayedTransactions = useMemo(() => {
    if (filters.voucherType === 'All') return searchedTransactions;
    return searchedTransactions.filter(tx => tx.type === filters.voucherType);
  }, [searchedTransactions, filters.voucherType]);

  const totalDebit = useMemo(
    () => displayedTransactions.reduce((s, tx) => s + tx.debit, 0),
    [displayedTransactions]
  );
  const totalCredit = useMemo(
    () => displayedTransactions.reduce((s, tx) => s + tx.credit, 0),
    [displayedTransactions]
  );
  const closingBalance = useMemo(() => {
    if (displayedTransactions.length === 0) return openingBalance;
    return displayedTransactions[displayedTransactions.length - 1].runningBalance;
  }, [displayedTransactions, openingBalance]);

  const openingBalanceInPeriod = useMemo(() => {
    if (!filters.customerId) return 0;
    let ob = openingBalance;
    for (const tx of canonicalLedger.transactions) {
      const ts = tx.date ? new Date(tx.date).getTime() : null;
      if (startT != null && ts != null && ts < startT) {
        ob = ob + tx.debit - tx.credit;
      }
    }
    return ob;
  }, [canonicalLedger, filters.customerId, openingBalance, startT]);

  const formatCurrency = useCallback((val: number) => {
    if (!isFinite(val)) return `${currency}0.00`;
    return `${currency}${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, [currency]);

  const safeFormatDate = useCallback((dateStr: string | null | undefined) => {
    if (!dateStr) return '—';
    try { return format(parseISO(dateStr), 'dd/MM/yyyy'); }
    catch { return dateStr; }
  }, []);

  const handleGenerate = () => {
    if (!filters.customerId) return;
  };

  const handlePreviewPDF = () => {
    if (!selectedCustomer) return;

    const statementData = {
      date: format(new Date(), 'yyyy-MM-dd'),
      customerName: selectedCustomer.companyName || selectedCustomer.name || 'Customer',
      customerCode: selectedCustomer.id || '',
      address: selectedCustomer.address || '',
      phone: selectedCustomer.phone || '',
      email: selectedCustomer.email || '',
      startDate: filters.startDate,
      endDate: filters.endDate,
      currency,
      openingBalance: openingBalanceInPeriod,
      transactions: displayedTransactions.map(tx => ({
        date: tx.date ? format(new Date(tx.date), 'yyyy-MM-dd') : '',
        reference: tx.reference || tx.docNumber,
        memo: tx.description,
        debit: tx.debit,
        credit: tx.credit,
        runningBalance: tx.runningBalance,
      })),
      totalInvoiced: totalDebit,
      totalReceived: totalCredit,
      finalBalance: closingBalance,
    };

    safeOpenPreview('ACCOUNT_STATEMENT', statementData);
  };

  const handleExportCSV = () => {
    if (displayedTransactions.length === 0) return;
    const headers = ['Date', 'Particulars', 'Voucher No.', 'Reference No.', 'Voucher Type', 'Debit', 'Credit', 'Running Balance'];
    const rows = displayedTransactions.map(tx => ({
      Date: tx.date ? format(new Date(tx.date), 'yyyy-MM-dd') : '',
      Particulars: tx.description,
      'Voucher No.': tx.docNumber,
      'Reference No.': tx.reference,
      'Voucher Type': tx.type,
      Debit: tx.debit || '',
      Credit: tx.credit || '',
      'Running Balance': tx.runningBalance,
    }));

    const openingRow = {
      Date: filters.startDate,
      Particulars: 'Opening Balance',
      'Voucher No.': '',
      'Reference No.': '',
      'Voucher Type': '',
      Debit: '',
      Credit: '',
      'Running Balance': openingBalanceInPeriod,
    };

    const totalRow = {
      Date: '',
      Particulars: 'TOTALS',
      'Voucher No.': '',
      'Reference No.': '',
      'Voucher Type': '',
      Debit: totalDebit,
      Credit: totalCredit,
      'Running Balance': closingBalance,
    };

    const csvData = [
      { Date: 'STATEMENT PERIOD:', Particulars: `${filters.startDate} to ${filters.endDate}`, 'Voucher No.': '', 'Reference No.': '', 'Voucher Type': '', Debit: '', Credit: '', 'Running Balance': '' },
      { Date: 'CUSTOMER:', Particulars: selectedCustomer?.companyName || selectedCustomer?.name || '', 'Voucher No.': '', 'Reference No.': '', 'Voucher Type': '', Debit: '', Credit: '', 'Running Balance': '' },
      openingRow,
      ...rows,
      totalRow,
    ];

    const headers2 = Object.keys(csvData[0]);
    const csvContent = [
      headers2.join(','),
      ...csvData.map(row =>
        headers2.map(h => {
          const val = (row as any)[h];
          const str = val === null || val === undefined ? '' : String(val);
          const escaped = str.replace(/"/g, '""');
          return escaped.includes(',') ? `"${escaped}"` : escaped;
        }).join(',')
      )
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Customer_Statement_${selectedCustomer?.companyName || selectedCustomer?.name || 'customer'}_${filters.startDate}_to_${filters.endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleEmailStatement = async () => {
    if (!selectedCustomer?.email) {
      alert('No email address on file for this customer.');
      return;
    }
    try {
      const statementData = {
        date: format(new Date(), 'yyyy-MM-dd'),
        customerName: selectedCustomer.companyName || selectedCustomer.name || 'Customer',
        customerCode: selectedCustomer.id || '',
        address: selectedCustomer.address || '',
        phone: selectedCustomer.phone || '',
        email: selectedCustomer.email || '',
        startDate: filters.startDate,
        endDate: filters.endDate,
        currency,
        openingBalance: openingBalanceInPeriod,
        transactions: displayedTransactions.map(tx => ({
          date: tx.date ? format(new Date(tx.date), 'yyyy-MM-dd') : '',
          reference: tx.reference || tx.docNumber,
          memo: tx.description,
          debit: tx.debit,
          credit: tx.credit,
          runningBalance: tx.runningBalance,
        })),
        totalInvoiced: totalDebit,
        totalReceived: totalCredit,
        finalBalance: closingBalance,
      };

      const response = await fetch('/api/reports/customer-statement/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: filters.customerId,
          startDate: filters.startDate,
          endDate: filters.endDate,
          customerEmail: selectedCustomer.email,
          statementData,
        }),
      });

      if (!response.ok) throw new Error('Failed to send email');
      alert('Statement email sent successfully.');
    } catch (err) {
      console.error('Email statement error:', err);
      alert('Failed to send statement email. Please try again.');
    }
  };

  const handleReset = () => {
    setFilters({ customerId: '', startDate: defaultStart, endDate: defaultEnd, voucherType: 'All' });
    setSearchQuery('');
  };

  const setFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const toggleSetting = (key: keyof DisplaySettings) => {
    setDisplaySettings(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isOutstandingRow = (tx: typeof displayedTransactions[0]) =>
    displaySettings.showOutstandingInRed && tx.outstanding;

  return (
    <div className="space-y-4 animate-fadeIn font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-600 to-emerald-800 flex items-center justify-center shadow-lg shadow-emerald-200">
            <FileText size={20} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Customer Statement</h2>
            <p className="text-xs text-slate-500">Bookkeeper-style customer ledger</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-all"
          >
            <Info size={14} />
            Display Settings
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Customer */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Customer</label>
            <div className="relative">
              <Users size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <select
                value={filters.customerId}
                onChange={e => setFilter('customerId', e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer"
              >
                <option value="">Select customer...</option>
                {customers.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {/* Start Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Start Date</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={e => setFilter('startDate', e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">End Date</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={e => setFilter('endDate', e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* Voucher Type */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Voucher Type</label>
            <div className="relative">
              <select
                value={filters.voucherType}
                onChange={e => setFilter('voucherType', e.target.value)}
                className="w-full pl-3 pr-8 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer"
              >
                {VOUCHER_TYPES.map(vt => (
                  <option key={vt} value={vt}>{vt}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {/* Generate Button */}
          <div className="flex items-end">
            <button
              onClick={handleGenerate}
              disabled={!filters.customerId}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-700 text-white text-xs font-bold hover:from-emerald-700 hover:to-emerald-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              <FileText size={14} />
              Generate Statement
            </button>
          </div>
        </div>

        {/* Search & Quick Filters Row */}
        {filters.customerId && (
          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1 relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search by voucher number, reference, or description..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:border-emerald-500 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-all"
            >
              <RefreshCw size={12} />
              Reset
            </button>
          </div>
        )}
      </div>

      {/* Display Settings Panel */}
      {showSettings && filters.customerId && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-700">Display Options</h3>
            <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600">
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { key: 'showCompanyDetails', label: 'Company Details' },
              { key: 'showCustomerDetails', label: 'Customer Details' },
              { key: 'showTransactionCount', label: 'Transaction Count' },
              { key: 'showAllAccountAmounts', label: 'Display Amount for All Accounts' },
              { key: 'showOutstandingInRed', label: 'Outstanding in Red' },
              { key: 'showBillDetails', label: 'Bill Details' },
              { key: 'showNarration', label: 'Narration' },
              { key: 'showPostDatedVouchers', label: 'Post-Dated Vouchers' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(displaySettings as any)[key]}
                  onChange={() => toggleSetting(key as keyof DisplaySettings)}
                  className="w-4 h-4 rounded border-slate-300 text-emerald-600 cursor-pointer"
                />
                <span className="text-xs font-medium text-slate-600">{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      {filters.customerId && displayedTransactions.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={handlePreviewPDF}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-xs font-bold hover:bg-slate-900 transition-all"
          >
            <Eye size={14} />
            Preview PDF
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200 transition-all"
          >
            <Printer size={14} />
            Print
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100 transition-all"
          >
            <FileSpreadsheet size={14} />
            Export CSV
          </button>
          {selectedCustomer?.email && (
            <button
              onClick={handleEmailStatement}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold hover:bg-blue-100 transition-all"
            >
              <Mail size={14} />
              Email Statement
            </button>
          )}
        </div>
      )}

      {/* Empty State */}
      {!filters.customerId && (
        <div className="flex flex-col items-center justify-center py-20 bg-white rounded-xl border border-dashed border-slate-300">
          <Building2 size={48} className="text-slate-300 mb-4" />
          <p className="text-sm font-semibold text-slate-500">Select a customer to generate a statement</p>
          <p className="text-xs text-slate-400 mt-1">Choose a customer and date range above to get started</p>
        </div>
      )}

      {/* Customer Info Banner */}
      {filters.customerId && selectedCustomer && (
        <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl p-4 text-white shadow-lg">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
                <Building2 size={20} className="text-white/80" />
              </div>
              <div>
                <p className="text-sm font-bold">{selectedCustomer.companyName || selectedCustomer.name}</p>
                <p className="text-[10px] text-white/60 font-mono mt-0.5">{selectedCustomer.id}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-white/50 uppercase tracking-widest">Statement Period</p>
              <p className="text-xs font-bold text-white/90 mt-0.5">
                {filters.startDate} — {filters.endDate}
              </p>
            </div>
          </div>
          {displaySettings.showCustomerDetails && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 pt-3 border-t border-white/10">
              {selectedCustomer.address && (
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-widest">Address</p>
                  <p className="text-xs text-white/80 mt-0.5">{selectedCustomer.address}</p>
                </div>
              )}
              {selectedCustomer.phone && (
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-widest">Phone</p>
                  <p className="text-xs text-white/80 mt-0.5">{selectedCustomer.phone}</p>
                </div>
              )}
              {selectedCustomer.email && (
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-widest">Email</p>
                  <p className="text-xs text-white/80 mt-0.5">{selectedCustomer.email}</p>
                </div>
              )}
              {selectedCustomer.creditLimit != null && (
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-widest">Credit Limit</p>
                  <p className="text-xs text-white/80 mt-0.5">{formatCurrency(selectedCustomer.creditLimit)}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary Cards */}
      {filters.customerId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Opening Balance</p>
            <p className="text-lg font-black text-slate-900 finance-nums mt-1">{formatCurrency(openingBalanceInPeriod)}</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Debit</p>
            <p className="text-lg font-black text-rose-600 finance-nums mt-1">{formatCurrency(totalDebit)}</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Credit</p>
            <p className="text-lg font-black text-emerald-600 finance-nums mt-1">{formatCurrency(totalCredit)}</p>
          </div>
          <div className={`rounded-xl border shadow-sm p-4 ${closingBalance > 0 ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200'}`}>
            <p className="text-[10px] font-bold uppercase tracking-widest">Closing Balance</p>
            <p className={`text-lg font-black finance-nums mt-1 ${closingBalance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
              {formatCurrency(closingBalance)}
            </p>
          </div>
        </div>
      )}

      {/* Transaction Table */}
      {filters.customerId && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-emerald-600" />
              <h3 className="font-bold text-slate-900 text-sm">Transaction Ledger</h3>
            </div>
            {displaySettings.showTransactionCount && (
              <span className="text-[10px] text-slate-400 font-mono bg-slate-100 px-2 py-0.5 rounded">
                {displayedTransactions.length} transaction{displayedTransactions.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            {displayedTransactions.length === 0 ? (
              <div className="text-center py-12">
                <FileText size={36} className="mx-auto text-slate-300 mb-3" />
                <p className="text-slate-400 font-medium text-sm">No transactions found for this period.</p>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Date</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Particulars</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Voucher No.</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Reference No.</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Voucher Type</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Debit</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Credit</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {/* Opening Balance Row */}
                  <tr className="bg-slate-50/60">
                    <td className="px-3 py-2.5 text-[11px] text-slate-500 whitespace-nowrap">
                      {filters.startDate ? format(parseISO(filters.startDate), 'dd/MM/yyyy') : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold border bg-slate-100 text-slate-600 border-slate-200">
                        OPENING
                      </span>
                      <span className="ml-2 text-[11px] font-semibold text-slate-700">Opening Balance</span>
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-slate-400">—</td>
                    <td className="px-3 py-2.5 text-[11px] text-slate-400">—</td>
                    <td className="px-3 py-2.5 text-[11px] text-slate-400">—</td>
                    <td className="px-3 py-2.5 text-[11px] text-right text-slate-400">—</td>
                    <td className="px-3 py-2.5 text-[11px] text-right text-slate-400">—</td>
                    <td className="px-3 py-2.5 text-[11px] text-right font-bold text-slate-800 finance-nums">
                      {formatCurrency(openingBalanceInPeriod)}
                    </td>
                  </tr>

                  {displayedTransactions.map((tx, idx) => {
                    const isOutstanding = isOutstandingRow(tx);
                    const typeColor: Record<string, string> = {
                      Invoice: 'bg-blue-50 text-blue-700 border-blue-200',
                      Receipt: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                      'Credit Note': 'bg-purple-50 text-purple-700 border-purple-200',
                      'Debit Note': 'bg-amber-50 text-amber-700 border-amber-200',
                      Adjustment: 'bg-slate-50 text-slate-600 border-slate-200',
                      Other: 'bg-slate-50 text-slate-500 border-slate-200',
                    };
                    return (
                      <React.Fragment key={`${tx.id}-${idx}`}>
                        <tr
                          className={`hover:bg-slate-50/50 transition-colors ${isOutstanding ? 'bg-rose-50/30' : ''}`}
                        >
                          <td className="px-3 py-2.5 text-[11px] text-slate-600 whitespace-nowrap font-medium">
                            {tx.date ? format(parseISO(tx.date), 'dd/MM/yyyy') : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-[11px] font-medium text-slate-700">
                            {displaySettings.showNarration
                              ? tx.description
                              : (tx.description.split(' ').slice(0, 5).join(' ') + (tx.description.split(' ').length > 5 ? '…' : ''))}
                            {isOutstanding && displaySettings.showOutstandingInRed && (
                              <span className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-700 border border-rose-300">
                                <AlertTriangle size={8} />
                                Outstanding
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-[11px] font-mono text-slate-600 font-medium">{tx.docNumber}</td>
                          <td className="px-3 py-2.5 text-[11px] font-mono text-slate-400">{tx.reference || '—'}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${typeColor[tx.type] || typeColor.Other}`}>
                              {tx.type}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-[11px] text-right font-bold text-rose-600 finance-nums">
                            {displaySettings.showAllAccountAmounts
                              ? (tx.debit > 0 ? formatCurrency(tx.debit) : formatCurrency(0))
                              : (tx.debit > 0 ? formatCurrency(tx.debit) : '—')}
                          </td>
                          <td className="px-3 py-2.5 text-[11px] text-right font-bold text-emerald-600 finance-nums">
                            {displaySettings.showAllAccountAmounts
                              ? (tx.credit > 0 ? formatCurrency(tx.credit) : formatCurrency(0))
                              : (tx.credit > 0 ? formatCurrency(tx.credit) : '—')}
                          </td>
                          <td className={`px-3 py-2.5 text-[11px] text-right font-bold finance-nums ${
                            isOutstanding && displaySettings.showOutstandingInRed ? 'text-rose-700' : 'text-slate-900'
                          }`}>
                            {formatCurrency(tx.runningBalance)}
                          </td>
                        </tr>
                        {displaySettings.showBillDetails && tx.originalDate && (
                          <>
                            <tr key={`${tx.id}-${idx}-bill`} className="bg-slate-25 hover:bg-slate-50/30 transition-colors">
                              <td className="px-3 py-0.5 pl-6 text-[10px] text-slate-400" colSpan={2}>
                                <span className="text-slate-400 italic">Original date: {safeFormatDate(tx.originalDate)}</span>
                              </td>
                              <td className="px-3 py-0.5 text-[10px] text-slate-400" colSpan={3}>
                                <span className="text-slate-400 italic">Status: {tx.status || '—'}</span>
                              </td>
                              <td className="px-3 py-0.5 text-[10px] text-right text-slate-400" colSpan={3}></td>
                            </tr>
                            {tx.items && tx.items.length > 0 && (
                              <tr key={`${tx.id}-${idx}-items`} className="bg-slate-25/50">
                                <td className="px-3 py-0.5 pl-10 text-[9px] text-slate-500 border-t border-slate-100" colSpan={8}>
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex gap-4 font-semibold text-slate-500 mb-1">
                                      <span className="w-48">Description</span>
                                      <span className="w-16 text-right">Qty</span>
                                      <span className="w-24 text-right">Price</span>
                                      <span className="w-24 text-right">Total</span>
                                    </div>
                                    {tx.items.map((item: any, iIdx: number) => (
                                      <div key={iIdx} className="flex gap-4 text-slate-500">
                                        <span className="w-48 truncate">{item.desc || item.description || '—'}</span>
                                        <span className="w-16 text-right">{item.qty ?? item.quantity ?? '—'}</span>
                                        <span className="w-24 text-right">{item.price != null ? formatCurrency(item.price) : '—'}</span>
                                        <span className="w-24 text-right">{item.total != null ? formatCurrency(item.total) : '—'}</span>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>

                {/* Totals Footer */}
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50">
                    <td colSpan={5} className="px-3 py-3">
                      <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">Totals</span>
                    </td>
                    <td className="px-3 py-3 text-[11px] text-right font-bold text-rose-700 finance-nums">
                      {formatCurrency(totalDebit)}
                    </td>
                    <td className="px-3 py-3 text-[11px] text-right font-bold text-emerald-700 finance-nums">
                      {formatCurrency(totalCredit)}
                    </td>
                    <td className={`px-3 py-3 text-[11px] text-right font-black text-base finance-nums ${
                      closingBalance > 0 ? 'text-rose-800' : 'text-emerald-800'
                    }`}>
                      {formatCurrency(closingBalance)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      )}

      <style>{`
        @media print {
          body { background: white !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
        }
        @media screen {
          .print-only { display: none; }
        }
      `}</style>
    </div>
  );
};

export default CustomerStatement;
