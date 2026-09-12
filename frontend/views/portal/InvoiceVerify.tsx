import React from 'react';
import { useParams } from 'react-router-dom';
import { DocumentVerify } from './DocumentVerify';

/**
 * Invoice verification page — compatibility wrapper.
 * Route: /verify/invoice/:invoiceNumber?t=<token>
 * Delegates to the generic DocumentVerify page with a forced invoice type,
 * so links/QR codes issued before the generic framework keep working with
 * identical behavior.
 */
export const InvoiceVerify: React.FC = () => {
  const { invoiceNumber } = useParams<{ invoiceNumber: string }>();
  return <DocumentVerify forcedType="invoice" forcedNumber={invoiceNumber} />;
};

export default InvoiceVerify;
