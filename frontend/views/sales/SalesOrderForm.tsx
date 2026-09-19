import React, { useState, useMemo, useEffect } from 'react';
import { useSales } from '../../context/SalesContext';
import { useSalesOrderStore } from '../../stores/salesOrderStore';
import { useAuth } from '../../context/AuthContext';
import { getCustomerOptionLabel } from '../../utils/customerDisplay';
import type { SalesOrderItem, SalesOrder } from '../../types';
import { Printer } from 'lucide-react';

interface SalesOrderFormProps {
  initial?: SalesOrder;
  onDone?: () => void;
  onCreate?: (o: SalesOrder) => Promise<void>;
  /** Fired with the saved order after a successful create/update. */
  onSaved?: (saved: SalesOrder) => void;
}

interface OrderFormState extends SalesOrder {
  _creditWarning?: string;
}

const SalesOrderForm: React.FC<SalesOrderFormProps> = ({ initial, onDone, onCreate, onSaved }) => {
  const { customers } = useSales();
  const { createSalesOrder, updateSalesOrder } = useSalesOrderStore.getState();
  const { companyConfig } = useAuth();
  const [order, setOrder] = React.useState<OrderFormState>({ 
    id: '',
    items: [], 
    subtotal: 0, 
    total: 0, 
    status: 'Draft',
    discounts: 0,
    tax: 0,
    orderDate: new Date().toISOString()
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    if (initial) {
      setOrder({
        ...initial,
        _creditWarning: undefined,
        subtotal: initial.subtotal || 0,
        total: initial.total || 0
      });
      const c = (customers || []).find((x: any) => x.id === initial.customerId);
      setSearchTerm(c?.name || c?.id || initial.customerId || '');
    }
  }, [initial, customers]);

  // Item form state
  const [newItem, setNewItem] = useState<Partial<SalesOrderItem>>({
    productId: '',
    quantity: 1,
    unitPrice: 0
  });
  const [successModal, setSuccessModal] = useState<{ open: boolean; order: SalesOrder | null; isNew: boolean }>({ open: false, order: null, isNew: false });

  // Calculate totals based on items
  const calculatedSubtotal = useMemo(() => {
    return (order.items || []).reduce((sum, item) => {
      const lineTotal = (item.quantity || 0) * (item.unitPrice || 0);
      const discount = item.discount || 0;
      return sum + lineTotal - discount;
    }, 0);
  }, [order.items]);

  const calculatedTotal = useMemo(() => {
    const subtotal = calculatedSubtotal;
    const discounts = order.discounts || 0;
    const tax = order.tax || 0;
    return subtotal - discounts + tax;
  }, [calculatedSubtotal, order.discounts, order.tax]);

  const selectedCustomer = useMemo(() =>
    customers?.find((c: any) => c.id === order.customerId),
    [customers, order.customerId]
  );

  const filteredCustomers = useMemo(() => {
    if (!searchTerm) return customers || [];
    const term = searchTerm.toLowerCase();
    return (customers || []).filter((c: any) =>
      getCustomerOptionLabel(c).toLowerCase().includes(term) ||
      c.name?.toLowerCase().includes(term) ||
      c.id?.toLowerCase().includes(term) ||
      c.phone?.includes(term)
    );
  }, [customers, searchTerm]);

  const selectCustomer = (customer: any) => {
    const limit = Number(customer.creditLimit || 0);
    const outstanding = Number(customer.outstandingBalance || 0);
    // Use calculated total for credit check
    const willBe = outstanding + calculatedTotal;
    let warning = '';
    if (customer.creditHold) {
      warning = 'Customer is on credit hold.';
    } else if (limit > 0 && willBe > limit) {
      warning = `Credit limit ${limit} will be exceeded (${willBe}).`;
    }
    setOrder({ ...order, customerId: customer.id, _creditWarning: warning });
    setSearchTerm(getCustomerOptionLabel(customer));
    setShowDropdown(false);
  };

  // Add item to order
  const addItem = () => {
    if (!newItem.productId) {
      alert('Product ID is required');
      return;
    }
    
    const item: SalesOrderItem = {
      id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      productId: newItem.productId || '',
      description: newItem.description || '',
      quantity: Number(newItem.quantity) || 1,
      unitPrice: Number(newItem.unitPrice) || 0,
      discount: Number(newItem.discount) || 0,
      lineTotal: (Number(newItem.quantity) || 1) * (Number(newItem.unitPrice) || 0) - (Number(newItem.discount) || 0)
    };

    setOrder({
      ...order,
      items: [...(order.items || []), item],
      subtotal: calculatedSubtotal + item.lineTotal
    });

    // Reset item form
    setNewItem({
      productId: '',
      quantity: 1,
      unitPrice: 0,
      description: '',
      discount: 0
    });
  };

  // Remove item from order
  const removeItem = (itemId: string) => {
    setOrder({
      ...order,
      items: (order.items || []).filter(item => item.id !== itemId)
    });
  };

  // Update item in order
  const updateItem = (itemId: string, field: keyof SalesOrderItem, value: any) => {
    const updatedItems = (order.items || []).map(item => {
      if (item.id === itemId) {
        const updatedItem = { ...item, [field]: value };
        // Recalculate line total
        updatedItem.lineTotal = (updatedItem.quantity || 0) * (updatedItem.unitPrice || 0) - (updatedItem.discount || 0);
        return updatedItem;
      }
      return item;
    });

    setOrder({ ...order, items: updatedItems });
  };

  const save = async () => {
    const orderToSave = {
      ...order,
      subtotal: calculatedSubtotal,
      total: calculatedTotal,
      orderDate: order.orderDate || new Date().toISOString()
    };

    const isNew = !orderToSave.id;
    try {
      if (isNew) {
        if (onCreate) await onCreate(orderToSave); else await createSalesOrder(orderToSave);
      } else {
        await updateSalesOrder(orderToSave);
      }
      if (typeof onSaved === 'function') onSaved(orderToSave);
      // Show success modal before closing — mirrors Payments flow
      if (isNew) {
        setSuccessModal({ open: true, order: orderToSave as SalesOrder, isNew: true });
      } else {
        if (typeof onDone === 'function') onDone();
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to save sales order');
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px' }}>
      <h2>{order.id ? 'Edit' : 'New'} Sales Order</h2>
      
      {/* Customer Selection */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Customer</label>
        <div style={{ position: 'relative' }}>
          <input
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
            placeholder="Search customer by name, ID, or phone..."
            style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
          />
          {selectedCustomer && (
            <small style={{ display: 'block', color: '#666', marginTop: '4px' }}>
              Selected: {selectedCustomer.name} ({selectedCustomer.id})
            </small>
          )}
          {order._creditWarning && (
            <div style={{ color: 'red', fontSize: 12, marginTop: 4 }}>{order._creditWarning}</div>
          )}
          {showDropdown && (
            <ul style={{ 
              position: 'absolute', 
              zIndex: 10, 
              background: 'white', 
              border: '1px solid #ccc', 
              maxHeight: 200, 
              overflow: 'auto', 
              listStyle: 'none', 
              padding: 0, 
              margin: 0, 
              width: '100%',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}>
              {filteredCustomers.map((c: any) => (
                <li
                  key={c.id}
                  onMouseDown={() => selectCustomer(c)}
                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                >
                  {getCustomerOptionLabel(c)} ({c.id}) {c.creditHold ? '⚠️ HOLD' : ''}
                </li>
              ))}
              {filteredCustomers.length === 0 && (
                <li style={{ padding: '8px 12px', color: '#999' }}>No customers found</li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* Reference */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Reference</label>
        <input
          value={order.referenceDoc || ''}
          onChange={e => setOrder({ ...order, referenceDoc: e.target.value })}
          placeholder="Request or document reference"
          style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
        />
      </div>

      {/* Items Section */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ borderBottom: '2px solid #eee', paddingBottom: '8px' }}>Order Items</h3>
        
        {/* Items Table */}
        {(order.items || []).length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '15px' }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #ddd' }}>Product</th>
                <th style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #ddd' }}>Qty</th>
                <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Price</th>
                <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Discount</th>
                <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Total</th>
                <th style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #ddd' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {(order.items || []).map(item => (
                <tr key={item.id}>
                  <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                    <input
                      value={item.description || ''}
                      onChange={e => updateItem(item.id, 'description', e.target.value)}
                      placeholder="Product description"
                      style={{ width: '100%', border: 'none', padding: '4px' }}
                    />
                  </td>
                  <td style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #eee' }}>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity || 1}
                      onChange={e => updateItem(item.id, 'quantity', Number(e.target.value))}
                      style={{ width: '60px', textAlign: 'center' }}
                    />
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee' }}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice || 0}
                      onChange={e => updateItem(item.id, 'unitPrice', Number(e.target.value))}
                      style={{ width: '80px', textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee' }}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.discount || 0}
                      onChange={e => updateItem(item.id, 'discount', Number(e.target.value))}
                      style={{ width: '70px', textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee', fontWeight: 'bold' }}>
                    {(item.lineTotal || 0).toFixed(2)}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #eee' }}>
                    <button
                      onClick={() => removeItem(item.id)}
                      style={{ background: '#ff4444', color: 'white', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer' }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: '#999', fontStyle: 'italic' }}>No items added yet</p>
        )}

        {/* Add Item Form */}
        <div style={{ border: '1px dashed #ccc', padding: '15px', borderRadius: '4px', background: '#fafafa' }}>
          <h4 style={{ marginTop: 0 }}>Add New Item</h4>
           <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '10px', alignItems: 'start' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Product ID</label>
              <input
                value={newItem.productId || ''}
                onChange={e => setNewItem({ ...newItem, productId: e.target.value })}
                placeholder="Enter product ID"
                style={{ width: '100%', padding: '6px', border: '1px solid #ccc', borderRadius: '4px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Quantity</label>
              <input
                type="number"
                min="1"
                value={newItem.quantity || 1}
                onChange={e => setNewItem({ ...newItem, quantity: Number(e.target.value) })}
                style={{ width: '100%', padding: '6px', border: '1px solid #ccc', borderRadius: '4px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Unit Price</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={newItem.unitPrice || 0}
                onChange={e => setNewItem({ ...newItem, unitPrice: Number(e.target.value) })}
                style={{ width: '100%', padding: '6px', border: '1px solid #ccc', borderRadius: '4px' }}
              />
            </div>
            <button
              onClick={addItem}
              style={{
                background: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 12px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              Add Item
            </button>
          </div>
        </div>
      </div>

      {/* Totals Summary */}
      <div style={{ 
        border: '1px solid #ddd', 
        padding: '15px', 
        borderRadius: '4px', 
        background: '#f9f9f9',
        marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span>Subtotal:</span>
          <span style={{ fontWeight: 'bold' }}>{calculatedSubtotal.toFixed(2)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span>Discounts:</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={order.discounts || 0}
            onChange={e => setOrder({ ...order, discounts: Number(e.target.value) })}
            style={{ width: '100px', textAlign: 'right', padding: '4px', border: '1px solid #ccc' }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span>Tax:</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={order.tax || 0}
            onChange={e => setOrder({ ...order, tax: Number(e.target.value) })}
            style={{ width: '100px', textAlign: 'right', padding: '4px', border: '1px solid #ccc' }}
          />
        </div>
        <hr style={{ margin: '10px 0', border: 'none', borderTop: '2px solid #333' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px' }}>
          <span style={{ fontWeight: 'bold' }}>Total:</span>
          <span style={{ fontWeight: 'bold', color: '#2196F3' }}>{calculatedTotal.toFixed(2)}</span>
        </div>
      </div>

      {/* Notes */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Notes</label>
        <textarea 
          value={order.notes || ''} 
          onChange={e => setOrder({ ...order, notes: e.target.value })}
          style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', minHeight: '80px' }}
        />
      </div>

      {/* Save Button */}
      <div>
        <button 
          onClick={save} 
          className="btn"
          style={{ 
            background: '#2196F3', 
            color: 'white', 
            border: 'none', 
            padding: '12px 24px',
            borderRadius: '4px',
            fontSize: '16px',
            fontWeight: 'bold',
            cursor: 'pointer'
          }}
        >
          Save Sales Order
        </button>
      </div>

      {/* Invoice Saved Modal — mimics Payment Successful modal design */}
      {successModal.open && successModal.order && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => { setSuccessModal({ open: false, order: null, isNew: false }); if (typeof onDone === 'function') onDone(); }}
        >
          <div
            className="bg-[#FEFDFB] rounded-2xl shadow-2xl border border-[#e4ddd1] w-full max-w-[420px] overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="invoice-success-title"
          >
            <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, #1f8577, #3fa294 50%, #d99a3f 100%)' }} />
            <div className="p-6 sm:p-7 text-center">
              <div className="w-14 h-14 rounded-full bg-[#eef7f6] border border-[#d3ece9] flex items-center justify-center mx-auto mb-4">
                <div className="w-10 h-10 rounded-full bg-[#1f8577] flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </div>
              </div>
              <h2 id="invoice-success-title" className="text-[18px] font-bold text-[#0b3e39] tracking-tight">Invoice Saved</h2>
              <p className="text-[12px] text-[#5c6567] mt-1">Invoice <span className="font-mono font-bold text-[#23282A]">{successModal.order.id || '—'}</span> has been created</p>
              <div className="mt-5 bg-[#eef7f6]/60 border border-[#e4ddd1] rounded-xl p-4 text-left space-y-2.5">
                <div className="flex justify-between items-center text-[12px]">
                  <span className="text-[#5c6567] font-semibold">Customer</span>
                  <span className="font-bold text-[#23282A] truncate max-w-[180px]">{customers.find((c:any)=>c.id===successModal.order!.customerId)?.name || successModal.order.customerId || '—'}</span>
                </div>
                <div className="flex justify-between items-center text-[12px]">
                  <span className="text-[#5c6567] font-semibold">Total</span>
                  <span className="font-bold text-[#0f544c]">{companyConfig.currencySymbol || '$'}{(successModal.order.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between items-center text-[11px] pt-2 border-t border-[#e4ddd1]">
                  <span className="text-[#5c6567]">{new Date(successModal.order.orderDate || new Date().toISOString()).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#eef7f6] border border-[#d3ece9] text-[10px] font-bold text-[#0f544c] uppercase">{successModal.order.status || 'Draft'}</span>
                </div>
              </div>
              <div className="mt-6 flex flex-col sm:flex-row gap-2">
                <button
                  onClick={async () => {
                    const o = successModal.order!;
                    setSuccessModal({ open: false, order: null, isNew: false });
                    if (typeof onDone === 'function') onDone();
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white shadow-sm hover:brightness-110 active:scale-[0.98] transition-all"
                  style={{ background: 'linear-gradient(155deg, #1f8577, #0f544c)' }}
                >
                  <Printer size={16} /> View Invoice
                </button>
                <button
                  onClick={() => { setSuccessModal({ open: false, order: null, isNew: false }); if (typeof onDone === 'function') onDone(); }}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold bg-white border border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6] hover:border-[#d3ece9] active:scale-[0.98] transition-all"
                >
                  Done
                </button>
              </div>
              <button
                onClick={() => {
                  setSuccessModal({ open: false, order: null, isNew: false });
                  setOrder({ id: '', items: [], subtotal: 0, total: 0, status: 'Draft', discounts: 0, tax: 0, orderDate: new Date().toISOString() } as any);
                  setSearchTerm('');
                }}
                className="mt-3 text-[12px] font-semibold text-[#1f8577] hover:text-[#0f544c] hover:underline"
              >
                + Create another invoice
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SalesOrderForm;