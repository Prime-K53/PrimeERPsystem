import React, { useState, useEffect, useMemo } from 'react';
import { Transfer } from '../../types';
import { useFinance } from '../../context/FinanceContext';
import { useData, REFRESH_INTERVAL } from '../../context/DataContext';
import { useAuth } from '../../context/AuthContext';
import { useModuleRefresh } from '../../hooks/useModuleRefresh';
import { useBankingStore } from '../../context/BankingContext';
import {
  RefreshCw, Plus, Search, Filter, Download, ArrowRightLeft,
  Building2, Wallet, TrendingUp, TrendingDown, Calendar,
  User, Hash, DollarSign, Clock, CheckCircle, XCircle, X,
  AlertCircle, Eye, Edit, Trash2, ChevronDown
} from 'lucide-react';
import { format, startOfMonth, endOfMonth, isWithinInterval, parseISO } from 'date-fns';
import { exportToCSV } from '../../services/excelService';
import { generateNextId } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';
import { financialReportingService } from '../../services/financialReportingService';
import { getDefaultDate, validateDateInFY } from '../../utils/financialYearUtils';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, EmptyState, tableCard, tableHeadRow, tableHeadCell,
} from './components/financeChrome';

const Transfers: React.FC = () => {
  const { transfers, executeTransfer } = useFinance();
  const {
    accounts: bankingAccounts,
    fetchBankingData,
    createTransaction: createBankTransaction
  } = useBankingStore();
  const { notify, companyConfig } = useAuth();
  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
  
  // State
  const [showModal, setShowModal] = useState<'create' | 'view' | null>(null);
  const [selectedTransfer, setSelectedTransfer] = useState<Transfer | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [dateRange, setDateRange] = useState({
    start: startOfMonth(new Date()).toISOString().split('T')[0],
    end: endOfMonth(new Date()).toISOString().split('T')[0]
  });
  const [filterStatus, setFilterStatus] = useState<'all' | 'completed'>('all');
  const [sortBy, setSortBy] = useState<'date' | 'amount' | 'from' | 'to'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Form state
  const [formData, setFormData] = useState({
    date: getDefaultDate(),
    amount: '',
    fromAccountId: '',
    toAccountId: '',
    description: '',
    reference: ''
  });

  const { refreshAllData } = useData();

  // 5-minute poll + focus refresh
  useModuleRefresh(async () => {
    await Promise.allSettled([
      fetchBankingData(),
      refreshAllData()
    ]);
  }, { interval: REFRESH_INTERVAL });

  // COA balances for book balance display
  const [coaBalances, setCoaBalances] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!bankingAccounts || bankingAccounts.length === 0) return;
    const loadCOABalances = async () => {
      try {
        const balances = await financialReportingService.getBookBalancesForBankAccounts(bankingAccounts);
        setCoaBalances(balances);
      } catch (err) {
        console.error('Failed to load COA balances for transfers:', err);
      }
    };
    loadCOABalances();
  }, [bankingAccounts]);

  // Filter and sort transfers
  const filteredTransfers = useMemo(() => {
    return transfers
      .filter(transfer => {
        const transferDate = parseISO(transfer.date);
        const startDate = parseISO(dateRange.start);
        const endDate = parseISO(dateRange.end);
        return isWithinInterval(transferDate, { start: startDate, end: endDate });
      })
      .filter(transfer => {
        if (!searchTerm) return true;
        const fromAccount = bankingAccounts.find(a => a.id === transfer.fromAccountId)?.name || '';
        const toAccount = bankingAccounts.find(a => a.id === transfer.toAccountId)?.name || '';
        return (
          transfer.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          transfer.reference?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          fromAccount.toLowerCase().includes(searchTerm.toLowerCase()) ||
          toAccount.toLowerCase().includes(searchTerm.toLowerCase())
        );
      })
      .filter(transfer => {
        if (filterStatus === 'all') return true;
        return transfer.status === filterStatus;
      })
      .sort((a, b) => {
        let aValue: any, bValue: any;
        
        switch (sortBy) {
          case 'date':
            aValue = new Date(a.date).getTime();
            bValue = new Date(b.date).getTime();
            break;
          case 'amount':
            aValue = a.amount;
            bValue = b.amount;
            break;
          case 'from':
            aValue = bankingAccounts.find(acc => acc.id === a.fromAccountId)?.name || '';
            bValue = bankingAccounts.find(acc => acc.id === b.fromAccountId)?.name || '';
            break;
          case 'to':
            aValue = bankingAccounts.find(acc => acc.id === a.toAccountId)?.name || '';
            bValue = bankingAccounts.find(acc => acc.id === b.toAccountId)?.name || '';
            break;
          default:
            aValue = new Date(a.date).getTime();
            bValue = new Date(b.date).getTime();
        }
        
        if (sortOrder === 'asc') {
          if (typeof aValue === 'string' && typeof bValue === 'string') return aValue.localeCompare(bValue);
          return aValue > bValue ? 1 : -1;
        } else {
          if (typeof aValue === 'string' && typeof bValue === 'string') return bValue.localeCompare(aValue);
          return aValue < bValue ? 1 : -1;
        }
      });
  }, [transfers, dateRange, searchTerm, filterStatus, sortBy, sortOrder, bankingAccounts]);

  const activeBankAccounts = useMemo(() => {
    return bankingAccounts.filter(account => account.status === 'Active');
  }, [bankingAccounts]);

  // Account balances summary
  const accountBalances = useMemo(() => {
    const balances: Record<string, number> = {};

    bankingAccounts.forEach(account => {
      balances[account.id] = coaBalances[account.id] ?? account.availableBalance ?? account.balance ?? 0;
    });

    return balances;
  }, [bankingAccounts, coaBalances]);

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.fromAccountId || !formData.toAccountId) {
      notify('Please select both source and destination accounts', 'error');
      return;
    }
    
    if (formData.fromAccountId === formData.toAccountId) {
      notify('Source and destination accounts cannot be the same', 'error');
      return;
    }
    
    const amount = parseFloat(formData.amount);
    if (isNaN(amount) || amount <= 0) {
      notify('Please enter a valid amount', 'error');
      return;
    }
    
    // Check if source account has sufficient balance
    const fromAccount = bankingAccounts.find(a => a.id === formData.fromAccountId);
    if (fromAccount) {
      const fromAccountBalance = accountBalances[fromAccount.id] || 0;
      
      if (fromAccountBalance < amount) {
        notify('Insufficient balance in source account', 'error');
        return;
}
    }

    // Validate date against active financial year
    const dateError = validateDateInFY(formData.date);
    if (dateError) { notify(dateError, "error"); return; }

    try {
      const transferId = generateNextId('TRF', transfers, companyConfig);
      const reference = formData.reference || transferId;
      const newTransfer: Transfer = {
        id: transferId,
        date: formData.date,
        amount: amount,
        fromAccountId: formData.fromAccountId,
        toAccountId: formData.toAccountId,
        description: formData.description,
        reference
      };
      
      await executeTransfer(newTransfer);

      // Mirror transfers to banking transactions so bank balances stay accurate.
      await createBankTransaction({
        date: formData.date,
        amount,
        type: 'Withdrawal',
        description: formData.description || `Transfer to ${getAccountName(formData.toAccountId)}`,
        reference,
        bankAccountId: formData.fromAccountId,
        counterparty: { name: getAccountName(formData.toAccountId) },
        category: 'Transfer',
        reconciled: false
      });

      await createBankTransaction({
        date: formData.date,
        amount,
        type: 'Deposit',
        description: formData.description || `Transfer from ${getAccountName(formData.fromAccountId)}`,
        reference,
        bankAccountId: formData.toAccountId,
        counterparty: { name: getAccountName(formData.fromAccountId) },
        category: 'Transfer',
        reconciled: false
      });
      
      // Reset form
      setFormData({
        date: new Date().toISOString().split('T')[0],
        amount: '',
        fromAccountId: '',
        toAccountId: '',
        description: '',
        reference: ''
      });
      
      setShowModal(null);
    } catch (error: any) {
      notify(`Transfer failed: ${error.message}`, 'error');
    }
  };

  // Export to CSV
  const handleExport = () => {
    const exportData = filteredTransfers.map(transfer => ({
      'Date': format(parseISO(transfer.date), 'yyyy-MM-dd'),
      'From Account': bankingAccounts.find(a => a.id === transfer.fromAccountId)?.name || transfer.fromAccountId,
      'To Account': bankingAccounts.find(a => a.id === transfer.toAccountId)?.name || transfer.toAccountId,
      'Amount': transfer.amount.toFixed(2),
      'Description': transfer.description || '',
      'Reference': transfer.reference || ''
    }));
    
    exportToCSV(exportData, `transfers-${format(new Date(), 'yyyy-MM-dd')}`);
  };

  // Get account name by ID
  const getAccountName = (accountId: string) => {
    return bankingAccounts.find(a => a.id === accountId)?.name || accountId;
  };

  return (
    <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
      <PageHeader
        icon={<ArrowRightLeft size={19} color="#fff" />}
        title="Account Transfers"
        subtitle="Transfer funds between accounts & track all movements"
        actions={
          <>
            <button
              onClick={handleExport}
              style={btnGhostStyle}
              onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
            >
              <Download size={15} />
              Export
            </button>
            <button
              onClick={() => setShowModal('create')}
              disabled={activeBankAccounts.length < 2}
              style={{ ...btnPrimaryStyle, opacity: activeBankAccounts.length < 2 ? 0.55 : 1 }}
              onMouseEnter={e => { if (activeBankAccounts.length >= 2) e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <Plus size={15} /> New Transfer
            </button>
          </>
        }
      />

      {activeBankAccounts.length < 2 && (
        <div style={{ margin: '16px 28px 0', padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 600, color: amber[600] }}>
          <AlertCircle size={16} />
          At least two active banking accounts are required to create transfers.
        </div>
      )}

      {/* Summary Cards — KpiCards language */}
      <KpiCards items={[
        { label: 'Total Transfers', value: String(filteredTransfers.length), icon: TrendingUp, color: teal[700], bg: teal[50] },
        { label: 'Total Amount', value: `${currency}${filteredTransfers.reduce((sum, t) => sum + t.amount, 0).toLocaleString()}`, icon: DollarSign, color: teal[600], bg: teal[50] },
        { label: 'Active Accounts', value: String(activeBankAccounts.length), icon: Building2, color: amber[600], bg: amber[100] },
        { label: 'This Period', value: `${format(parseISO(dateRange.start), 'MMM dd')} - ${format(parseISO(dateRange.end), 'MMM dd')}`, icon: Clock, color: amber[600], bg: amber[100] },
      ]} />

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, padding: '16px 28px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', position: 'relative' }}>
          <label style={labelStyle}>Search</label>
          <div style={{ position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search transfers..."
              style={{ ...inputStyle, paddingLeft: 34 }}
            />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Start Date</label>
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>End Date</label>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Status</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as 'all' | 'completed')}
            style={{ ...selectStyle, width: 160 }}
          >
            <option value="all">All Transfers</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Sort By</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'date' | 'amount' | 'from' | 'to')}
              style={{ ...selectStyle, width: 150 }}
            >
              <option value="date">Date</option>
              <option value="amount">Amount</option>
              <option value="from">From Account</option>
              <option value="to">To Account</option>
            </select>
            <button
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              style={btnGhostStyle}
              onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
            >
              <ChevronDown
                size={16}
                style={{ transform: sortOrder === 'desc' ? 'rotate(180deg)' : '', transition: 'transform .15s ease' }}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Transfers Table */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${hairline}`, background: teal[50], borderRadius: '14px 14px 0 0', border: `1.4px solid ${hairline}`, borderBottomWidth: 1 }}>
          <h3 style={{ fontWeight: 700, fontSize: 14, color: ink, margin: 0 }}>
            Transfer History ({filteredTransfers.length} records)
          </h3>
        </div>
        <div style={{ ...tableCard, borderRadius: '0 0 14px 14px', borderTop: 'none' }}>
          {filteredTransfers.length === 0 ? (
            <div style={{ padding: 24 }}>
              <EmptyState icon={<ArrowRightLeft size={32} />} title="No transfers found" hint="No transfers found for the selected period." />
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={tableHeadRow}>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Date</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>From Account</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>To Account</th>
                    <th style={{ ...tableHeadCell, textAlign: 'right' }}>Amount</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Description</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Reference</th>
                    <th style={{ ...tableHeadCell, textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransfers.map((transfer) => (
                    <tr key={transfer.id}
                      style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                      onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '12px 16px', color: ink, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Calendar size={14} style={{ color: inkSoft }} />
                          {format(parseISO(transfer.date), 'MMM dd, yyyy')}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ padding: 8, borderRadius: 8, background: '#fdeeee', color: danger }}>
                            <TrendingDown size={14} />
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: ink }}>
                              {getAccountName(transfer.fromAccountId)}
                            </div>
                            <div style={{ fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>
                              Balance: {currency}{accountBalances[transfer.fromAccountId]?.toLocaleString() || '0.00'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ padding: 8, borderRadius: 8, background: teal[50], color: teal[700] }}>
                            <TrendingUp size={14} />
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: ink }}>
                              {getAccountName(transfer.toAccountId)}
                            </div>
                            <div style={{ fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>
                              Balance: {currency}{accountBalances[transfer.toAccountId]?.toLocaleString() || '0.00'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                          {currency}{transfer.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: 13, color: inkSoft }}>
                        {transfer.description || '-'}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '3px 8px', borderRadius: 6, background: teal[50], color: inkSoft }}>
                          {transfer.reference || '-'}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                          <button
                            onClick={() => {
                              setSelectedTransfer(transfer);
                              setShowModal('view');
                            }}
                            style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                            title="View details"
                            onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <Eye size={16} style={{ color: teal[600] }} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* New Transfer Modal */}
      {showModal === 'create' && (
        <div style={modalOverlayStyle} onClick={() => setShowModal(null)}>
          <div style={modalShell(600)} onClick={e => e.stopPropagation()}>
            <AccentStripe />
            <ModalHeader
              icon={<ArrowRightLeft size={19} color="#fff" />}
              title="New Transfer"
              subtitle="Move funds between accounts — Transfer ledger"
              onClose={() => setShowModal(null)}
            />
            <form id="transfer-create-form" onSubmit={handleSubmit} style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Transfer Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  style={inputStyle}
                  required
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Amount <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    placeholder="0.00"
                    style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                    required
                  />
                </div>
              </div>
              <div style={sectionLabelStyle}><span>Accounts</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>From Account <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                  <select
                    value={formData.fromAccountId}
                    onChange={(e) => setFormData({ ...formData, fromAccountId: e.target.value })}
                    style={selectStyle}
                    required
                  >
                    <option value="">Select account</option>
                    {activeBankAccounts
                      .filter(acc => acc.id !== formData.toAccountId)
                      .map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name} (Balance: {currency}{(accountBalances[account.id] || 0).toLocaleString()})
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>To Account <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                  <select
                    value={formData.toAccountId}
                    onChange={(e) => setFormData({ ...formData, toAccountId: e.target.value })}
                    style={selectStyle}
                    required
                  >
                    <option value="">Select account</option>
                    {activeBankAccounts
                      .filter(acc => acc.id !== formData.fromAccountId)
                      .map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name} (Balance: {currency}{(accountBalances[account.id] || 0).toLocaleString()})
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Description
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Transfer description"
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Reference
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                </label>
                <input
                  type="text"
                  value={formData.reference}
                  onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                  placeholder="Reference number"
                  style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                />
              </div>
            </form>
            <ModalFooter
              stepLabel="Transfer · posts two legs"
              onCancel={() => setShowModal(null)}
              submitLabel="Transfer Funds"
              submitFormId="transfer-create-form"
            />
          </div>
        </div>
      )}

      {/* View Transfer Modal */}
      {showModal === 'view' && selectedTransfer && (
        <div style={modalOverlayStyle} onClick={() => setShowModal(null)}>
          <div style={modalShell(560)} onClick={e => e.stopPropagation()}>
            <AccentStripe />
            <ModalHeader
              icon={<ArrowRightLeft size={19} color="#fff" />}
              title="Transfer Details"
              subtitle={`${selectedTransfer.reference || selectedTransfer.id} · Transfer ledger`}
              onClose={() => setShowModal(null)}
            />
            <div style={{ padding: '24px 28px', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div style={{ padding: 14, borderRadius: 10, background: teal[50], border: `1px solid ${hairline}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 4 }}>Date</div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: ink }}>{format(parseISO(selectedTransfer.date), 'MMMM dd, yyyy')}</div>
                </div>
                <div style={{ padding: 14, borderRadius: 10, background: teal[50], border: `1px solid ${hairline}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 4 }}>Amount</div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{currency}{selectedTransfer.amount.toLocaleString()}</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={labelStyle}>From Account</div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <TrendingDown size={16} style={{ color: danger }} />
                    {getAccountName(selectedTransfer.fromAccountId)}
                  </div>
                </div>
                <div>
                  <div style={labelStyle}>To Account</div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <TrendingUp size={16} style={{ color: teal[600] }} />
                    {getAccountName(selectedTransfer.toAccountId)}
                  </div>
                </div>
                {selectedTransfer.description && (
                  <div>
                    <div style={labelStyle}>Description</div>
                    <div style={{ fontSize: 13, color: ink }}>{selectedTransfer.description}</div>
                  </div>
                )}
                {selectedTransfer.reference && (
                  <div>
                    <div style={labelStyle}>Reference</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: teal[50], border: `1px solid ${hairline}`, padding: '6px 10px', borderRadius: 8, display: 'inline-block', color: ink }}>
                      {selectedTransfer.reference}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <ModalFooter stepLabel="Transfer · read-only" onCancel={() => setShowModal(null)} submitLabel="Close" onSubmit={() => setShowModal(null)} />
          </div>
        </div>
      )}
    </div>
  );
};

export default Transfers;
