import React, { useEffect, useMemo, useState } from 'react';
import {
  FileText, Plus, Search, RefreshCw, Calendar, Wallet, Printer,
  Play, Pause, Edit2, Trash2, Eye, CheckCircle, Ban,
  ClipboardList, History, Landmark, ChevronRight, PenLine,
} from 'lucide-react';
import type {
  AssessmentContract, AssessmentContractItem, ContractAmendment,
  Customer, ExaminationBatch, School, JobOrder, WalletTransaction,
} from '../../types';
import { useFinanceStore } from '../../stores/financeStore';
import { useSalesStore } from '../../stores/salesStore';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import {
  emptyContractLine, contractLineAmount, contractLinesTotal, contractLinesQuantity,
  isValidContractLine, buildContractItemsFromLines, buildInvoiceDraftFromContract,
  type ContractFormLine,
} from '../../utils/contractInvoiceDraft';
import {
  CONTRACT_TRANSITIONS,
  applyContractSignature,
  applySignatureVoid,
  generateNextContractNumber,
  isAllowedContractTransition,
  isFullySigned,
  isSignableContractStatus,
  matchContractWalletTx,
  readContractSignatures,
  resolveActivationEvidence,
  validateAmendmentAdjustments,
  type SignatureParty,
} from '../../utils/contractLifecycle';
import { SignatureCapture, type CapturedContractSignature } from './SignatureCapture';
import { buildPrintingContractDoc } from '../../services/printingContractService';
import { PrintingContractSchema } from '../../views/shared/components/PDF/schemas';
import { PreviewModal } from '../../views/shared/components/PDF/PreviewModal';
import { dbService } from '../../services/db';
import { generateNextId } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';
import { ConfirmDialog, ConfirmDialogType } from '../ConfirmDialog';
import {
  ContractModalShell, ContractSectionLabel, ContractGhostButton, ContractPrimaryButton,
  contractLabelStyle, contractInputStyle, contractTextareaStyle, contractSelectStyle,
  contractGridStyle, ContractRequiredMark,
  contractTeal, contractAmber, contractPaper, contractInk, contractHairline, contractInkSoft, contractDanger,
  contractIconTileStyle, contractPageTitleStyle, contractPageSubtitleStyle,
  contractFilterControlStyle, contractFilterSelectStyle,
} from './contractModalChrome';

/**
 * Printing Contracts hub (formerly "Subscriptions").
 *
 * Implements the Phase 2B domain design + Phase 3A implementation plan
 * (§20 UI plan, §11–13 data model, §18 financial flow) on top of the
 * existing `assessment_contracts` / `assessment_contract_items` /
 * `contract_amendments` tables (supabase/migrations/0006 + 0019):
 *
 * - Printing Contract  = commercial agreement + prepaid entitlement + schedule
 *   (may span financial years; FY scoping applies to assessments/jobs/txns).
 * - Contract Assessment = individual contractual printing event, optionally
 *   linked to a Job Order (operational execution) and/or an examination
 *   printing batch.
 * - Wallet stays the sole financial source of truth: contract.prepaid_amount
 *   is the commercial figure; Customer.walletBalance moves only at payment
 *   time (Deposit on activation, Deduction on job payment, Credit on refund).
 * - Legacy `recurring_invoices` data is retained read-only (plan §14) under
 *   the collapsed "Legacy recurring billing" section — never converted.
 */

type ContractStatus = AssessmentContract['status'];
type ItemStatus = AssessmentContractItem['status'];

const CONTRACT_STATUSES: ContractStatus[] = [
  'draft', 'pending_payment', 'active', 'suspended', 'completed', 'expired', 'cancelled',
];

const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: 'Draft',
  pending_payment: 'Pending Payment',
  active: 'Active',
  suspended: 'Suspended',
  completed: 'Completed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const CONTRACT_STATUS_STYLE: Record<ContractStatus, string> = {
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  pending_payment: 'bg-amber-50 text-amber-700 border-amber-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  suspended: 'bg-orange-50 text-orange-700 border-orange-200',
  completed: 'bg-blue-50 text-blue-700 border-blue-200',
  expired: 'bg-stone-100 text-stone-500 border-stone-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  reserved: 'Reserved',
  consumed: 'Consumed',
  released: 'Released',
  cancelled: 'Cancelled',
};

