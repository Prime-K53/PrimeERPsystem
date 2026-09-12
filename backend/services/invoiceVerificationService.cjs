/**
 * invoiceVerificationService.cjs — compatibility facade over the generic
 * document verification foundation (`documentVerificationService.cjs`).
 *
 * The invoice was the first verifiable document type. Every export here
 * delegates so existing invoice behavior stays byte-identical: same lookup,
 * same VOID semantics, same 12-field allow-list, same generic failure.
 */
const generic = require('./documentVerificationService.cjs');

async function verifyInvoice(invoiceNumber, token, deps) {
  const result = await generic.verifyDocument('invoice', invoiceNumber, token, deps);
  return result;
}

module.exports = {
  verifyInvoice,
  mapVerificationStatus: generic.mapInvoiceStatus,
  sanitizeInvoiceNumber: generic.sanitizeDocumentNumber,
  GENERIC_FAILURE: 'Invoice could not be verified against Prime Printing records.',
};
