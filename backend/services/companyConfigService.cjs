const repo = require('./supabaseRepository.cjs');

const DEFAULT_COMPANY_CONFIG = Object.freeze({
  companyName: 'Prime ERP',
  addressLine1: 'Main Street',
  city: 'Dedza',
  country: 'Malawi',
  phone: '0884 528 222',
  email: 'info@primeerp.com',
  currencySymbol: 'K',
  invoiceTemplates: {
    engine: 'Classic',
    accentColor: '#3b82f6',
    companyNameFontSize: 18,
    bodyFontSize: 12,
    fontFamily: 'Helvetica',
    logoWidth: 140,
    showCompanyLogo: true,
    showPaymentTerms: true,
    showDueDate: true,
    showOutstandingAndWalletBalances: true,
    showAccountSummary: true,
  },
});

function parseStoredValue(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pickFirstText(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeCompanyConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...DEFAULT_COMPANY_CONFIG,
      companyAddress: DEFAULT_COMPANY_CONFIG.addressLine1,
      companyPhone: DEFAULT_COMPANY_CONFIG.phone,
      companyEmail: DEFAULT_COMPANY_CONFIG.email,
    };
  }

  const source = raw;
  const companyName = pickFirstText(source.companyName, source.name, DEFAULT_COMPANY_CONFIG.companyName);
  const addressLine1 = pickFirstText(source.addressLine1, source.companyAddress, source.address, DEFAULT_COMPANY_CONFIG.addressLine1);
  const city = pickFirstText(source.city, DEFAULT_COMPANY_CONFIG.city);
  const country = pickFirstText(source.country, DEFAULT_COMPANY_CONFIG.country);
  const phone = pickFirstText(source.phone, source.companyPhone, DEFAULT_COMPANY_CONFIG.phone);
  const email = pickFirstText(source.email, source.companyEmail, DEFAULT_COMPANY_CONFIG.email);
  const website = pickFirstText(source.website, source.companyWebsite);
  const footer = pickFirstText(
    source.footer,
    source.receiptFooter,
    source.transactionSettings?.pos?.receiptFooter
  );
  const logo = pickFirstText(source.logo, source.companyLogo, source.logoUrl) || source.logoBase64 || null;
  const paymentTermsText = pickFirstText(
    source.paymentTerms,
    source.documentSettings?.paymentTerms,
    source.transactionSettings?.paymentTermsText
  );

  return {
    ...DEFAULT_COMPANY_CONFIG,
    ...source,
    companyName,
    name: companyName,
    companyAddress: addressLine1,
    addressLine1,
    city,
    country,
    companyPhone: phone,
    phone,
    companyEmail: email,
    email,
    website: website || undefined,
    companyWebsite: website || undefined,
    footer: footer || undefined,
    paymentTerms: paymentTermsText || undefined,
    companyLogo: logo,
    logo,
    logoUrl: typeof logo === 'string' ? logo : undefined,
    invoiceTemplates: {
      ...DEFAULT_COMPANY_CONFIG.invoiceTemplates,
      ...(source.invoiceTemplates || {}),
      showOutstandingAndWalletBalances: source.invoiceTemplates?.showOutstandingAndWalletBalances !== false,
      showAccountSummary: source.invoiceTemplates?.showAccountSummary !== false,
    },
  };
}

async function loadStoredCompanyConfigRow() {
  const rows = await repo.getAll('settings', { 'data->>key': 'eq.companyConfig' });
  let row = (rows || [])[0] || null;

  if (!row) {
    const allSettings = await repo.getAll('settings');
    row = (allSettings || []).find(
      (s) => s.key === 'companyConfig' || s.id === 'companyConfig' || s.key === 'nexus_company_config' || s.id === 'nexus_company_config'
    ) || null;
  }

  return row;
}

async function getCompanyConfig() {
  try {
    const row = await loadStoredCompanyConfigRow();
    if (!row) return normalizeCompanyConfig(null);

    const parsed = parseStoredValue(row.value ?? row.val ?? row.data?.value ?? row.data ?? row);
    return normalizeCompanyConfig(parsed);
  } catch {
    return normalizeCompanyConfig(null);
  }
}

module.exports = {
  DEFAULT_COMPANY_CONFIG,
  normalizeCompanyConfig,
  getCompanyConfig,
};
