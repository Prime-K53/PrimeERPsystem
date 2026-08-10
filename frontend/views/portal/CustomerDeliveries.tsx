import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Truck, Clock, User, Navigation,
  Search, X, CheckCircle2,
  AlertCircle, Loader2, Bell, Package, Phone, MapPin
} from 'lucide-react';
import { portalLifecycle, PortalShipmentRecord } from '../../services/portalApiClient';
import { sampleDeliveries } from './sampleData';
import { useCustomerAuth } from '../../context/CustomerAuthContext';
import EmptyState from './components/EmptyState';
import PortalLoadingSkeleton from './components/PortalLoadingSkeleton';
import { F } from './portalStyles';

// ── Status Badge Styles ─────────────────────────────────────────────────
const statusBadgeStyles: Record<string, { bg: string; color: string; border: string }> = {
  delivered: { bg: '#ECFDF5', color: '#065F46', border: '#A7F3D0' },
  out_for_delivery: { bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  dispatched: { bg: '#F8FAFC', color: '#475569', border: '#E2E8F0' },
  in_transit: { bg: '#F8FAFC', color: '#475569', border: '#E2E8F0' },
  processing: { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const key = status.toLowerCase().replace(/\s+/g, '_');
  const style = statusBadgeStyles[key] || statusBadgeStyles.dispatched;
  const label = status.replace(/_/g, ' ').toUpperCase();

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 9999,
      fontSize: 10.5,
      fontWeight: 700,
      letterSpacing: '0.05em',
      background: style.bg,
      color: style.color,
      border: `1px solid ${style.border}`,
      whiteSpace: 'nowrap',
      lineHeight: 1.4,
    }}>
      {label}
    </span>
  );
};

// ── Live Tracking Modal ─────────────────────────────────────────────────
interface TrackingDialogProps {
  shipment: PortalShipmentRecord;
  onClose: () => void;
}

