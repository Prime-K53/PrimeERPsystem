import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: vi.fn(() => Promise.resolve({
        getViewport: vi.fn(() => ({ width: 794, height: 1123 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
      destroy: vi.fn(),
    }),
  })),
}));

import { OfficialDocumentPreview } from '../../../views/shared/components/PDF/Official/OfficialDocumentPreview';

const mockPdfBlob = new Blob(['%PDF-1.4 mock pdf content'], { type: 'application/pdf' });

describe('OfficialDocumentPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url-123');
    global.URL.revokeObjectURL = vi.fn();
  });

  it('renders empty state when no source provided', () => {
    render(<OfficialDocumentPreview source={null} />);
    expect(screen.getByText('No document to preview')).toBeInTheDocument();
  });

  it('renders loading state when source is provided', () => {
    render(<OfficialDocumentPreview source={mockPdfBlob} title="Test Document" />);
    expect(screen.getByText(/Rendering document/i)).toBeInTheDocument();
  });

  it('renders title in header', () => {
    render(<OfficialDocumentPreview source={mockPdfBlob} title="My Invoice" />);
    expect(screen.getByText('My Invoice')).toBeInTheDocument();
  });
});
