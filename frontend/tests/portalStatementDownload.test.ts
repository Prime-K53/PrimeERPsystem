import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDownloadFilename,
  portalLifecycle,
} from '../services/portalApiClient';

describe('portal customer statement download', () => {
  beforeEach(() => {
    const session = {
      access_token: 'portal-access-token',
      refresh_token: 'portal-refresh-token',
      expires_in: '30m',
      user: {
        id: 'portal-user-1',
        customer_id: 'customer-1',
        email: 'customer@example.com',
      },
    };
    (window.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(session));
  });

  it('downloads the ERP-authoritative PDF with portal authentication', async () => {
    const pdfBlob = new Blob(['%PDF-1.7 official statement'], { type: 'application/pdf' });
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="Statement-Acme_2026-08-01_to_2026-08-31.pdf"',
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers,
      blob: vi.fn().mockResolvedValue(pdfBlob),
    });

    const result = await portalLifecycle.statements.download({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/portal/customers/statement/document?from=2026-08-01&to=2026-08-31'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/pdf',
          Authorization: 'Bearer portal-access-token',
        }),
      }),
    );
    expect(result.blob).toBe(pdfBlob);
    expect(result.filename).toBe('Statement-Acme_2026-08-01_to_2026-08-31.pdf');
  });

  it('rejects a successful response that is not a PDF', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      blob: vi.fn(),
    });

    await expect(portalLifecycle.statements.download({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })).rejects.toThrow('did not return an official PDF statement');
  });
});

describe('parseDownloadFilename', () => {
  it('supports standard and UTF-8 Content-Disposition filenames', () => {
    expect(parseDownloadFilename('attachment; filename="Statement-Customer_A.pdf"'))
      .toBe('Statement-Customer_A.pdf');
    expect(parseDownloadFilename("attachment; filename*=UTF-8''Statement-Customer%20A.pdf"))
      .toBe('Statement-Customer A.pdf');
  });
});
