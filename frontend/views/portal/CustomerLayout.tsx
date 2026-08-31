import React, { useState, useEffect, useCallback, Component, ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useCustomerAuth } from '../../context/CustomerAuthContext';
import { portalLifecycle } from '../../services/portalApiClient';
import PortalSidebar from './components/PortalSidebar';
import { ToastProvider } from './components/Toast';
import CommandPalette from './components/CommandPalette';
import MobileBottomNav from './components/MobileBottomNav';
import { ThemeProvider } from './context/ThemeContext';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PortalErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  props: { children: ReactNode };
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[PortalErrorBoundary] Caught error:', error, errorInfo);
  }

  handleRetry = () => {
    this.state = { hasError: false, error: null };
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 12 }}>
          <div style={{
            background: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(226,232,240,0.8)',
            borderRadius: 16,
            padding: 24,
            textAlign: 'center',
            boxShadow: '0 4px 24px rgba(15,44,89,0.08)',
          }}>
            <div style={{
              width: 56,
              height: 56,
              margin: '0 auto 14px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <AlertTriangle size={26} style={{ color: '#DC2626' }} />
            </div>
            <h2 style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#0F172A',
              margin: '0 0 8px',
              letterSpacing: '-0.01em',
            }}>
              Something went wrong
            </h2>
            <p style={{
              fontSize: 13,
              color: '#64748B',
              margin: '0 0 20px',
              lineHeight: 1.5,
            }}>
              An unexpected error occurred. Please try again.
            </p>
            <button
              onClick={this.handleRetry}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 20px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background: 'linear-gradient(135deg, #0F2C59 0%, #0A1F42 100%)',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 12px -2px rgba(15,44,89,0.3)',
              }}
            >
              <RefreshCw size={14} /> Try Again
            </button>
            {this.state.error && (
              <details style={{
                marginTop: 20,
                textAlign: 'left',
                padding: '12px 16px',
                background: 'rgba(248,250,252,0.8)',
                borderRadius: 10,
                border: '1px solid #E2E8F0',
              }}>
                <summary style={{
                  fontSize: 11,
                  color: '#94A3B8',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}>
                  Error details
                </summary>
                <pre style={{
                  marginTop: 10,
                  padding: 12,
                  background: '#fff',
                  borderRadius: 8,
                  fontSize: 11,
                  color: '#64748B',
                  overflow: 'auto',
                  maxHeight: 160,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {this.state.error.message}
                  {this.state.error.stack && `\n\n${this.state.error.stack}`}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const pageTitles: Record<string, string> = {
  '/portal/dashboard': 'Dashboard',
  '/portal/requests': 'Requests',
  '/portal/orders': 'Product Orders',
  '/portal/quotations': 'Quotations',
  '/portal/invoices': 'Invoices',
  '/portal/payments': 'Receipt',
  '/portal/payment-options': 'Payment Options',
  '/portal/referrals': 'Referrals',
  '/portal/wallet': 'Wallet',
  '/portal/shipments': 'Deliveries & Tracking',
  '/portal/deliveries': 'Deliveries & Tracking',
  '/portal/support': 'Support',
  '/portal/profile': 'Profile',
};

const SF = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const CustomerLayout: React.FC = () => {
  const { isAuthenticated, loading } = useCustomerAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  const currentTitle = pageTitles[location.pathname] || 'Customer Portal';

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    document.title = currentTitle && currentTitle !== 'Customer Portal'
      ? `PrimePORTAL · ${currentTitle}`
      : 'PrimePORTAL';
  }, [currentTitle]);

  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleToggle = () => setSidebarOpen((v) => !v);
    window.addEventListener('toggle-portal-sidebar', handleToggle);
    return () => window.removeEventListener('toggle-portal-sidebar', handleToggle);
  }, []);

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #F8FAFC 0%, #EEF2F9 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          width: 32,
          height: 32,
          border: '3px solid rgba(15,44,89,0.1)',
          borderTopColor: '#0F2C59',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/portal/login" replace />;
  }

  return (
    <ThemeProvider>
      <ToastProvider>
        <div style={{
          minHeight: '100vh',
          background: 'linear-gradient(135deg, #F8FAFC 0%, #EEF2F9 50%, #F1F5F9 100%)',
          fontFamily: SF,
          color: '#1E293B',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'fixed',
            inset: 0,
            background: 'radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.05) 0%, transparent 50%)',
            pointerEvents: 'none',
          }} />
          <div style={{
            position: 'fixed',
            inset: 0,
            background: 'radial-gradient(ellipse at 80% 100%, rgba(5,150,105,0.04) 0%, transparent 50%)',
            pointerEvents: 'none',
          }} />

          {sidebarOpen && (
            <div
              onClick={closeSidebar}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 40,
                background: 'rgba(15,44,89,0.3)',
                backdropFilter: 'blur(4px)',
              }}
            />
          )}
          <PortalSidebar
            isOpen={sidebarOpen}
            onClose={closeSidebar}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            moduleName={location.pathname === '/portal/dashboard' ? undefined : currentTitle}
          />
          <main
            id="main-content"
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflowX: 'auto',
              overflowY: 'auto',
              transition: 'left 0.2s ease',
            }}
          >
            <div
              className="portal-module"
              style={{
                padding: '12px 14px 20px',
                maxWidth: 1400,
                margin: '0 auto',
              }}
            >
              <PortalErrorBoundary>
                <Outlet />
              </PortalErrorBoundary>
            </div>
          </main>
          <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
          <MobileBottomNav />
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
};

export default CustomerLayout;
