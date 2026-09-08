/**
 * Fixed Asset Service
 *
 * Phase 1: Core module for fixed asset management
 * Phase 2: Acquisition + capitalisation + lifecycle + dimensions
 * Phase 3: Depreciation (straight-line, declining-balance, sum-of-years,
 *          units-of-production, manual) with full schedule generation
 * Phase 4: Disposal, transfers, revaluation, impairment, maintenance,
 *          warranty, insurance, verification, reversal
 * Phase 5: Year-end reconciliation check + AI context builder
 *
 * Reuses ledgerService for all accounting impact (asset subledger never
 * duplicates accounting truth) and dbService for offline-first storage.
 */

import { dbService } from './db';
import { FixedAsset, DepreciationEntry, AssetDisposal, DepreciationMethod, FixedAssetStatus, AssetLifecycleStatus, AssetCondition, DisposalType, FixedAssetTransfer, FixedAssetRevaluation, FixedAssetImpairment, FixedAssetMaintenance, FixedAssetWarranty, FixedAssetInsurance, FixedAssetVerification } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';
import { validateDateInFY } from '../utils/financialYearUtils';
import { roundFinancial } from '../utils/helpers';

const STORE_NAME = 'fixedAssets';
const DEPRECIATION_ENTRY_STORE = 'depreciationEntries';
const ASSET_DISPOSAL_STORE = 'assetDisposals';

function getConfig() {
    return getGLConfig();
}

