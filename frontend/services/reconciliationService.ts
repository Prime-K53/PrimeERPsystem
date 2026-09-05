/**
 * Reconciliation Service
 * 
 * Provides data integrity checks and automated reconciliation between modules
 */

import { dbService } from './db';
import { financialIntegrityService } from './financialIntegrityService';
import { accountResolutionService } from './accountResolutionService';
import { getGLConfig } from './transactions/_internal';

import {
  Discrepancy,
  ReconciliationResult,
  FinancialIntegrityIssue,
  FinancialIntegrityAuditResult
} from '../types';

class ReconciliationService {
  
  /**
   * Resolve AR account ID for reconciliation.
   * Supports both legacy codes and canonical account.id.
   */
  private async resolveARAccountId(): Promise<string[]> {
    const accounts = await dbService.getAll<any>('accounts');
     const arIds: string[] = ['11310', '11300']; // Default canonical AR posting accounts
     const gl = getGLConfig();
     
     // Try to resolve via account resolution service
     try {
       const arAccount = await accountResolutionService.resolveByRole('AR');
       if (arAccount) {
         arIds.push(arAccount.id);
       }
     } catch {
       // Fall back to canonical defaults
     }
     
     // Also include the configured AR account if different
     if (gl.accountsReceivable && gl.accountsReceivable !== '11310') {
      arIds.push(gl.accountsReceivable);
      // Resolve to actual account.id
      const configured = accounts.find(a => 
        a.id === gl.accountsReceivable || 
        a.code === gl.accountsReceivable || 
        a.account_number === gl.accountsReceivable
      );
      if (configured) {
        arIds.push(configured.id);
      }
    }
    
    return [...new Set(arIds)];
  }
  
  /**
   * Resolve AP account ID for reconciliation.
   * Supports both legacy codes and canonical account.id.
   */
  private async resolveAPAccountId(): Promise<string[]> {
    const accounts = await dbService.getAll<any>('accounts');
     const apIds: string[] = ['21110', '21100']; // Default canonical AP posting accounts
     const gl = getGLConfig();
     
     // Try to resolve via account resolution service
     try {
       const apAccount = await accountResolutionService.resolveByRole('AP');
       if (apAccount) {
         apIds.push(apAccount.id);
       }
     } catch {
       // Fall back to canonical defaults
     }
     
     // Also include the configured AP account if different
     if (gl.accountsPayable && gl.accountsPayable !== '21110') {
      apIds.push(gl.accountsPayable);
      // Resolve to actual account.id
      const configured = accounts.find(a => 
        a.id === gl.accountsPayable || 
        a.code === gl.accountsPayable || 
        a.account_number === gl.accountsPayable
      );
      if (configured) {
        apIds.push(configured.id);
      }
    }
    
    return [...new Set(apIds)];
  }
  
  async runFullReconciliation(): Promise<ReconciliationResult> {
    const discrepancies: Discrepancy[] = [];

    const customerDiscrepancies = await this.reconcileCustomerBalances();
    discrepancies.push(...customerDiscrepancies);

    const supplierDiscrepancies = await this.reconcileSupplierBalances();
    discrepancies.push(...supplierDiscrepancies);

    const orphanedEntries = await this.findOrphanedEntries();
    discrepancies.push(...orphanedEntries);

    const integrityAudit = await financialIntegrityService.runAudit();
    discrepancies.push(...integrityAudit.issues.map(issue => ({
      type:
        issue.type === 'invoice_payment_mismatch' ? 'invoice_payment' :
        issue.type === 'missing_bank_mirror' || issue.type === 'orphaned_bank_reference' ? 'bank_mirror' :
        issue.type === 'broken_examination_link' ? 'examination_link' :
        'ledger_gap',
      entityId: issue.entityId || issue.id,
      entityName: `${issue.entityType} ${issue.entityId || issue.id}`,
      expectedValue: 0,
      actualValue: 0,
      difference: 0,
      suggestedAction: issue.recommendedAction,
      severity: issue.severity
    })));

    return {
      success: discrepancies.length === 0,
      discrepancies,
      summary: {
        totalChecked: discrepancies.length,
        totalDiscrepancies: discrepancies.length
      }
    };
  }

