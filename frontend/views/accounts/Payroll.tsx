import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Download, Users, DollarSign, Calendar, X,
    UserPlus, Trash2, Edit2, Eye, Loader2, TrendingUp, CreditCard
} from 'lucide-react';
import { payrollService } from '../../services/payrollService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { Employee, PayrollEntry } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const assets = '#1f8577';
const danger = '#dc2626';

const Payroll: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();

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

    return (
        <div className="flex flex-col h-full" style={{ background: paper }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div>
                    <h1 className="text-lg font-semibold" style={{ color: ink }}>Payroll</h1>
                    <p className="text-sm" style={{ color: inkSoft }}>Manage employees and process payroll</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={exportToCSV}
                        className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border transition-colors"
                        style={{ borderColor: hairline, color: ink }}
                    >
                        <Download size={16} />
                        Export
                    </button>
                    {canEdit && (
                        <>
                            <button
                                onClick={() => setIsAddEmployeeModalOpen(true)}
                                className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border transition-colors"
                                style={{ borderColor: hairline, color: ink }}
                            >
                                <UserPlus size={16} />
                                Add Employee
                            </button>
                            <button
                                onClick={() => setIsPayrollModalOpen(true)}
                                className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white transition-colors"
                                style={{ background: assets }}
                            >
                                <CreditCard size={16} />
                                Process Payroll
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-4 gap-4 px-6 py-4">
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <Users size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Employees</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: ink }}>{summary.employeeCount}</span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <DollarSign size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Gross (YTD)</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: ink }}>{formatCurrency(summary.totalGross)}</span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingUp size={16} style={{ color: danger }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total PAYE (YTD)</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: danger }}>{formatCurrency(summary.totalPAYE)}</span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <DollarSign size={16} style={{ color: assets }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Net (YTD)</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: assets }}>{formatCurrency(summary.totalNet)}</span>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b" style={{ borderColor: hairline }}>
                <div className="flex-1 relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search employees..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border outline-none"
                        style={{ borderColor: hairline }}
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="All">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="terminated">Terminated</option>
                </select>
            </div>

            {/* Employee Table */}
            <div className="flex-1 overflow-auto px-6 py-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin" style={{ color: assets }} />
                    </div>
                ) : filteredEmployees.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64" style={{ color: inkSoft }}>
                        <Users size={48} className="mb-4 opacity-50" />
                        <p>No employees found</p>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="text-left text-xs" style={{ color: inkSoft }}>
                                <th className="pb-3 font-medium">Employee</th>
                                <th className="pb-3 font-medium">Department</th>
                                <th className="pb-3 font-medium">Position</th>
                                <th className="pb-3 font-medium text-right">Basic Salary</th>
                                <th className="pb-3 font-medium">Status</th>
                                <th className="pb-3 font-medium text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredEmployees.map(emp => (
                                <tr key={emp.id} className="border-t" style={{ borderColor: hairline }}>
                                    <td className="py-3">
                                        <div>
                                            <p className="font-medium text-sm" style={{ color: ink }}>
                                                {emp.first_name} {emp.last_name}
                                            </p>
                                            <p className="text-xs" style={{ color: inkSoft }}>{emp.employee_number}</p>
                                        </div>
                                    </td>
                                    <td className="py-3 text-sm" style={{ color: ink }}>{emp.department}</td>
                                    <td className="py-3 text-sm" style={{ color: ink }}>{emp.position}</td>
                                    <td className="py-3 text-sm text-right font-mono" style={{ color: ink }}>
                                        {formatCurrency(emp.basic_salary)}
                                    </td>
                                    <td className="py-3">
                                        <span
                                            className="px-2 py-1 text-xs rounded-full"
                                            style={{
                                                background: emp.status === 'active' ? '#d1fae5' : emp.status === 'inactive' ? '#fef3c7' : '#fee2e2',
                                                color: emp.status === 'active' ? '#065f46' : emp.status === 'inactive' ? '#92400e' : '#991b1b'
                                            }}
                                        >
                                            {emp.status}
                                        </span>
                                    </td>
                                    <td className="py-3">
                                        <div className="flex items-center justify-center gap-2">
                                            {canEdit && (
                                                <>
                                                    <button
                                                        onClick={() => {
                                                            setSelectedEmployee(emp);
                                                            setIsPayrollModalOpen(true);
                                                        }}
                                                        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                                                        title="Process Payroll"
                                                    >
                                                        <CreditCard size={16} style={{ color: assets }} />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Add Employee Modal */}
            {isAddEmployeeModalOpen && (
                <AddEmployeeModal
                    onClose={() => setIsAddEmployeeModalOpen(false)}
                    onSubmit={handleAddEmployee}
                />
            )}

            {/* Process Payroll Modal */}
            {isPayrollModalOpen && (
                <ProcessPayrollModal
                    employees={employees}
                    selectedEmployee={selectedEmployee}
                    onClose={() => { setIsPayrollModalOpen(false); setSelectedEmployee(null); }}
                    onSubmit={handleProcessPayroll}
                />
            )}
        </div>
    );
};

