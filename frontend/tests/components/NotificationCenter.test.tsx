/**
 * NotificationCenter.test.tsx — the dropdown must never overflow the
 * viewport (previously it could extend past the right edge with message
 * text clipped mid-word) and must track the bell on scroll/resize.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import NotificationCenter from '../../components/ui/NotificationCenter';

const baseProps = {
  onClose: vi.fn(),
  onMarkRead: vi.fn(),
  onMarkAllRead: vi.fn(),
  onClear: vi.fn(),
  notifications: [
    {
      id: 'n1',
      type: 'insight' as const,
      title: 'POS Sale Completed',
      message: 'Sale #POS-P726/020 posted (K7,000.00).',
      timestamp: new Date().toISOString(),
      severity: 'low' as const,
      read: false,
    },
  ],
};

function mockAnchor(rect: Partial<DOMRect>) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () =>
    ({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      left: rect.left ?? 0,
      top: rect.top ?? 0,
      right: rect.right ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

afterEach(() => {
  // NOTE: do NOT clear document.body here — the panel renders via portal
  // and testing-library cleanup must unmount it first.
  vi.restoreAllMocks();
});

describe('NotificationCenter positioning', () => {
  it('right-aligns to the bell and stays inside a wide viewport', () => {
    setViewport(1600);
    const anchor = mockAnchor({ left: 1390, right: 1422, top: 108, bottom: 140, width: 32, height: 32 });
    render(<NotificationCenter {...baseProps} isOpen anchorEl={anchor} />);
    const panel = screen.getByTestId('notification-center-panel') as HTMLElement;
    // Portalled to document.body: immune to backdrop-filter/transform
    // containing blocks in ancestor headers.
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.width).toBe('380px');
    // Right-aligned to the bell: 1422 - 380 = 1042, right edge at the bell.
    expect(panel.style.left).toBe('1042px');
    expect(1042 + 380).toBeLessThanOrEqual(1600);
    expect(screen.getByText('POS Sale Completed')).toBeTruthy();
  });

  it('clamps to the viewport when the bell sits at the extreme right edge', () => {
    setViewport(1600);
    // Bell rect extending past the viewport (stale rect after layout shift,
    // zoom, or transform) must not push the panel off-screen.
    const anchor = mockAnchor({ left: 1570, right: 1602, top: 108, bottom: 140, width: 32, height: 32 });
    render(<NotificationCenter {...baseProps} isOpen anchorEl={anchor} />);
    const panel = screen.getByTestId('notification-center-panel') as HTMLElement;
    const left = parseFloat(panel.style.left);
    const width = parseFloat(panel.style.width);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + width).toBeLessThanOrEqual(1600);
  });

  it('shrinks and pins to the left margin on narrow viewports', () => {
    setViewport(360);
    const anchor = mockAnchor({ left: 300, right: 332, top: 60, bottom: 92, width: 32, height: 32 });
    render(<NotificationCenter {...baseProps} isOpen anchorEl={anchor} />);
    const panel = screen.getByTestId('notification-center-panel') as HTMLElement;
    const left = parseFloat(panel.style.left);
    const width = parseFloat(panel.style.width);
    expect(width).toBeLessThanOrEqual(360 - 24);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + width).toBeLessThanOrEqual(360);
  });

  it('repositions on scroll when the anchor moves (no stale detachment)', () => {
    setViewport(1600);
    let rect = { left: 1390, right: 1422, top: 108, bottom: 140, width: 32, height: 32 };
    const anchor = mockAnchor(rect);
    anchor.getBoundingClientRect = () =>
      ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
    render(<NotificationCenter {...baseProps} isOpen anchorEl={anchor} />);
    const panel = screen.getByTestId('notification-center-panel') as HTMLElement;
    expect(panel.style.left).toBe('1042px');
    // Layout shift moves the bell left; scroll must re-glue the panel.
    rect = { left: 1200, right: 1232, top: 108, bottom: 140, width: 32, height: 32 };
    act(() => {
      fireEvent.scroll(window);
    });
    expect(panel.style.left).toBe('852px');
  });
});
