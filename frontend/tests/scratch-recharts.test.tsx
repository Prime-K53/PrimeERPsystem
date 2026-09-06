import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis } from 'recharts';

const DATA = [
  { day: 'Mon', income: 10 },
  { day: 'Tue', income: 20 },
];

const mockSize = { width: 400, height: 0 };
let observer: { cb: (e: { contentRect: { width: number; height: number } }[]) => void } | null = null;

class MockResizeObserver {
  constructor(cb: any) { observer = { cb }; }
  observe() {
    Promise.resolve().then(() => {
      observer?.cb([{ contentRect: { width: mockSize.width, height: mockSize.height } }]);
    });
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  mockSize.width = 400;
  mockSize.height = 0;
  observer = null;
  (globalThis as any).ResizeObserver = MockResizeObserver;
  (Element.prototype as any).getBoundingClientRect = function () {
    return { width: mockSize.width, height: mockSize.height, top: 0, left: 0, right: mockSize.width, bottom: mockSize.height, x: 0, y: 0, toJSON: () => ({}) };
  };
});

function countWarnings(fn: () => void): { warns: string[]; warnsWithNeg: number } {
  const warns: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(String(a[0]));
  });
  fn();
  spy.mockRestore();
  return { warns, warnsWithNeg: warns.filter((w) => w.includes('should be greater than 0')).length };
}

const renderChart = () => {
  render(
    <div style={{ width: '100%', height: mockSize.height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={DATA}>
          <XAxis dataKey="day" />
          <YAxis />
          <Area type="monotone" dataKey="income" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

const flush = () => new Promise((r) => setTimeout(r, 80));

describe('scratch recharts sizing', () => {
  it('warns exactly once with (-1,-1) on initial mount even when it later measures a real height', async () => {
    mockSize.height = 250;
    let result: { warns: string[]; warnsWithNeg: number } = { warns: [], warnsWithNeg: 0 };
    await vi.waitFor(async () => {
      result = countWarnings(renderChart);
      await flush();
    });
    expect(result.warnsWithNeg).toBeGreaterThanOrEqual(1);
    expect(result.warns[0]).toContain('width(-1) and height(-1)');
  });

  it('does NOT warn when a fixed numeric height is supplied', async () => {
    mockSize.height = 0;
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(String(a[0]));
    });
    render(
      <div style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={DATA}>
            <XAxis dataKey="day" />
            <YAxis />
            <Area type="monotone" dataKey="income" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
    await flush();
    spy.mockRestore();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });

  it('does NOT warn when initialDimension is supplied as positive values', async () => {
    mockSize.height = 250;
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(String(a[0]));
    });
    render(
      <div style={{ width: '100%', height: 250 }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 400, height: 250 }}>
          <AreaChart data={DATA}>
            <XAxis dataKey="day" />
            <YAxis />
            <Area type="monotone" dataKey="income" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
    await flush();
    spy.mockRestore();
    expect(warns.filter((w) => w.includes('should be greater than 0'))).toHaveLength(0);
  });
});