interface AddEmployeeModalProps {
    onClose: () => void;
    onSubmit: (data: any) => void;
}

const AddEmployeeModal: React.FC<AddEmployeeModalProps> = ({ onClose, onSubmit }) => {
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-lg mx-4 shadow-xl max-h-[90vh] overflow-auto">
                <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Add Employee</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>First Name</label>
                            <input
                                type="text"
                                required
                                value={formData.first_name}
                                onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Last Name</label>
                            <input
                                type="text"
                                required
                                value={formData.last_name}
                                onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Email</label>
                            <input
                                type="email"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Phone</label>
                            <input
                                type="tel"
                                value={formData.phone}
                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Department</label>
                            <input
                                type="text"
                                required
                                value={formData.department}
                                onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Position</label>
                            <input
                                type="text"
                                required
                                value={formData.position}
                                onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Join Date</label>
                            <input
                                type="date"
                                required
                                value={formData.join_date}
                                onChange={(e) => setFormData({ ...formData, join_date: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Basic Salary</label>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.basic_salary}
                                onChange={(e) => setFormData({ ...formData, basic_salary: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Pay Frequency</label>
                        <select
                            value={formData.pay_frequency}
                            onChange={(e) => setFormData({ ...formData, pay_frequency: e.target.value as any })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        >
                            <option value="monthly">Monthly</option>
                            <option value="bi-weekly">Bi-Weekly</option>
                            <option value="weekly">Weekly</option>
                        </select>
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: assets }}>
                            Add Employee
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

interface ProcessPayrollModalProps {
    employees: Employee[];
    selectedEmployee: Employee | null;
    onClose: () => void;
    onSubmit: (data: any) => void;
}

const ProcessPayrollModal: React.FC<ProcessPayrollModalProps> = ({ employees, selectedEmployee, onClose, onSubmit }) => {
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Process Payroll</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Employee</label>
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
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        >
                            <option value="">Select Employee</option>
                            {employees.filter(e => e.status === 'active').map(emp => (
                                <option key={emp.id} value={emp.id}>
                                    {emp.first_name} {emp.last_name} - {formatCurrency(emp.basic_salary)}/month
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Pay Period Start</label>
                            <input
                                type="date"
                                required
                                value={formData.payPeriodStart}
                                onChange={(e) => setFormData({ ...formData, payPeriodStart: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Pay Period End</label>
                            <input
                                type="date"
                                required
                                value={formData.payPeriodEnd}
                                onChange={(e) => setFormData({ ...formData, payPeriodEnd: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Payment Date</label>
                        <input
                            type="date"
                            required
                            value={formData.paymentDate}
                            onChange={(e) => setFormData({ ...formData, paymentDate: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Gross Salary</label>
                        <input
                            type="number"
                            required
                            min="0"
                            step="0.01"
                            value={formData.grossSalary}
                            onChange={(e) => setFormData({ ...formData, grossSalary: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Pension (Optional)</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={formData.pensionAmount}
                                onChange={(e) => setFormData({ ...formData, pensionAmount: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Other Deductions</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={formData.otherDeductions}
                                onChange={(e) => setFormData({ ...formData, otherDeductions: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    {selectedEmp && (
                        <div className="p-3 rounded-lg text-xs" style={{ background: '#f3f4f6' }}>
                            <p style={{ color: ink }}>PAYE will be auto-calculated based on annual tax brackets</p>
                        </div>
                    )}
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: assets }}>
                            Process Payroll
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default Payroll;