const ITEM_STATUS_STYLE: Record<ItemStatus, string> = {
  reserved: 'bg-amber-50 text-amber-700 border-amber-200',
  consumed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  released: 'bg-slate-100 text-slate-600 border-slate-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

/** Lifecycle edges live in utils/contractLifecycle so the finance store
 * enforces the same map (UI checks alone are bypassable). */

type DetailTab = 'overview' | 'assessments' | 'jobs' | 'wallet' | 'amendments';

const DETAIL_TAB_LABEL: Record<DetailTab, string> = {
  overview: 'Overview',
  assessments: 'Assessments',
  jobs: 'Printing Jobs',
  wallet: 'Wallet',
  amendments: 'Amendments',
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const toDateInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fundsOf = (c: AssessmentContract) => ({
  prepaid: num(c.prepaid_amount),
  consumed: num(c.consumed_amount),
  reserved: num(c.reserved_amount),
  available: c.available_funds != null
    ? num(c.available_funds)
    : num(c.prepaid_amount) - num(c.consumed_amount) - num(c.reserved_amount),
});

const emptyContractDraft = () => ({
  title: '',
  customer_id: '',
  school_id: '',
  assessment_type: 'examination',
  assessment_grade: '',
  assessment_subject: '',
  prepaid_amount: 0,
  max_assessments: 1,
  assessment_price: 0,
  starts_at: new Date().toISOString().slice(0, 10),
  ends_at: '',
  description: '',
  terms: '',
  notes: '',
  // Invoice-style billable lines (create mode). Totals derive from these,
  // exactly like invoice lines roll up into the invoice total.
  lines: [emptyContractLine()] as ContractFormLine[],
});

const emptyItemDraft = () => ({
  assessment_name: '',
  assessment_type: 'examination',
  assessment_grade: '',
  assessment_subject: '',
  assessment_date: new Date().toISOString().slice(0, 10),
  item_price: 0,
  notes: '',
});

const PrintingContractsView: React.FC = () => {
  const { companyConfig, notify, user, checkPermission } = useAuth() as ReturnType<typeof useAuth> & {
    checkPermission?: (permissionId: string) => boolean;
  };
  const { addInvoice } = useFinance();
  const currency = companyConfig?.currencySymbol
    || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol
    || '$';

  const assessmentContracts = useFinanceStore(s => s.assessmentContracts);
  const contractAssessments = useFinanceStore(s => s.contractAssessments);
  const contractAmendments = useFinanceStore(s => s.contractAmendments);
  const walletTransactions = useFinanceStore(s => s.walletTransactions);
  const invoices = useFinanceStore(s => s.invoices);
  const legacyRecurring = useFinanceStore(s => s.recurringInvoices);
  const fetchFinanceData = useFinanceStore(s => s.fetchFinanceData);
  const addAssessmentContract = useFinanceStore(s => s.addAssessmentContract);
  const updateAssessmentContract = useFinanceStore(s => s.updateAssessmentContract);
  const deleteAssessmentContract = useFinanceStore(s => s.deleteAssessmentContract);
  const addContractAssessment = useFinanceStore(s => s.addContractAssessment);
  const updateContractAssessment = useFinanceStore(s => s.updateContractAssessment);
  const deleteContractAssessment = useFinanceStore(s => s.deleteContractAssessment);
  const addContractAmendment = useFinanceStore(s => s.addContractAmendment);
  const updateContractAmendment = useFinanceStore(s => s.updateContractAmendment);
  const addWalletTransaction = useFinanceStore(s => s.addWalletTransaction);

  const customers = useSalesStore(s => s.customers);
  const jobOrders = useSalesStore(s => s.jobOrders);
  const addJobOrder = useSalesStore(s => s.addJobOrder);
  const updateJobOrder = useSalesStore(s => s.updateJobOrder);
  const fetchSalesData = useSalesStore(s => s.fetchSalesData);

  const [schools, setSchools] = useState<School[]>([]);
  const [examBatches, setExamBatches] = useState<ExaminationBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | ContractStatus>('All');
  const [partyFilter, setPartyFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [metricFilter, setMetricFilter] = useState<'All' | 'Active' | 'Pending' | 'Funds'>('All');
  const [sortBy, setSortBy] = useState<'contract_number' | 'starts_at' | 'prepaid'>('contract_number');
  const [showLegacy, setShowLegacy] = useState(false);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<AssessmentContract | null>(null);
  const [formDraft, setFormDraft] = useState(emptyContractDraft());
  const [isSaving, setIsSaving] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');

  const [isItemFormOpen, setIsItemFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AssessmentContractItem | null>(null);
  const [itemDraft, setItemDraft] = useState(emptyItemDraft());

  const [jobLinkItem, setJobLinkItem] = useState<AssessmentContractItem | null>(null);
  const [jobLinkId, setJobLinkId] = useState('');
  const [examBatchId, setExamBatchId] = useState('');

  const [isAmendOpen, setIsAmendOpen] = useState(false);
  const [amendDraft, setAmendDraft] = useState({ amendment_type: 'terms', description: '', prepaid_amount_adjustment: 0, assessment_count_adjustment: 0, assessment_price_adjustment: 0 });

  const [confirmState, setConfirmState] = useState<{
    open: boolean; title: string; message: string; confirmText?: string;
    type?: ConfirmDialogType; onConfirm?: () => void;
  }>({ open: false, title: '', message: '' });

  // Activation without payment evidence requires a recorded reason —
  // the button promises "Verify & activate" and must not fabricate it.
  const [activateOverride, setActivateOverride] = useState<{ contract: AssessmentContract; reason: string } | null>(null);

  // Same-device sequential signing ceremony: company first, customer second.
  const [signingParty, setSigningParty] = useState<SignatureParty | null>(null);

  // Generated contract document preview (read-only render, no state change).
  const [docPreview, setDocPreview] = useState<{ data: any } | null>(null);

  // Role gates mirror services/api.ts (save: Admin/Editor, delete: Admin).
  // Granular printing_contracts.* permissions grant additively where assigned.
  // Unknown/missing role fails OPEN exactly like the API (checkAuth allows
  // when it cannot resolve a role) — a UI gate must never be stricter than
  // its enforcement layer, or it manufactures lockouts the API would allow.
  const userRole = String((user as any)?.role || '').toLowerCase();
  const isSuperUser = Boolean((user as any)?.isSuperAdmin) || userRole === 'admin';
  const roleKnown = Boolean(user) && (Boolean(userRole) || Boolean((user as any)?.isSuperAdmin));
  const hasPerm = (id: string) => {
    try {
      return typeof checkPermission === 'function' ? !!checkPermission(id) : false;
    } catch {
      return false;
    }
  };
  const canManageContracts = !roleKnown || isSuperUser || userRole === 'editor'
    || hasPerm('printing_contracts.create') || hasPerm('printing_contracts.edit')
    || hasPerm('printing_contracts.activate') || hasPerm('printing_contracts.amend')
    || hasPerm('printing_contracts.manage_assessments') || hasPerm('printing_contracts.create_job');
  const canDeleteContracts = !roleKnown || isSuperUser;

  // Behavioral gates: buttons are also hidden/disabled, but the handlers
  // enforce roles themselves so no caller can bypass the UI.
  const requireManageContracts = () => {
    if (canManageContracts) return true;
    notify('Your role cannot modify printing contracts.', 'error');
    return false;
  };
  const requireDeleteContracts = () => {
    if (canDeleteContracts) return true;
    notify('Only an Admin can delete printing contracts.', 'error');
    return false;
  };

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      fetchFinanceData().catch(() => {}),
      fetchSalesData(true).catch(() => {}),
      dbService.getAll<School>('schools').then(setSchools).catch(() => setSchools([])),
      dbService.getAll<ExaminationBatch>('examPrintingBatches').then(setExamBatches).catch(() => setExamBatches([])),
    ]).finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const customerNameOf = (id?: string) =>
    customers.find((c: Customer) => String(c.id) === String(id))?.name || id || '—';
  const schoolNameOf = (id?: string) =>
    schools.find(s => String(s.id) === String(id))?.name
    || customers.find((c: Customer) => String(c.id) === String(id))?.name
    || id || '—';

  const stats = useMemo(() => {
    let active = 0; let pending = 0;
    let prepaid = 0; let available = 0; let reserved = 0; let consumed = 0;
    let itemsReserved = 0; let itemsConsumed = 0;
    for (const c of assessmentContracts || []) {
      if (c.status === 'active') active++;
      if (c.status === 'pending_payment' || c.status === 'draft') pending++;
      const f = fundsOf(c);
      prepaid += f.prepaid; available += f.available; reserved += f.reserved; consumed += f.consumed;
    }
    for (const a of contractAssessments || []) {
      if (a.status === 'reserved') itemsReserved++;
      if (a.status === 'consumed') itemsConsumed++;
    }
    return { active, pending, prepaid, available, reserved, consumed, itemsReserved, itemsConsumed, total: (assessmentContracts || []).length };
  }, [assessmentContracts, contractAssessments]);

  const filtered = useMemo(() => {
    let list = [...(assessmentContracts || [])];
    if (metricFilter === 'Active') list = list.filter(c => c.status === 'active');
    if (metricFilter === 'Pending') list = list.filter(c => c.status === 'draft' || c.status === 'pending_payment');
    if (metricFilter === 'Funds') list = list.filter(c => fundsOf(c).available > 0);
    if (statusFilter !== 'All') list = list.filter(c => c.status === statusFilter);
    if (partyFilter) {
      list = list.filter(c => String(c.customer_id) === partyFilter || String(c.school_id) === partyFilter);
    }
    if (fromDate) list = list.filter(c => !c.starts_at || c.starts_at.slice(0, 10) >= fromDate);
    if (toDate) list = list.filter(c => !c.starts_at || c.starts_at.slice(0, 10) <= toDate);
    if (searchText) {
      const q = searchText.toLowerCase();
      list = list.filter(c =>
        (c.contract_number || '').toLowerCase().includes(q)
        || (c.title || '').toLowerCase().includes(q)
        || customerNameOf(c.customer_id).toLowerCase().includes(q)
        || schoolNameOf(c.school_id).toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      if (sortBy === 'starts_at') return String(b.starts_at || '').localeCompare(String(a.starts_at || ''));
      if (sortBy === 'prepaid') return num(b.prepaid_amount) - num(a.prepaid_amount);
      return String(a.contract_number || '').localeCompare(String(b.contract_number || ''));
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentContracts, metricFilter, statusFilter, partyFilter, fromDate, toDate, searchText, sortBy, customers, schools]);

  const selected = useMemo(
    () => (assessmentContracts || []).find(c => c.id === selectedId) || null,
    [assessmentContracts, selectedId],
  );
  const selectedItems = useMemo(
    () => (contractAssessments || []).filter(a => a.contract_id === selectedId),
    [contractAssessments, selectedId],
  );
  const selectedAmendments = useMemo(
    () => (contractAmendments || []).filter(a => a.contract_id === selectedId),
    [contractAmendments, selectedId],
  );
  const selectedJobs = useMemo(() => {
    const ids = new Set(selectedItems.map(a => a.job_order_id).filter(Boolean));
    return (jobOrders || []).filter((j: JobOrder) =>
      (j.id && ids.has(j.id)) || (j.contract_assessment_id && selectedItems.some(a => a.id === j.contract_assessment_id)),
    );
  }, [jobOrders, selectedItems]);
  const selectedWalletTx = useMemo(() => {
    const cid = String(selectedId || '');
    const cnum = String(selected?.contract_number || '');
    if (!cid && !cnum) return [];
    return (walletTransactions || []).filter((t: WalletTransaction) =>
      matchContractWalletTx(t as { contract_id?: unknown; reference?: unknown; data?: { contract_id?: unknown } | null }, cid, cnum),
    );
  }, [walletTransactions, selectedId, selected]);
  const selectedSignatures = useMemo(
    () => readContractSignatures(selected?.data),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, selected?.data],
  );

  // ── Contract CRUD ──────────────────────────────────────────────
  const openCreate = () => {
    setEditingContract(null);
    setFormDraft(emptyContractDraft());
    setIsFormOpen(true);
  };
  const openEdit = (c: AssessmentContract) => {
    setEditingContract(c);
    setFormDraft({
      title: c.title || '',
      customer_id: c.customer_id || '',
      school_id: c.school_id || '',
      assessment_type: c.assessment_type || 'examination',
      assessment_grade: c.assessment_grade || '',
      assessment_subject: c.assessment_subject || '',
      prepaid_amount: num(c.prepaid_amount),
      max_assessments: c.max_assessments || 1,
      assessment_price: num(c.assessment_price),
      starts_at: toDateInput(c.starts_at) || new Date().toISOString().slice(0, 10),
      ends_at: toDateInput(c.ends_at),
      description: c.description || '',
      terms: c.terms || '',
      notes: c.notes || '',
      // Edit mode keeps the agreement fields; entitlement changes go through
      // the Assessments tab / amendments so consumed history is protected.
      lines: [] as ContractFormLine[],
    });
    setIsFormOpen(true);
  };

  const validateContractDraft = (issueInvoice = false) => {
    if (!formDraft.title.trim()) return 'Contract title is required.';
    if (!formDraft.customer_id) return 'Select a customer for this contract.';
    if (!formDraft.school_id) return 'Select a school for this contract.';
    if (!editingContract) {
      const validLines = (formDraft.lines || []).filter(isValidContractLine);
      if (validLines.length === 0) return 'Add at least one billable item (name, quantity and unit price).';
      if (issueInvoice && contractLinesTotal(validLines) <= 0) {
        return 'Add billable items with a value greater than zero to issue an invoice.';
      }
    } else {
      if (formDraft.max_assessments <= 0) return 'Assessment entitlement must be at least 1.';
      if (formDraft.prepaid_amount < 0) return 'Prepaid amount cannot be negative.';
      if (formDraft.assessment_price < 0) return 'Assessment price cannot be negative.';
    }
    if (formDraft.ends_at && formDraft.starts_at && formDraft.ends_at < formDraft.starts_at) {
      return 'Contract end date must be on or after the start date (contracts may span financial years).';
    }
    return null;
  };

  const issueContractInvoice = async (
    contractNumber: string,
    contractTitle: string,
    customerId: string,
    lines: ContractFormLine[],
    terms?: string,
    notes?: string,
  ): Promise<string | null> => {
    const customer = (customers || []).find((c: Customer) => String(c.id) === String(customerId));
    if (!customer) { notify('Customer not found — invoice not issued.', 'error'); return null; }
    const draft = buildInvoiceDraftFromContract(
      {
        contract_number: contractNumber,
        contract_title: contractTitle,
        customer,
        issuedDate: new Date().toISOString().slice(0, 10),
        terms,
        notes,
      },
      lines,
    );
    const invoiceId = await addInvoice(draft as any);
    return invoiceId || null;
  };

  const handleSaveContract = async (issueInvoice = false) => {
    if (!requireManageContracts()) return;
    const err = validateContractDraft(issueInvoice);
    if (err) { notify(err, 'error'); return; }
    if (isSaving) return;
    setIsSaving(true);
    try {
      const now = new Date().toISOString();
      if (editingContract) {
        if (['completed', 'cancelled', 'expired'].includes(editingContract.status)) {
          notify('Historical contracts are protected and cannot be edited. Create an amendment instead.', 'error');
          return;
        }
        await updateAssessmentContract({
          ...editingContract,
          title: formDraft.title.trim(),
          customer_id: formDraft.customer_id,
          school_id: formDraft.school_id,
          assessment_type: formDraft.assessment_type,
          assessment_grade: formDraft.assessment_grade || undefined,
          assessment_subject: formDraft.assessment_subject || undefined,
          prepaid_amount: num(formDraft.prepaid_amount),
          max_assessments: Math.floor(num(formDraft.max_assessments)),
          assessment_price: num(formDraft.assessment_price),
          starts_at: formDraft.starts_at ? new Date(formDraft.starts_at).toISOString() : editingContract.starts_at,
          ends_at: formDraft.ends_at ? new Date(formDraft.ends_at).toISOString() : undefined,
          description: formDraft.description || undefined,
          terms: formDraft.terms || undefined,
          notes: formDraft.notes || undefined,
          updated_at: now,
          version: num(editingContract.version) + 1,
        });
        notify('Printing contract updated', 'success');
      } else {
        // Invoice-style totals: entitlement and prepaid derive from the lines.
        const rawLines = formDraft.lines || [];
        if (rawLines.some((l) => Number(l.quantity) < 0 || Number(l.unit_price) < 0)) {
          notify('Negative quantities/prices were treated as zero.', 'warning');
        }
        const validLines = rawLines.filter(isValidContractLine);
        const linesTotal = contractLinesTotal(validLines);
        const linesQty = contractLinesQuantity(validLines);
        // Sequence is drawn from contract_number (record ids are random
        // uids) with a uniqueness guard against legacy duplicates.
        const contractNumber = generateNextContractNumber(assessmentContracts || [], companyConfig);
        const companyId = (companyConfig as any)?.id || (user as any)?.companyId || 'default';
        const createdBy = (user as any)?.id || (user as any)?.username || 'system';
        const recordId = uid();
        // Materialise the entitlement first so assessment_count is exact on
        // day one instead of drifting from zero.
        const contractItems = buildContractItemsFromLines(
          {
            contract_id: recordId,
            company_id: companyId,
            customer_id: formDraft.customer_id,
            school_id: formDraft.school_id,
            created_by: createdBy,
            now,
          },
          validLines,
        );
        const record: AssessmentContract = {
          id: recordId,
          company_id: companyId,
          customer_id: formDraft.customer_id,
          school_id: formDraft.school_id,
          contract_number: contractNumber,
          title: formDraft.title.trim(),
          description: formDraft.description || undefined,
          status: 'draft',
          prepaid_amount: linesTotal,
          consumed_amount: 0,
          reserved_amount: 0,
          starts_at: formDraft.starts_at ? new Date(formDraft.starts_at).toISOString() : now,
          ends_at: formDraft.ends_at ? new Date(formDraft.ends_at).toISOString() : undefined,
          assessment_type: formDraft.assessment_type,
          assessment_grade: formDraft.assessment_grade || undefined,
          assessment_subject: formDraft.assessment_subject || undefined,
          assessment_count: contractItems.length,
          max_assessments: linesQty,
          assessment_price: linesQty > 0 ? linesTotal / linesQty : 0,
          payment_status: 'pending',
          terms: formDraft.terms || undefined,
          notes: formDraft.notes || undefined,
          created_by: createdBy,
          created_at: now,
          updated_at: now,
          version: 1,
          // Snapshot the billable lines so the invoice can be (re)issued from
          // the detail view and the commercial basis stays auditable.
          data: { lines: validLines },
        };
        await addAssessmentContract(record);
        // Materialise one reserved assessment record per billed unit.
        for (const item of contractItems) {
          await addContractAssessment(item);
        }
        if (issueInvoice) {
          const invoiceId = await issueContractInvoice(
            contractNumber,
            record.title,
            formDraft.customer_id,
            validLines,
            formDraft.terms,
            formDraft.notes,
          );
          if (invoiceId) {
            await updateAssessmentContract({
              ...record,
              data: { ...(record.data || {}), issued_invoice_id: invoiceId },
              updated_at: new Date().toISOString(),
            });
            notify(`Printing contract ${contractNumber} created — invoice ${invoiceId} issued to the customer`, 'success');
          } else {
            notify(`Printing contract ${contractNumber} created as draft — invoice issue failed`, 'error');
          }
        } else {
          notify(`Printing contract ${contractNumber} created as draft`, 'success');
        }
      }
      setIsFormOpen(false);
      setEditingContract(null);
    } catch (e: any) {
      notify(`Failed to save contract: ${e.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleIssueInvoiceForSelected = async () => {
    if (!requireManageContracts()) return;
    if (!selected || isSaving) return;
    const data = (selected.data || {}) as any;
    if (data.issued_invoice_id) {
      notify(`Invoice ${data.issued_invoice_id} is already issued for this contract.`, 'info');
      return;
    }
    const storedLines = Array.isArray(data.lines) ? (data.lines as ContractFormLine[]) : [];
    const lines: ContractFormLine[] = storedLines.length > 0
      ? storedLines
      : [{
        ...emptyContractLine(selected.assessment_type),
        assessment_name: selected.title,
        assessment_grade: selected.assessment_grade || '',
        assessment_subject: selected.assessment_subject || '',
        quantity: Math.max(1, Math.floor(num(selected.max_assessments))),
        unit_price: num(selected.assessment_price),
      }];
    if (contractLinesTotal(lines.filter(isValidContractLine)) <= 0) {
      notify('No billable value to invoice on this contract.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const invoiceId = await issueContractInvoice(
        selected.contract_number,
        selected.title,
        selected.customer_id,
        lines,
        selected.terms,
        selected.notes,
      );
      if (invoiceId) {
        await updateAssessmentContract({
          ...selected,
          data: { ...data, issued_invoice_id: invoiceId },
          updated_at: new Date().toISOString(),
        });
        notify(`Invoice ${invoiceId} issued to the customer`, 'success');
      }
    } catch (e: any) {
      notify(`Failed to issue invoice: ${e.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const transitionContract = async (c: AssessmentContract, next: ContractStatus, opts?: { overrideReason?: string }) => {
    if (!requireManageContracts()) return;
    if (!isAllowedContractTransition(c.status, next)) {
      notify(`Transition ${CONTRACT_STATUS_LABEL[c.status]} → ${CONTRACT_STATUS_LABEL[next]} is not allowed.`, 'error');
      return;
    }
    const now = new Date().toISOString();
    const actor = (user as any)?.id || (user as any)?.username || 'system';

    // Activation honesty: this button promises "Verify & activate", so a
    // verified stamp and wallet deposit require payment evidence. Without
    // evidence the caller is routed to an explicit, reason-recorded
    // override — verification is never fabricated.
    if (next === 'active') {
      const evidence = resolveActivationEvidence(c, invoices || []);
      const overrideReason = (opts?.overrideReason || '').trim();
      if (!evidence.ok && !overrideReason) {
        setActivateOverride({ contract: c, reason: '' });
        return;
      }
      try {
        if (evidence.ok && evidence.kind === 'paid-invoice' && num(c.prepaid_amount) > 0) {
          // Wallet first: a failed posting aborts the transition instead
          // of leaving an active contract with silently missing money.
          await addWalletTransaction({
            id: '', customerId: c.customer_id, amount: num(c.prepaid_amount),
            type: 'Deposit', reference: c.contract_number, date: now,
            data: { type: 'CONTRACT_DEPOSIT', contract_id: c.id, contract_number: c.contract_number, invoice_id: evidence.invoiceId },
          } as WalletTransaction);
        }
        const patch: Partial<AssessmentContract> = {
          status: next,
          updated_at: now,
          version: num(c.version) + 1,
          activated_at: now,
        };
        if (evidence.ok && evidence.kind === 'paid-invoice') {
          patch.payment_status = 'verified';
          patch.payment_verified_at = now;
          patch.wallet_credit_applied_at = now;
          await updateAssessmentContract({ ...c, ...patch } as AssessmentContract);
          notify(`Contract activated — payment verified against invoice ${evidence.invoiceId}`, 'success');
        } else if (evidence.ok) {
          await updateAssessmentContract({ ...c, ...patch } as AssessmentContract);
          notify('Contract activated (no payment required for zero value)', 'success');
        } else {
          await updateAssessmentContract({
            ...c,
            ...patch,
            data: {
              ...(c.data || {}),
              activationOverride: { reason: overrideReason, by: actor, at: now },
            },
          } as AssessmentContract);
          notify('Contract activated WITHOUT payment evidence — reason recorded on the contract.', 'warning');
        }
      } catch (e: any) {
        notify(`Activation failed: ${e.message}`, 'error');
      }
      return;
    }

    if (next === 'cancelled') {
      const patch: Partial<AssessmentContract> = {
        status: next, updated_at: now, version: num(c.version) + 1, cancelled_at: now,
      };
      try {
        const refund = fundsOf(c).prepaid - fundsOf(c).consumed;
        if (refund > 0) {
          // Refund first: a failed posting aborts instead of reporting a
          // refund that never happened.
          await addWalletTransaction({
            id: '', customerId: c.customer_id, amount: refund,
            type: 'Credit', reference: c.contract_number, date: now,
            data: { type: 'CONTRACT_REFUND', contract_id: c.id, contract_number: c.contract_number },
          } as WalletTransaction);
          await updateAssessmentContract({ ...c, ...patch } as AssessmentContract);
          notify(`Contract cancelled. Unused ${currency}${refund.toLocaleString()} refunded to wallet.`, 'success');
          return;
        }
        await updateAssessmentContract({ ...c, ...patch } as AssessmentContract);
        notify(`Contract ${CONTRACT_STATUS_LABEL[next].toLowerCase()}`, 'success');
      } catch (e: any) {
        notify(`Cancellation failed: ${e.message}`, 'error');
      }
      return;
    }

    const patch: Partial<AssessmentContract> = { status: next, updated_at: now, version: num(c.version) + 1 };
    if (next === 'suspended') patch.suspended_at = now;
    if (next === 'completed') patch.completed_at = now;
    try {
      await updateAssessmentContract({ ...c, ...patch } as AssessmentContract);
      notify(`Contract ${CONTRACT_STATUS_LABEL[next].toLowerCase()}`, 'success');
    } catch (e: any) {
      notify(`Transition failed: ${e.message}`, 'error');
    }
  };

  const handleDeleteContract = (c: AssessmentContract) => {
    if (!requireDeleteContracts()) return;
    const linkedItems = (contractAssessments || []).filter(a => a.contract_id === c.id);
    const hasConsumed = linkedItems.some(a => a.status === 'consumed');
    if (c.status === 'active' || c.status === 'suspended') {
      notify('Active contracts cannot be deleted. Cancel or complete the contract first.', 'error');
      return;
    }
    if (hasConsumed) {
      notify('Contracts with consumed assessments are historical records and cannot be deleted.', 'error');
      return;
    }
    setConfirmState({
      open: true, title: 'Delete Printing Contract',
      message: `Permanently delete contract ${c.contract_number} (${c.title})? This cannot be undone. Linked schedule entries will be removed. Wallet transactions and invoices are preserved as financial history.`,
      confirmText: 'Delete permanently', type: 'danger',
      onConfirm: async () => {
        try {
          const failures: string[] = [];
          for (const a of linkedItems) {
            try {
              await deleteContractAssessment(a.id);
            } catch (e: any) {
              failures.push(a.assessment_name || a.id);
            }
          }
          if (failures.length > 0) {
            notify(`Delete aborted: could not remove ${failures.length} schedule entr${failures.length === 1 ? 'y' : 'ies'}.`, 'error');
            return;
          }
          await deleteAssessmentContract(c.id);
          if (selectedId === c.id) setSelectedId(null);
          notify('Printing contract deleted', 'info');
        } catch (e: any) { notify(`Delete failed: ${e.message}`, 'error'); }
      },
    });
  };

  // ── Assessment CRUD + entitlement enforcement (§13) ─────────────
  const openItemCreate = () => {
    if (!selected) return;
    setEditingItem(null);
    setItemDraft({ ...emptyItemDraft(), assessment_type: selected.assessment_type || 'examination', item_price: num(selected.assessment_price) });
    setIsItemFormOpen(true);
  };
  const openItemEdit = (a: AssessmentContractItem) => {
    setEditingItem(a);
    setItemDraft({
      assessment_name: a.assessment_name || '',
      assessment_type: a.assessment_type || 'examination',
      assessment_grade: a.assessment_grade || '',
      assessment_subject: a.assessment_subject || '',
      assessment_date: toDateInput(a.assessment_date) || new Date().toISOString().slice(0, 10),
      item_price: num(a.item_price),
      notes: a.notes || '',
    });
    setIsItemFormOpen(true);
  };

  const handleSaveItem = async () => {
    if (!requireManageContracts()) return;
    if (!selected) return;
    if (!itemDraft.assessment_name.trim()) { notify('Assessment name is required.', 'error'); return; }
    if (Number(itemDraft.item_price) < 0) { notify('Assessment price cannot be negative.', 'error'); return; }
    const siblings = (contractAssessments || []).filter(a => a.contract_id === selected.id && a.id !== editingItem?.id);
    if (!editingItem && siblings.length >= num(selected.max_assessments)) {
      notify(`Entitlement exceeded: contract allows ${selected.max_assessments} assessments. Create an amendment to extend it.`, 'error');
      return;
    }
    const now = new Date().toISOString();
    try {
      if (editingItem) {
        if (editingItem.status === 'consumed') { notify('Consumed assessments are historical and cannot be edited.', 'error'); return; }
        await updateContractAssessment({
          ...editingItem,
          assessment_name: itemDraft.assessment_name.trim(),
          assessment_type: itemDraft.assessment_type,
          assessment_grade: itemDraft.assessment_grade || undefined,
          assessment_subject: itemDraft.assessment_subject || undefined,
          assessment_date: itemDraft.assessment_date ? new Date(itemDraft.assessment_date).toISOString() : editingItem.assessment_date,
          item_price: num(itemDraft.item_price),
          notes: itemDraft.notes || undefined,
          updated_at: now, version: num(editingItem.version) + 1,
        });
        notify('Assessment updated', 'success');
      } else {
        const record: AssessmentContractItem = {
          id: uid(),
          contract_id: selected.id,
          company_id: selected.company_id,
          customer_id: selected.customer_id,
          school_id: selected.school_id,
          assessment_type: itemDraft.assessment_type,
          assessment_grade: itemDraft.assessment_grade || undefined,
          assessment_subject: itemDraft.assessment_subject || undefined,
          assessment_name: itemDraft.assessment_name.trim(),
          assessment_date: itemDraft.assessment_date ? new Date(itemDraft.assessment_date).toISOString() : now,
          status: 'reserved',
          item_price: num(itemDraft.item_price),
          reserved_at: now,
          notes: itemDraft.notes || undefined,
          created_by: (user as any)?.id || 'system',
          created_at: now, updated_at: now, version: 1, data: {},
        };
        await addContractAssessment(record);
        await updateAssessmentContract({
          ...selected,
          assessment_count: num(selected.assessment_count) + 1,
          reserved_amount: num(selected.reserved_amount) + record.item_price,
          updated_at: now, version: num(selected.version) + 1,
        });
        notify('Assessment scheduled (funds reserved)', 'success');
      }
      setIsItemFormOpen(false);
      setEditingItem(null);
    } catch (e: any) { notify(`Failed to save assessment: ${e.message}`, 'error'); }
  };

  const transitionItem = async (a: AssessmentContractItem, next: ItemStatus) => {
    const contract = (assessmentContracts || []).find(c => c.id === a.contract_id);
    if (!contract) { notify('Parent contract not found.', 'error'); return; }
    const now = new Date().toISOString();
    const patch: Partial<AssessmentContractItem> = { status: next, updated_at: now, version: num(a.version) + 1 };
    if (next === 'consumed') patch.consumed_at = now;
    if (next === 'released') patch.released_at = now;
    try {
      await updateContractAssessment({ ...a, ...patch } as AssessmentContractItem);
      // Keep contract money buckets consistent (reserved → consumed / released).
      let reserved = num(contract.reserved_amount);
      let consumed = num(contract.consumed_amount);
      if (a.status === 'reserved' && next === 'consumed') { reserved -= num(a.item_price); consumed += num(a.item_price); }
      if (a.status === 'reserved' && (next === 'released' || next === 'cancelled')) { reserved -= num(a.item_price); }
      if (a.status === 'consumed' && next === 'cancelled') { consumed -= num(a.item_price); }
      await updateAssessmentContract({
        ...contract, reserved_amount: Math.max(0, reserved), consumed_amount: Math.max(0, consumed),
        updated_at: now, version: num(contract.version) + 1,
      });
      notify(`Assessment ${ITEM_STATUS_LABEL[next].toLowerCase()}`, 'success');
    } catch (e: any) { notify(`Assessment update failed: ${e.message}`, 'error'); }
  };

  // ── Job order integration (§6/§14 design: optional 1:0..1 link) ──
  const openJobLink = (a: AssessmentContractItem) => {
    setJobLinkItem(a);
    setJobLinkId(a.job_order_id || '');
    setExamBatchId(a.examination_printing_batch_id || '');
  };
  const handleSaveJobLink = async () => {
    if (!requireManageContracts()) return;
    if (!jobLinkItem) return;
    const batchId = (examBatchId || '').trim();
    if (batchId && !examBatches.some(b => b.id === batchId || b.batch_number === batchId)) {
      notify(`Examination batch "${batchId}" was not found.`, 'error');
      return;
    }
    try {
      const now = new Date().toISOString();
      const prevJobId = jobLinkItem.job_order_id || '';
      await updateContractAssessment({
        ...jobLinkItem,
        job_order_id: jobLinkId || undefined,
        examination_printing_batch_id: batchId || undefined,
        updated_at: now, version: num(jobLinkItem.version) + 1,
      });
      // Clear a stale backlink when the item is re-linked elsewhere.
      if (prevJobId && prevJobId !== jobLinkId) {
        const prev = (jobOrders || []).find((j: JobOrder) => j.id === prevJobId);
        if (prev && (prev as JobOrder).contract_assessment_id === jobLinkItem.id) {
          await updateJobOrder({ ...(prev as JobOrder), contract_assessment_id: undefined } as JobOrder);
        }
      }
      if (jobLinkId) {
        const job = (jobOrders || []).find((j: JobOrder) => j.id === jobLinkId);
        if (job) {
          try {
            await updateJobOrder({ ...job, contract_assessment_id: jobLinkItem.id } as JobOrder);
          } catch (e: any) {
            notify(`Item linked, but the job back-link failed: ${e.message}`, 'warning');
          }
        }
      }
      notify('Printing job linked to assessment', 'success');
      setJobLinkItem(null);
    } catch (e: any) { notify(`Link failed: ${e.message}`, 'error'); }
  };
  const handleCreateJobFromAssessment = async (a: AssessmentContractItem) => {
    if (!requireManageContracts()) return;
    const contract = (assessmentContracts || []).find(c => c.id === a.contract_id);
    if (!contract) return;
    if (a.job_order_id) { notify('This assessment already has a linked job order.', 'info'); return; }
    try {
      const job: JobOrder = {
        id: generateNextId('JO', jobOrders || [], companyConfig),
        customerId: contract.customer_id,
        customerName: customerNameOf(contract.customer_id),
        totalQuantity: 1,
        status: 'Pending',
        date: new Date().toISOString(),
        notes: `Printing contract ${contract.contract_number} — ${a.assessment_name}`,
        contract_assessment_id: a.id,
      } as JobOrder;
      await addJobOrder(job);
      await updateContractAssessment({
        ...a, job_order_id: job.id, updated_at: new Date().toISOString(), version: num(a.version) + 1,
      });
      notify(`Job order ${job.id} created and linked`, 'success');
    } catch (e: any) { notify(`Job creation failed: ${e.message}`, 'error'); }
  };

  // ── Amendments (audit-backed, §17 design) ───────────────────────
  const handleSaveAmendment = async () => {
    if (!requireManageContracts()) return;
    if (!selected) return;
    if (!amendDraft.description.trim()) { notify('Amendment description is required.', 'error'); return; }
    const boundsError = validateAmendmentAdjustments(selected, {
      prepaid_amount_adjustment: amendDraft.prepaid_amount_adjustment,
      assessment_count_adjustment: amendDraft.assessment_count_adjustment,
    });
    if (boundsError) { notify(boundsError, 'error'); return; }
    const now = new Date().toISOString();
    try {
      await addContractAmendment({
        id: uid(), contract_id: selected.id, company_id: selected.company_id,
        customer_id: selected.customer_id, amendment_type: amendDraft.amendment_type,
        description: amendDraft.description.trim(),
        prepaid_amount_adjustment: num(amendDraft.prepaid_amount_adjustment),
        assessment_count_adjustment: Math.floor(num(amendDraft.assessment_count_adjustment)),
        assessment_price_adjustment: num(amendDraft.assessment_price_adjustment),
        requested_by: (user as any)?.id || 'system',
        status: 'pending', notes: undefined,
        created_at: now, updated_at: now, version: 1, data: {},
      } as ContractAmendment);
      notify('Amendment requested (pending approval)', 'success');
      setIsAmendOpen(false);
      setAmendDraft({ amendment_type: 'terms', description: '', prepaid_amount_adjustment: 0, assessment_count_adjustment: 0, assessment_price_adjustment: 0 });
    } catch (e: any) { notify(`Amendment failed: ${e.message}`, 'error'); }
  };
  const handleApproveAmendment = async (am: ContractAmendment, approve: boolean) => {
    if (!requireManageContracts()) return;
    const contract = (assessmentContracts || []).find(c => c.id === am.contract_id);
    if (!contract) return;
    const now = new Date().toISOString();
    const actor = (user as any)?.id || (user as any)?.username || 'system';
    try {
      await updateContractAmendment({
        ...am, status: approve ? 'approved' : 'rejected',
        approved_by: actor, approved_at: now, updated_at: now, version: num(am.version) + 1,
      });
      if (approve) {
        // Bounds first: never silently clamp or drive money negative.
        const boundsError = validateAmendmentAdjustments(contract, {
          prepaid_amount_adjustment: am.prepaid_amount_adjustment,
          assessment_count_adjustment: am.assessment_count_adjustment,
        });
        if (boundsError) {
          notify(boundsError, 'error');
          return;
        }
        const data: Record<string, any> = { ...(contract.data || {}) };
        // Approved amendments void signatures (a signed PDF must never
        // disagree with current terms). No-op when nothing is signed.
        const voided = applySignatureVoid(data, {
          by: actor,
          at: now,
          reason: `amendment ${am.id} approved`,
        });
        if (voided !== data) {
          Object.assign(data, voided);
        }
        const priceAdj = num(am.assessment_price_adjustment);
        if (priceAdj > 0 && priceAdj !== num(contract.assessment_price)) {
          data.priceHistory = [
            ...((data as any).priceHistory || []),
            { at: now, by: actor, from: num(contract.assessment_price), to: priceAdj, amendmentId: am.id },
          ];
        }
        const prepaidAdj = num(am.prepaid_amount_adjustment);
        await updateAssessmentContract({
          ...contract,
          prepaid_amount: num(contract.prepaid_amount) + prepaidAdj,
          max_assessments: Math.max(1, num(contract.max_assessments) + Math.floor(num(am.assessment_count_adjustment))),
          assessment_price: priceAdj > 0 ? priceAdj : contract.assessment_price,
          data,
          updated_at: now, version: num(contract.version) + 1,
        });
        // No wallet fabrication: extra commercial value is a receivable.
        // The holder must record customer payment; activation evidence
        // re-checks coverage against the new prepaid figure.
        if (prepaidAdj > 0) {
          notify(`Amendment approved — additional ${money(prepaidAdj)} is now due. Record customer payment.`, 'warning');
        } else {
          notify('Amendment approved and applied', 'success');
        }
      } else {
        notify('Amendment rejected', 'info');
      }
    } catch (e: any) { notify(`Amendment update failed: ${e.message}`, 'error'); }
  };

  // ── Same-device sequential signing ceremony ──────────────────────
  const handleConfirmSignature = async (party: SignatureParty, captured: CapturedContractSignature) => {
    if (!requireManageContracts()) return;
    if (!selected) return;
    if (!isSignableContractStatus(selected.status)) {
      notify(`Contracts with status ${CONTRACT_STATUS_LABEL[selected.status]} cannot be signed.`, 'error');
      return;
    }
    const current = readContractSignatures(selected.data);
    if (party === 'customer' && !current.company) {
      notify('The company must sign first — sequential order is enforced.', 'error');
      return;
    }
    const now = new Date().toISOString();
    const actor = (user as any)?.id || (user as any)?.username || 'system';
    try {
      const data = applyContractSignature({ ...(selected.data || {}) }, party, {
        name: captured.name,
        role: captured.role,
        signatureDataUrl: captured.signatureDataUrl,
        mode: captured.mode,
        signedAt: now,
        signedBy: actor,
      });
      await updateAssessmentContract({
        ...selected,
        data,
        updated_at: now,
        version: num(selected.version) + 1,
      } as AssessmentContract);
      notify(
        party === 'company' ? 'Company signature recorded.' : 'Customer signature recorded — contract fully signed.',
        'success',
      );
      setSigningParty(null);
    } catch (e: any) {
      notify(`Signature failed: ${e.message}`, 'error');
    }
  };

  // ── Contract document generation (read-only) ─────────────────────
  const handleGenerateContractDocument = async () => {
    if (!selected) return;
    try {
      const doc = await buildPrintingContractDoc({
        contract: selected,
        customerName: customerNameOf(selected.customer_id),
        schoolName: schoolNameOf(selected.school_id),
      });
      setDocPreview({ data: PrintingContractSchema.parse(doc) });
    } catch (e: any) {
      notify(`Document generation failed: ${e.message}`, 'error');
    }
  };

  const money = (v: number) => `${currency}${num(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const partyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of customers || []) map.set(String(c.id), (c as Customer).name || String(c.id));
    for (const s of schools || []) if (!map.has(String(s.id))) map.set(String(s.id), s.name || String(s.id));
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, schools]);

  const metricCards = [
    { key: 'Active', label: 'Active Contracts', value: String(stats.active), icon: <CheckCircle size={20} />, accent: contractTeal[500], tileBg: contractTeal[50], tileColor: contractTeal[600] },
    { key: 'Pending', label: 'Draft / Pending Payment', value: String(stats.pending), icon: <ClipboardList size={20} />, accent: contractAmber[500], tileBg: contractAmber[100], tileColor: contractAmber[600] },
    { key: 'Funds', label: 'Available Funds', value: money(stats.available), icon: <Wallet size={20} />, accent: contractTeal[700], tileBg: contractTeal[100], tileColor: contractTeal[700] },
    { key: 'All', label: 'Assessments Reserved / Consumed', value: `${stats.itemsReserved} / ${stats.itemsConsumed}`, icon: <Printer size={20} />, accent: contractAmber[300], tileBg: contractAmber[100], tileColor: contractAmber[600] },
  ] as const;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto h-[calc(100vh-4rem)] flex flex-col relative w-full text-sm font-normal"
      style={{ background: contractPaper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: contractInk }}>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4 shrink-0">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={contractIconTileStyle(40)}>
            <FileText size={19} color="#fff" />
          </div>
          <div>
            <h1 style={contractPageTitleStyle}>Printing Contracts</h1>
            <p style={contractPageSubtitleStyle}>
              Commercial agreements, assessment entitlement, print schedules and prepaid balances
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: contractInkSoft }} />
            <input
              type="text" placeholder="Search contracts, schools, clients..."
              value={searchText} onChange={e => setSearchText(e.target.value)}
              style={{ ...contractFilterControlStyle, width: 224, fontWeight: 400, paddingLeft: 30 }}
            />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'All' | ContractStatus)}
            style={contractFilterSelectStyle}>
            <option value="All">All statuses</option>
            {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>)}
          </select>
          <select value={partyFilter} onChange={e => setPartyFilter(e.target.value)}
            style={{ ...contractFilterSelectStyle, maxWidth: 180 }}>
            <option value="">All clients / schools</option>
            {partyOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={contractFilterControlStyle} title="From start date" />
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={contractFilterControlStyle} title="To start date" />
          <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
            style={contractFilterSelectStyle}>
            <option value="contract_number">Sort: Contract №</option>
            <option value="starts_at">Sort: Start date</option>
            <option value="prepaid">Sort: Prepaid</option>
          </select>
          <ContractGhostButton compact onClick={() => { setIsLoading(true); Promise.all([fetchFinanceData().catch(() => {}), fetchSalesData(true).catch(() => {})]).finally(() => setIsLoading(false)); }}>
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Refresh
          </ContractGhostButton>
          {canManageContracts && (
            <ContractPrimaryButton compact chevron={false} onClick={openCreate}>
              <Plus size={14} /> New Contract
            </ContractPrimaryButton>
          )}
        </div>
      </div>

      {/* Money bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4 shrink-0">
        {metricCards.map(card => {
          const isActive = metricFilter === card.key;
          return (
            <div key={card.key}
              onClick={() => setMetricFilter(metricFilter === card.key ? 'All' : (card.key as typeof metricFilter))}
              style={{
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16,
                padding: 16, borderRadius: 12, background: isActive ? contractTeal[50] : contractPaper,
                border: `1.4px solid ${isActive ? contractTeal[200] : contractHairline}`,
                borderLeft: `4px solid ${card.accent}`,
                boxShadow: isActive ? '0 6px 16px -6px rgba(15,84,76,.35)' : '0 1px 3px rgba(0,0,0,.04)',
                transition: 'all .15s ease',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = contractTeal[50]; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = contractPaper; }}
            >
              <div style={{ padding: 10, borderRadius: 8, background: card.tileBg, color: card.tileColor }}>{card.icon}</div>
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: contractInkSoft, textTransform: 'uppercase', letterSpacing: 0.06, margin: '0 0 6px' }}>{card.label}</p>
                <p className="finance-nums" style={{ fontSize: 20, fontWeight: 700, color: contractTeal[800], margin: 0, fontVariantNumeric: 'tabular-nums' }}>{card.value}</p>
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: contractInkSoft, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }} className="shrink-0">
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: contractAmber[500], flexShrink: 0 }} />
        <span>
          Prepaid under contract <b style={{ color: contractInk }}>{" "}{money(stats.prepaid)}</b>
          {' · '}Reserved <b style={{ color: contractInk }}>{" "}{money(stats.reserved)}</b>
          {' · '}Consumed <b style={{ color: contractInk }}>{" "}{money(stats.consumed)}</b>
          {' · '}Prepaid is the commercial figure on the contract — wallet balances move only at payment time.
        </span>
      </p>

      {/* Contract list */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
        style={{ background: contractPaper, borderRadius: 14, border: `1px solid ${contractHairline}`, boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ ...contractIconTileStyle(48), margin: '0 auto 12px', opacity: 0.65 }}>
              <FileText size={22} color="#fff" />
            </div>
            <p style={{ fontWeight: 700, color: contractInk, margin: '0 0 4px' }}>No printing contracts found</p>
            <p style={{ fontSize: 12, color: contractInkSoft, margin: '0 0 16px' }}>Create the first commercial agreement to schedule assessments against prepaid entitlement.</p>
            {canManageContracts && (
              <ContractPrimaryButton compact chevron={false} onClick={openCreate}>
                <Plus size={14} /> New Printing Contract
              </ContractPrimaryButton>
            )}
          </div>
        ) : (
          <table style={{ width: '100%', textAlign: 'left', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: contractPaper, borderBottom: `1px solid ${contractHairline}` }}>
              <tr>
                {['Contract', 'Client / School', 'Period', 'Entitlement', 'Funds', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft }}>{h}</th>
                ))}
                <th style={{ padding: '10px 16px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const f = fundsOf(c);
                const used = (contractAssessments || []).filter(a => a.contract_id === c.id).length;
                const isSelected = selectedId === c.id;
                return (
                  <tr key={c.id}
                    style={{
                      borderBottom: `1px solid ${contractHairline}`, cursor: 'pointer',
                      background: isSelected ? contractTeal[50] : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = contractTeal[50]; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    onClick={() => { setSelectedId(c.id); setDetailTab('overview'); }}>
                    <td style={{ padding: '10px 16px' }}>
                      <p className="finance-nums" style={{ fontWeight: 700, color: contractTeal[800], fontFamily: "'JetBrains Mono', monospace", fontSize: 11, margin: 0 }}>{c.contract_number}</p>
                      <p style={{ color: contractInk, margin: '2px 0 0', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
                      <p style={{ fontSize: 10, color: contractInkSoft, textTransform: 'capitalize', margin: '2px 0 0' }}>{(c.assessment_type || '').replace(/_/g, ' ')}</p>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <p style={{ fontWeight: 600, color: contractInk, margin: 0 }}>{customerNameOf(c.customer_id)}</p>
                      <p style={{ color: contractInkSoft, fontSize: 11, margin: '2px 0 0' }}>{schoolNameOf(c.school_id)}</p>
                    </td>
                    <td style={{ padding: '10px 16px', color: contractInkSoft, whiteSpace: 'nowrap' }}>
                      {c.starts_at ? new Date(c.starts_at).toLocaleDateString() : '—'}
                      {' → '}{c.ends_at ? new Date(c.ends_at).toLocaleDateString() : 'open'}
                    </td>
                    <td style={{ padding: '10px 16px', color: contractInkSoft, whiteSpace: 'nowrap' }}>{used} / {c.max_assessments} items</td>
                    <td style={{ padding: '10px 16px' }}>
                      <p className="finance-nums" style={{ fontWeight: 700, color: contractInk, margin: 0, fontVariantNumeric: 'tabular-nums' }}>{money(f.available)} <span style={{ fontWeight: 400, color: contractInkSoft }}>avail</span></p>
                      <p className="finance-nums" style={{ fontSize: 10, color: contractInkSoft, margin: '2px 0 0', fontVariantNumeric: 'tabular-nums' }}>{money(f.prepaid)} prepaid · {money(f.reserved)} res · {money(f.consumed)} used</p>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${CONTRACT_STATUS_STYLE[c.status]}`}>
                        {CONTRACT_STATUS_LABEL[c.status]}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                        <button title="Open details" onClick={() => { setSelectedId(c.id); setDetailTab('overview'); }} className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:text-[#0f544c] hover:bg-[#eef7f6]"><Eye size={14} /></button>
                        <button title="Edit" onClick={() => openEdit(c)} className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:text-[#0f544c] hover:bg-[#eef7f6]"><Edit2 size={14} /></button>
                        {canDeleteContracts && (<button title="Delete" onClick={() => handleDeleteContract(c)} className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:text-[#b5493f] hover:bg-[#b5493f15]"><Trash2 size={14} /></button>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Legacy archive (plan §14: retained, never converted) */}
      <div className="mt-3 shrink-0" style={{ background: contractPaper, borderRadius: 14, border: `1px solid ${contractHairline}` }}>
        <button onClick={() => setShowLegacy(v => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <span className="flex items-center gap-2"><History size={14} /> Legacy recurring billing (archived — {(legacyRecurring || []).length} records)</span>
          <ChevronRight size={14} className={`transition-transform ${showLegacy ? 'rotate-90' : ''}`} />
        </button>
        {showLegacy && (
          <div className="px-4 pb-3 max-h-48 overflow-y-auto custom-scrollbar">
            <p style={{ fontSize: 11, color: contractInkSoft, margin: '0 0 8px' }}>Historical subscription records are preserved read-only. Printing Contracts is a separate domain — nothing here is migrated or billed.</p>
            {(legacyRecurring || []).length === 0
              ? <p style={{ fontSize: 11, color: contractInkSoft, fontStyle: 'italic' }}>No legacy records.</p>
              : <table style={{ width: '100%', textAlign: 'left', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead><tr style={{ fontSize: 10, textTransform: 'uppercase', color: contractInkSoft }}>{['ID', 'Customer', 'Total', 'Status', 'Next run'].map(h => <th key={h} style={{ padding: '4px 0', fontWeight: 800, letterSpacing: 0.06 }}>{h}</th>)}</tr></thead>
                <tbody>{(legacyRecurring || []).slice(0, 50).map((r: any) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${contractHairline}`, color: contractInk }}>
                    <td className="finance-nums" style={{ padding: '4px 0', fontFamily: "'JetBrains Mono', monospace" }}>{r.id}</td><td>{r.customerName}</td>
                    <td className="finance-nums">{money(num(r.total))}</td><td>{r.status}</td><td>{r.nextRunDate || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>}
          </div>
        )}
      </div>

      {/* ── Contract form modal ── */}
      {isFormOpen && (
        <ContractModalShell
          width={920}
          icon={<FileText size={19} color="#fff" />}
          title={editingContract ? `Edit Contract: ${editingContract.contract_number}` : 'New Printing Contract'}
          subtitle={editingContract
            ? `${customerNameOf(editingContract.customer_id)} · ${schoolNameOf(editingContract.school_id)}`
            : 'New commercial agreement — draft until verified & activated'}
          onClose={() => { setIsFormOpen(false); setEditingContract(null); }}
          footerHint={editingContract ? `Contract ${editingContract.contract_number} — historical records are protected` : 'Prepaid is the commercial figure — wallet moves only at payment time'}
          submitLabel={editingContract ? 'Save Changes' : 'Create Draft Contract'}
          onSubmit={() => handleSaveContract(false)}
          submitDisabled={isSaving}
          footerActions={editingContract ? undefined : (
            <>
              <ContractGhostButton onClick={() => { setIsFormOpen(false); setEditingContract(null); }}>Cancel</ContractGhostButton>
              <ContractGhostButton onClick={() => handleSaveContract(true)}>
                <FileText size={14} /> {isSaving ? 'Saving…' : 'Save & issue invoice'}
              </ContractGhostButton>
              <ContractPrimaryButton onClick={() => handleSaveContract(false)} disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Create Draft Contract'}
              </ContractPrimaryButton>
            </>
          )}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={contractLabelStyle}>
                Title <ContractRequiredMark />
              </label>
              <input
                value={formDraft.title} onChange={e => setFormDraft({ ...formDraft, title: e.target.value })}
                placeholder="e.g. 2026 Term 2 examination printing agreement"
                style={contractInputStyle}
              />
            </div>
          </div>

          <ContractSectionLabel>Parties &amp; Type</ContractSectionLabel>
          <div style={contractGridStyle}>
            <div>
              <label style={contractLabelStyle}>
                Customer <ContractRequiredMark />
              </label>
              <select value={formDraft.customer_id} onChange={e => setFormDraft({ ...formDraft, customer_id: e.target.value })}
                style={contractSelectStyle}>
                <option value="">Select customer…</option>
                {(customers || []).map((c: Customer) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={contractLabelStyle}>
                School <ContractRequiredMark />
              </label>
              <select value={formDraft.school_id} onChange={e => setFormDraft({ ...formDraft, school_id: e.target.value })}
                style={contractSelectStyle}>
                <option value="">Select school…</option>
                {schools.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                {(customers || []).map((c: Customer) => <option key={`c-${c.id}`} value={c.id}>{c.name} (client)</option>)}
              </select>
            </div>
            <div>
              <label style={contractLabelStyle}>Contract type</label>
              <select value={formDraft.assessment_type} onChange={e => setFormDraft({ ...formDraft, assessment_type: e.target.value })}
                style={contractSelectStyle}>
                <option value="examination">Examination printing</option>
                <option value="commercial">Commercial printing</option>
                <option value="general">General</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={contractLabelStyle}>Grade</label>
                <input value={formDraft.assessment_grade} onChange={e => setFormDraft({ ...formDraft, assessment_grade: e.target.value })}
                  style={contractInputStyle} placeholder="Optional" />
              </div>
              <div>
                <label style={contractLabelStyle}>Subject</label>
                <input value={formDraft.assessment_subject} onChange={e => setFormDraft({ ...formDraft, assessment_subject: e.target.value })}
                  style={contractInputStyle} placeholder="Optional" />
              </div>
            </div>
          </div>

          <ContractSectionLabel>Commercials &amp; Period</ContractSectionLabel>
          {!editingContract ? (
            <>
              {/* Invoice-style billable items: each line rolls into entitlement + prepaid total */}
              <div style={{ border: `1px solid ${contractHairline}`, borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: contractTeal[50], color: contractTeal[800], fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                        <th scope="col" style={{ textAlign: 'left', padding: '8px 10px', minWidth: 180 }}>Assessment item</th>
                        <th scope="col" style={{ textAlign: 'left', padding: '8px 10px', width: 110 }}>Type</th>
                        <th scope="col" style={{ textAlign: 'left', padding: '8px 10px', width: 90 }}>Grade</th>
                        <th scope="col" style={{ textAlign: 'left', padding: '8px 10px', width: 100 }}>Subject</th>
                        <th scope="col" style={{ textAlign: 'right', padding: '8px 10px', width: 64 }}>Qty</th>
                        <th scope="col" style={{ textAlign: 'right', padding: '8px 10px', width: 110 }}>Unit price</th>
                        <th scope="col" style={{ textAlign: 'right', padding: '8px 10px', width: 110 }}>Amount</th>
                        <th scope="col" style={{ padding: '8px 10px', width: 40 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Remove</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(formDraft.lines || []).map((line) => (
                        <tr key={line.key} style={{ borderTop: `1px solid ${contractHairline}` }}>
                          <td style={{ padding: 6 }}>
                            <input value={line.assessment_name}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, assessment_name: e.target.value } : l) })}
                              placeholder="e.g. Term 2 Grade 7 Mathematics"
                              aria-label="Assessment item name"
                              style={{ ...contractInputStyle, padding: '7px 10px', fontSize: 12 }} />
                          </td>
                          <td style={{ padding: 6 }}>
                            <select value={line.assessment_type}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, assessment_type: e.target.value } : l) })}
                              aria-label="Assessment type"
                              style={{ ...contractSelectStyle, padding: '7px 8px', fontSize: 12 }}>
                              <option value="examination">Examination</option>
                              <option value="commercial">Commercial</option>
                              <option value="general">General</option>
                            </select>
                          </td>
                          <td style={{ padding: 6 }}>
                            <input value={line.assessment_grade}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, assessment_grade: e.target.value } : l) })}
                              placeholder="—" aria-label="Grade"
                              style={{ ...contractInputStyle, padding: '7px 10px', fontSize: 12 }} />
                          </td>
                          <td style={{ padding: 6 }}>
                            <input value={line.assessment_subject}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, assessment_subject: e.target.value } : l) })}
                              placeholder="—" aria-label="Subject"
                              style={{ ...contractInputStyle, padding: '7px 10px', fontSize: 12 }} />
                          </td>
                          <td style={{ padding: 6 }}>
                            <input type="number" min={1} step={1} value={line.quantity}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, quantity: Number(e.target.value) } : l) })}
                              aria-label="Quantity"
                              style={{ ...contractInputStyle, padding: '7px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                          </td>
                          <td style={{ padding: 6 }}>
                            <input type="number" min={0} step="0.01" value={line.unit_price}
                              onChange={e => setFormDraft({ ...formDraft, lines: formDraft.lines.map(l => l.key === line.key ? { ...l, unit_price: Number(e.target.value) } : l) })}
                              aria-label="Unit price"
                              style={{ ...contractInputStyle, padding: '7px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                          </td>
                          <td className="finance-nums" style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: contractInk, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {currency}{contractLineAmount(line).toLocaleString()}
                          </td>
                          <td style={{ padding: 6, textAlign: 'center' }}>
                            <button type="button"
                              onClick={() => setFormDraft({ ...formDraft, lines: formDraft.lines.filter(l => l.key !== line.key) })}
                              disabled={(formDraft.lines || []).length <= 1}
                              aria-label={`Remove ${line.assessment_name || 'line'}`}
                              style={{ padding: 7, borderRadius: 8, border: `1px solid ${contractHairline}`, background: '#fff', color: (formDraft.lines || []).length <= 1 ? '#c9c2b4' : contractDanger, cursor: (formDraft.lines || []).length <= 1 ? 'not-allowed' : 'pointer', display: 'inline-flex' }}>
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <ContractGhostButton compact onClick={() => setFormDraft({ ...formDraft, lines: [...(formDraft.lines || []), emptyContractLine(formDraft.assessment_type)] })}>
                  <Plus size={13} /> Add item
                </ContractGhostButton>
                <div className="finance-nums" style={{ display: 'flex', gap: 16, fontSize: 12, color: contractInkSoft, fontVariantNumeric: 'tabular-nums' }}>
                  <span>Entitlement <b style={{ color: contractInk }}>{contractLinesQuantity(formDraft.lines || [])}</b></span>
                  <span>Contract total <b style={{ color: contractTeal[800], fontSize: 14 }}>{currency}{contractLinesTotal(formDraft.lines || []).toLocaleString()}</b></span>
                </div>
              </div>
              <div style={contractGridStyle}>
                <div>
                  <label style={contractLabelStyle}>Start date</label>
                  <input type="date" value={formDraft.starts_at} onChange={e => setFormDraft({ ...formDraft, starts_at: e.target.value })}
                    style={contractInputStyle} />
                </div>
                <div>
                  <label style={contractLabelStyle}>End date (may cross FY)</label>
                  <input type="date" value={formDraft.ends_at} onChange={e => setFormDraft({ ...formDraft, ends_at: e.target.value })}
                    style={contractInputStyle} />
                </div>
              </div>
            </>
          ) : (
          <div style={contractGridStyle}>
            <div>
              <label style={contractLabelStyle}>Prepaid amount (commercial figure)</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: contractInkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                <input type="number" min={0} step="0.01" value={formDraft.prepaid_amount}
                  onChange={e => setFormDraft({ ...formDraft, prepaid_amount: Number(e.target.value) })}
                  style={{ ...contractInputStyle, paddingLeft: 28, fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={contractLabelStyle}>Assessment entitlement</label>
                <input type="number" min={1} step={1} value={formDraft.max_assessments}
                  onChange={e => setFormDraft({ ...formDraft, max_assessments: Number(e.target.value) })}
                  style={{ ...contractInputStyle, fontVariantNumeric: 'tabular-nums' }} />
              </div>
              <div>
                <label style={contractLabelStyle}>Unit price</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: contractInkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                  <input type="number" min={0} step="0.01" value={formDraft.assessment_price}
                    onChange={e => setFormDraft({ ...formDraft, assessment_price: Number(e.target.value) })}
                    style={{ ...contractInputStyle, paddingLeft: 28, fontVariantNumeric: 'tabular-nums' }} />
                </div>
              </div>
            </div>
            <div>
              <label style={contractLabelStyle}>Start date</label>
              <input type="date" value={formDraft.starts_at} onChange={e => setFormDraft({ ...formDraft, starts_at: e.target.value })}
                style={contractInputStyle} />
            </div>
            <div>
              <label style={contractLabelStyle}>End date (may cross FY)</label>
              <input type="date" value={formDraft.ends_at} onChange={e => setFormDraft({ ...formDraft, ends_at: e.target.value })}
                style={contractInputStyle} />
            </div>
          </div>
          )}

          <ContractSectionLabel>Terms &amp; Notes</ContractSectionLabel>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Terms</label>
            <textarea value={formDraft.terms} onChange={e => setFormDraft({ ...formDraft, terms: e.target.value })} rows={3}
              placeholder="Printing specifications, pricing rules, delivery terms…"
              style={contractTextareaStyle} />
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Notes</label>
            <textarea value={formDraft.notes} onChange={e => setFormDraft({ ...formDraft, notes: e.target.value })} rows={2}
              style={contractTextareaStyle} />
          </div>
        </ContractModalShell>
      )}

      {/* ── Detail modal (centered, no sidebar) ── */}
      {selected && (
        <ContractModalShell
          width={960}
          icon={<FileText size={19} color="#fff" />}
          title={selected.title || selected.contract_number}
          subtitle={
            <span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{selected.contract_number}</span>
              {' — '}{customerNameOf(selected.customer_id)} · {schoolNameOf(selected.school_id)}
              {' · '}<span style={{
                display: 'inline-block', padding: '1px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                background: selected.status === 'active' ? contractTeal[50] : contractPaper,
                color: contractTeal[700], border: `1px solid ${contractTeal[100]}`,
              }}>{CONTRACT_STATUS_LABEL[selected.status]}</span>
            </span>
          }
          onClose={() => setSelectedId(null)}
          footerHint={`Contract ${selected.contract_number} — ${CONTRACT_STATUS_LABEL[selected.status]}`}
            footerActions={
              <>
                <ContractGhostButton onClick={() => setSelectedId(null)}>Close</ContractGhostButton>
                {canManageContracts && (<ContractPrimaryButton onClick={() => openEdit(selected)}>Edit Contract</ContractPrimaryButton>)}
              </>
            }
        >
          {/* Horizontal tab strip (no sidebar) */}
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18,
            padding: 10, background: contractTeal[50],
            border: `1px solid ${contractTeal[100]}`, borderRadius: 12,
          }}>
            {(['overview', 'assessments', 'jobs', 'wallet', 'amendments'] as DetailTab[]).map(t => {
              const isActive = detailTab === t;
              return (
                <button key={t} onClick={() => setDetailTab(t)} style={{
                  padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  letterSpacing: 0.04, textTransform: 'uppercase', cursor: 'pointer',
                  border: isActive ? '1px solid transparent' : `1px solid ${contractHairline}`,
                  background: isActive ? `linear-gradient(155deg, ${contractTeal[500]}, ${contractTeal[700]})` : contractPaper,
                  color: isActive ? '#fff' : contractInkSoft,
                  boxShadow: isActive ? '0 4px 10px -4px rgba(15,84,76,.5)' : 'none',
                  transition: 'all .15s ease',
                }}>
                  {DETAIL_TAB_LABEL[t]}
                </button>
              );
            })}
          </div>

          {/* Lifecycle transitions */}
          {canManageContracts && CONTRACT_TRANSITIONS[selected.status].length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
              {CONTRACT_TRANSITIONS[selected.status].map(next => (
                <ContractGhostButton key={next} onClick={() => transitionContract(selected, next)}>
                  {next === 'active' ? <Play size={13} /> : next === 'suspended' ? <Pause size={13} /> : next === 'cancelled' ? <Ban size={13} /> : <CheckCircle size={13} />}
                  {next === 'pending_payment' ? 'Submit for payment' : next === 'active' ? 'Verify & activate' : next === 'suspended' ? 'Suspend' : CONTRACT_STATUS_LABEL[next]}
                </ContractGhostButton>
              ))}
            </div>
          )}
              {detailTab === 'overview' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { l: 'Prepaid', v: money(fundsOf(selected).prepaid) },
                      { l: 'Reserved', v: money(fundsOf(selected).reserved) },
                      { l: 'Consumed', v: money(fundsOf(selected).consumed) },
                      { l: 'Available', v: money(fundsOf(selected).available) },
                    ].map(k => (
                      <div key={k.l} style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12 }}>
                        <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 4px' }}>{k.l}</p>
                        <p className="finance-nums" style={{ fontWeight: 700, color: contractInk, margin: 0, fontVariantNumeric: 'tabular-nums' }}>{k.v}</p>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12 }}>
                      <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 2px' }}>Customer invoice</p>
                      <p className="finance-nums" style={{ fontWeight: 700, color: contractInk, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>
                        {(selected.data as any)?.issued_invoice_id || 'Not yet issued'}
                      </p>
                    </div>
                    {!(selected.data as any)?.issued_invoice_id && canManageContracts && (
                      <ContractPrimaryButton compact chevron={false} onClick={handleIssueInvoiceForSelected}>
                        <FileText size={13} /> Issue invoice
                      </ContractPrimaryButton>
                    )}
                  </div>
                  <div style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                      <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: 0 }}>Signatures</p>
                      <span style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06,
                        padding: '3px 10px', borderRadius: 999, border: '1px solid',
                        ...(selectedSignatures.company && selectedSignatures.customer
                          ? { color: '#047857', background: '#ecfdf5', borderColor: '#a7f3d0' }
                          : (selectedSignatures.company || selectedSignatures.customer)
                            ? { color: '#b45309', background: '#fffbeb', borderColor: '#fde68a' }
                            : { color: '#5c6567', background: '#f1f5f9', borderColor: '#e4ddd1' }),
                      }}>
                        {selectedSignatures.company && selectedSignatures.customer
                          ? 'Fully signed'
                          : (selectedSignatures.company || selectedSignatures.customer) ? 'Partially signed' : 'Unsigned'}
                      </span>
                    </div>
                    {!selectedSignatures.company && !selectedSignatures.customer && selectedSignatures.history.some(h => h.type === 'voided') && (
                      <p style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px' }}>
                        Signatures were voided by an approved amendment — re-signing is required before a new document is generated.
                      </p>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      {(['company', 'customer'] as SignatureParty[]).map(party => {
                        const block = selectedSignatures[party];
                        const lockedByOrder = party === 'customer' && !selectedSignatures.company;
                        const canSign = canManageContracts && isSignableContractStatus(selected.status);
                        return (
                          <div key={party} style={{ border: `1px solid ${contractHairline}`, borderRadius: 10, padding: 12, background: '#fff' }}>
                            <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 8px' }}>
                              {party === 'company' ? 'Company' : 'Customer'}
                            </p>
                            {block ? (
                              <div>
                                {block.signatureDataUrl && (
                                  <img src={block.signatureDataUrl} alt={`${party} signature`} style={{ maxWidth: '100%', maxHeight: 56, marginBottom: 6, border: '1px solid #e4ddd1', borderRadius: 6, background: '#fff' }} />
                                )}
                                <p style={{ fontSize: 12, fontWeight: 700, color: contractInk, margin: 0 }}>{block.name}</p>
                                <p style={{ fontSize: 11, color: contractInkSoft, margin: '2px 0 0' }}>{block.role} · signed {block.signedAt ? new Date(block.signedAt).toLocaleDateString() : ''}</p>
                              </div>
                            ) : (
                              <p style={{ fontSize: 12, color: contractInkSoft, fontStyle: 'italic', margin: 0 }}>Not signed</p>
                            )}
                            {canSign && (
                              <button
                                type="button"
                                disabled={lockedByOrder}
                                title={lockedByOrder ? 'The company must sign first — sequential order is enforced' : (block ? `Re-sign as ${party}` : `Sign as ${party}`)}
                                onClick={() => setSigningParty(party)}
                                style={{
                                  marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6,
                                  padding: '7px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: lockedByOrder ? 'not-allowed' : 'pointer',
                                  border: '1px solid #0f766e', background: lockedByOrder ? '#f1f5f9' : '#0f766e', color: lockedByOrder ? '#94a3b8' : '#fff',
                                }}
                              >
                                <PenLine size={13} /> {block ? 'Re-sign' : 'Sign'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {selectedSignatures.history.length > 0 && (
                      <div style={{ marginTop: 12, borderTop: `1px solid ${contractHairline}`, paddingTop: 8 }}>
                        {selectedSignatures.history.slice(-4).map((h, i) => (
                          <p key={i} style={{ fontSize: 11, color: contractInkSoft, margin: '2px 0', fontFamily: "'JetBrains Mono', monospace" }}>
                            {h.type}{h.party ? ` · ${h.party}` : ''} · {h.at ? new Date(h.at).toLocaleDateString() : ''} · {h.by}{h.reason ? ` · ${h.reason}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12 }}>
                      <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 2px' }}>Contract document</p>
                      <p className="finance-nums" style={{ fontWeight: 700, color: contractInk, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>
                        {selected.contract_number} · v{num(selected.version) || 1} · {selectedSignatures.company && selectedSignatures.customer ? 'fully signed' : 'unsigned/partial'}
                      </p>
                    </div>
                    <ContractPrimaryButton compact chevron={false} onClick={() => { void handleGenerateContractDocument(); }}>
                      <FileText size={13} /> Generate document
                    </ContractPrimaryButton>
                  </div>
                  <div style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
                    <p style={{ margin: 0 }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Period</span>
                      <span style={{ color: contractInk }}>{selected.starts_at ? new Date(selected.starts_at).toLocaleDateString() : '—'} → {selected.ends_at ? new Date(selected.ends_at).toLocaleDateString() : 'open'}</span></p>
                    <p style={{ margin: 0 }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Entitlement</span>
                      <span style={{ color: contractInk }}>{selectedItems.length} / {selected.max_assessments} assessments · {money(num(selected.assessment_price))} each</span></p>
                    <p style={{ margin: 0 }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Type</span>
                      <span style={{ color: contractInk, textTransform: 'capitalize' }}>{(selected.assessment_type || '').replace(/_/g, ' ')}</span>
                      <span style={{ color: contractInkSoft }}>{[selected.assessment_grade, selected.assessment_subject].filter(Boolean).join(' · ') || ''}</span></p>
                    <p style={{ margin: 0 }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Payment</span>
                      <span style={{ color: contractInk }}>{selected.payment_status || 'pending'}{selected.payment_verified_at ? ` · verified ${new Date(selected.payment_verified_at).toLocaleDateString()}` : ''}</span></p>
                    {selected.description && <p style={{ margin: 0, gridColumn: '1 / -1' }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Description</span><span style={{ color: contractInk }}>{selected.description}</span></p>}
                    {selected.terms && <p style={{ margin: 0, gridColumn: '1 / -1' }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Terms</span><span style={{ color: contractInk }}>{selected.terms}</span></p>}
                    {selected.notes && <p style={{ margin: 0, gridColumn: '1 / -1' }}><span style={{ color: contractInkSoft, fontWeight: 800, textTransform: 'uppercase', fontSize: 10, display: 'block', letterSpacing: 0.06 }}>Notes</span><span style={{ color: contractInk }}>{selected.notes}</span></p>}
                  </div>
                </div>
              )}

              {detailTab === 'assessments' && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: 0 }}>Schedule ({selectedItems.length}/{selected.max_assessments})</p>
                    <ContractPrimaryButton compact chevron={false} onClick={openItemCreate}>
                      <Plus size={13} /> Schedule Assessment
                    </ContractPrimaryButton>
                  </div>
                  {selectedItems.length === 0
                    ? <p style={{ fontSize: 12, color: contractInkSoft, fontStyle: 'italic', background: contractPaper, borderRadius: 12, border: `2px dashed ${contractTeal[100]}`, padding: 24, textAlign: 'center', margin: 0 }}>No assessments scheduled yet.</p>
                    : <div className="space-y-2">
                      {selectedItems.map(a => (
                        <div key={a.id} className="flex flex-col md:flex-row md:items-center gap-2 justify-between"
                          style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12 }}>
                          <div>
                            <p style={{ fontWeight: 700, color: contractInk, fontSize: 13, margin: 0 }}>{a.assessment_name}</p>
                            <p style={{ fontSize: 11, color: contractInkSoft, display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 0' }}>
                              <Calendar size={11} /> {a.assessment_date ? new Date(a.assessment_date).toLocaleDateString() : 'unscheduled'}
                              {' · '}{money(num(a.item_price))}
                              {a.job_order_id && <span style={{ fontFamily: "'JetBrains Mono', monospace", background: contractTeal[50], border: `1px solid ${contractTeal[100]}`, color: contractTeal[700], borderRadius: 6, padding: '1px 6px' }}>JOB {a.job_order_id}</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${ITEM_STATUS_STYLE[a.status]}`}>{ITEM_STATUS_LABEL[a.status]}</span>
                            {a.status === 'reserved' && (
                              <>
                                <button onClick={() => transitionItem(a, 'consumed')} title="Mark consumed" className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#146b60] hover:bg-[#eef7f6]"><CheckCircle size={14} /></button>
                                <button onClick={() => transitionItem(a, 'released')} title="Release reservation" className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6]"><History size={14} /></button>
                                <button onClick={() => handleCreateJobFromAssessment(a)} title="Create printing job" className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#146b60] hover:bg-[#eef7f6]"><Printer size={14} /></button>
                              </>
                            )}
                            <button onClick={() => openJobLink(a)} title="Link job / exam batch" className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6]"><ClipboardList size={14} /></button>
                            <button onClick={() => openItemEdit(a)} className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6]"><Edit2 size={14} /></button>
                            {a.status !== 'consumed' && (
                              <button onClick={() => transitionItem(a, 'cancelled')} title="Cancel assessment" className="p-1.5 rounded-lg border border-[#e4ddd1] text-[#b5493f] hover:bg-[#b5493f15]"><Ban size={14} /></button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>}
                </div>
              )}

              {detailTab === 'jobs' && (
                <div>
                  <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 12px' }}>Linked printing jobs ({selectedJobs.length})</p>
                  {selectedJobs.length === 0
                    ? <p style={{ fontSize: 12, color: contractInkSoft, fontStyle: 'italic', background: contractPaper, borderRadius: 12, border: `2px dashed ${contractTeal[100]}`, padding: 24, textAlign: 'center', margin: 0 }}>
                      No job orders linked. Create one from the Assessments tab or link an existing ticket.</p>
                    : <div className="space-y-2">
                      {selectedJobs.map((j: JobOrder) => (
                        <div key={j.id} className="flex items-center justify-between gap-2"
                          style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12 }}>
                          <div>
                            <p className="finance-nums" style={{ fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: contractInk, margin: 0 }}>{j.id}</p>
                            <p style={{ fontSize: 11, color: contractInkSoft, margin: '2px 0 0' }}>{j.customerName || customerNameOf(j.customerId)} · qty {j.totalQuantity} · due {j.dueDate ? new Date(j.dueDate).toLocaleDateString() : '—'}</p>
                          </div>
                          <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: contractTeal[50], color: contractTeal[700], border: `1px solid ${contractTeal[100]}` }}>{j.status}</span>
                        </div>
                      ))}
                    </div>}
                  {(invoices || []).filter((inv: any) =>
                    (String(inv.customerId || inv.customerName || '').includes(String(selected.customer_id)) || String((inv as any).reference || (inv as any).referenceDoc || '').includes(String(selected.contract_number || ''))) && inv.status !== 'Paid').slice(0, 5).length > 0 && (
                    <div className="mt-4">
                      <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: '0 0 8px' }}>Related open invoices</p>
                      {(invoices || []).filter((inv: any) =>
                        (String(inv.customerId || inv.customerName || '').includes(String(selected.customer_id)) || String((inv as any).reference || (inv as any).referenceDoc || '').includes(String(selected.contract_number || ''))) && inv.status !== 'Paid').slice(0, 5)
                        .map((inv: any) => (
                          <div key={inv.id} className="flex justify-between"
                            style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 10, marginBottom: 6, fontSize: 12 }}>
                            <span className="finance-nums" style={{ fontFamily: "'JetBrains Mono', monospace", color: contractInkSoft }}>{inv.id} · {inv.customerName}</span>
                            <span className="finance-nums" style={{ fontWeight: 700, color: contractInk, fontVariantNumeric: 'tabular-nums' }}>{money(num(inv.totalAmount ?? inv.total))} · {inv.status}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {detailTab === 'wallet' && (
                <div className="space-y-3">
                  <div style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ padding: 10, background: contractTeal[50], color: contractTeal[600], borderRadius: 8 }}><Landmark size={18} /></div>
                    <div style={{ fontSize: 12, color: contractInkSoft }}>
                      <p style={{ margin: 0 }}><b style={{ color: contractInk }}>Prepaid (commercial):</b> {money(fundsOf(selected).prepaid)} — recorded on the contract.</p>
                      <p style={{ margin: '4px 0 0' }}><b style={{ color: contractInk }}>Wallet (financial truth):</b> moves only at payment time — Deposit on activation, Deduction on job payment, Credit on cancellation refund.</p>
                    </div>
                  </div>
                  {selectedWalletTx.length === 0
                    ? <p style={{ fontSize: 12, color: contractInkSoft, fontStyle: 'italic', background: contractPaper, borderRadius: 12, border: `2px dashed ${contractTeal[100]}`, padding: 24, textAlign: 'center', margin: 0 }}>No wallet movements reference this contract yet.</p>
                    : selectedWalletTx.map((t: WalletTransaction) => (
                      <div key={t.id} className="flex justify-between"
                        style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12, fontSize: 12 }}>
                        <div>
                          <p style={{ fontWeight: 700, color: contractInk, margin: 0 }}>{t.type} <span style={{ fontWeight: 400, color: contractInkSoft }}>· {t.reference || t.id}</span></p>
                          <p style={{ color: contractInkSoft, margin: '2px 0 0' }}>{t.date ? new Date(t.date).toLocaleDateString() : ''}</p>
                        </div>
                        <p className="finance-nums" style={{ fontWeight: 700, margin: 0, fontVariantNumeric: 'tabular-nums', color: num(t.amount) < 0 ? contractDanger : contractTeal[600] }}>
                          {num(t.amount) < 0 ? '−' : '+'}{money(Math.abs(num(t.amount)))}
                        </p>
                      </div>
                    ))}
                </div>
              )}

              {detailTab === 'amendments' && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: contractInkSoft, margin: 0 }}>Amendments ({selectedAmendments.length})</p>
                    {canManageContracts && (
                      <ContractGhostButton compact onClick={() => setIsAmendOpen(true)}>
                        <Plus size={13} /> Request Amendment
                      </ContractGhostButton>
                    )}
                  </div>
                  {selectedAmendments.length === 0
                    ? <p style={{ fontSize: 12, color: contractInkSoft, fontStyle: 'italic', background: contractPaper, borderRadius: 12, border: `2px dashed ${contractTeal[100]}`, padding: 24, textAlign: 'center', margin: 0 }}>No amendments. History is audit-backed — each change is a new amendment record.</p>
                    : selectedAmendments.map(am => (
                      <div key={am.id} style={{ background: contractPaper, borderRadius: 12, border: `1px solid ${contractHairline}`, padding: 12, marginBottom: 8 }}>
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <p style={{ fontWeight: 700, fontSize: 12, color: contractInk, textTransform: 'capitalize', margin: 0 }}>{am.amendment_type} · {am.status}</p>
                            <p style={{ fontSize: 12, color: contractInk, margin: '4px 0 0' }}>{am.description}</p>
                            <p className="finance-nums" style={{ fontSize: 11, color: contractInkSoft, margin: '4px 0 0', fontVariantNumeric: 'tabular-nums' }}>
                              {num(am.prepaid_amount_adjustment) !== 0 && `prepaid ${num(am.prepaid_amount_adjustment) > 0 ? '+' : ''}${money(num(am.prepaid_amount_adjustment))} · `}
                              {num(am.assessment_count_adjustment) !== 0 && `entitlement ${num(am.assessment_count_adjustment) > 0 ? '+' : ''}${am.assessment_count_adjustment} · `}
                              requested {am.created_at ? new Date(am.created_at).toLocaleDateString() : ''}
                            </p>
                          </div>
                          {am.status === 'pending' && canManageContracts && (
                            <div className="flex gap-1.5 shrink-0">
                              <ContractPrimaryButton compact chevron={false} onClick={() => handleApproveAmendment(am, true)}>Approve</ContractPrimaryButton>
                              <ContractGhostButton compact onClick={() => handleApproveAmendment(am, false)}>Reject</ContractGhostButton>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}
        </ContractModalShell>
      )}

      {/* ── Assessment form ── */}
      {isItemFormOpen && selected && (
        <ContractModalShell
          width={640}
          zIndex={9100}
          icon={<Calendar size={19} color="#fff" />}
          title={editingItem ? 'Edit Assessment' : 'Schedule Assessment'}
          subtitle={`${selected.contract_number} · entitlement ${selectedItems.length + (editingItem ? 0 : 1)}/${selected.max_assessments}`}
          onClose={() => { setIsItemFormOpen(false); setEditingItem(null); }}
          footerHint={editingItem ? 'Consumed assessments are historical and protected' : 'Scheduling reserves funds against the contract'}
          submitLabel={editingItem ? 'Save' : 'Reserve & Schedule'}
          onSubmit={handleSaveItem}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>
              Assessment name <ContractRequiredMark />
            </label>
            <input value={itemDraft.assessment_name} onChange={e => setItemDraft({ ...itemDraft, assessment_name: e.target.value })}
              placeholder="e.g. Term 2 Mathematics — Grade 8" style={contractInputStyle} />
          </div>
          <div style={contractGridStyle}>
            <div>
              <label style={contractLabelStyle}>Type</label>
              <select value={itemDraft.assessment_type} onChange={e => setItemDraft({ ...itemDraft, assessment_type: e.target.value })}
                style={contractSelectStyle}>
                <option value="examination">Examination</option><option value="commercial">Commercial</option><option value="general">General</option>
              </select>
            </div>
            <div>
              <label style={contractLabelStyle}>Scheduled date</label>
              <input type="date" value={itemDraft.assessment_date} onChange={e => setItemDraft({ ...itemDraft, assessment_date: e.target.value })}
                style={contractInputStyle} />
            </div>
            <div>
              <label style={contractLabelStyle}>Grade</label>
              <input value={itemDraft.assessment_grade} onChange={e => setItemDraft({ ...itemDraft, assessment_grade: e.target.value })}
                style={contractInputStyle} />
            </div>
            <div>
              <label style={contractLabelStyle}>Subject</label>
              <input value={itemDraft.assessment_subject} onChange={e => setItemDraft({ ...itemDraft, assessment_subject: e.target.value })}
                style={contractInputStyle} />
            </div>
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>
              Estimated cost <ContractRequiredMark />
            </label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: contractInkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
              <input type="number" min={0} step="0.01" value={itemDraft.item_price} onChange={e => setItemDraft({ ...itemDraft, item_price: Number(e.target.value) })}
                style={{ ...contractInputStyle, paddingLeft: 28, fontVariantNumeric: 'tabular-nums' }} />
            </div>
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Notes</label>
            <textarea value={itemDraft.notes} onChange={e => setItemDraft({ ...itemDraft, notes: e.target.value })} rows={2}
              style={contractTextareaStyle} />
          </div>
        </ContractModalShell>
      )}

      {/* ── Job / exam-batch link ── */}
      {jobLinkItem && (
        <ContractModalShell
          width={560}
          zIndex={9100}
          icon={<ClipboardList size={19} color="#fff" />}
          title="Link operational records"
          subtitle={jobLinkItem.assessment_name}
          onClose={() => setJobLinkItem(null)}
          footerHint="Links are optional references — the assessment stays the contractual record"
          submitLabel="Save Links"
          onSubmit={handleSaveJobLink}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Job order</label>
            <select value={jobLinkId} onChange={e => setJobLinkId(e.target.value)}
              style={contractSelectStyle}>
              <option value="">None</option>
              {(jobOrders || []).slice(0, 200).map((j: JobOrder) => (
                <option key={j.id} value={j.id}>{j.id} — {j.customerName || customerNameOf(j.customerId)} ({j.status})</option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Examination printing batch (optional)</label>
            <select value={examBatchId} onChange={e => setExamBatchId(e.target.value)}
              style={{ ...contractSelectStyle, fontFamily: "'JetBrains Mono', monospace" }}>
              <option value="">None</option>
              {examBatchId && !examBatches.some(b => b.id === examBatchId || b.batch_number === examBatchId) && (
                <option value={examBatchId}>{examBatchId} (unknown — clear and reselect)</option>
              )}
              {examBatches.map(b => (
                <option key={b.id} value={b.id}>{b.batch_number || b.id} — {b.name || 'Unnamed batch'}{b.status ? ` (${b.status})` : ''}</option>
              ))}
            </select>
          </div>
        </ContractModalShell>
      )}

      {/* ── Amendment form ── */}
      {isAmendOpen && (
        <ContractModalShell
          width={560}
          zIndex={9100}
          icon={<History size={19} color="#fff" />}
          title="Request Amendment"
          subtitle={selected ? `${selected.contract_number} — pending approval before it applies` : undefined}
          onClose={() => setIsAmendOpen(false)}
          footerHint="Approved amendments adjust prepaid, entitlement or unit price"
          submitLabel="Submit Request"
          onSubmit={handleSaveAmendment}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>Type</label>
            <select value={amendDraft.amendment_type} onChange={e => setAmendDraft({ ...amendDraft, amendment_type: e.target.value })}
              style={contractSelectStyle}>
              <option value="terms">Terms</option><option value="funds">Prepaid adjustment</option>
              <option value="entitlement">Entitlement change</option><option value="schedule">Schedule change</option>
            </select>
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>
              Description <ContractRequiredMark />
            </label>
            <textarea value={amendDraft.description} onChange={e => setAmendDraft({ ...amendDraft, description: e.target.value })} rows={3}
              style={contractTextareaStyle} />
          </div>
          <div style={{ ...contractGridStyle, gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={contractLabelStyle}>Prepaid ±</label>
              <input type="number" step="0.01" value={amendDraft.prepaid_amount_adjustment}
                onChange={e => setAmendDraft({ ...amendDraft, prepaid_amount_adjustment: Number(e.target.value) })}
                style={{ ...contractInputStyle, fontVariantNumeric: 'tabular-nums' }} />
            </div>
            <div>
              <label style={contractLabelStyle}>Count ±</label>
              <input type="number" step={1} value={amendDraft.assessment_count_adjustment}
                onChange={e => setAmendDraft({ ...amendDraft, assessment_count_adjustment: Number(e.target.value) })}
                style={{ ...contractInputStyle, fontVariantNumeric: 'tabular-nums' }} />
            </div>
            <div>
              <label style={contractLabelStyle}>Price</label>
              <input type="number" step="0.01" value={amendDraft.assessment_price_adjustment}
                onChange={e => setAmendDraft({ ...amendDraft, assessment_price_adjustment: Number(e.target.value) })}
                style={{ ...contractInputStyle, fontVariantNumeric: 'tabular-nums' }} />
            </div>
          </div>
        </ContractModalShell>
      )}

      {/* ── Activation without payment evidence (explicit override) ── */}
      {activateOverride && (
        <ContractModalShell
          width={560}
          zIndex={9200}
          icon={<Play size={19} color="#fff" />}
          title="Activate without payment evidence"
          subtitle={`${activateOverride.contract.contract_number} — no paid invoice found`}
          onClose={() => setActivateOverride(null)}
          footerHint="The reason is stored on the contract audit trail. Prefer issuing the invoice and recording payment first."
          submitLabel="Activate anyway"
          onSubmit={() => {
            if (!activateOverride.reason.trim()) {
              notify('A reason is required to activate without payment evidence.', 'error');
              return;
            }
            const target = activateOverride.contract;
            const reason = activateOverride.reason.trim();
            setActivateOverride(null);
            void transitionContract(target, 'active', { overrideReason: reason });
          }}
        >
          <div style={{ marginBottom: 18 }}>
            <label style={contractLabelStyle}>
              Reason <ContractRequiredMark />
            </label>
            <textarea
              value={activateOverride.reason}
              onChange={e => setActivateOverride({ ...activateOverride, reason: e.target.value })}
              rows={3}
              placeholder="e.g. Government LPO received — payment follows in 30 days"
              style={contractTextareaStyle}
            />
          </div>
        </ContractModalShell>
      )}

      {/* ── Same-device signing ceremony ── */}
      {signingParty && selected && (
        <ContractModalShell
          width={620}
          zIndex={9200}
          icon={<PenLine size={19} color="#fff" />}
          title={`Sign as ${signingParty === 'company' ? 'Company' : 'Customer'}`}
          subtitle={`${selected.contract_number} — ${selected.title}`}
          onClose={() => setSigningParty(null)}
          footerHint={signingParty === 'customer' && !selectedSignatures.company
            ? 'The company must sign first — sequential order is enforced'
            : 'The signature, printed name and timestamp are stored on the contract audit trail'}
          footerActions={<></>}
        >
          <SignatureCapture
            signerLabel={signingParty === 'company' ? 'Company representative' : 'Customer representative'}
            initialName={signingParty === 'company'
              ? String((user as any)?.name || (user as any)?.username || '')
              : customerNameOf(selected.customer_id)}
            submitLabel={signingParty === 'company' ? 'Sign as Company' : 'Sign as Customer'}
            onConfirm={(captured) => { void handleConfirmSignature(signingParty, captured); }}
            onCancel={() => setSigningParty(null)}
          />
        </ContractModalShell>
      )}

      {/* Generated document preview (portal-based modal) */}
      <PreviewModal
        isOpen={!!docPreview}
        onClose={() => setDocPreview(null)}
        type="PRINTING_CONTRACT"
        data={docPreview?.data ?? null}
      />

      {/* Delete confirm renders above the contract modal overlays (shell uses z 9000+) */}
      <div style={{ position: 'relative', zIndex: 9500 }}>
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => !open && setConfirmState(c => ({ ...c, open: false }))}
        onConfirm={() => { confirmState.onConfirm?.(); setConfirmState(c => ({ ...c, open: false })); }}
        onCancel={() => setConfirmState(c => ({ ...c, open: false }))}
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        type={confirmState.type || 'danger'}
      />
      </div>
      {isLoading && assessmentContracts.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center" style={{ background: 'rgba(254,253,251,.6)' }}>
          <p className="flex items-center gap-2 text-xs font-bold" style={{ color: contractInkSoft }}>
            <RefreshCw size={14} className="animate-spin" /> Loading printing contracts…
          </p>
        </div>
      )}
    </div>
  );
};

export default PrintingContractsView;