const TrackingDialog: React.FC<TrackingDialogProps> = ({ shipment, onClose }) => {
  const orderNumber = shipment.order_number || shipment.id.slice(0, 8);
  const trackingNumber = shipment.tracking_number || '—';
  const driverName = shipment.driver_name || '—';
  const driverPhone = shipment.driver_phone || '—';
  const vehicleNo = shipment.vehicle_no || '—';
  const estimatedArrival = shipment.estimated_delivery
    ? new Date(shipment.estimated_delivery).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  const displayOrderNumber = orderNumber.replace(/^ORD-/i, '');
  const displayTrackingNumber = trackingNumber.replace(/^TRK-/i, '');

  const currentStage = (() => {
    const s = shipment.status.toLowerCase();
    if (s === 'delivered' || s === 'fulfilled') return 4;
    if (s === 'out_for_delivery') return 3;
    if (s === 'shipped' || s === 'in_transit' || s === 'dispatched') return 2;
    return 1;
  })();

  const stageDefinitions = [
    { label: 'Order Placed', icon: Package },
    { label: 'Warehouse Dispatched', icon: Truck },
    { label: 'Out for Delivery', icon: Navigation },
    { label: 'Delivered', icon: CheckCircle2 },
  ];

  const StatusIcon = currentStage === 4 ? CheckCircle2 : Truck;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
        fontFamily: F,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fff',
        borderRadius: 20,
        border: '1px solid #E2E8F0',
        boxShadow: '0 25px 50px -12px rgba(15,23,42,0.25)',
        width: '100%',
        maxWidth: 400,
        maxHeight: '90vh',
        overflowY: 'auto',
      }} role="dialog" aria-modal="true">
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid #F1F5F9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0F2C59' }}>
              Order ORD-{displayOrderNumber}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#64748B', marginTop: 2 }}>
              Tracking: TRK-{displayTrackingNumber}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: '1px solid #E2E8F0',
              background: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#64748B',
              transition: 'all 0.15s ease',
              flexShrink: 0,
            }}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '14px 24px 0', display: 'flex', justifyContent: 'center' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: '#059669',
            padding: '6px 12px',
            borderRadius: 8,
          }}>
            <CheckCircle2 size={16} style={{ color: '#fff' }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Status: DELIVERED</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 1 }}>ETA: {estimatedArrival}</div>
            </div>
          </div>
        </div>

        {/* Driver & Vehicle */}
        <div style={{ padding: '16px 24px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#F1F5F9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <User size={16} style={{ color: '#475569' }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1E293B' }}>Driver: {driverName}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#F1F5F9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Phone size={16} style={{ color: '#475569' }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1E293B' }}>Contact: {driverPhone}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#F1F5F9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Truck size={16} style={{ color: '#475569' }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1E293B', fontFamily: "'JetBrains Mono', monospace" }}>Vehicle: {vehicleNo}</div>
            </div>
          </div>
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Delivery Timeline
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {stageDefinitions.map((stage, idx) => {
              const isCompleted = idx < currentStage;
              return (
                <div key={stage.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: isCompleted ? '#059669' : '#E2E8F0',
                    flexShrink: 0,
                  }}>
                    {isCompleted ? (
                      <CheckCircle2 size={16} style={{ color: '#fff' }} />
                    ) : (
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#94A3B8' }} />
                    )}
                  </div>
                  <div style={{
                    fontSize: 13,
                    fontWeight: isCompleted ? 700 : 600,
                    color: isCompleted ? '#0F2C59' : '#94A3B8',
                  }}>
                    {stage.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ padding: '14px 20px 20px' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 11,
              border: 'none',
              background: 'linear-gradient(135deg, #0F2C59 0%, #0A1F42 100%)',
              color: '#fff',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              boxShadow: '0 6px 16px -6px rgba(15,44,89,.6)',
              fontFamily: F,
            }}
          >
            Close Tracker
          </button>
        </div>
      </div>

      <style>{`
        @keyframes delSlideUp {
          from { transform: translateY(100%); opacity: 0 }
          to { transform: translateY(0); opacity: 1 }
        }
        @keyframes delFadeIn {
          from { opacity: 0 }
          to { opacity: 1 }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>,
    document.body
  );
};

// ── Main Component ──────────────────────────────────────────────────────
const CustomerDeliveries: React.FC = () => {
  const { user } = useCustomerAuth();
  const [shipments, setShipments] = useState<PortalShipmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedShipment, setSelectedShipment] = useState<PortalShipmentRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await portalLifecycle.shipments.list();
      let filtered = data;
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter((s) =>
          (s.order_number || '').toLowerCase().includes(q) ||
          (s.tracking_number || '').toLowerCase().includes(q) ||
          (s.customerName || '').toLowerCase().includes(q)
        );
      }
      setShipments(filtered.length > 0 ? filtered : sampleDeliveries as any);
    } catch (err: any) {
      setError(err.message || 'Failed to load deliveries');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      unsubscribe = await portalLifecycle.subscribe({
        onEvent: (type, payload) => {
          if (type === 'entity_changed' && payload?.docType === 'order' && !cancelled) load();
        },
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [load]);

  const formatETA = (estimated_delivery?: string) => {
    if (!estimated_delivery) return '—';
    const d = new Date(estimated_delivery);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    if (diffDays === 0 && diffMs > 0) {
      return `Today, ${d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays === 1) {
      return `Tomorrow, ${d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays > 1 && diffDays <= 7) {
      return `In ${diffDays} days, ${d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    }
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDelivered = (estimated_delivery?: string) => {
    if (!estimated_delivery) return '—';
    return new Date(estimated_delivery).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div style={{ padding: '0 16px', maxWidth: 800, margin: '0 auto' }}>
        <PortalLoadingSkeleton type="table" count={6} />
      </div>
    );
  }

  return (
    <div style={{ fontFamily: F, fontSize: 13.5, lineHeight: 1.45, color: '#1E293B' }}>
      {/* Top Bar Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16,
        margin: '4px 16px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 50, height: 50, borderRadius: 15,
            background: 'linear-gradient(160deg, #4A76B5 0%, #0F2C59 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 8px 20px -8px rgba(15,44,89,0.6), inset 0 1px 0 rgba(255,255,255,0.25)',
          }}>
            <Truck size={24} style={{ color: '#fff' }} />
          </div>
          <div>
            <h1 style={{ fontSize: 21, fontWeight: 700, color: '#0F172A', margin: 0, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
              Deliveries &amp; Tracking
            </h1>
            <p style={{ fontSize: 13, fontWeight: 500, color: '#64748B', margin: '3px 0 0', lineHeight: 1.4 }}>
              Receive live dispatch notifications and track active logistics shipments in real time.
            </p>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 16px 28px' }}>
        {error && (
          <div style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            color: '#DC2626',
            fontSize: 13,
            fontWeight: 500,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {/* Search */}
        <div style={{ position: 'relative', marginBottom: 16 }}>
          <Search size={16} style={{
            position: 'absolute',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#94A3B8',
          }} />
          <input
            type="text"
            placeholder="Search by order #, tracking #, or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 14px 10px 40px',
              borderRadius: 12,
              background: '#fff',
              border: '1px solid #E2E8F0',
              fontSize: 13,
              fontWeight: 500,
              color: '#1E293B',
              fontFamily: F,
              outline: 'none',
              boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
              transition: 'all 0.15s ease',
            }}
          />
        </div>

        {/* Deliveries List — no cards, no KPIs */}
        {shipments.length === 0 ? (
          <EmptyState
            icon={<Truck size={32} />}
            title="No deliveries yet"
            description={search ? 'No deliveries match your search.' : 'When your orders are dispatched, tracking information will appear here.'}
          />
        ) : (
          <div>
            {shipments.map((shipment, index) => {
              const orderNumber = shipment.order_number || shipment.id.slice(0, 8);
              const trackingNumber = shipment.tracking_number || '—';
              const driverName = shipment.driver_name || '—';
              const vehicleNo = shipment.vehicle_no || '—';
              const destination = shipment.shipping_address || shipment.customerName || '—';

              const displayOrderNumber = orderNumber.replace(/^ORD-/i, '');
              const displayTrackingNumber = trackingNumber.replace(/^TRK-/i, '');

              const status = (shipment.status || '').toLowerCase();
              const isDelivered = status === 'delivered' || status === 'fulfilled';
              const etaText = isDelivered
                ? formatDelivered(shipment.estimated_delivery)
                : formatETA(shipment.estimated_delivery);

              const isLast = index === shipments.length - 1;

              return (
                  <div
                    key={shipment.id}
                    style={{
                      paddingTop: 10,
                      paddingBottom: 10,
                      paddingLeft: 12,
                      paddingRight: 12,
                      borderBottom: isLast ? 'none' : '1px solid #F1F5F9',
                      borderLeft: '3px solid transparent',
                      borderRadius: 8,
                      background: '#fff',
                      transition: 'all 200ms cubic-bezier(.4,0,.2,1)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#F8FAFC';
                      e.currentTarget.style.borderLeftColor = '#0F2C59';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#fff';
                      e.currentTarget.style.borderLeftColor = 'transparent';
                    }}
                  >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0, lineHeight: 1.3, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                          Order ORD-{displayOrderNumber}
                        </h3>
                        <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                          Tracking No: TRK-{displayTrackingNumber}
                        </div>
                      </div>
                      <StatusBadge status={shipment.status} />
                    </div>

                    <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <User size={13} style={{ color: '#64748B', flexShrink: 0 }} />
                      <span>
                        Driver: {driverName}{driverName !== '—' ? ` (${vehicleNo})` : ''}
                      </span>
                    </div>

                    <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <MapPin size={13} style={{ color: '#64748B', flexShrink: 0, marginTop: 2 }} />
                      <span>{destination}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 auto' }}>
                        <Clock size={14} style={{ color: '#2563EB', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#1E40AF', whiteSpace: 'nowrap' }}>Estimated Arrival</span>
                        <span style={{ fontSize: 10.5, color: '#64748B', whiteSpace: 'nowrap' }}>
                          {isDelivered ? `Delivered ${etaText}` : etaText}
                        </span>
                      </div>
                      <button
                        onClick={() => setSelectedShipment(shipment)}
                        style={{
                          padding: '8px 14px',
                          borderRadius: 9,
                          border: 'none',
                          background: 'linear-gradient(135deg, #0F2C59 0%, #0A1F42 100%)',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          boxShadow: '0 4px 14px -4px rgba(15,44,89,0.55)',
                          transition: 'all .15s ease',
                          fontFamily: F,
                          lineHeight: 1.4,
                        }}
                      >
                        <Navigation size={13} /> Live Tracking
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Live Tracking Modal */}
      {selectedShipment && (
        <TrackingDialog
          shipment={selectedShipment}
          onClose={() => setSelectedShipment(null)}
        />
      )}
    </div>
  );
};

export default CustomerDeliveries;
