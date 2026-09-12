import { useCallback } from 'react';
import { useFinance } from '../context/FinanceContext';
import { useAuth } from '../context/AuthContext';
import {
  buildDocumentVerificationUrl,
  type VerifiableDocumentType,
} from '../utils/documentVerification';

/**
 * Shared verification-link actions for every verifiable document view.
 * Ensures (backfills) the permanent token through the approved save path,
 * then builds the public URL with the single generic builder. The raw token
 * is never displayed — only the link is copied/opened.
 */
export function useDocumentVerificationLink() {
  const { getDocumentVerificationToken } = useFinance();
  const { notify } = useAuth();

  const getLink = useCallback(async (
    documentType: VerifiableDocumentType,
    storeName: string,
    id: string,
    documentNumber?: string
  ): Promise<string | null> => {
    try {
      const token = await getDocumentVerificationToken(storeName, id);
      return buildDocumentVerificationUrl({
        documentType,
        documentNumber: documentNumber || id,
        verificationToken: token,
      });
    } catch {
      return null;
    }
  }, [getDocumentVerificationToken]);

  const copyVerificationLink = useCallback(async (
    documentType: VerifiableDocumentType,
    storeName: string,
    id: string,
    documentNumber?: string
  ) => {
    const url = await getLink(documentType, storeName, id, documentNumber);
    if (!url) {
      notify('Verification link unavailable', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify('Verification link copied', 'success');
    } catch {
      notify('Could not copy link', 'error');
    }
  }, [getLink, notify]);

  const openVerificationLink = useCallback(async (
    documentType: VerifiableDocumentType,
    storeName: string,
    id: string,
    documentNumber?: string
  ) => {
    const url = await getLink(documentType, storeName, id, documentNumber);
    if (!url) {
      notify('Verification link unavailable', 'error');
      return;
    }
    window.open(url, '_blank', 'noopener');
  }, [getLink, notify]);

  return { getLink, copyVerificationLink, openVerificationLink };
}