function getNextId(prefix: string, items: any[]): string {
    const existing = items.filter(i => String(i.id || '').startsWith(prefix));
    if (!existing || existing.length === 0) return `${prefix}-0001`;
    const max = existing.reduce((m, i) => {
        const num = parseInt(String(i.id || '').replace(prefix + '-', ''), 10);
        return isNaN(num) ? m : Math.max(m, num);
    }, 0);
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

export const fixedAssetService = {
    STORE_NAME,

    async getAll(): Promise<FixedAsset[]> {
        try {
            return await dbService.getAll<FixedAsset>(STORE_NAME);
        } catch (error) {
            logger.error('Failed to get fixed assets', error);
            return [];
        }
    },

    async getById(id: string): Promise<FixedAsset | null> {
        try {
            return await dbService.getById<FixedAsset>(STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get fixed asset ${id}`, error);
            return null;
        }
    },

    async create(asset: Omit<FixedAsset, 'id' | 'created_at' | 'updated_at'>, accounts: any[]): Promise<FixedAsset> {
        const config = getConfig();
        const allAssets = await this.getAll();
        const assetCode = getNextId('FA', allAssets);

        const fixedAsset: FixedAsset = {
            ...asset,
            id: assetCode,
            fixed_asset_account_id: resolveAccountForPosting(config.fixedAssetAccount, accounts) || config.fixedAssetAccount,
            accumulated_depreciation_account_id: resolveAccountForPosting(config.accumulatedDepreciationAccount, accounts) || config.accumulatedDepreciationAccount,
            depreciation_expense_account_id: resolveAccountForPosting(config.depreciationExpenseAccount, accounts) || config.depreciationExpenseAccount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        await dbService.put(STORE_NAME, fixedAsset);

        await this.postAcquisitionJournal(fixedAsset, accounts);

        return fixedAsset;
    },

    async update(id: string, updates: Partial<FixedAsset>): Promise<FixedAsset | null> {
        const existing = await this.getById(id);
        if (!existing) return null;

        const updated: FixedAsset = {
            ...existing,
            ...updates,
            id: existing.id,
            updated_at: new Date().toISOString(),
        };

        await dbService.put(STORE_NAME, updated);
        return updated;
    },

    async delete(id: string): Promise<boolean> {
        const asset = await this.getById(id);
        if (!asset) return false;
        if (asset.status !== 'active' && asset.status !== 'fully_depreciated') {
            throw new Error('Cannot delete asset that is not active or fully depreciated');
        }
        await dbService.delete(STORE_NAME, id);
        return true;
    },

    async postAcquisitionJournal(asset: FixedAsset, accounts: any[]): Promise<string | null> {
        const config = getConfig();
        const cashOrBankAccount = resolveAccountForPosting(config.bankAccount, accounts);
        
        if (!cashOrBankAccount) {
            logger.warn('Could not resolve cash/bank account for fixed asset acquisition');
            return null;
        }

        const description = `Fixed Asset Acquisition: ${asset.name} (${asset.asset_code})`;

        try {
            const entry = await ledgerService.createJournalEntry({
                date: asset.acquisition_date,
                description,
                reference: `FA-ACQ-${asset.asset_code}`,
                lines: [
                    {
                        debitAccountId: asset.fixed_asset_account_id,
                        creditAccountId: cashOrBankAccount,
                        amount: asset.acquisition_cost,
                        description: `Asset: ${asset.name}`,
                    }
                ],
                entryType: 'FA_ACQUISITION',
                createdBy: asset.created_by,
            });
            return entry?.id || null;
        } catch (error) {
            logger.error('Failed to post acquisition journal', error);
            return null;
        }
    },

    calculateDepreciation(asset: FixedAsset, periodYear: number, periodMonth: number): { depreciation: number; accumulated: number; bookValue: number } {
        const cost = asset.acquisition_cost;
        const salvage = asset.salvage_value;
        const usefulLife = asset.useful_life_years;
        const depreciableAmount = cost - salvage;

        let annualDepreciation: number;
        let currentAccumulated: number;

        switch (asset.depreciation_method) {
            case 'straight_line':
                annualDepreciation = depreciableAmount / usefulLife;
                break;
            case 'declining_balance':
                const rate = asset.depreciation_rate || (1 / usefulLife * 2);
                annualDepreciation = cost * rate;
                break;
            case 'sum_of_years':
                const sumOfYears = (usefulLife * (usefulLife + 1)) / 2;
                const remainingLife = usefulLife - this.getAssetAgeInYears(asset);
                annualDepreciation = (depreciableAmount * remainingLife) / sumOfYears;
                break;
            default:
                annualDepreciation = depreciableAmount / usefulLife;
        }

        currentAccumulated = this.getAccumulatedDepreciation(asset);

        const monthsInYear = 12;
        const monthlyDepreciation = annualDepreciation / monthsInYear;

        const periodDepreciation = Math.min(
            monthlyDepreciation,
            depreciableAmount - currentAccumulated,
            Math.max(0, depreciableAmount - currentAccumulated - monthlyDepreciation * (periodMonth - 1))
        );

        const accumulatedAfter = currentAccumulated + periodDepreciation;
        const bookValue = cost - accumulatedAfter;

        return {
            depreciation: Math.round(periodDepreciation * 100) / 100,
            accumulated: Math.round(accumulatedAfter * 100) / 100,
            bookValue: Math.round(bookValue * 100) / 100,
        };
    },

    getAssetAgeInYears(asset: FixedAsset): number {
        const acquisitionDate = new Date(asset.acquisition_date);
        const now = new Date();
        const years = (now.getTime() - acquisitionDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        return Math.max(0, years);
    },

    async getAccumulatedDepreciation(asset: FixedAsset): Promise<number> {
        try {
            const entries = await dbService.getAll<DepreciationEntry>(DEPRECIATION_ENTRY_STORE);
            return entries
                .filter(e => e.fixed_asset_id === asset.id)
                .reduce((sum, e) => sum + e.depreciation_amount, 0);
        } catch {
            return 0;
        }
    },

    async postDepreciation(asset: FixedAsset, periodYear: number, periodMonth: number, accounts: any[]): Promise<DepreciationEntry | null> {
        const config = getConfig();
        
        if (asset.status === 'disposed') {
            logger.warn(`Asset ${asset.id} is disposed, skipping depreciation`);
            return null;
        }

        const existingEntries = await dbService.getAll<DepreciationEntry>(DEPRECIATION_ENTRY_STORE);
        const alreadyPosted = existingEntries.some(
            e => e.fixed_asset_id === asset.id && e.period_year === periodYear && e.period_month === periodMonth
        );

        if (alreadyPosted) {
            logger.info(`Depreciation already posted for asset ${asset.id} for ${periodYear}-${periodMonth}`);
            return null;
        }

        const { depreciation, accumulated, bookValue } = this.calculateDepreciation(asset, periodYear, periodMonth);

        if (depreciation <= 0) {
            logger.info(`No depreciation to post for asset ${asset.id}`);
            return null;
        }

        const description = `Depreciation: ${asset.name} (${asset.asset_code}) - ${periodYear}-${String(periodMonth).padStart(2, '0')}`;

        try {
            const entry = await ledgerService.createJournalEntry({
                date: new Date(periodYear, periodMonth - 1, 1).toISOString(),
                description,
                reference: `FA-DEP-${asset.asset_code}-${periodYear}${String(periodMonth).padStart(2, '0')}`,
                lines: [
                    {
                        debitAccountId: asset.depreciation_expense_account_id,
                        creditAccountId: asset.accumulated_depreciation_account_id,
                        amount: depreciation,
                        description: `Depreciation for ${periodYear}-${periodMonth}`,
                    }
                ],
                entryType: 'FA_DEPRECIATION',
            });

            const depreciationEntry: DepreciationEntry = {
                id: generateId('DEP'),
                fixed_asset_id: asset.id,
                period_year: periodYear,
                period_month: periodMonth,
                depreciation_amount: depreciation,
                accumulated_depreciation: accumulated,
                book_value: bookValue,
                journal_entry_id: entry?.id,
                created_at: new Date().toISOString(),
            };

            await dbService.put(DEPRECIATION_ENTRY_STORE, depreciationEntry);

            if (bookValue <= asset.salvage_value) {
                await this.update(asset.id, { status: 'fully_depreciated' });
            }

            return depreciationEntry;
        } catch (error) {
            logger.error('Failed to post depreciation journal', error);
            return null;
        }
    },

    async postMonthlyDepreciationForAllAssets(periodYear: number, periodMonth: number, accounts: any[]): Promise<DepreciationEntry[]> {
        const assets = await this.getAll();
        const results: DepreciationEntry[] = [];

        for (const asset of assets) {
            if (asset.status !== 'active') continue;
            
            const result = await this.postDepreciation(asset, periodYear, periodMonth, accounts);
            if (result) results.push(result);
        }

        return results;
    },

    async disposeAsset(
        assetId: string,
        disposalDate: string,
        proceeds: number,
        reason: string,
        accounts: any[]
    ): Promise<AssetDisposal | null> {
        const asset = await this.getById(assetId);
        if (!asset) return null;

        if (asset.status === 'disposed') {
            throw new Error('Asset already disposed');
        }

        const config = getConfig();
        const accumulatedDep = await this.getAccumulatedDepreciation(asset);
        const originalCost = asset.acquisition_cost;
        const gainLoss = proceeds - (originalCost - accumulatedDep);

        const description = `Disposal of Fixed Asset: ${asset.name} (${asset.asset_code})`;

        try {
            const lines: any[] = [
                {
                    debitAccountId: asset.accumulated_depreciation_account_id,
                    creditAccountId: asset.fixed_asset_account_id,
                    amount: accumulatedDep,
                    description: 'Remove accumulated depreciation',
                }
            ];

            if (proceeds > 0) {
                lines.push({
                    debitAccountId: resolveAccountForPosting(config.bankAccount, accounts),
                    creditAccountId: asset.fixed_asset_account_id,
                    amount: Math.min(proceeds, originalCost - accumulatedDep),
                    description: 'Proceeds from disposal',
                });
            }

            if (gainLoss !== 0) {
                const gainLossAccount = gainLoss > 0
                    ? resolveAccountForPosting(config.otherIncomeAccount, accounts)
                    : resolveAccountForPosting(config.depreciationExpenseAccount, accounts);
                
                if (gainLoss > 0) {
                    lines.push({
                        debitAccountId: asset.fixed_asset_account_id,
                        creditAccountId: gainLossAccount,
                        amount: Math.abs(gainLoss),
                        description: gainLoss > 0 ? `Gain on disposal` : `Loss on disposal`,
                    });
                } else {
                    lines.push({
                        debitAccountId: gainLossAccount,
                        creditAccountId: asset.fixed_asset_account_id,
                        amount: Math.abs(gainLoss),
                        description: `Loss on disposal`,
                    });
                }
            }

            const entry = await ledgerService.createJournalEntry({
                date: disposalDate,
                description,
                reference: `FA-DISP-${asset.asset_code}`,
                lines,
                entryType: 'FA_DISPOSAL',
            });

            const disposal: AssetDisposal = {
                id: generateId('DISP'),
                fixed_asset_id: assetId,
                disposal_date: disposalDate,
                disposal_proceeds: proceeds,
                original_cost: originalCost,
                accumulated_depreciation: accumulatedDep,
                gain_loss: gainLoss,
                reason,
                journal_entry_id: entry?.id,
                created_at: new Date().toISOString(),
            };

            await dbService.put(ASSET_DISPOSAL_STORE, disposal);
            await this.update(assetId, {
                status: 'disposed',
                disposal_date: disposalDate,
                disposal_proceeds: proceeds,
                disposal_gain_loss: gainLoss,
            });

            return disposal;
        } catch (error) {
            logger.error('Failed to dispose asset', error);
            return null;
        }
    },

    async getDepreciationEntries(assetId: string): Promise<DepreciationEntry[]> {
        try {
            const all = await dbService.getAll<DepreciationEntry>(DEPRECIATION_ENTRY_STORE);
            return all.filter(e => e.fixed_asset_id === assetId);
        } catch {
            return [];
        }
    },

    async getDisposal(assetId: string): Promise<AssetDisposal | null> {
        try {
            const all = await dbService.getAll<AssetDisposal>(ASSET_DISPOSAL_STORE);
            return all.find(d => d.fixed_asset_id === assetId) || null;
        } catch {
            return null;
        }
    },

    async getAssetRegister(): Promise<(FixedAsset & { current_book_value: number; accumulated_depreciation: number })[]> {
        const assets = await this.getAll();
        const results = [];

        for (const asset of assets) {
            const accumulated = await this.getAccumulatedDepreciation(asset);
            const currentBookValue = asset.acquisition_cost - accumulated;
            results.push({
                ...asset,
                accumulated_depreciation: accumulated,
                current_book_value: Math.round(currentBookValue * 100) / 100,
            });
        }

        return results;
    },

    async initializeStores(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { /* store may exist */ }
        try {
            await dbService.createObjectStore(DEPRECIATION_ENTRY_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
        try {
            await dbService.createObjectStore(ASSET_DISPOSAL_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
        for (const s of ['fixedAssetLocations', 'fixedAssetCustodians', 'fixedAssetTransfers', 'fixedAssetRevaluations', 'fixedAssetImpairments', 'fixedAssetMaintenance', 'fixedAssetWarranty', 'fixedAssetInsurance', 'fixedAssetVerification', 'fixedAssetReversals']) {
            try { await dbService.createObjectStore(s, { keyPath: 'id' }); } catch { /* may exist */ }
        }
    },

    // ====================================================================
    //   PHASE 2: Capitalisation
    // ====================================================================

    /**
     * Capitalise an asset. Sets lifecycle to Capitalised, sets depreciation
     * start date, and posts the capitalisation entry (Dr Fixed Asset /
     * Cr Asset Clearing). The acquisition journal should already be posted.
     */
    async capitalise(assetId: string, params: { depreciation_start_date: string; capitalised_cost?: number; notes?: string }, accounts: any[], createdBy?: string): Promise<FixedAsset | null> {
        const asset = await this.getById(assetId);
        if (!asset) throw new Error('Asset not found');
        if (!params.depreciation_start_date) throw new Error('Depreciation start date is required');
        const fyErr = validateDateInFY(params.depreciation_start_date);
        if (fyErr) throw new Error(fyErr);
        const config = getConfig();
        const clearing = resolveAccountForPosting(config.bankAccount, accounts) || config.bankAccount;
        const updated = await this.update(assetId, {
            lifecycle_status: 'Capitalised' as AssetLifecycleStatus,
            capitalised_at: new Date().toISOString(),
            depreciation_start_date: params.depreciation_start_date,
            depreciation_frequency: (asset as any).depreciation_frequency || 'Monthly',
            depreciation_convention: (asset as any).depreciation_convention || 'FullMonth',
            acquisition_cost: params.capitalised_cost ?? asset.acquisition_cost,
            status: 'active',
        } as any);
        // Audit + accounting config: post a memo journal noting capitalisation
        try {
            await ledgerService.createJournalEntry({
                date: params.depreciation_start_date,
                description: `Capitalisation of ${asset.name} (${asset.asset_code})`,
                reference: `FA-CAP-${asset.asset_code}`,
                lines: [{
                    debitAccountId: asset.fixed_asset_account_id,
                    creditAccountId: clearing,
                    amount: roundFinancial(params.capitalised_cost ?? asset.acquisition_cost),
                    description: `Capitalise ${asset.name}`,
                }],
                entryType: 'FA_CAPITALISATION',
                createdBy,
            });
        } catch (err) { logger.warn('[FA] capitalisation memo journal failed', err); }
        return updated;
    },

    // ====================================================================
    //   PHASE 7: Transfers
    // ====================================================================

    async recordTransfer(transfer: Omit<FixedAssetTransfer, 'id' | 'created_at'>): Promise<FixedAssetTransfer> {
        const t: FixedAssetTransfer = { ...transfer, id: generateId('TRF'), created_at: new Date().toISOString() };
        await dbService.put('fixedAssetTransfers', t);
        await this.update(transfer.fixed_asset_id, {
            location_id: transfer.to_location_id,
            custodian_id: transfer.to_custodian_id,
            department: transfer.to_department,
            cost_centre: transfer.to_cost_centre,
        } as any);
        return t;
    },

    async getTransfers(assetId: string): Promise<FixedAssetTransfer[]> {
        const all = await dbService.getAll<FixedAssetTransfer>('fixedAssetTransfers');
        return all.filter((t) => t.fixed_asset_id === assetId).sort((a, b) => b.transfer_date.localeCompare(a.transfer_date));
    },

    async getAllTransfers(): Promise<FixedAssetTransfer[]> {
        return (await dbService.getAll<FixedAssetTransfer>('fixedAssetTransfers')).sort((a, b) => b.transfer_date.localeCompare(a.transfer_date));
    },

    // ====================================================================
    //   PHASE 8: Disposal + Write-Off (full workflow)
    // ====================================================================

    async disposeAssetV2(
        assetId: string,
        params: { disposal_date: string; proceeds: number; reason: string; disposal_type: DisposalType; buyer?: string; reference?: string; attachment_ref?: string; write_off_only?: boolean },
        accounts: any[],
        createdBy?: string,
    ): Promise<AssetDisposal | null> {
        const asset = await this.getById(assetId);
        if (!asset) throw new Error('Asset not found');
        if ((asset as any).status === 'disposed') throw new Error('Asset already disposed');
        if (params.disposal_date < asset.acquisition_date) throw new Error('Disposal date cannot be before acquisition date');
        const fyErr = validateDateInFY(params.disposal_date);
        if (fyErr) throw new Error(fyErr);

        const config = getConfig();
        const accumulatedDep = await this.getAccumulatedDepreciation(asset);
        const originalCost = asset.acquisition_cost;
        const nbv = originalCost - accumulatedDep;
        const gainLoss = roundFinancial(params.proceeds - nbv);

        const gainAcct = asset.gain_on_disposal_account_id || resolveAccountForPosting(config.gainOnDisposalAccount, accounts) || config.otherIncomeAccount;
        const lossAcct = asset.loss_on_disposal_account_id || resolveAccountForPosting(config.lossOnDisposalAccount, accounts) || config.otherExpensesAccount;
        const bankAcct = resolveAccountForPosting(config.bankAccount, accounts) || config.bankAccount;

        const lines: any[] = [
            // Remove accumulated depreciation
            {
                debitAccountId: asset.accumulated_depreciation_account_id,
                creditAccountId: asset.fixed_asset_account_id,
                amount: roundFinancial(accumulatedDep),
                description: 'Remove accumulated depreciation',
            },
        ];

        if (params.proceeds > 0 && !params.write_off_only) {
            lines.push({
                debitAccountId: bankAcct,
                creditAccountId: asset.fixed_asset_account_id,
                amount: roundFinancial(params.proceeds),
                description: `Proceeds (${params.disposal_type})`,
            });
        }

        if (gainLoss > 0) {
            // Gain: Cr gain account
            lines.push({
                debitAccountId: asset.fixed_asset_account_id,
                creditAccountId: gainAcct,
                amount: roundFinancial(gainLoss),
                description: 'Gain on disposal',
            });
        } else if (gainLoss < 0) {
            // Loss: Dr loss account
            lines.push({
                debitAccountId: lossAcct,
                creditAccountId: asset.fixed_asset_account_id,
                amount: roundFinancial(Math.abs(gainLoss)),
                description: 'Loss on disposal',
            });
        }

        const description = `${params.disposal_type} of Fixed Asset: ${asset.name} (${asset.asset_code})`;
        const entry = await ledgerService.createJournalEntry({
            date: params.disposal_date,
            description,
            reference: `FA-${params.disposal_type.toUpperCase()}-${asset.asset_code}`,
            lines,
            entryType: params.write_off_only ? 'FA_WRITEOFF' : 'FA_DISPOSAL',
            createdBy,
        });

        const disposal: AssetDisposal = {
            id: generateId('DISP'),
            fixed_asset_id: assetId,
            disposal_date: params.disposal_date,
            disposal_proceeds: params.proceeds,
            original_cost: originalCost,
            accumulated_depreciation: roundFinancial(accumulatedDep),
            gain_loss: gainLoss,
            journal_entry_id: entry?.id,
            reason: `${params.disposal_type}: ${params.reason}${params.buyer ? ` (Buyer: ${params.buyer})` : ''}`,
            created_at: new Date().toISOString(),
        };
        await dbService.put(ASSET_DISPOSAL_STORE, disposal);
        await this.update(assetId, {
            status: params.write_off_only ? 'disposed' : 'disposed',
            disposal_date: params.disposal_date,
            disposal_proceeds: params.proceeds,
            disposal_gain_loss: gainLoss,
            lifecycle_status: params.write_off_only ? 'WrittenOff' as AssetLifecycleStatus : 'Disposed' as AssetLifecycleStatus,
        } as any);
        return disposal;
    },

    // ====================================================================
    //   PHASE 9: Revaluation + Impairment
    // ====================================================================

    async revalue(assetId: string, params: { revaluation_date: string; new_carrying_value: number; reason: string; valuation_method?: string; supporting_document_ref?: string }, accounts: any[], createdBy?: string): Promise<FixedAssetRevaluation | null> {
        const asset = await this.getById(assetId);
        if (!asset) throw new Error('Asset not found');
        const accumulated = await this.getAccumulatedDepreciation(asset);
        const oldCarrying = roundFinancial(asset.acquisition_cost - accumulated);
        const newCarrying = roundFinancial(params.new_carrying_value);
        if (newCarrying < 0) throw new Error('New carrying value cannot be negative');
        const delta = roundFinancial(newCarrying - oldCarrying);
        if (delta === 0) throw new Error('New value equals current carrying value');

        const fyErr = validateDateInFY(params.revaluation_date);
        if (fyErr) throw new Error(fyErr);

        const config = getConfig();
        const reserveAcct = asset.revaluation_reserve_account_id || resolveAccountForPosting(config.revaluationReserveAccount, accounts) || '32010';
        const fixedAssetAcct = asset.fixed_asset_account_id;

        // Revaluation journal: Dr Fixed Asset / Cr Revaluation Reserve (upward)
        //                       Dr Revaluation Reserve / Cr Fixed Asset (downward)
        const lines = delta > 0
          ? [{ debitAccountId: fixedAssetAcct, creditAccountId: reserveAcct, amount: Math.abs(delta), description: 'Upward revaluation' }]
          : [{ debitAccountId: reserveAcct, creditAccountId: fixedAssetAcct, amount: Math.abs(delta), description: 'Downward revaluation' }];

        const entry = await ledgerService.createJournalEntry({
            date: params.revaluation_date,
            description: `Revaluation of ${asset.name} (${asset.asset_code})`,
            reference: `FA-REV-${asset.asset_code}-${Date.now()}`,
            lines,
            entryType: 'FA_REVALUATION',
            createdBy,
        });

        // Update asset cost to reflect new carrying value (preserving accumulated)
        await this.update(assetId, { acquisition_cost: roundFinancial(asset.acquisition_cost + delta) } as any);

        const rev: FixedAssetRevaluation = {
            id: generateId('REV'),
            fixed_asset_id: assetId,
            revaluation_date: params.revaluation_date,
            old_carrying_value: oldCarrying,
            new_carrying_value: newCarrying,
            revaluation_amount: delta,
            reason: params.reason,
            valuation_method: params.valuation_method,
            supporting_document_ref: params.supporting_document_ref,
            journal_entry_id: entry?.id,
            created_at: new Date().toISOString(),
            created_by: createdBy,
        };
        await dbService.put('fixedAssetRevaluations', rev);
        return rev;
    },

    async impair(assetId: string, params: { impairment_date: string; recoverable_amount: number; reason: string; supporting_document_ref?: string }, accounts: any[], createdBy?: string): Promise<FixedAssetImpairment | null> {
        const asset = await this.getById(assetId);
        if (!asset) throw new Error('Asset not found');
        const accumulated = await this.getAccumulatedDepreciation(asset);
        const carrying = roundFinancial(asset.acquisition_cost - accumulated);
        const recoverable = roundFinancial(params.recoverable_amount);
        const impairment = roundFinancial(carrying - recoverable);
        if (impairment <= 0) throw new Error('Recoverable amount must be less than carrying amount');
        const fyErr = validateDateInFY(params.impairment_date);
        if (fyErr) throw new Error(fyErr);

        const config = getConfig();
        const expenseAcct = asset.impairment_expense_account_id || resolveAccountForPosting(config.impairmentExpenseAccount, accounts) || '53100';
        const accumAcct = asset.accumulated_impairment_account_id || resolveAccountForPosting(config.accumulatedImpairmentAccount, accounts) || '12510';

        const entry = await ledgerService.createJournalEntry({
            date: params.impairment_date,
            description: `Impairment of ${asset.name} (${asset.asset_code})`,
            reference: `FA-IMP-${asset.asset_code}-${Date.now()}`,
            lines: [{ debitAccountId: expenseAcct, creditAccountId: accumAcct, amount: impairment, description: 'Impairment loss' }],
            entryType: 'FA_IMPAIRMENT',
            createdBy,
        });

        const imp: FixedAssetImpairment = {
            id: generateId('IMP'),
            fixed_asset_id: assetId,
            impairment_date: params.impairment_date,
            carrying_amount: carrying,
            recoverable_amount: recoverable,
            impairment_amount: impairment,
            reason: params.reason,
            supporting_document_ref: params.supporting_document_ref,
            journal_entry_id: entry?.id,
            created_at: new Date().toISOString(),
            created_by: createdBy,
        };
        await dbService.put('fixedAssetImpairments', imp);
        return imp;
    },

    async reverseImpairment(impairmentId: string, reversalDate: string, accounts: any[], createdBy?: string): Promise<FixedAssetImpairment | null> {
        const all = await dbService.getAll<FixedAssetImpairment>('fixedAssetImpairments');
        const orig = all.find((x) => x.id === impairmentId);
        if (!orig) throw new Error('Impairment not found');
        if (orig.is_reversal) throw new Error('Cannot reverse a reversal');
        const fyErr = validateDateInFY(reversalDate);
        if (fyErr) throw new Error(fyErr);
        const config = getConfig();
        const asset = await this.getById(orig.fixed_asset_id);
        const expenseAcct = asset?.impairment_expense_account_id || resolveAccountForPosting(config.impairmentExpenseAccount, accounts) || '53100';
        const accumAcct = asset?.accumulated_impairment_account_id || resolveAccountForPosting(config.accumulatedImpairmentAccount, accounts) || '12510';

        const entry = await ledgerService.createJournalEntry({
            date: reversalDate,
            description: `Reversal of impairment ${orig.id}`,
            reference: `FA-IMP-REV-${orig.id}`,
            lines: [{ debitAccountId: accumAcct, creditAccountId: expenseAcct, amount: orig.impairment_amount, description: 'Reversal of impairment' }],
            entryType: 'FA_IMPAIRMENT_REVERSAL',
            createdBy,
        });

        const rev: FixedAssetImpairment = {
            id: generateId('IMP-REV'),
            fixed_asset_id: orig.fixed_asset_id,
            impairment_date: reversalDate,
            carrying_amount: orig.carrying_amount,
            recoverable_amount: orig.carrying_amount,
            impairment_amount: orig.impairment_amount,
            reason: `Reversal of ${orig.id}`,
            journal_entry_id: entry?.id,
            is_reversal: true,
            reverses_id: orig.id,
            created_at: new Date().toISOString(),
            created_by: createdBy,
        };
        await dbService.put('fixedAssetImpairments', rev);
        return rev;
    },

    // ====================================================================
    //   PHASE 10: Maintenance, Warranty, Insurance
    // ====================================================================

    async recordMaintenance(assetId: string, params: Omit<FixedAssetMaintenance, 'id' | 'fixed_asset_id' | 'created_at' | 'created_by'> & { created_by?: string }): Promise<FixedAssetMaintenance> {
        const m: FixedAssetMaintenance = {
            ...params,
            id: generateId('MNT'),
            fixed_asset_id: assetId,
            created_at: new Date().toISOString(),
            created_by: params.created_by,
        };
        await dbService.put('fixedAssetMaintenance', m);
        return m;
    },

    async getMaintenance(assetId: string): Promise<FixedAssetMaintenance[]> {
        const all = await dbService.getAll<FixedAssetMaintenance>('fixedAssetMaintenance');
        return all.filter((m) => m.fixed_asset_id === assetId).sort((a, b) => b.maintenance_date.localeCompare(a.maintenance_date));
    },

    async setWarranty(assetId: string, params: Omit<FixedAssetWarranty, 'id' | 'fixed_asset_id' | 'created_at'>): Promise<FixedAssetWarranty> {
        const w: FixedAssetWarranty = { ...params, id: generateId('WAR'), fixed_asset_id: assetId, created_at: new Date().toISOString() };
        await dbService.put('fixedAssetWarranty', w);
        return w;
    },

    async getWarranty(assetId: string): Promise<FixedAssetWarranty[]> {
        const all = await dbService.getAll<FixedAssetWarranty>('fixedAssetWarranty');
        return all.filter((w) => w.fixed_asset_id === assetId);
    },

    async setInsurance(assetId: string, params: Omit<FixedAssetInsurance, 'id' | 'fixed_asset_id' | 'created_at'>): Promise<FixedAssetInsurance> {
        const i: FixedAssetInsurance = { ...params, id: generateId('INS'), fixed_asset_id: assetId, created_at: new Date().toISOString() };
        await dbService.put('fixedAssetInsurance', i);
        return i;
    },

    async getInsurance(assetId: string): Promise<FixedAssetInsurance[]> {
        const all = await dbService.getAll<FixedAssetInsurance>('fixedAssetInsurance');
        return all.filter((i) => i.fixed_asset_id === assetId);
    },

    // ====================================================================
    //   PHASE 11: Physical Verification
    // ====================================================================

    async recordVerification(assetId: string, params: Omit<FixedAssetVerification, 'id' | 'fixed_asset_id' | 'created_at'>): Promise<FixedAssetVerification> {
        const v: FixedAssetVerification = { ...params, id: generateId('VRF'), fixed_asset_id: assetId, created_at: new Date().toISOString() };
        await dbService.put('fixedAssetVerification', v);
        await this.update(assetId, { last_verification_id: v.id, last_verification_date: v.verification_date } as any);
        return v;
    },

    async getVerifications(assetId: string): Promise<FixedAssetVerification[]> {
        const all = await dbService.getAll<FixedAssetVerification>('fixedAssetVerification');
        return all.filter((v) => v.fixed_asset_id === assetId).sort((a, b) => b.verification_date.localeCompare(a.verification_date));
    },

    // ====================================================================
    //   PHASE 4: Full depreciation schedule
    // ====================================================================

    /**
     * Generate the full multi-period schedule for an asset, applying the
     * partial-period convention and stopping at salvage value. The schedule
     * is deterministic and reproducible.
     */
    generateSchedule(asset: FixedAsset, opts?: { upToYear?: number; upToMonth?: number }): Array<{ period: string; openingNbv: number; depreciation: number; accumulated: number; closingNbv: number }> {
        const cost = roundFinancial(asset.acquisition_cost);
        const salvage = roundFinancial(asset.salvage_value || 0);
        const life = asset.useful_life_years;
        const method = asset.depreciation_method || 'straight_line';
        const frequency = (asset as any).depreciation_frequency || 'Monthly';
        const convention = (asset as any).depreciation_convention || 'FullMonth';
        const start = new Date(asset.depreciation_start_date || asset.acquisition_date);
        const periodsPerYear = frequency === 'Annually' ? 1 : frequency === 'Quarterly' ? 4 : 12;
        const periodMonths = 12 / periodsPerYear;
        const totalPeriods = Math.ceil(life * periodsPerYear);
        const startPeriod = start.getFullYear() * periodsPerYear + Math.floor(start.getMonth() / periodMonths);
        const upTo = opts?.upToYear && opts?.upToMonth
          ? (opts.upToYear * periodsPerYear + Math.floor((opts.upToMonth - 1) / periodMonths))
          : Infinity;

        const rows: Array<{ period: string; openingNbv: number; depreciation: number; accumulated: number; closingNbv: number }> = [];
        let accumulated = 0;

        for (let i = 0; i < totalPeriods; i++) {
          const periodIndex = startPeriod + i;
          if (periodIndex > upTo) break;
          const periodYear = Math.floor(periodIndex / periodsPerYear);
          const periodMonth = (Math.floor(periodIndex % periodsPerYear) * periodMonths) + 1;
          const openingNbv = roundFinancial(cost - accumulated);
          let periodDep = 0;
          if (method === 'straight_line') {
            periodDep = roundFinancial((cost - salvage) / totalPeriods);
          } else if (method === 'declining_balance') {
            const rate = asset.depreciation_rate || (1 / life * 2);
            periodDep = roundFinancial(openingNbv * rate / periodsPerYear);
          } else if (method === 'sum_of_years') {
            const n = totalPeriods;
            const remaining = n - i;
            const sy = (n * (n + 1)) / 2;
            periodDep = roundFinancial((cost - salvage) * remaining / sy);
          } else if (method === 'units_of_production') {
            const upPer = (asset as any).units_per_period || 0;
            const upTotal = (asset as any).units_total || 1;
            periodDep = roundFinancial((cost - salvage) * upPer / upTotal);
          } else {
            periodDep = roundFinancial((cost - salvage) / totalPeriods);
          }
          // First-period proration under ProRataDaily / MonthAfterAcquisition
          if (i === 0) {
            if (convention === 'ProRataDaily') {
              const dayOfMonth = start.getDate();
              const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
              periodDep = roundFinancial(periodDep * (daysInMonth - dayOfMonth + 1) / daysInMonth);
            } else if (convention === 'MonthAfterAcquisition') {
              periodDep = 0;
            } else if (convention === 'MonthOfAcquisition' && start.getDate() > 1) {
              const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
              periodDep = roundFinancial(periodDep * (daysInMonth - start.getDate() + 1) / daysInMonth);
            }
          }
          // Cap to remaining depreciable amount
          const remainingDepreciable = roundFinancial((cost - salvage) - accumulated);
          periodDep = Math.max(0, Math.min(periodDep, remainingDepreciable));

          const newAccumulated = roundFinancial(accumulated + periodDep);
          const closingNbv = roundFinancial(cost - newAccumulated);

          rows.push({
            period: `${periodYear}-${String(periodMonth).padStart(2, '0')}`,
            openingNbv,
            depreciation: periodDep,
            accumulated: newAccumulated,
            closingNbv,
          });
          accumulated = newAccumulated;
          if (accumulated >= (cost - salvage)) break;
        }
        return rows;
    },

    // ====================================================================
    //   PHASE 5: Year-end reconciliation
    // ====================================================================

    async getYearEndReport(fiscalYear: number): Promise<{ issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; count?: number }>; summary: { totalAssets: number; depreciationPosted: boolean; pendingCapitalisation: number; unreconciled: number } }> {
        const assets = await this.getAll();
        const allDep = await dbService.getAll<DepreciationEntry>('depreciationEntries');
        const inFY = (d: string) => (d || '').startsWith(`${fiscalYear}-`);
        const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; count?: number }> = [];

        const fyDepPosted = allDep.some((e) => e.period_year === fiscalYear);
        if (!fyDepPosted && assets.some((a) => a.status === 'active' || a.status === 'fully_depreciated')) {
          issues.push({ severity: 'warning', message: `No depreciation has been posted for FY ${fiscalYear}.` });
        }
        const pendingCap = assets.filter((a) => (a as any).lifecycle_status === 'PendingCapitalisation' || (a as any).lifecycle_status === 'Acquired').length;
        if (pendingCap > 0) {
          issues.push({ severity: 'error', message: `${pendingCap} asset(s) pending capitalisation.`, count: pendingCap });
        }
        const fyDisposals = (await dbService.getAll<AssetDisposal>(ASSET_DISPOSAL_STORE)).filter((d) => inFY(d.disposal_date));
        if (fyDisposals.some((d) => !d.journal_entry_id)) {
          issues.push({ severity: 'error', message: `Some disposals in FY ${fiscalYear} are missing journal linkage.` });
        }
        const missingMapping = assets.filter((a) => !a.fixed_asset_account_id || !a.accumulated_depreciation_account_id || !a.depreciation_expense_account_id).length;
        if (missingMapping > 0) {
          issues.push({ severity: 'warning', message: `${missingMapping} asset(s) missing required GL account mapping.`, count: missingMapping });
        }
        return {
          issues,
          summary: {
            totalAssets: assets.length,
            depreciationPosted: fyDepPosted,
            pendingCapitalisation: pendingCap,
            unreconciled: missingMapping,
          },
        };
    },
};

export default fixedAssetService;
