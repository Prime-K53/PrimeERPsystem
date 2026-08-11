import React from 'react';
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  MapPin,
  MessageSquare,
  Navigation,
  Package,
  PhoneCall,
  ShieldCheck,
  Truck,
  User,
  X,
} from 'lucide-react';
import { DeliveryNotification, DeliveryStatus } from '../../types';
import { formatDateTime, getDeliveryStatusBadge } from '../../utils/formatters';

interface DeliveryTrackingModalProps {
  delivery: DeliveryNotification | null;
  isOpen: boolean;
  onClose: () => void;
}

export const DeliveryTrackingModal: React.FC<DeliveryTrackingModalProps> = ({
  delivery,
  isOpen,
  onClose,
}) => {
  if (!isOpen || !delivery) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div className="bg-white w-full max-w-sm sm:max-w-md rounded-3xl shadow-2xl border border-slate-100 overflow-hidden flex flex-col p-6 animate-slide-up space-y-5">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-black text-slate-900 tracking-tight">
              Order #{delivery.orderId}
            </h2>
            <p className="text-xs font-semibold text-slate-500 mt-0.5">
              Tracking: {delivery.trackingNumber}
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-full text-slate-700 hover:bg-slate-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Box */}
        <div className="flex items-center gap-3.5 p-3.5 bg-slate-50 rounded-2xl border border-slate-100">
          <div className="p-2.5 rounded-xl bg-slate-900 text-white shrink-0">
            <Package className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-black text-slate-900 uppercase">
              Status: <span className="text-slate-900">{delivery.status.replace('_', ' ').toUpperCase()}</span>
            </p>
            <p className="text-xs font-bold text-slate-600 mt-0.5">
              ETA: {delivery.estimatedArrival || 'Aug 12, 10:00 AM'}
            </p>
          </div>
        </div>

        {/* Driver & Courier Details */}
        <div className="space-y-2.5 text-xs font-extrabold text-slate-900">
          <div className="flex items-center gap-2.5">
            <User className="w-4 h-4 text-slate-800 shrink-0" />
            <span>Driver: {delivery.driverName || 'Sam Harris'}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <PhoneCall className="w-4 h-4 text-slate-800 shrink-0" />
            <span>Contact: {delivery.driverPhone || '+1 (555) 720-1923'}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Truck className="w-4 h-4 text-slate-800 shrink-0" />
            <span>Vehicle: {delivery.vehicleNumber || 'TRK-109'}</span>
          </div>
        </div>

        {/* Delivery Timeline */}
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <h3 className="text-xs font-black text-slate-900 tracking-tight">Delivery Timeline</h3>

          <div className="space-y-3 pl-1">
            {/* Step 1 */}
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-slate-950 text-white flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <span className="text-xs font-black text-slate-900">Order Placed</span>
            </div>

            {/* Step 2 */}
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full border-2 border-slate-200 bg-slate-50 flex items-center justify-center shrink-0" />
              <span className="text-xs font-bold text-slate-500">Warehouse Dispatched</span>
            </div>

            {/* Step 3 */}
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full border-2 border-slate-200 bg-slate-50 flex items-center justify-center shrink-0" />
              <span className="text-xs font-bold text-slate-500">Out for Delivery</span>
            </div>

            {/* Step 4 */}
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full border-2 border-slate-200 bg-slate-50 flex items-center justify-center shrink-0" />
              <span className="text-xs font-bold text-slate-500">Delivered</span>
            </div>
          </div>
        </div>

        {/* Close Button */}
        <div className="pt-2">
          <button
            onClick={onClose}
            className="w-full py-3.5 bg-slate-950 hover:bg-slate-800 text-white font-extrabold text-xs rounded-full shadow-md transition text-center"
          >
            Close Tracker
          </button>
        </div>
      </div>
    </div>
  );
};
