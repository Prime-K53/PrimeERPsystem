
import { Item, User, Account, Warehouse, WorkCenter, ProductionResource, PermissionNode, UserGroup } from './types';

export const OFFLINE_MODE = false;

export const SEED_ITEM_IDS = [
  'RM-PAP-A4','RM-TON-HP','RM-PAP-GLS','RM-INK-CYA','RM-INK-MAG','RM-INK-YEL',
  'RM-INK-BLK','RM-BND-GLU','RM-BND-WIR','FG-BK-001','FG-FL-001','FG-BC-001',
];

export const SEED_ITEMS: Item[] = [
  { id: 'RM-PAP-A4', name: 'A4 Copy Paper (70gsm)', sku: 'PAP-A4-70', type: 'Raw Material', category: 'Paper', unit: 'Ream', cost: 3.50, price: 5.00, stock: 100, costPrice: 3.50, sellingPrice: 5.00, profitAmount: 1.50, profitMargin: 42.86, minimumMargin: 20, pricingValidated: true, minStockLevel: 20, reorderPoint: 30, status: 'Active', description: 'Standard 70gsm A4 copy paper for everyday printing' },
  { id: 'RM-TON-HP', name: 'HP LaserJet Toner Cartridge', sku: 'TON-HP-85A', type: 'Raw Material', category: 'Toner', unit: 'Piece', cost: 45.00, price: 65.00, stock: 10, costPrice: 45.00, sellingPrice: 65.00, profitAmount: 20.00, profitMargin: 44.44, minimumMargin: 20, pricingValidated: true, minStockLevel: 3, reorderPoint: 5, status: 'Active', description: 'HP 85A black toner cartridge' },
  { id: 'RM-PAP-GLS', name: 'A4 Glossy Photo Paper', sku: 'PAP-GLS-200', type: 'Raw Material', category: 'Paper', unit: 'Pack', cost: 8.00, price: 12.00, stock: 50, costPrice: 8.00, sellingPrice: 12.00, profitAmount: 4.00, profitMargin: 50.00, minimumMargin: 20, pricingValidated: true, minStockLevel: 10, reorderPoint: 15, status: 'Active', description: '200gsm A4 glossy photo paper for high-quality prints' },
  { id: 'RM-INK-CYA', name: 'Cyan Ink (CMYK)', sku: 'INK-CMY-1L', type: 'Raw Material', category: 'Ink', unit: 'Litre', cost: 12.00, price: 18.00, stock: 20, costPrice: 12.00, sellingPrice: 18.00, profitAmount: 6.00, profitMargin: 50.00, minimumMargin: 20, pricingValidated: true, minStockLevel: 5, reorderPoint: 8, status: 'Active', description: 'Cyan ink for offset/inkjet printing, 1 litre' },
  { id: 'RM-INK-MAG', name: 'Magenta Ink (CMYK)', sku: 'INK-CMM-1L', type: 'Raw Material', category: 'Ink', unit: 'Litre', cost: 12.00, price: 18.00, stock: 20, costPrice: 12.00, sellingPrice: 18.00, profitAmount: 6.00, profitMargin: 50.00, minimumMargin: 20, pricingValidated: true, minStockLevel: 5, reorderPoint: 8, status: 'Active', description: 'Magenta ink for offset/inkjet printing, 1 litre' },
  { id: 'RM-INK-YEL', name: 'Yellow Ink (CMYK)', sku: 'INK-CMY-1L', type: 'Raw Material', category: 'Ink', unit: 'Litre', cost: 12.00, price: 18.00, stock: 20, costPrice: 12.00, sellingPrice: 18.00, profitAmount: 6.00, profitMargin: 50.00, minimumMargin: 20, pricingValidated: true, minStockLevel: 5, reorderPoint: 8, status: 'Active', description: 'Yellow ink for offset/inkjet printing, 1 litre' },
  { id: 'RM-INK-BLK', name: 'Black Ink (CMYK)', sku: 'INK-CMB-1L', type: 'Raw Material', category: 'Ink', unit: 'Litre', cost: 10.00, price: 15.00, stock: 30, costPrice: 10.00, sellingPrice: 15.00, profitAmount: 5.00, profitMargin: 50.00, minimumMargin: 20, pricingValidated: true, minStockLevel: 8, reorderPoint: 12, status: 'Active', description: 'Black ink for offset/inkjet printing, 1 litre' },
  { id: 'RM-BND-GLU', name: 'Perfect Binding Glue', sku: 'BND-GLU-500', type: 'Raw Material', category: 'Binding', unit: 'Bottle', cost: 6.00, price: 9.50, stock: 15, costPrice: 6.00, sellingPrice: 9.50, profitAmount: 3.50, profitMargin: 58.33, minimumMargin: 20, pricingValidated: true, minStockLevel: 3, reorderPoint: 5, status: 'Active', description: '500ml perfect binding adhesive glue' },
  { id: 'RM-BND-WIR', name: 'Binding Wire / Coil', sku: 'BND-WIR-3:1', type: 'Raw Material', category: 'Binding', unit: 'Roll', cost: 14.00, price: 20.00, stock: 12, costPrice: 14.00, sellingPrice: 20.00, profitAmount: 6.00, profitMargin: 42.86, minimumMargin: 20, pricingValidated: true, minStockLevel: 3, reorderPoint: 5, status: 'Active', description: '3:1 pitch binding wire coil for spiral binding' },
  { id: 'FG-BK-001', name: 'Perfect Bound Book (A5, 200pp)', sku: 'FG-BK-A5-200', type: 'Product', category: 'Finished Goods', unit: 'Piece', cost: 2.80, price: 6.00, stock: 200, costPrice: 2.80, sellingPrice: 6.00, profitAmount: 3.20, profitMargin: 114.29, minimumMargin: 30, pricingValidated: true, minStockLevel: 50, reorderPoint: 80, status: 'Active', description: 'A5 perfect bound book, 200 pages, full colour cover' },
  { id: 'FG-FL-001', name: 'A5 Full Colour Flyer', sku: 'FG-FL-A5-4C', type: 'Product', category: 'Finished Goods', unit: 'Piece', cost: 0.35, price: 0.75, stock: 1000, costPrice: 0.35, sellingPrice: 0.75, profitAmount: 0.40, profitMargin: 114.29, minimumMargin: 30, pricingValidated: true, minStockLevel: 200, reorderPoint: 400, status: 'Active', description: 'A5 full colour flyer, 150gsm gloss, single sided' },
  { id: 'FG-BC-001', name: 'Saddle-Stitched Booklet (A4 folded)', sku: 'FG-BC-A4-ST', type: 'Product', category: 'Finished Goods', unit: 'Piece', cost: 1.20, price: 2.50, stock: 500, costPrice: 1.20, sellingPrice: 2.50, profitAmount: 1.30, profitMargin: 108.33, minimumMargin: 30, pricingValidated: true, minStockLevel: 100, reorderPoint: 200, status: 'Active', description: 'A4 folded to A5 saddle-stitched booklet, 8 pages' },
];

