/**
 * Fixed Asset Service
 * 
 * Phase 1: Core module for fixed asset management
 * Handles:
 * - Asset acquisition (posting to fixed asset accounts)
 * - Depreciation calculation and auto-posting (straight-line, declining balance)
 * - Asset disposal with gain/loss calculation
 * - Asset register maintenance
 */

import { dbService } from './db';
import { FixedAsset, DepreciationEntry, AssetDisposal, DepreciationMethod, FixedAssetStatus } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

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
    },
};

export default fixedAssetService;
