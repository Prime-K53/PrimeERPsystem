/**
 * Customer CSV name mapping.
 *
 * Customers carry two names (see `utils/customerDisplay.ts` + ClientModal):
 *   - Business name  → `companyName` (required, customer identity)
 *   - Contact person → `contactName`, mirrored into legacy `name`
 *     (ClientModal stores the contact person in `name`; the workspace and
 *     customer card read `contactName`).
 *
 * Legacy single-name CSVs (`Full name` / `Name` / …) keep working: the single
 * value is treated as the business name.
 */

const firstPresent = (row: Record<string, any>, keys: string[]): string => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
};

const BUSINESS_KEYS = [
  'Business name',
  'Business Name',
  'BusinessName',
  'businessName',
  'Company name',
  'Company Name',
  'CompanyName',
  'companyName',
  'Company',
  'company',
  // Legacy single-name columns (business identity fallback)
  'Full name',
  'Full Name',
  'FullName',
  'CustomerName',
  'Customer Name',
  'Name',
  'name',
];

const CONTACT_KEYS = [
  'Contact person',
  'Contact Person',
  'ContactPerson',
  'contactPerson',
  'Contact name',
  'Contact Name',
  'ContactName',
  'contactName',
];

export interface ImportCustomerNames {
  /** Business name — customer identity, stored in `companyName`. */
  business: string;
  /** Contact person — stored in `contactName` (+ legacy `name`). */
  contact: string;
}

export const resolveImportCustomerNames = (row: Record<string, any>): ImportCustomerNames => ({
  business: firstPresent(row, BUSINESS_KEYS),
  contact: firstPresent(row, CONTACT_KEYS),
});

/**
 * Business identity used for duplicate detection, matching the display
 * contract: businessName → companyName → legacy name.
 */
export const customerBusinessIdentity = (customer: {
  businessName?: string | null;
  companyName?: string | null;
  name?: string | null;
} | null): string =>
  String(
    customer?.businessName || customer?.companyName || customer?.name || '',
  )
    .trim()
    .toLowerCase();