export const ACCOUNT_IDS = {
  // Canonical 5-digit codes (standard chart)
  CASH_DRAWER: '11110',
  BANK: '11210',
  MOBILE_MONEY: '11230',
  PETTY_CASH: '11120',
  CASH_IN_HAND: '11100',
  TRADE_DEBTORS: '11310',
  ACCOUNTS_RECEIVABLE: '11300',
  MERCHANDISE_INVENTORY: '11410',
  RAW_MATERIALS: '11420',
  FINISHED_GOODS: '11430',
  INVENTORY: '11400',
  ACCOUNTS_PAYABLE: '21110',
  TRADE_CREDITORS: '21110',
  VAT_PAYABLE: '21210',
  PAYE_PAYABLE: '21220',
  ACCRUED_EXPENSES: '21300',
  EQUITY: '30000',
  OWNER_CAPITAL: '31000',
  RETAINED_EARNINGS: '32000',
  CURRENT_YEAR_EARNINGS: '33000',
  DRAWINGS: '34000',
  PRODUCT_SALES: '41100',
  SERVICE_INCOME: '41200',
  INTEREST_INCOME: '42100',
  DISCOUNT_RECEIVED: '42200',
  OTHER_INCOME: '42000',
  COST_OF_GOODS_SOLD: '51200',
  PURCHASES: '51100',
  FREIGHT: '51300',
  SALARIES_WAGES: '52100',
  RENT: '52200',
  UTILITIES: '52300',
  INTERNET_TELEPHONE: '52400',
  ADVERTISING: '52500',
  TRANSPORT: '52600',
  REPAIRS: '52700',
  OFFICE_EXPENSES: '52800',
  BANK_CHARGES: '52900',
  DEPRECIATION: '53000',
  INTEREST_EXPENSE: '54100',
  MOTOR_VEHICLES: '12100',
  FURNITURE_FIXTURES: '12200',
  COMPUTERS_EQUIPMENT: '12300',
  BUILDINGS: '12400',
  ACCUMULATED_DEPRECIATION: '12500',
  FIXED_ASSETS: '12000',
  CURRENT_ASSETS: '11000',
  BANK_ACCOUNTS: '11200',
  OTHER_CURRENT_ASSETS: '11500',
  PREPAYMENTS: '11510',
  STAFF_ADVANCES: '11520',
  CURRENT_LIABILITIES: '21000',
  TAX_PAYABLE: '21200',
  LONG_TERM_LIABILITIES: '22000',
  BANK_LOANS: '22100',
  OTHER_LOANS: '22200'
};

