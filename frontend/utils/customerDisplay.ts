export interface CustomerDisplayInputs {
  businessName?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  legacyCustomerName?: string | null;
}

/**
 * Authoritative CUSTOMER / BUSINESS display name resolver.
 *
 * Contract:
 *   1. businessName (preferred customer identity)
 *   2. legacy customer name field (backward compat only when businessName missing)
 *
 * contactName MUST NOT be used as the customer/business display name.
 */
export const getCustomerDisplayName = ({
  businessName,
  companyName,
  legacyCustomerName,
}: CustomerDisplayInputs): string => {
  if (typeof businessName === 'string' && businessName.trim().length > 0) {
    return businessName.trim();
  }
  if (typeof companyName === 'string' && companyName.trim().length > 0) {
    return companyName.trim();
  }
  if (typeof legacyCustomerName === 'string' && legacyCustomerName.trim().length > 0) {
    return legacyCustomerName.trim();
  }
  return '';
};

/**
 * Authoritative CONTACT PERSON resolver.
 *
 * This is intentionally separate from getCustomerDisplayName so the two concepts
 * cannot be accidentally mixed.
 */
export const getCustomerContactName = ({
  contactName,
}: CustomerDisplayInputs): string => {
  if (typeof contactName === 'string' && contactName.trim().length > 0) {
    return contactName.trim();
  }
  return '';
};

export const resolveCustomerDisplay = (
  customer: { businessName?: string | null; companyName?: string | null; contactName?: string | null; name?: string | null } | null
): { displayName: string; contactName: string } => {
  if (!customer) {
    return { displayName: '', contactName: '' };
  }
  return {
    displayName: getCustomerDisplayName({
      businessName: customer.businessName ?? null,
      companyName: customer.companyName ?? null,
      legacyCustomerName: customer.name ?? null,
    }),
    contactName: getCustomerContactName({ contactName: customer.contactName ?? null }),
  };
};

/**
 * Label for customer <option> / search-dropdown rows.
 *
 * NON-NEGOTIABLE: always the Business Name, never the contact name.
 * Falls back to the customer id (never blank) when no business identity
 * exists, so dropdowns cannot render empty options.
 */
export const getCustomerOptionLabel = (
  customer: {
    id?: string | null;
    name?: string | null;
    businessName?: string | null;
    companyName?: string | null;
  } | null | undefined
): string => {
  if (!customer) return 'Unknown customer';
  return (
    getCustomerDisplayName({
      businessName: customer.businessName ?? null,
      companyName: customer.companyName ?? null,
      legacyCustomerName: customer.name ?? null,
    }) ||
    String(customer.id || '').trim() ||
    'Unknown customer'
  );
};