  async reconcileCustomerBalances(): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = [];
    const [customers, ledger] = await Promise.all([
      dbService.getAll<any>('customers'),
      dbService.getAll<any>('ledger')
    ]);

    const arAccountIds = await this.resolveARAccountId();

    for (const customer of customers) {
      const customerEntries = ledger.filter(e => e.customerId === customer.id);
      let expectedBalance = 0;

      for (const entry of customerEntries) {
        if (arAccountIds.includes(entry.debitAccountId)) expectedBalance += entry.amount;
        if (arAccountIds.includes(entry.creditAccountId)) expectedBalance -= entry.amount;
      }

      const actualBalance = customer.balance || 0;
      const difference = expectedBalance - actualBalance;

      if (Math.abs(difference) > 0.01) {
        discrepancies.push({
          type: 'customer_balance',
          entityId: customer.id,
          entityName: customer.name,
          expectedValue: expectedBalance,
          actualValue: actualBalance,
          difference,
          suggestedAction: `Update balance to ${expectedBalance.toFixed(2)}`,
          severity: Math.abs(difference) > 100 ? 'high' : 'medium'
        });
      }
    }

    return discrepancies;
  }

  async reconcileSupplierBalances(): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = [];
    const [suppliers, ledger] = await Promise.all([
      dbService.getAll<any>('suppliers'),
      dbService.getAll<any>('ledger')
    ]);

    const apAccountIds = await this.resolveAPAccountId();

    for (const supplier of suppliers) {
      const supplierEntries = ledger.filter(e => e.supplierId === supplier.id);
      let expectedBalance = 0;

      for (const entry of supplierEntries) {
        if (apAccountIds.includes(entry.creditAccountId)) expectedBalance += entry.amount;
        if (apAccountIds.includes(entry.debitAccountId)) expectedBalance -= entry.amount;
      }

      const actualBalance = supplier.balance || 0;
      const difference = expectedBalance - actualBalance;

      if (Math.abs(difference) > 0.01) {
        discrepancies.push({
          type: 'supplier_balance',
          entityId: supplier.id,
          entityName: supplier.name,
          expectedValue: expectedBalance,
          actualValue: actualBalance,
          difference,
          suggestedAction: `Update balance to ${expectedBalance.toFixed(2)}`,
          severity: Math.abs(difference) > 100 ? 'high' : 'medium'
        });
      }
    }

    return discrepancies;
  }

  async findOrphanedEntries(): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = [];
    const [customers, suppliers, ledger] = await Promise.all([
      dbService.getAll<any>('customers'),
      dbService.getAll<any>('suppliers'),
      dbService.getAll<any>('ledger')
    ]);

    const customerIds = new Set(customers.map(c => c.id));
    const supplierIds = new Set(suppliers.map(s => s.id));

    for (const entry of ledger) {
      if (entry.customerId && !customerIds.has(entry.customerId)) {
        discrepancies.push({
          type: 'orphaned_entry',
          entityId: entry.id,
          entityName: `Ledger Entry ${entry.id}`,
          expectedValue: 0,
          actualValue: entry.amount,
          difference: entry.amount,
          suggestedAction: `Review orphaned ledger entry for missing customer ${entry.customerId}`,
          severity: 'low'
        });
      }

      if (entry.supplierId && !supplierIds.has(entry.supplierId)) {
        discrepancies.push({
          type: 'orphaned_entry',
          entityId: entry.id,
          entityName: `Ledger Entry ${entry.id}`,
          expectedValue: 0,
          actualValue: entry.amount,
          difference: entry.amount,
          suggestedAction: `Review orphaned ledger entry for missing supplier ${entry.supplierId}`,
          severity: 'low'
        });
      }
    }

    return discrepancies;
  }
}

export const reconciliationService = new ReconciliationService();
export default reconciliationService;