export const DEFAULT_ACCOUNTS: Account[] = [
  // --- Assets (10000-19999) ---
  { id: '10000', code: '10000', account_number: '10000', name: 'Assets', account_type: 'ASSET', type: 'Asset', allow_posting: false, is_system_account: true },
  { id: '11000', code: '11000', account_number: '11000', name: 'Current Assets', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', allow_posting: false },
  { id: '11100', code: '11100', account_number: '11100', name: 'Cash in Hand', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', allow_posting: false, subtype: 'CASH' },
  { id: '11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11100', subtype: 'CASH', is_system_account: true },
  { id: '11120', code: '11120', account_number: '11120', name: 'Petty Cash', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11100', subtype: 'CASH', allow_posting: true },
  { id: '11200', code: '11200', account_number: '11200', name: 'Bank Accounts', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', allow_posting: false, subtype: 'BANK' },
  { id: '11210', code: '11210', account_number: '11210', name: 'National Bank', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11200', subtype: 'BANK', is_system_account: true },
  { id: '11220', code: '11220', account_number: '11220', name: 'FDH Bank', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11200', subtype: 'BANK' },
  { id: '11230', code: '11230', account_number: '11230', name: 'NBS Bank', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11200', subtype: 'BANK' },
  { id: '11300', code: '11300', account_number: '11300', name: 'Accounts Receivable', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'RECEIVABLE', is_system_account: true },
  { id: '11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11300', allow_posting: true, is_system_account: true },
  { id: '11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'INVENTORY', is_system_account: true },
  { id: '11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11400', allow_posting: true },
  { id: '11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11400', allow_posting: true },
  { id: '11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11400', allow_posting: true },
  { id: '11500', code: '11500', account_number: '11500', name: 'Other Current Assets', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', allow_posting: false },
  { id: '11510', code: '11510', account_number: '11510', name: 'Prepayments', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11500', allow_posting: true },
  { id: '11520', code: '11520', account_number: '11520', name: 'Staff Advances', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', parent_account_id: '11500', allow_posting: true },
  { id: '12000', code: '12000', account_number: '12000', name: 'Fixed Assets', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', allow_posting: false },
  { id: '12100', code: '12100', account_number: '12100', name: 'Motor Vehicles', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', parent_account_id: '12000' },
  { id: '12200', code: '12200', account_number: '12200', name: 'Furniture & Fixtures', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', parent_account_id: '12000' },
  { id: '12300', code: '12300', account_number: '12300', name: 'Computers & Equipment', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', parent_account_id: '12000' },
  { id: '12400', code: '12400', account_number: '12400', name: 'Buildings', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', parent_account_id: '12000' },
  { id: '12500', code: '12500', account_number: '12500', name: 'Accumulated Depreciation', account_type: 'ASSET', type: 'Asset', account_group: 'FIXED_ASSET', parent_account_id: '12000', allow_posting: false },
  // --- Liabilities (20000-29999) ---
  { id: '20000', code: '20000', account_number: '20000', name: 'Liabilities', account_type: 'LIABILITY', type: 'Liability', allow_posting: false, is_system_account: true },
  { id: '21000', code: '21000', account_number: '21000', name: 'Current Liabilities', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', allow_posting: false },
  { id: '21100', code: '21100', account_number: '21100', name: 'Accounts Payable', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', subtype: 'PAYABLE', is_system_account: true },
  { id: '21110', code: '21110', account_number: '21110', name: 'Trade Creditors', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', parent_account_id: '21100', allow_posting: true, is_system_account: true },
  { id: '21200', code: '21200', account_number: '21200', name: 'Tax Payable', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', allow_posting: false, subtype: 'TAX' },
  { id: '21210', code: '21210', account_number: '21210', name: 'VAT Payable', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', parent_account_id: '21200', subtype: 'TAX', allow_posting: true, is_system_account: true },
  { id: '21220', code: '21220', account_number: '21220', name: 'PAYE Payable', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', parent_account_id: '21200', subtype: 'TAX', allow_posting: true },
  { id: '21300', code: '21300', account_number: '21300', name: 'Accrued Expenses', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', allow_posting: true },
  { id: '22000', code: '22000', account_number: '22000', name: 'Long-Term Liabilities', account_type: 'LIABILITY', type: 'Liability', account_group: 'LONG_TERM_LIABILITY', allow_posting: false },
  { id: '22100', code: '22100', account_number: '22100', name: 'Bank Loans', account_type: 'LIABILITY', type: 'Liability', account_group: 'LONG_TERM_LIABILITY', parent_account_id: '22000', allow_posting: true },
  { id: '22200', code: '22200', account_number: '22200', name: 'Other Loans', account_type: 'LIABILITY', type: 'Liability', account_group: 'LONG_TERM_LIABILITY', parent_account_id: '22000', allow_posting: true },
  // --- Equity (30000-39999) ---
  { id: '30000', code: '30000', account_number: '30000', name: 'Equity', account_type: 'EQUITY', type: 'Equity', allow_posting: false, is_system_account: true },
  { id: '31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', type: 'Equity', account_group: 'EQUITY', allow_posting: true },
  { id: '32000', code: '32000', account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', type: 'Equity', account_group: 'EQUITY', is_system_account: true },
  { id: '33000', code: '33000', account_number: '33000', name: 'Current Year Earnings', account_type: 'EQUITY', type: 'Equity', account_group: 'EQUITY', is_system_account: true },
  { id: '34000', code: '34000', account_number: '34000', name: 'Drawings', account_type: 'EQUITY', type: 'Equity', account_group: 'EQUITY', allow_posting: true },
  // --- Income (40000-49999) ---
  { id: '40000', code: '40000', account_number: '40000', name: 'Income', account_type: 'INCOME', type: 'Revenue', allow_posting: false, is_system_account: true },
  { id: '41000', code: '41000', account_number: '41000', name: 'Sales / Revenue', account_type: 'INCOME', type: 'Revenue', account_group: 'REVENUE', allow_posting: false },
  { id: '41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', type: 'Revenue', account_group: 'REVENUE', is_system_account: true },
  { id: '41200', code: '41200', account_number: '41200', name: 'Service Income', account_type: 'INCOME', type: 'Revenue', account_group: 'REVENUE', is_system_account: true },
  { id: '42000', code: '42000', account_number: '42000', name: 'Other Income', account_type: 'INCOME', type: 'Revenue', account_group: 'OTHER_INCOME', allow_posting: false },
  { id: '42100', code: '42100', account_number: '42100', name: 'Interest Income', account_type: 'INCOME', type: 'Revenue', account_group: 'OTHER_INCOME', allow_posting: true },
  { id: '42200', code: '42200', account_number: '42200', name: 'Discount Received', account_type: 'INCOME', type: 'Revenue', account_group: 'OTHER_INCOME', allow_posting: true },
  // --- Expenses (50000-59999) ---
  { id: '50000', code: '50000', account_number: '50000', name: 'Expenses', account_type: 'EXPENSE', type: 'Expense', allow_posting: false, is_system_account: true },
  { id: '51000', code: '51000', account_number: '51000', name: 'Cost of Sales', account_type: 'EXPENSE', type: 'Expense', account_group: 'COST_OF_SALES', allow_posting: false },
  { id: '51100', code: '51100', account_number: '51100', name: 'Purchases', account_type: 'EXPENSE', type: 'Expense', account_group: 'COST_OF_SALES', parent_account_id: '51000', allow_posting: true },
  { id: '51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', type: 'Expense', account_group: 'COST_OF_SALES', is_system_account: true },
  { id: '51300', code: '51300', account_number: '51300', name: 'Freight & Carriage', account_type: 'EXPENSE', type: 'Expense', account_group: 'COST_OF_SALES', parent_account_id: '51000', allow_posting: true },
  { id: '52000', code: '52000', account_number: '52000', name: 'Operating Expenses', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', allow_posting: false },
  { id: '52100', code: '52100', account_number: '52100', name: 'Salaries & Wages', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000', is_system_account: true },
  { id: '52200', code: '52200', account_number: '52200', name: 'Rent', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52300', code: '52300', account_number: '52300', name: 'Utilities', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52400', code: '52400', account_number: '52400', name: 'Internet & Telephone', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52500', code: '52500', account_number: '52500', name: 'Advertising', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52600', code: '52600', account_number: '52600', name: 'Transport', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52700', code: '52700', account_number: '52700', name: 'Repairs & Maintenance', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52800', code: '52800', account_number: '52800', name: 'Office Expenses', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '52900', code: '52900', account_number: '52900', name: 'Bank Charges', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '53000', code: '53000', account_number: '53000', name: 'Depreciation', account_type: 'EXPENSE', type: 'Expense', account_group: 'OPERATING_EXPENSE', parent_account_id: '52000' },
  { id: '54000', code: '54000', account_number: '54000', name: 'Other Expenses', account_type: 'EXPENSE', type: 'Expense', account_group: 'OTHER_EXPENSE', allow_posting: false },
  { id: '54100', code: '54100', account_number: '54100', name: 'Interest Expense', account_type: 'EXPENSE', type: 'Expense', account_group: 'OTHER_EXPENSE', parent_account_id: '54000', allow_posting: true },
];

export const AVAILABLE_PERMISSIONS: PermissionNode[] = [
  // Dashboard & Analytics
  { id: 'dashboard.view', label: 'View Dashboard', module: 'Analytics' },
  { id: 'reports.view', label: 'View Financial Reports', module: 'Analytics' },
  { id: 'audit.view', label: 'View Audit Logs', module: 'System' },

  // Sales & POS
  { id: 'sales.view', label: 'View Sales Modules', module: 'Sales' },
  { id: 'sale.process', label: 'Process Sales', module: 'Sales' },
  { id: 'sale.refund', label: 'Process Refunds', module: 'Sales' },
  { id: 'sale.void', label: 'Void Transactions', module: 'Sales' },
  { id: 'quotation.manage', label: 'Manage Quotations', module: 'Sales' },

  // Inventory & Procurement
  { id: 'inventory.view', label: 'View Inventory', module: 'Inventory' },
  { id: 'inventory.adjust', label: 'Adjust Stock', module: 'Inventory' },
  { id: 'inventory.receive', label: 'Receive Goods (GRN)', module: 'Inventory' },
  { id: 'procurement.view', label: 'View Procurement', module: 'Procurement' },
  { id: 'procurement.manage', label: 'Manage Purchase Orders', module: 'Procurement' },

  // Production
  { id: 'production.view', label: 'View Production', module: 'Production' },
  { id: 'production.manage', label: 'Manage Work Orders', module: 'Production' },
  { id: 'production.log', label: 'Log Production Progress', module: 'Production' },
  { id: 'examination.cost.override', label: 'Override Examination Cost', module: 'Production' },

  // Finance
  { id: 'accounts.view', label: 'View Accounts', module: 'Finance' },
  { id: 'ledger.view', label: 'View General Ledger', module: 'Finance' },
  { id: 'ledger.post', label: 'Post Journal Entries', module: 'Finance' },
  { id: 'banking.manage', label: 'Manage Bank Accounts', module: 'Finance' },
  { id: 'payroll.manage', label: 'Process Payroll', module: 'Finance' },

  // Referral Program
  { id: 'referrals.view', label: 'View Referrals & Rewards', module: 'Sales' },
  { id: 'referrals.approve', label: 'Approve Referral Rewards', module: 'Sales' },
  { id: 'referrals.manage', label: 'Manage Referral Settings', module: 'System' },

  // System
  { id: 'admin.settings', label: 'Manage System Settings', module: 'System' },
  { id: 'admin.users', label: 'Manage Users & Groups', module: 'System' },
  { id: 'settings.manage', label: 'Manage System Settings', module: 'System' },
  { id: 'users.manage', label: 'Manage Users & Groups', module: 'System' },
];

export const INITIAL_USER_GROUPS: UserGroup[] = [
  {
    id: 'GRP-ADMIN',
    name: 'Administrators',
    description: 'Full system access with all permissions',
    permissions: ['all']
  },
  {
    id: 'GRP-ACCOUNTANT',
    name: 'Accountants',
    description: 'Financial management, reporting, and ledger access',
    permissions: [
      'dashboard.view', 'reports.view', 'ledger.view', 'ledger.post',
      'banking.manage', 'sale.process', 'sale.refund', 'inventory.view',
      'examination.cost.override'
    ]
  },
  {
    id: 'GRP-CASHIER',
    name: 'Cashiers',
    description: 'Front-end sales and basic inventory viewing',
    permissions: ['dashboard.view', 'sale.process', 'sale.refund', 'inventory.view']
  },
  {
    id: 'GRP-MANAGER',
    name: 'Managers',
    description: 'Operational managers with sales, inventory, and report visibility',
    permissions: ['dashboard.view', 'reports.view', 'sales.view', 'sale.process', 'inventory.view', 'inventory.adjust', 'procurement.view', 'referrals.view', 'referrals.approve']
  },
  {
    id: 'GRP-SALES',
    name: 'Sales Staff',
    description: 'Sales users who can manage customers, quotations, invoices, and receipts',
    permissions: ['dashboard.view', 'sales.view', 'sale.process', 'quotation.manage', 'inventory.view']
  },
  {
    id: 'GRP-USER',
    name: 'Standard Users',
    description: 'Baseline authenticated access',
    permissions: ['dashboard.view']
  },
  {
    id: 'GRP-OPERATOR',
    name: 'Production Operators',
    description: 'Production logging and work order execution',
    permissions: ['dashboard.view', 'production.log', 'inventory.view']
  }
];

export const MOCK_WAREHOUSES: Warehouse[] = [
  { id: 'WH-MAIN', name: 'Main Warehouse', type: 'Physical', location: 'Lilongwe' },
  { id: 'WH-SHOP', name: 'Front Shop', type: 'Store', location: 'Lilongwe' },
  { id: 'WH-VIR', name: 'Virtual/Transit', type: 'Virtual', location: 'System' },
];

export const MOCK_WORK_CENTERS: WorkCenter[] = [
  { id: 'WC-PRN-01', name: 'Offset Printing Line 1', hourlyRate: 45.00, capacityPerDay: 8 },
  { id: 'WC-BND-01', name: 'Perfect Binding Station', hourlyRate: 35.00, capacityPerDay: 8 },
  { id: 'WC-CUT-01', name: 'Hydraulic Cutting Station', hourlyRate: 25.00, capacityPerDay: 8 },
];

export const MOCK_RESOURCES: ProductionResource[] = [
  { id: 'RES-PRN-01', name: 'Heidelberg Speedmaster', workCenterId: 'WC-PRN-01', status: 'Active' },
  { id: 'RES-BND-01', name: 'Horizon Binder', workCenterId: 'WC-BND-01', status: 'Active' },
  { id: 'RES-CUT-01', name: 'Polar Cutter', workCenterId: 'WC-CUT-01', status: 'Active' },
];
