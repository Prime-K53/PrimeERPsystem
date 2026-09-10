import React, { useState, useEffect, useMemo } from 'react';
import {
    Search, Download, Users, DollarSign, TrendingUp,
    CreditCard, UserPlus, Loader2,
} from 'lucide-react';
import { payrollService } from '../../services/payrollService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { Employee, PayrollEntry } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './components/financeChrome';

const Payroll: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const [employees, setEmployees] = useState<Employee[]>([]);
    const [payrollEntries, setPayrollEntries] = useState<PayrollEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [isAddEmployeeModalOpen, setIsAddEmployeeModalOpen] = useState(false);
    const [isPayrollModalOpen, setIsPayrollModalOpen] = useState(false);
    const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
    const [summary, setSummary] = useState({ totalGross: 0, totalPAYE: 0, totalPension: 0, totalNet: 0, employeeCount: 0 });

    const canEdit = checkPermission('accounts.edit');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setIsLoading(true);
        try {
            await payrollService.initializeStores();
            const emps = await payrollService.getAllEmployees();
            const entries = await payrollService.getAllPayrollEntries();
            const sum = await payrollService.getPayrollSummary();
            setEmployees(emps);
            setPayrollEntries(entries);
            setSummary(sum);
        } catch (error) {
            notify('Failed to load payroll data', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const filteredEmployees = useMemo(() => {
        return employees.filter(emp => {
            if (statusFilter !== 'All' && emp.status !== statusFilter) return false;
            if (searchTerm) {
                const search = searchTerm.toLowerCase();
                return emp.first_name.toLowerCase().includes(search) ||
                    emp.last_name.toLowerCase().includes(search) ||
                    emp.employee_number.toLowerCase().includes(search) ||
                    emp.department.toLowerCase().includes(search);
            }
            return true;
        });
    }, [employees, searchTerm, statusFilter]);

    const handleAddEmployee = async (data: any) => {
        try {
            await payrollService.createEmployee(data);
            notify('Employee added successfully', 'success');
            setIsAddEmployeeModalOpen(false);
            loadData();
        } catch (error: any) {
            notify(error.message || 'Failed to add employee', 'error');
        }
    };

    const handleProcessPayroll = async (data: any) => {
        try {
            const paye = await payrollService.calculatePAYE(data.grossSalary);
            await payrollService.processPayroll(
                data.employeeId,
                data.payPeriodStart,
                data.payPeriodEnd,
                data.paymentDate,
                data.grossSalary,
                paye,
                data.pensionAmount || 0,
                data.otherDeductions || 0,
                data.deductionDescription || '',
                accounts
            );
            notify('Payroll processed successfully', 'success');
            setIsPayrollModalOpen(false);
            setSelectedEmployee(null);
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to process payroll', 'error');
        }
    };

    const exportToCSV = () => {
        const headers = ['Employee #', 'Name', 'Department', 'Basic Salary', 'Status'];
        const rows = filteredEmployees.map(emp => [
            emp.employee_number,
            `${emp.first_name} ${emp.last_name}`,
            emp.department,
            emp.basic_salary.toFixed(2),
            emp.status,
        ]);

        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `employees_${getDefaultDate()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const kpis = [
        { label: 'Total Employees', value: String(summary.employeeCount), icon: Users, color: amber[600], bg: amber[100] },
        { label: 'Total Gross (YTD)', value: formatCurrency(summary.totalGross, currency), icon: DollarSign, color: teal[700], bg: teal[50] },
        { label: 'Total PAYE (YTD)', value: formatCurrency(summary.totalPAYE, currency), icon: TrendingUp, color: danger, bg: '#fdeeee' },
        { label: 'Total Net (YTD)', value: formatCurrency(summary.totalNet, currency), icon: CreditCard, color: teal[600], bg: teal[100] },
    ];

    return (
        <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            <PageHeader
                icon={<Users size={19} color="#fff" />}
                title="Payroll"
                subtitle="Manage employees and process payroll"
                actions={
                    <>
                        <button
                            onClick={exportToCSV}
                            style={btnGhostStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                        >
                            <Download size={15} />
                            Export
                        </button>
                        {canEdit && (
                            <button
                                onClick={() => setIsAddEmployeeModalOpen(true)}
                                style={btnGhostStyle}
                                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                            >
                                <UserPlus size={15} />
                                Add Employee
                            </button>
                        )}
                        {canEdit && (
                            <button
                                onClick={() => setIsPayrollModalOpen(true)}
                                style={btnPrimaryStyle}
                                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                            >
                                <CreditCard size={15} />
                                Process Payroll
                            </button>
                        )}
                    </>
                }
            />

            <KpiCards items={kpis} />

            {/* Filters */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                    <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search employees..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ ...inputStyle, paddingLeft: 34 }}
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{ ...selectStyle, width: 190 }}
                >
                    <option value="All">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="terminated">Terminated</option>
                </select>
            </div>

            {/* Employee Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
                        <Loader2 size={24} className="animate-spin" style={{ color: teal[500] }} />
                    </div>
                ) : filteredEmployees.length === 0 ? (
                    <EmptyState
                        icon={<Users size={32} />}
                        title="No employees found"
                        hint="Add an employee to start running payroll."
                    />
                ) : (
                    <div style={tableCard}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={tableHeadRow}>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Employee</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Department</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Position</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Basic Salary</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Status</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredEmployees.map(emp => (
                                    <tr key={emp.id}
                                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                    >
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <div style={{
                                                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                                    background: teal[100], color: teal[700],
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: 13, fontWeight: 700
                                                }}>
                                                    {(emp.first_name || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <div>
                                                    <p style={{ fontWeight: 600, fontSize: 13, color: ink, margin: 0 }}>
                                                        {emp.first_name} {emp.last_name}
                                                    </p>
                                                    <p style={{ fontSize: 11, color: inkSoft, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{emp.employee_number}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, color: ink }}>{emp.department}</td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, color: ink }}>{emp.position}</td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: ink, fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(emp.basic_salary, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <span
                                                style={{
                                                    padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, textTransform: 'capitalize',
                                                    background: emp.status === 'active' ? '#d1fae5' : emp.status === 'inactive' ? '#fef3c7' : '#fee2e2',
                                                    color: emp.status === 'active' ? '#065f46' : emp.status === 'inactive' ? '#92400e' : '#991b1b'
                                                }}
                                            >
                                                {emp.status}
                                            </span>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                                {canEdit && (
                                                    <button
                                                        onClick={() => {
                                                            setSelectedEmployee(emp);
                                                            setIsPayrollModalOpen(true);
                                                        }}
                                                        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                        title="Process Payroll"
                                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <CreditCard size={16} style={{ color: teal[600] }} />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add Employee Modal */}
            {isAddEmployeeModalOpen && (
                <AddEmployeeModal
                    onClose={() => setIsAddEmployeeModalOpen(false)}
                    onSubmit={handleAddEmployee}
                    currency={currency}
                />
            )}

            {/* Process Payroll Modal */}
            {isPayrollModalOpen && (
                <ProcessPayrollModal
                    employees={employees}
                    selectedEmployee={selectedEmployee}
                    onClose={() => { setIsPayrollModalOpen(false); setSelectedEmployee(null); }}
                    onSubmit={handleProcessPayroll}
                    currency={currency}
                />
            )}
        </div>
    );
};

interface AddEmployeeModalProps {
    onClose: () => void;
    onSubmit: (data: any) => void;
    currency: string;
}

const AddEmployeeModal: React.FC<AddEmployeeModalProps> = ({ onClose, onSubmit, currency }) => {
    const [formData, setFormData] = useState({
        employee_number: '',
        first_name: '',
        last_name: '',
        email: '',
        phone: '',
        department: '',
        position: '',
        join_date: getDefaultDate(),
        basic_salary: '',
        pay_frequency: 'monthly' as const,
        paye_number: '',
        bank_account_number: '',
        bank_name: '',
        status: 'active' as const,
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({
            ...formData,
            basic_salary: parseFloat(formData.basic_salary),
        });
    };

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<UserPlus size={19} color="#fff" />}
                    title="Add Employee"
                    subtitle="New staff record — Payroll ledger"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <form id="add-employee-form" onSubmit={handleSubmit}>
                        <div style={sectionLabelStyle}><span>Personal Details</span></div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                            <div>
                                <label style={labelStyle}>First Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={formData.first_name}
                                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                                    placeholder="First name"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Last Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={formData.last_name}
                                    onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                                    placeholder="Last name"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>
                                    Email
                                    <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                                </label>
                                <input
                                    type="email"
                                    value={formData.email}
                                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                    placeholder="name@company.com"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>
                                    Phone
                                    <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                                </label>
                                <input
                                    type="tel"
                                    value={formData.phone}
                                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                    placeholder="+260 …"
                                    style={inputStyle}
                                />
                            </div>
                        </div>

                        <div style={sectionLabelStyle}><span>Employment &amp; Pay</span></div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                            <div>
                                <label style={labelStyle}>Department <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={formData.department}
                                    onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                                    placeholder="e.g. Finance"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Position <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={formData.position}
                                    onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                                    placeholder="e.g. Accountant"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Join Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="date"
                                    required
                                    value={formData.join_date}
                                    onChange={(e) => setFormData({ ...formData, join_date: e.target.value })}
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Basic Salary <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                    <input
                                        type="number"
                                        required
                                        min="0"
                                        step="0.01"
                                        value={formData.basic_salary}
                                        onChange={(e) => setFormData({ ...formData, basic_salary: e.target.value })}
                                        placeholder="0.00"
                                        style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                            </div>
                        </div>
                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>Pay Frequency</label>
                            <select
                                value={formData.pay_frequency}
                                onChange={(e) => setFormData({ ...formData, pay_frequency: e.target.value as any })}
                                style={selectStyle}
                            >
                                <option value="monthly">Monthly</option>
                                <option value="bi-weekly">Bi-Weekly</option>
                                <option value="weekly">Weekly</option>
                            </select>
                        </div>

                        <div style={{
                            padding: 16, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                        }}>
                            <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[600] }}>
                                <CreditCard size={18} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: teal[800] }}>PAYE &amp; pension</div>
                                <div style={{ fontSize: 11, color: inkSoft, fontWeight: 500 }}>PAYE is auto-calculated on each pay run from the annual tax brackets.</div>
                            </div>
                        </div>
                    </form>
                </div>
                <ModalFooter
                    stepLabel="New staff · Payroll ledger"
                    onCancel={onClose}
                    submitLabel="Add Employee"
                    submitFormId="add-employee-form"
                />
            </div>
        </div>
    );
};

interface ProcessPayrollModalProps {
    employees: Employee[];
    selectedEmployee: Employee | null;
    onClose: () => void;
    onSubmit: (data: any) => void;
    currency: string;
}

const ProcessPayrollModal: React.FC<ProcessPayrollModalProps> = ({ employees, selectedEmployee, onClose, onSubmit, currency }) => {
    const [employeeId, setEmployeeId] = useState(selectedEmployee?.id || '');
    const [formData, setFormData] = useState({
        payPeriodStart: getDefaultDate(),
        payPeriodEnd: getDefaultDate(),
        paymentDate: getDefaultDate(),
        grossSalary: selectedEmployee?.basic_salary.toString() || '',
        pensionAmount: '0',
        otherDeductions: '0',
        deductionDescription: '',
    });

    const selectedEmp = employees.find(e => e.id === employeeId);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!employeeId) {
            alert('Please select an employee');
            return;
        }
        onSubmit({
            employeeId,
            ...formData,
            grossSalary: parseFloat(formData.grossSalary),
            pensionAmount: parseFloat(formData.pensionAmount) || 0,
            otherDeductions: parseFloat(formData.otherDeductions) || 0,
        });
    };

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(600)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<CreditCard size={19} color="#fff" />}
                    title="Process Payroll"
                    subtitle={selectedEmp ? `${selectedEmp.first_name} ${selectedEmp.last_name} — pay run` : 'Pay run — PAYE auto-calculated'}
                    onClose={onClose}
                />
                <form id="process-payroll-form" onSubmit={handleSubmit} style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    {selectedEmp && (
                        <div style={{
                            padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                        }}>
                            <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                                <Users size={18} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: ink }}>{selectedEmp.first_name} {selectedEmp.last_name}</div>
                                <div style={{ fontSize: 11.5, color: inkSoft, fontWeight: 500 }}>
                                    Basic: <b style={{ color: teal[700], fontFamily: "'JetBrains Mono', monospace" }}>{formatCurrency(selectedEmp.basic_salary, currency)}</b>/month
                                </div>
                            </div>
                        </div>
                    )}

                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Employee <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                        <select
                            required
                            value={employeeId}
                            onChange={(e) => {
                                setEmployeeId(e.target.value);
                                const emp = employees.find(em => em.id === e.target.value);
                                if (emp) {
                                    setFormData({ ...formData, grossSalary: emp.basic_salary.toString() });
                                }
                            }}
                            style={selectStyle}
                        >
                            <option value="">Select Employee</option>
                            {employees.filter(e => e.status === 'active').map(emp => (
                                <option key={emp.id} value={emp.id}>
                                    {emp.first_name} {emp.last_name} - {formatCurrency(emp.basic_salary, currency)}/month
                                </option>
                            ))}
                        </select>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                            <label style={labelStyle}>Pay Period Start <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <input
                                type="date"
                                required
                                value={formData.payPeriodStart}
                                onChange={(e) => setFormData({ ...formData, payPeriodStart: e.target.value })}
                                style={inputStyle}
                            />
                        </div>
                        <div>
                            <label style={labelStyle}>Pay Period End <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <input
                                type="date"
                                required
                                value={formData.payPeriodEnd}
                                onChange={(e) => setFormData({ ...formData, payPeriodEnd: e.target.value })}
                                style={inputStyle}
                            />
                        </div>
                    </div>
                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Payment Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                        <input
                            type="date"
                            required
                            value={formData.paymentDate}
                            onChange={(e) => setFormData({ ...formData, paymentDate: e.target.value })}
                            style={inputStyle}
                        />
                    </div>
                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Gross Salary <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                        <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.grossSalary}
                                onChange={(e) => setFormData({ ...formData, grossSalary: e.target.value })}
                                placeholder="0.00"
                                style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                            />
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div>
                            <label style={labelStyle}>
                                Pension
                                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                            </label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={formData.pensionAmount}
                                    onChange={(e) => setFormData({ ...formData, pensionAmount: e.target.value })}
                                    placeholder="0.00"
                                    style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                />
                            </div>
                        </div>
                        <div>
                            <label style={labelStyle}>
                                Other Deductions
                                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                            </label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={formData.otherDeductions}
                                    onChange={(e) => setFormData({ ...formData, otherDeductions: e.target.value })}
                                    placeholder="0.00"
                                    style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                />
                            </div>
                        </div>
                    </div>
                    {selectedEmp && (
                        <div style={{
                            padding: 14, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                        }}>
                            <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[600] }}>
                                <DollarSign size={18} />
                            </div>
                            <div style={{ fontSize: 12, color: ink, fontWeight: 500 }}>PAYE will be auto-calculated based on annual tax brackets</div>
                        </div>
                    )}
                </form>
                <ModalFooter
                    stepLabel="Pay run · Dr Salary / Cr Bank"
                    onCancel={onClose}
                    submitLabel="Process Payroll"
                    submitFormId="process-payroll-form"
                />
            </div>
        </div>
    );
};

export default Payroll;
