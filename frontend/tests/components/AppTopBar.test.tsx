/**
 * AppTopBar.test.tsx — the single admin top navigation bar.
 *
 * Locks in the P0/P1 fixes:
 * - FY button shows the real FY label (+ Closed state), not static text
 * - sync/offline pill is rendered with retry (was fetched but never shown)
 * - admin-only menu items are gated by permission (were visible to everyone)
 * - notification bell exposes a real count label (was an unlabeled dot)
 * - search is debounced, counted, keyboard-navigable, ESC-closable
 * - logout awaits the provider before navigating
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  mockNavigate,
  mockUseAuth,
  mockUseFY,
  mockUseNotifications,
  mockUseSales,
  mockUseInventory,
  mockNC,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseFY: vi.fn(),
  mockUseNotifications: vi.fn(),
  mockUseSales: vi.fn(),
  mockUseInventory: vi.fn(),
  mockNC: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));
vi.mock('../../context/FinancialYearContext', () => ({
  useFinancialYear: (...args: unknown[]) => mockUseFY(...args),
}));
vi.mock('../../context/NotificationContext', () => ({
  useNotifications: (...args: unknown[]) => mockUseNotifications(...args),
}));
vi.mock('../../context/SalesContext', () => ({
  useSales: (...args: unknown[]) => mockUseSales(...args),
}));
vi.mock('../../context/InventoryContext', () => ({
  useInventory: (...args: unknown[]) => mockUseInventory(...args),
}));
vi.mock('../../components/ui', () => ({
  NotificationCenter: (props: Record<string, unknown>) => {
    mockNC(props);
    if (!props.isOpen) return null;
    const notifs = (props.notifications as Array<{ id: string; title: string }>) || [];
    return (
      <div data-testid="nc-stub">
        {notifs.map((n) => (
          <div key={n.id} data-testid={`nc-${n.id}`}>
            {n.title}
          </div>
        ))}
        <button onClick={() => (props.onMarkAllRead as () => void)()}>nc-mark-all</button>
      </div>
    );
  },
}));

import AppTopBar from '../../components/AppTopBar';

const adminAuth = {
  user: { fullName: 'Jane Doe', username: 'jane', email: 'jane@acme.com', role: 'Admin', isSuperAdmin: true },
  companyConfig: { companyName: 'Acme Corp' },
  isOnline: true,
  dbSyncStatus: 'connected',
  lastSyncTime: null,
  checkPermission: () => true,
  logout: vi.fn().mockResolvedValue(undefined),
  connectDbSync: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn(),
};

const openFY = {
  selectedFinancialYear: {
    id: 'FY-2025',
    name: 'FY2025',
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    is_default: true,
    is_active: true,
    is_closed: 0,
    status: 'Active',
  },
  availableFinancialYears: [],
  setFinancialYear: vi.fn(),
  isLoading: false,
};

const salesData = {
  customers: [{ name: 'Globex Corp', phone: '123', email: 'g@globex.com' }],
  invoices: [{ invoiceNumber: 'INV-001', customerName: 'Globex Corp' }],
  jobOrders: [{ jobName: 'Print run', status: 'Scheduled' }],
};

function setup(overrides: {
  auth?: Record<string, unknown>;
  fy?: Record<string, unknown>;
  notifs?: Array<Record<string, unknown>>;
  sales?: Record<string, unknown>;
  inventory?: unknown[];
} = {}) {
  mockUseAuth.mockReturnValue({ ...adminAuth, ...(overrides.auth || {}) });
  mockUseFY.mockReturnValue({ ...openFY, ...(overrides.fy || {}) });
  const notifs =
    overrides.notifs !== undefined
      ? overrides.notifs
      : [
          { id: 'n1', type: 'SYSTEM', priority: 'Low', title: 'Low first', message: 'm', is_read: false, created_at: new Date().toISOString() },
          { id: 'n2', type: 'SYSTEM', priority: 'Urgent', title: 'Urgent second', message: 'm', is_read: false, created_at: new Date().toISOString() },
        ];
  mockUseNotifications.mockReturnValue({
    notifications: notifs,
    unreadCount: notifs.filter((n) => !n.is_read).length,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    dismissNotification: vi.fn(),
  });
  mockUseSales.mockReturnValue({ ...(salesData as object), ...(overrides.sales || {}) });
  mockUseInventory.mockReturnValue({ inventory: overrides.inventory !== undefined ? overrides.inventory : [{ name: 'A4 Paper', sku: 'PAP-A4' }] });
}

function renderBar() {
  return render(
    <MemoryRouter initialEntries={['/sales-flow/invoices']}>
      <AppTopBar onOpenSidebar={vi.fn()} onToggleCollapse={vi.fn()} onOpenMessages={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  adminAuth.logout.mockResolvedValue(undefined);
  adminAuth.connectDbSync.mockResolvedValue(undefined);
  openFY.setFinancialYear.mockClear();
  setup();
});

describe('AppTopBar', () => {
  it('shows the real FY label, online state, search hint, and a counted bell', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /financial year fy 2025/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/online/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search.*k/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 unread notifications/i })).toBeInTheDocument();
    // identity shows the name, not the role
    expect(screen.getByRole('button', { name: /account menu for jane doe/i })).toBeInTheDocument();
  });

  it('shows Closed state and blocks posting actions when the FY is closed', () => {
    setup({
      fy: {
        selectedFinancialYear: { ...openFY.selectedFinancialYear, is_closed: 1 },
        availableFinancialYears: [{ ...openFY.selectedFinancialYear, is_closed: 1 }],
      },
    });
    renderBar();
    expect(screen.getByRole('button', { name: /financial year.*closed/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create new record/i }));
    const menu = screen.getByRole('menu', { name: /create new/i });
    const pos = within(menu).getByRole('menuitem', { name: /pos sale/i });
    const invoice = within(menu).getByRole('menuitem', { name: /invoice/i });
    expect(pos).toBeDisabled();
    expect(invoice).toBeDisabled();
    expect(invoice).toHaveAttribute('title', expect.stringMatching(/closed/i));
    // non-posting creates stay available
    expect(within(menu).getByRole('menuitem', { name: /customer/i })).toBeEnabled();
  });

  it('gates admin tools for non-admin users', () => {
    setup({
      auth: {
        user: { fullName: 'Cashier Kay', username: 'kay', email: 'k@acme.com', role: 'Cashier', isSuperAdmin: false },
        checkPermission: () => false,
      },
    });
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /account menu for cashier kay/i }));
    const menu = screen.getByRole('menu', { name: /account/i });
    expect(within(menu).getByRole('menuitem', { name: /user profile/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /audit log/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /settings/i })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /user management/i })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /acceptance run/i })).toBeNull();
  });

  it('shows admin tools for admins', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /account menu for jane doe/i }));
    const menu = screen.getByRole('menu', { name: /account/i });
    expect(within(menu).getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /user management/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /sync health/i })).toBeInTheDocument();
  });

  it('shows offline pill with retry when offline', async () => {
    setup({ auth: { isOnline: false, dbSyncStatus: 'idle' } });
    renderBar();
    const pill = screen.getByRole('button', { name: /offline.*retry/i });
    expect(pill).toBeInTheDocument();
    fireEvent.click(pill);
    await waitFor(() => expect(adminAuth.connectDbSync).toHaveBeenCalledTimes(1));
  });

  it('sorts notifications severity-first before handing to the center', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /unread notifications/i }));
    expect(mockNC).toHaveBeenCalled();
    const last = mockNC.mock.calls[mockNC.mock.calls.length - 1][0] as {
      notifications: Array<{ id: string }>;
    };
    expect(last.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);
  });

  it('searches with debounce, counts, keyboard nav, and ESC focus return', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /search.*k/i }));
    const box = screen.getByRole('combobox', { name: /global search/i });
    fireEvent.change(box, { target: { value: 'globex' } });
    const dialog = await screen.findByRole('dialog', { name: /global search/i });
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent(/customer: 1/i)
    );
    expect(within(dialog).getAllByRole('option', { name: /globex corp/i }).length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sales-flow/invoices'));
    // ESC closes and returns focus to the trigger
    fireEvent.click(screen.getByRole('button', { name: /search.*k/i }));
    const box2 = await screen.findByRole('combobox', { name: /global search/i });
    fireEvent.keyDown(box2, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /global search/i })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /search.*k/i })).toHaveFocus();
  });

  it('awaits logout before navigating to login', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /account menu for jane doe/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));
    await waitFor(() => expect(adminAuth.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('groups results with highlighted matches and scope filtering', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /search.*k/i }));
    const box = screen.getByRole('combobox', { name: /global search/i });
    fireEvent.change(box, { target: { value: 'globex' } });
    const dialog = await screen.findByRole('dialog', { name: /global search/i });
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent(/customer: 1/i)
    );
    // grouped section headers with counts
    expect(within(dialog).getByRole('heading', { name: /customers/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /invoices/i })).toBeInTheDocument();
    // matched text is highlighted
    expect(within(dialog).getAllByText('Globex', { selector: 'mark' }).length).toBeGreaterThanOrEqual(1);
    // scope tab filters to invoices only
    fireEvent.click(within(dialog).getByRole('tab', { name: /invoices/i }));
    await waitFor(() =>
      expect(within(dialog).queryByRole('heading', { name: /customers/i })).not.toBeInTheDocument()
    );
    expect(within(dialog).getByRole('heading', { name: /invoices/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: /invoices/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers quick actions on idle and a footer see-all link on results', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /search.*k/i }));
    const dialog = await screen.findByRole('dialog', { name: /global search/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /open pos/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sales-flow/pos'));
    // footer see-all on the results view
    fireEvent.click(screen.getByRole('button', { name: /search.*k/i }));
    const dialog2 = await screen.findByRole('dialog', { name: /global search/i });
    const box2 = within(dialog2).getByRole('combobox', { name: /global search/i });
    fireEvent.change(box2, { target: { value: 'globex' } });
    await waitFor(() =>
      expect(within(dialog2).getByRole('status')).toHaveTextContent(/customer: 1/i)
    );
    fireEvent.click(within(dialog2).getByRole('button', { name: /see all results for “globex”/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/search?q=globex'));
  });
});
