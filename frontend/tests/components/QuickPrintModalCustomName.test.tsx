import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuickPrintModal from '../../components/QuickPrintModal';

const baseProps = {
  open: true,
  onClose: vi.fn(),
  pricePerPage: 150,
  currency: 'K',
  onConfirm: vi.fn(),
};

describe('QuickPrintModal optional photocopy name', () => {
  it('shows the optional name field for photocopy only', () => {
    const { unmount } = render(<QuickPrintModal {...baseProps} type="photocopy" onConfirm={vi.fn()} />);
    expect(screen.getByPlaceholderText('Leave blank for Quick Photocopy')).toBeInTheDocument();
    expect(screen.getByText('Document / Item Name (optional)')).toBeInTheDocument();
    unmount();

    render(<QuickPrintModal {...baseProps} type="printing" onConfirm={vi.fn()} />);
    expect(screen.queryByPlaceholderText('Leave blank for Quick Photocopy')).not.toBeInTheDocument();
  });

  it('forwards the trimmed custom name without affecting totals', () => {
    const onConfirm = vi.fn();
    render(<QuickPrintModal {...baseProps} type="photocopy" onConfirm={onConfirm} />);
    fireEvent.change(screen.getByPlaceholderText('Leave blank for Quick Photocopy'), {
      target: { value: '  SIG Budget  ' },
    });
    fireEvent.click(screen.getByText('Add to Cart'));
    // 1 copy × 1 page → 1 sheet × 150 = 150; name is display-only.
    expect(onConfirm).toHaveBeenCalledWith(1, 1, 150, 'photocopy', undefined, undefined, 'SIG Budget');
  });

  it('forwards undefined when the name is blank', () => {
    const onConfirm = vi.fn();
    render(<QuickPrintModal {...baseProps} type="photocopy" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Add to Cart'));
    expect(onConfirm).toHaveBeenCalledWith(1, 1, 150, 'photocopy', undefined, undefined, undefined);
  });

  it('touching only the name keeps quantity/price behavior (13 pages × 1 copy)', () => {
    const onConfirm = vi.fn();
    render(<QuickPrintModal {...baseProps} type="photocopy" onConfirm={onConfirm} />);
    // pages per copy input is the first number input; copies the second.
    const numbers = screen.getAllByRole('spinbutton');
    fireEvent.change(numbers[0], { target: { value: '13' } });
    fireEvent.change(screen.getByPlaceholderText('Leave blank for Quick Photocopy'), {
      target: { value: 'SIG Budget' },
    });
    fireEvent.click(screen.getByText('Add to Cart'));
    // 13 pages → 7 sheets × 150 = 1050, name carried separately.
    expect(onConfirm).toHaveBeenCalledWith(1, 13, 1050, 'photocopy', undefined, undefined, 'SIG Budget');
  });

  it('QP consumers compile: POS view and PrimeDocument transform', async () => {
    await expect(import('../../views/POS')).resolves.toBeTruthy();
    await expect(
      import('../../views/shared/components/PDF/PrimeDocument')
    ).resolves.toBeTruthy();
  }, 120000);
});
