import '@testing-library/jest-dom';
import { vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// @react-pdf/renderer (fontkit) resolves web-relative font srcs such as
// "/fonts/foo.ttf" through fs in the Node test runtime (vitest/jsdom). A rooted
// path resolves against the drive root and does not exist. Mirror the server-side
// redirect (backend/services/officialDocumentService.cjs) so PDF render tests
// can embed real font files from frontend/public/fonts.
const FONT_DIR = path.resolve(process.cwd(), 'public', 'fonts');
const FONT_PATH_PATTERN = /^\/fonts\/[^\/]+\.(ttf|otf)$/i;

function redirectFontPath(filename: string) {
  const m = filename.match(FONT_PATH_PATTERN);
  if (!m) return filename;
  return path.join(FONT_DIR, filename.replace(/^\/fonts\//i, ''));
}

const originalFsPromisesReadFile = fs.promises.readFile;
const originalFsReadFileSync = fs.readFileSync;

fs.promises.readFile = function (filename: any, ...args: any[]) {
  const redirected = typeof filename === 'string' ? redirectFontPath(filename) : filename;
  return originalFsPromisesReadFile.call(this, redirected, ...(args as []));
} as any;

fs.readFileSync = function (filename: any, ...args: any[]) {
  const redirected = typeof filename === 'string' ? redirectFontPath(filename) : filename;
  return originalFsReadFileSync.call(this, redirected, ...(args as []));
} as any;

// Mock IndexedDB
vi.mock('idb', () => ({
  openDB: vi.fn(() =>
    Promise.resolve({
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getAll: vi.fn(() => Promise.resolve([])),
      getAllFromIndex: vi.fn(() => Promise.resolve([])),
      count: vi.fn(() => Promise.resolve(0)),
      createObjectStore: vi.fn(),
      deleteObjectStore: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    })
  ),
  deleteDB: vi.fn(() => Promise.resolve()),
  unwrap: vi.fn(),
}));

// Mock notification service
vi.mock('../services/notificationService', () => ({
  notify: vi.fn(),
  showNotification: vi.fn(),
}));

// Mock logger service
vi.mock('../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLogs: vi.fn(() => []),
    clearLogs: vi.fn(),
  },
}));

// Mock platform API (browser-only web app)
const mockPlatformAPI = {
  getBackendUrl: vi.fn(() => Promise.resolve('https://primeerpsystem.onrender.com')),
  log: vi.fn(),
  readPdfFile: vi.fn(() => Promise.resolve({ success: true, data: [], size: 0 })),
  writeTempPdf: vi.fn(() => Promise.resolve({ success: true, path: '/tmp/test.pdf' })),
  cleanupTempPdf: vi.fn(() => Promise.resolve({ success: true })),
  openPdfWithSystemViewer: vi.fn(() => Promise.resolve({ success: true })),
  getPdfPreviewUrl: vi.fn((path: string) => `file://${path}`),
};

vi.mock('../services/platform', () => ({
  detectPlatform: vi.fn(() => 'browser'),
  isTauri: vi.fn(() => false),
  isElectron: vi.fn(() => false),
  isDesktop: vi.fn(() => false),
  getPlatformAPI: vi.fn(() => mockPlatformAPI),
  platform: {
    get type() { return 'browser'; },
    get isTauri() { return false; },
    get isElectron() { return false; },
    get isDesktop() { return false; },
    get api() { return mockPlatformAPI; },
  },
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock sessionStorage
const sessionStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock });

// Mock fetch
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
  })
) as vi.Mock;

// Mock URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => 'mock-url');
global.URL.revokeObjectURL = vi.fn();

// Mock crypto.randomUUID
// jsdom lacks a working crypto.subtle (the non-enumerable property is dropped by the
// the earlier spread), and utils/uuid.ts stringToUuid5 needs it for deterministic offline ids.
const cryptoSubtleMock = {
  digest: async (algorithm: unknown, data: BufferSource) => {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const requested = typeof algorithm === 'string'
      ? algorithm
      : String((algorithm as { name?: string } | null)?.name || 'SHA-1');
    const nodeAlgorithm = requested.toLowerCase().replace(/-/g, '');
    return createHash(nodeAlgorithm).update(Buffer.from(view)).digest();
  },
};
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: vi.fn(() => 'mock-uuid-1234'),
    getRandomValues: vi.fn((arr) => arr),
    subtle: cryptoSubtleMock as SubtleCrypto,
  },
  writable: true,
  configurable: true,
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock scrollTo
window.scrollTo = vi.fn();

// Mock alert and confirm
window.alert = vi.fn();
window.confirm = vi.fn(() => true);

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.getItem.mockReturnValue(null);
  sessionStorageMock.getItem.mockReturnValue(null);
});

// Cleanup after each test
afterEach(() => {
  vi.restoreAllMocks();
});

// Global test utilities
export const createMockUser = (overrides = {}) => ({
  id: 'user-1',
  username: 'testuser',
  email: 'test@example.com',
  role: 'Admin',
  permissions: ['all'],
  ...overrides,
});

export const createMockInvoice = (overrides = {}) => ({
  id: 'INV-001',
  customerId: 'CUST-001',
  customerName: 'Test Customer',
  items: [
    {
      description: 'Test Item',
      quantity: 1,
      unitPrice: 100,
      total: 100,
    },
  ],
  subtotal: 100,
  taxAmount: 0,
  totalAmount: 100,
  paidAmount: 0,
  status: 'Pending',
  dueDate: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides,
});

export const createMockExpense = (overrides = {}) => ({
  id: 'EXP-001',
  description: 'Test Expense',
  amount: 50,
  category: 'Office Supplies',
  date: new Date().toISOString(),
  status: 'Pending',
  createdBy: 'user-1',
  ...overrides,
});

export const createMockItem = (overrides = {}) => ({
  id: 'ITM-001',
  name: 'Test Item',
  sku: 'SKU-001',
  category: 'General',
  type: 'Product',
  unit: 'pcs',
  cost: 10,
  price: 25,
  stock: 100,
  minStockLevel: 10,
  ...overrides,
});
