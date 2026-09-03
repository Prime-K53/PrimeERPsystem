import React from 'react';
import { View, Text } from '@react-pdf/renderer';
import { docStyles as s } from './styles.ts';

/**
 * PortalCopyWatermark
 *
 * ONE reusable, ERP-authoritative "PORTAL COPY" watermark for official PDFs.
 *
 * Rendered natively by @react-pdf/renderer as real PDF content (text drawn
 * into the PDF content stream at generation time) — NOT an HTML overlay and
 * NOT a post-generation byte rewrite.
 *
 * The watermark is a presentation/security marker ONLY. It knows nothing
 * about the company, the customer, or the document's financial content, so
 * ERP branding and calculations remain the sole source of truth.
 *
 * `fixed` + absolute positioning makes the watermark repeat on EVERY page of
 * a multi-page document (same mechanism as the SecurityFooter / CANCELLED
 * watermark). It must be placed as a direct child of <Page>.
 */
export const PortalCopyWatermark = () => (
  <View style={s.portalWatermarkContainer} fixed>
    <Text style={s.portalWatermarkText}>PORTAL COPY</Text>
  </View>
);

export default PortalCopyWatermark;