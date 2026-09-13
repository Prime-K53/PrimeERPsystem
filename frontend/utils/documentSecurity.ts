import QRCode from 'qrcode';
import {
  buildDocumentVerificationUrl,
  detectVerifiableDocumentType,
  resolveVerifiableDocumentNumber,
} from './documentVerification';

const getCompanyNameFromStorage = () => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return 'Prime ERP';

  const saved = localStorage.getItem('nexus_company_config');
  if (!saved) return 'Prime ERP';

  try {
    const parsed = JSON.parse(saved);
    return String(parsed?.companyName || '').trim() || 'Prime ERP';
  } catch {
    return 'Prime ERP';
  }
};

const formatSecurityTimestamp = (value?: string) => {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return String(value || 'Unknown time');
  return parsed.toLocaleString();
};

const resolveDocumentNumber = (data: any) =>
  String(
    data?.number
    || data?.invoiceNumber
    || data?.orderNumber
    || data?.order_number
    || data?.receiptNumber
    || data?.quotationNumber
    || data?.quotationId
    || data?.dnNumber
    || data?.deliveryNoteNumber
    || data?.delivery_number
    || data?.paymentNumber
    || data?.paymentId
    || data?.statementNumber
    || data?.exchangeNumber
    || data?.reportName
    || 'N/A'
  ).trim() || 'N/A';

const resolveCreatedBy = (data: any) =>
  String(
    data?.createdByName
    || data?.createdBy
    || data?.created_by
    || data?.cashierName
    || data?.cashier_name
    || data?.operatorName
    || data?.operator_name
    || 'System User'
  ).trim() || 'System User';

const resolveCreatedAt = (data: any) =>
  String(
    data?.createdAtIso
    || data?.createdAt
    || data?.created_at
    || data?.date
    || ''
  ).trim();

export const buildSecurityQrPayload = (data: any, companyName?: string) => {
  // Documents carrying a verification token encode the verification URL
  // (compact, QR-friendly, no sensitive data). Everything else keeps the
  // legacy human-readable payload — including documents that predate tokens.
  // Invoice output is byte-identical to the original invoice implementation.
  const docType = detectVerifiableDocumentType(data);
  const verificationUrl = docType
    ? buildDocumentVerificationUrl({
      documentType: docType,
      documentNumber: resolveVerifiableDocumentNumber(data, docType),
      invoiceNumber: data.invoiceNumber,
      number: data.number,
      verificationToken: (data as any).verificationToken,
    })
    : null;
  if (verificationUrl) return verificationUrl;

  const resolvedCompanyName = String(companyName || '').trim() || getCompanyNameFromStorage();
  const documentNumber = resolveDocumentNumber(data);
  const createdOn = formatSecurityTimestamp(resolveCreatedAt(data));
  const createdBy = resolveCreatedBy(data);

  return `${resolvedCompanyName}, ${documentNumber}, created on ${createdOn}, by ${createdBy}`;
};

export const attachDocumentSecurity = async <T extends Record<string, any>>(data: T, companyName?: string): Promise<T> => {
  const payload = buildSecurityQrPayload(data, companyName);
  let securityQrCodeDataUrl: string | undefined;

  try {
    securityQrCodeDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      // Quiet zone + resolution for reliable phone-camera scanning in print.
      margin: 2,
      width: 192,
    });
  } catch (error) {
    console.warn('[documentSecurity] Failed to generate QR code data URL.', error);
  }

  return {
    ...data,
    securityQrPayload: payload,
    securityQrCodeDataUrl,
  };
};
