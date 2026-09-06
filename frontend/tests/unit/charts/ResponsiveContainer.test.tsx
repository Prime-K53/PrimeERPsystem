/**
 * ResponsiveContainer.test.tsx
 *
 * Regression tests for the Recharts width(-1)/height(-1) warning class.
 *
 * Recharts v3 mounts <ResponsiveContainer width="100%" height="100%"> with an
 * internal {-1,-1} size and warns before it measures its parent — and it warns
 * indefinitely while the parent reports 0x0 (hidden tabs/modals). The
 * app-level wrapper in components/charts/ResponsiveContainer.tsx only mounts
 * the Recharts container once the host div has a real, positive size, passing
 * that size as `initialDimension` so Recharts never renders -1.
 *
 * These tests emulate a browser ResizeObserver + measurable layout to prove:
 *   1. A chart with a measurable container renders with NO dimension warning.
 *   2. A chart inside a hidden (0x0) container mounts nothing and warns nothing.
 *   3. When that container becomes visible/measurable the chart mounts cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { AreaChart, Area, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/charts/ResponsiveContainer';

const DATA = [
  { day: 'Mon', income: 10 },
  { day: 'Tue', income: 20 },
];

// ── Browser emulation for layout measurement ────────────────────────────────
const mockSize = { width: 0, height: 0 };
let observers: { cb: (entry: { contentRect: { width: number; height: number } }) => void; el: Element }[] = [];

class MockResizeObserver {
  private cb: (entry: { contentRect: { width: number; height: number } }) => void;
  constructor(cb: (entry: { contentRect: { width: number; height: number } }) => void) {
    this.cb = cb;
  }
  observe(el: Element) {
    observers.push({ cb: this.cb, el });
  }
  disconnect() {}
  unobserve() {}
}

function fireObservers() {
  for (const { cb } of [...observers]) {
    cb({ contentRect: { width: mockSize.width, height: mockSize.height } });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  observers = [];
  mockSize.width = 0;
  mockSize.height = 0;
  (globalThis as any).ResizeObserver = MockResizeObserver;
  (Element.prototype as any).getBoundingClientRect = function () {
    return {
      width: mockSize.width,
      height: mockSize.height,
      top: 0, left: 0, right: mockSize.width, bottom: mockSize.height,
      x: 0, y: 0, toJSON: () => ({}),
    };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function collectRechartsWarnings() {
  const warns: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(String(args[0]));
  });
  return warns;
}

function ChartFixture() {
  return (
    <div style={{ width: 600, height: 280 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={150}>
        <AreaChart data={DATA}>
          <XAxis dataKey="day" />
          <YAxis />
          <Area type="monotone" dataKey="income" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

describe('ResponsiveContainer (app wrapper)', () => {
  it('renders the chart with valid dimensions and no width/height warning', async () => {
    mockSize.width = 600;
    mockSize.height = 280;
    const warns = collectRechartsWarnings();

    const { container } = render(<ChartFixture />);
    await act(async () => {
      fireObservers();
      await flush();
    });

    // The chart is actually mounted.
    expect(container.querySelector('.recharts-wrapper')).not.toBeNull();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });

  it('mounts nothing (and warns nothing) while the container is hidden at 0x0', async () => {
    mockSize.width = 0;
    mockSize.height = 0;
    const warns = collectRechartsWarnings();

    const { container } = render(<ChartFixture />);
    await act(async () => {
      fireObservers();
      await flush();
    });

    expect(container.querySelector('.recharts-wrapper')).toBeNull();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });

  it('mounts the chart cleanly once a previously-hidden container becomes visible', async () => {
    mockSize.width = 0;
    mockSize.height = 0;
    const warns = collectRechartsWarnings();

    const { container } = render(<ChartFixture />);
    await act(async () => {
      fireObservers();
      await flush();
    });
    expect(container.querySelector('.recharts-wrapper')).toBeNull();

    // Container becomes measurable (e.g. tab switched / modal opened).
    mockSize.width = 600;
    mockSize.height = 280;
    await act(async () => {
      fireObservers();
      await flush();
    });

    expect(container.querySelector('.recharts-wrapper')).not.toBeNull();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });

  it('supports the empty-data state without dimension warnings', async () => {
    mockSize.width = 600;
    mockSize.height = 280;
    const warns = collectRechartsWarnings();

    const { container } = render(
      <div style={{ width: 600, height: 280 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={150}>
          <AreaChart data={[]}>
            <XAxis dataKey="day" />
            <YAxis />
            <Area type="monotone" dataKey="income" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
    await act(async () => {
      fireObservers();
      await flush();
    });

    expect(container.querySelector('.recharts-wrapper')).not.toBeNull();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });
});
