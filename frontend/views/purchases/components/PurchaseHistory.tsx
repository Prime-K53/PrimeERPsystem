import React, { useState, useRef, useEffect, useMemo } from 'react';
import { logger } from '@/services/logger';
import { useLocation } from 'react-router-dom';
import { useHighlight } from '../../../hooks/useHighlight';
import { DocLink } from '../../../components/DocLink';
import { Package, CheckCircle, Eye, DollarSign, Trash2, ChevronRight, RefreshCw, Edit2, Layers, CheckSquare, Square, XCircle, FileText, Download, FileDown, Search, X, ArrowUp, ArrowDown, MoreVertical } from 'lucide-react';
import { Purchase } from '../../../types';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../shared/components/PDF/PrimeDocument';
import { initializePrimePdfFonts } from '../../shared/components/PDF/templateSettings';
import { useAuth } from '../../../context/AuthContext';
import { useInventory } from '../../../context/InventoryContext';
import { WhatsAppLogo } from '../../../components/Icons';
import { usePagination } from '../../../hooks/usePagination';
import Pagination from '../../../components/Pagination';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { useDocumentPreview } from '../../../hooks/useDocumentPreview';
import { downloadBlob } from '../../../utils/helpers';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { TableEmptyState } from '../../../components/EmptyState';

const paper = '#FEFDFB';
const hairline = '#e4ddd1';

interface PurchaseHistoryProps {
    purchases: Purchase[];
    suppliers: any[];
    onReceive: (id: string) => void;
    onView?: (purchase: Purchase) => void;
    onEdit: (purchase: Purchase) => void;
    onMerge: (ids: string[]) => void;
    onBatchDelete: (ids: string[]) => void;
    onPayment?: (purchase: Purchase) => void;
}

const SortableTh: React.FC<{
    field: string;
    sortConfig?: { field: any; direction: 'asc' | 'desc' } | null;
    onSort?: (field: any) => void;
    className?: string;
    children: React.ReactNode;
}> = ({ field, sortConfig, onSort, className = '', children }) => {
    const isActive = sortConfig?.field === field;
    const isRight = className.includes('text-right');
    const isCenter = className.includes('text-center');
    return (
        <th
            aria-sort={isActive ? (sortConfig?.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            className={`table-header select-none ${className} ${isActive ? 'text-[#0b3e39] font-bold' : ''}`}
        >
            <button
                type="button"
                onClick={() => onSort?.(field)}
                aria-label={`Sort by ${typeof children === 'string' ? children : field}${isActive ? ` (currently ${sortConfig?.direction === 'asc' ? 'ascending' : 'descending'})` : ''}`}
                className={`flex items-center gap-1 w-full bg-transparent border-0 p-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#3B82F6] focus-visible:outline-offset-2 focus-visible:rounded ${isRight ? 'justify-end' : isCenter ? 'justify-center' : 'justify-start'}`}
                style={{ font: 'inherit', color: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit' }}
            >
                {children}
                {isActive ? (
                    sortConfig?.direction === 'asc' ? <ArrowUp size={12} className="text-[#1f8577] shrink-0" aria-hidden="true" /> : <ArrowDown size={12} className="text-[#1f8577] shrink-0" aria-hidden="true" />
                ) : (
                    <span aria-hidden="true" className="opacity-0" />
                )}
            </button>
        </th>
    );
};

const useContextMenu = () => {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null);
    const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpenMenuId(null); setMenuPos(null); setActiveSubmenu(null);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleContextMenu = (e: React.MouseEvent, id: string) => {
        e.preventDefault();
        e.stopPropagation();
        setOpenMenuId(id);
        const x = Math.min(e.clientX, window.innerWidth - 260);
        const y = Math.min(e.clientY, window.innerHeight - 300);
        setMenuPos({ x, y });
        setActiveSubmenu(null);
    };

    const handleRowClick = (e: React.MouseEvent, id: string) => {
        e.preventDefault();
        e.stopPropagation();
        if (openMenuId === id) {
            setOpenMenuId(null);
        } else {
            const x = Math.min(e.clientX, window.innerWidth - 260);
            const y = Math.min(e.clientY, window.innerHeight - 300);
            setMenuPos({ x, y });
            setOpenMenuId(id);
            setActiveSubmenu(null);
        }
    };

    return { openMenuId, menuPos, activeSubmenu, setActiveSubmenu, menuRef, handleContextMenu, handleRowClick, setOpenMenuId };
};

const useHoverTimer = (delay: number = 2000) => {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
    const timerRef = useRef<any | null>(null);
    const activeIdRef = useRef<string | null>(null);

    const onMouseEnter = (id: string, e: React.MouseEvent) => {
        const { clientX, clientY } = e;
        activeIdRef.current = id;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (activeIdRef.current === id) {
                setHoveredId(id);
                setHoverPos({ x: clientX, y: clientY });
            }
        }, delay);
    };

    const onMouseMove = (e: React.MouseEvent) => {
        const { clientX, clientY } = e;
        if (hoveredId) {
            setHoveredId(null);
            activeIdRef.current = null;
            if (timerRef.current) clearTimeout(timerRef.current);
            return;
        }
        if (activeIdRef.current) {
            const currentId = activeIdRef.current;
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                if (activeIdRef.current === currentId) {
                    setHoveredId(currentId);
                    setHoverPos({ x: clientX, y: clientY });
                }
            }, delay);
        }
    };

    const onMouseLeave = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setHoveredId(null);
        activeIdRef.current = null;
    };

    return { hoveredId, hoverPos, onMouseEnter, onMouseMove, onMouseLeave };
};

const HoverPurchaseMenu: React.FC<{ id: string; pos: { x: number; y: number }; data: any; }> = ({ id, pos, data }) => {
    const { companyConfig } = useAuth();
    const currency = companyConfig.currencySymbol;
    if (!data) return null;
    const total = (data.total ?? data.totalAmount ?? 0) as number;
    const paid = (data.paidAmount ?? 0) as number;
    const balance = Math.max(0, total - paid);
    return (
        <div className="fixed z-[200] pointer-events-auto animate-in fade-in zoom-in-95 duration-200" style={{ top: pos.y + 15, left: pos.x + 15 }}>
            <div className="bg-[#23282A]/95 backdrop-blur-md border border-[#5c6567]/50 rounded-2xl shadow-premium p-4 min-w-[280px] flex flex-col gap-3 text-white">
                <div className="flex items-center gap-3 border-b border-[#5c6567]/50 pb-3">
                    <div className="w-8 h-8 rounded-lg bg-[#1f857720] flex items-center justify-center text-[#72c0b7]">
                        <Package size={16} />
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-[#72c0b7] tracking-tight">Bill details</p>
                        <p className="text-xs font-bold font-mono">{id}</p>
                    </div>
                </div>
                <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                    <p className="text-[10px] font-bold text-[#5c6567] tracking-tight mb-2">Items summary</p>
                    {data.items && data.items.length > 0 ? (
                        data.items.slice(0, 5).map((item: any, idx: number) => (
                            <div key={idx} className="flex justify-between items-start gap-4 text-xs py-1 border-b border-white/5 last:border-0">
                                <span className="text-[#FEFDFB] font-medium line-clamp-1">{item.name || item.productName || 'Item'}</span>
                                <span className="text-[#72c0b7] font-bold whitespace-nowrap">x{item.quantity ?? item.qty ?? 0}</span>
                            </div>
                        ))
                    ) : (
                        <p className="text-[10px] text-[#5c6567] italic">No items listed</p>
                    )}
                    {data.items && data.items.length > 5 && (
                        <p className="text-[10px] text-[#72c0b7] mt-1">+{data.items.length - 5} more items</p>
                    )}
                </div>
                <div className="mt-2 pt-2 border-t border-[#5c6567]/50 flex justify-between items-center">
                    <span className="text-[10px] font-bold text-[#5c6567] tracking-tight">Total value</span>
                    <span className="text-[13px] font-bold text-[#3fa294] finance-nums">{currency}{total.toLocaleString()}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-1">
                    <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-2">
                        <div className="text-[9px] font-bold text-[#5c6567] uppercase tracking-tight">Paid</div>
                        <div className="text-[11px] font-bold text-[#72c0b7] finance-nums">{currency}{paid.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-2">
                        <div className="text-[9px] font-bold text-[#5c6567] uppercase tracking-tight">Balance</div>
                        <div className={`text-[11px] font-bold finance-nums ${balance > 0 ? 'text-[#d99a3f]' : 'text-[#3fa294]'}`}>{currency}{balance.toLocaleString()}</div>
                    </div>
                </div>
                <div className="bg-white/5 rounded-lg p-2 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-[#72c0b7] rounded-full animate-pulse"></div>
                    <span className="text-[9px] text-[#FEFDFB] font-bold tracking-tight font-mono italic">Secure snapshot</span>
                </div>
            </div>
        </div>
    );
};

const LIST_ITEMS_PER_PAGE = 10;

export const PurchaseHistory: React.FC<PurchaseHistoryProps> = ({ purchases, suppliers, onReceive, onView, onEdit, onMerge, onBatchDelete, onPayment }) => {
    const { companyConfig, notify } = useAuth(); const { updatePurchase } = useInventory();
    const { handlePreview } = useDocumentPreview();
    const currency = companyConfig.currencySymbol;
    const location = useLocation();
    useHighlight();

    const { openMenuId, menuPos, activeSubmenu, setActiveSubmenu, menuRef, handleContextMenu, handleRowClick, setOpenMenuId } = useContextMenu();
    const { hoveredId, hoverPos, onMouseEnter, onMouseMove, onMouseLeave } = useHoverTimer(2000);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [sortConfig, setSortConfig] = useState<{ field: string; direction: 'asc' | 'desc' } | null>(null);
    const [adminPasswordModal, setAdminPasswordModal] = useState({
      open: false,
      po: null as Purchase | null,
    });
    const [adminPasswordInput, setAdminPasswordInput] = useState('');

    const getSupplierName = (po: Purchase) => {
        const supplier = (suppliers || []).find(s => s.id === po.supplierId) || (suppliers || []).find(s => s.name === po.supplierId);
        return supplier?.name || po.supplierId || '';
    };

    const filteredSortedData = useMemo(() => {
        let data = [...(purchases || [])];
        if (searchTerm) {
            const q = searchTerm.toLowerCase();
            data = data.filter(po => {
                const supplierName = getSupplierName(po).toLowerCase();
                const ref = (po.reference || '').toLowerCase();
                const status = (po.status || '').toLowerCase();
                const payment = (po.paymentStatus || '').toLowerCase();
                return po.id.toLowerCase().includes(q) || supplierName.includes(q) || ref.includes(q) || status.includes(q) || payment.includes(q);
            });
        }
        if (sortConfig) {
            data.sort((a: any, b: any) => {
                let aVal: any; let bVal: any;
                switch (sortConfig.field) {
                    case 'id': aVal = a.id; bVal = b.id; break;
                    case 'date': aVal = a.date; bVal = b.date; break;
                    case 'supplierName': aVal = getSupplierName(a); bVal = getSupplierName(b); break;
                    case 'reference': aVal = a.reference || ''; bVal = b.reference || ''; break;
                    case 'dueDate': aVal = a.dueDate || ''; bVal = b.dueDate || ''; break;
                    case 'total': aVal = a.total ?? a.totalAmount ?? 0; bVal = b.total ?? b.totalAmount ?? 0; break;
                    case 'paymentStatus': aVal = a.paymentStatus || ''; bVal = b.paymentStatus || ''; break;
                    case 'status': aVal = a.status || ''; bVal = b.status || ''; break;
                    default: aVal = a[sortConfig.field]; bVal = b[sortConfig.field];
                }
                if (aVal == null) aVal = ''; if (bVal == null) bVal = '';
                if (typeof aVal === 'string' && typeof bVal === 'string') {
                    const cmp = aVal.localeCompare(bVal);
                    return sortConfig.direction === 'asc' ? cmp : -cmp;
                }
                if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }
        return data;
    }, [purchases, suppliers, searchTerm, sortConfig]);

    const { currentItems, currentPage, maxPage, totalItems, next, prev, first, last, setItemsPerPage, itemsPerPage } = usePagination(filteredSortedData as any, LIST_ITEMS_PER_PAGE);

    const handleSort = (field: string) => {
        setSortConfig(prev => {
            if (prev?.field === field) {
                return { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
            }
            return { field, direction: 'asc' };
        });
    };

    const enrichPO = (po: Purchase) => {
        const supplier = (suppliers || []).find(s => s.id === po.supplierId) || (suppliers || []).find(s => s.name === po.supplierId);
        return {
            ...po,
            supplierName: supplier?.name || po.supplierId,
            vendorName: supplier?.name || po.supplierId,
            vendorAddress: supplier?.address,
            vendorPhone: supplier?.phone,
            address: supplier?.address,
            phone: supplier?.phone,
            clientName: supplier?.name || po.supplierId
        };
    };

    const handleToggleSelect = (id: string) => {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };

    const handleMergeClick = () => {
        onMerge(selectedIds);
        setSelectedIds([]);
    };

    const handleDownloadPDF = async (po: Purchase) => {
        try {
            notify("Preparing Purchase Order PDF...", "info");
            const enriched = enrichPO(po);
            const pdfData = mapToInvoiceData(enriched, companyConfig, 'PO');
            const securedPdfData = await attachDocumentSecurity(pdfData, companyConfig?.companyName);
            await initializePrimePdfFonts();
            const blob = await pdf(<PrimeDocument type="PO" data={securedPdfData} />).toBlob();
            const poNumber = (po as any).poNumber || po.id || '';
            const fileName = poNumber ? `Purchase Order - ${poNumber}.pdf` : `Purchase Order.pdf`;
            downloadBlob(blob, fileName);
            notify("Purchase Order PDF downloaded successfully", "success");
        } catch (error) {
            logger.error("PDF generation failed:", error);
            notify("Failed to generate PDF", "error");
        }
    };

    const handleAction = async (action: string, po: Purchase, extra?: string) => {
        if (action !== 'toggle_status_menu') { setOpenMenuId(null); }
        switch (action) {
            case 'view': if (onView) onView(po); break;
            case 'edit': onEdit(po); break;
            case 'whatsapp':
                const supplier = (suppliers || []).find(s => s.id === po.supplierId);
                if (supplier?.contact) {
                    const phone = supplier.contact.replace(/\D/g, '');
                    const msg = `Hello, regarding Bill ${po.id} — Vendor Ref: ${po.reference || 'N/A'} — Total: ${currency}${((po as any).total ?? (po as any).totalAmount ?? 0).toLocaleString()}. Please confirm receipt.`;
                    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
                } else { notify("Supplier phone number not available", "error"); }
                break;
            case 'change_status':
                if (extra) {
                    const updated: Partial<Purchase> = { status: extra as any };
                    if (extra === 'Cancelled') { (updated as any).paymentStatus = 'Cancelled'; }
                    updatePurchase({ ...po, ...updated } as Purchase);
                    notify(`Bill status changed to ${extra}`, 'success');
                }
                break;
            case 'delete':
                if (po.paymentStatus === 'Paid' || po.paymentStatus === 'Partial' || (po.paidAmount || 0) > 0) {
                    setAdminPasswordInput('');
                    setAdminPasswordModal({ open: true, po });
                    return;
                }
                if (confirm("Cancel this Bill? This will mark both the order and payment status as Cancelled.")) {
                    updatePurchase({ ...po, status: 'Cancelled', paymentStatus: 'Cancelled' } as Purchase);
                    notify("Bill Cancelled", "success");
                }
                break;
            case 'download_pdf': handleDownloadPDF(po); break;
        }
    };

    const currentPO = (purchases || []).find(p => p.id === openMenuId) as Purchase | undefined;
    const hoveredPO = (purchases || []).find((p: any) => p.id === hoveredId) as any;

    const getPaymentBadge = (status?: string) => {
        const s = status || 'Unpaid';
        if (s === 'Paid') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
        if (s === 'Partial') return 'bg-amber-100 text-amber-700 border-amber-200';
        if (s === 'Cancelled') return 'bg-slate-100 text-[#5c6567] border-slate-200 line-through';
        return 'bg-rose-100 text-rose-700 border-rose-200';
    };

    const getStatusBadge = (status?: string) => {
        switch (status) {
            case 'Received': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
            case 'Partially Received': return 'bg-amber-100 text-amber-700 border-amber-200';
            case 'Ordered': return 'bg-sky-100 text-sky-700 border-sky-200';
            case 'Pending Approval': return 'bg-amber-100 text-amber-700 border-amber-200';
            case 'Cancelled': return 'bg-slate-100 text-[#5c6567] border-slate-200 line-through';
            case 'Closed': return 'bg-slate-100 text-slate-600 border-slate-200';
            case 'Draft': return 'bg-slate-100 text-slate-500 border-slate-200';
            default: return 'bg-slate-100 text-[#5c6567] border-slate-200';
        }
    };

    const renderMenu = (po: Purchase) => {
        const menuWidth = 256;
        const menuHeight = 500;
        const submenuWidth = 192;
        let x = menuPos?.x || 0;
        let y = menuPos?.y || 0;
        if (x + menuWidth + submenuWidth > window.innerWidth) x = Math.max(0, window.innerWidth - menuWidth - submenuWidth);
        if (y + menuHeight > window.innerHeight) y = Math.max(0, window.innerHeight - menuHeight);

        const miStyle = (color: string): React.CSSProperties => ({
            width:'100%',textAlign:'left',padding:'10px 16px',fontSize:13,fontWeight:600,color,
            display:'flex',alignItems:'center',gap:10,cursor:'pointer',border:'none',background:'transparent',
            transition:'background .12s ease',fontFamily:"'Inter','DM Sans',sans-serif"
        });
        return (
        <div ref={menuRef}
            style={{position:'fixed',width:256,background:paper,border:`1.4px solid #e4ddd1`,borderRadius:14,boxShadow:'0 20px 50px -16px rgba(0,0,0,.2)',zIndex:70,top:y,left:x,overflowY:'auto',maxHeight:'90vh',display:'flex',flexDirection:'column',padding:'6px 0'}}
            onClick={(e)=>e.stopPropagation()}>
            <div style={{padding:'10px 16px',borderBottom:`1px solid #e4ddd1`,fontSize:10,fontWeight:700,color:'#5c6567',textTransform:'uppercase',letterSpacing:'.08em',fontFamily:"'Inter','DM Sans',sans-serif"}}>BILL ACTIONS</div>
            <button onClick={()=>{setOpenMenuId(null);handlePreview('PO',enrichPO(po))}} style={miStyle('#1f8577')} onMouseEnter={e=>e.currentTarget.style.background='#eef7f6'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><Eye size={14}/> Preview Bill</button>
            <div style={{height:1,background:'#e4ddd1',margin:'4px 0'}}/>
            <button onClick={()=>handleAction('view',po)} style={miStyle('#23282A')} onMouseEnter={e=>e.currentTarget.style.background='#f5f4f0'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><FileText size={14}/> View Details</button>
            <button onClick={()=>handleAction('download_pdf',po)} style={miStyle('#1f8577')} onMouseEnter={e=>e.currentTarget.style.background='#eef7f6'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><FileDown size={14}/> Download PDF</button>
            {po.paymentStatus !== 'Paid' && po.status !== 'Draft' && po.status !== 'Cancelled' && onPayment && (
                <button onClick={()=>{setOpenMenuId(null);onPayment(po)}} style={miStyle('#1f8577')} onMouseEnter={e=>e.currentTarget.style.background='#eef7f6'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><DollarSign size={14}/> Record Payment</button>
            )}
            {(po.status==='Draft'||po.status==='Ordered')&&(
                <button onClick={()=>handleAction('edit',po)} style={miStyle('#92620a')} onMouseEnter={e=>e.currentTarget.style.background='#fef3cd'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><Edit2 size={14}/> Edit Bill</button>
            )}
            <button onClick={()=>handleAction('whatsapp',po)} style={miStyle('#23282A')} onMouseEnter={e=>e.currentTarget.style.background='#f5f4f0'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><WhatsAppLogo size={14}/> Send via WhatsApp</button>
            <div style={{position:'relative'}}>
                <button onClick={()=>setActiveSubmenu(activeSubmenu==='status'?null:'status')} style={{...miStyle('#23282A'),justifyContent:'space-between'}} onMouseEnter={e=>e.currentTarget.style.background='#f5f4f0'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <span style={{display:'flex',alignItems:'center',gap:10}}><RefreshCw size={14}/> Change Status</span><ChevronRight size={12}/>
                </button>
                {activeSubmenu==='status'&&(
                    <div style={{position:'absolute',left:'100%',top:0,marginLeft:4,width:192,background:paper,border:`1.4px solid #e4ddd1`,borderRadius:12,boxShadow:'0 10px 30px -10px rgba(0,0,0,.15)',padding:'4px 0',overflow:'hidden'}}>
                        {['Draft','Ordered','Received','Closed','Cancelled'].map(status=>(
                            <button key={status} onClick={()=>handleAction('change_status',po,status)}
                                style={{width:'100%',padding:'9px 16px',textAlign:'left',fontSize:12,fontWeight:600,color:'#23282A',cursor:'pointer',border:'none',background:'transparent',transition:'background .12s',display:'block',fontFamily:"'Inter','DM Sans',sans-serif"}}
                                onMouseEnter={e=>e.currentTarget.style.background='#eef7f6'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                                <span style={{fontWeight:po.status===status?700:400,color:po.status===status?'#1f8577':'#23282A'}}>{status}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div style={{height:1,background:'#e4ddd1',margin:'4px 0'}}/>
            <button onClick={()=>handleAction('delete',po)} style={miStyle('#b5493f')} onMouseEnter={e=>e.currentTarget.style.background='#fde8e7'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><Trash2 size={14}/> Cancel Bill</button>
        </div>
    );
    };

    return (
        <div className="flex flex-col h-full">
            {openMenuId && menuPos && currentPO && renderMenu(currentPO)}
            {hoveredId && hoverPos && hoveredPO && <HoverPurchaseMenu id={hoveredId} pos={hoverPos} data={hoveredPO} />}

            {selectedIds.length > 0 && (
                <div className="mb-3 flex justify-center">
                    <div className="inline-flex items-center gap-3 bg-[#23282A]/90 backdrop-blur-md text-white px-4 py-2 rounded-full shadow-lg border border-white/10">
                        <span className="text-xs font-bold font-mono">{selectedIds.length} selected</span>
                        <span className="w-px h-4 bg-white/20" />
                        {selectedIds.length > 1 && (
                            <button onClick={handleMergeClick} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 hover:bg-white/25 text-white text-[11px] font-bold transition-colors"><Layers size={12}/> Merge Bills</button>
                        )}
                        <button onClick={()=>{onBatchDelete(selectedIds);setSelectedIds([])}} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/90 hover:bg-rose-600 text-white text-[11px] font-bold transition-colors"><Trash2 size={12}/> Delete</button>
                        <button onClick={()=>setSelectedIds([])} className="p-1 rounded-full hover:bg-white/15 transition-colors"><X size={14} /></button>
                    </div>
                </div>
            )}

            <div className="bg-white/70 backdrop-blur-xl rounded-2xl shadow-sm border border-white/60 overflow-hidden flex-1 flex flex-col">
                <div className="p-3 border-b border-slate-200/60 flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center bg-slate-50/30 shrink-0">
                    <div className="relative w-full sm:max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                        <input
                            type="text"
                            placeholder="Search bills by Bill #, supplier, vendor ref..."
                            className="w-full pl-9 pr-9 py-2 border border-slate-200/80 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/70 font-normal placeholder:text-slate-400"
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <X size={14} />
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="hidden sm:inline">Total:</span>
                        <span className="font-bold text-slate-700 finance-nums">{totalItems} bills</span>
                        {searchTerm && <span className="text-slate-400">· filtered</span>}
                    </div>
                </div>

                <div className="flex-1 overflow-auto custom-scrollbar sales-list-scroll">
                    <table className="w-full text-left text-[11px] md:text-[13px] table-auto md:table-fixed">
                        <thead className="bg-slate-50/80 backdrop-blur text-slate-500 sticky top-0 z-10 shadow-sm">
                            <tr>
                                <th className="table-header text-center hidden md:table-cell md:w-[3%]">
                                    <button onClick={()=>setSelectedIds(selectedIds.length===currentItems.length?[]:(currentItems as any).map((p:any)=>p.id))} className="inline-flex items-center justify-center w-5 h-5 rounded border border-slate-300 hover:border-blue-400 hover:bg-blue-50 transition-colors">
                                        {selectedIds.length>0&&selectedIds.length===currentItems.length?<CheckSquare size={14} className="text-blue-600"/>:<Square size={14} className="text-slate-400"/>}
                                    </button>
                                </th>
                                <SortableTh field="id" sortConfig={sortConfig} onSort={handleSort} className="text-left md:w-[13%]">Bill #</SortableTh>
                                <SortableTh field="date" sortConfig={sortConfig} onSort={handleSort} className="text-left md:w-[11%] hidden sm:table-cell">Date</SortableTh>
                                <SortableTh field="supplierName" sortConfig={sortConfig} onSort={handleSort} className="text-left md:w-[18%]">Supplier</SortableTh>
                                <SortableTh field="reference" sortConfig={sortConfig} onSort={handleSort} className="text-left md:w-[11%] hidden md:table-cell">Vendor Ref</SortableTh>
                                <SortableTh field="dueDate" sortConfig={sortConfig} onSort={handleSort} className="text-left md:w-[11%] hidden lg:table-cell">Due Date</SortableTh>
                                <SortableTh field="total" sortConfig={sortConfig} onSort={handleSort} className="text-right md:w-[12%] hidden sm:table-cell">Total</SortableTh>
                                <th className="table-header text-center md:w-[9%]">Payment</th>
                                <th className="table-header text-center md:w-[9%]">Status</th>
                                <th className="table-header text-center md:w-[9%]">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100/50">
                            {(currentItems||[]).length===0 ? (
                                <TableEmptyState module="purchases" colSpan={10} searchTerm={searchTerm} actionLabel={searchTerm ? undefined : "Create Bill"} onAction={searchTerm ? undefined : () => (document.querySelector<HTMLButtonElement>('[data-create-bill]')?.click())} />
                            ) : (currentItems as Purchase[]).map((po:any)=>{
                                const isSelected = selectedIds.includes(po.id);
                                const isChecked = isSelected;
                                const isMenuOpen = openMenuId===po.id;
                                const supplierName = getSupplierName(po);
                                const totalVal = (po.total ?? po.totalAmount ?? 0) as number;
                                const isOverdue = po.dueDate && new Date(po.dueDate) < new Date() && po.paymentStatus !== 'Paid' && po.status !== 'Cancelled';
                                const isCancelled = po.status === 'Cancelled';
                                return (
                                <tr key={po.id} id={`bill-${po.id}`}
                                    className={`transition-colors cursor-pointer group ${isChecked ? 'bg-blue-50/80' : isMenuOpen ? 'bg-blue-50/80 border-l-4 border-l-blue-500' : 'hover:bg-blue-50/50 border-l-4 border-l-transparent'}`}
                                    onClick={(e)=>handleRowClick(e,po.id)}
                                    onContextMenu={(e)=>handleContextMenu(e,po.id)}
                                    onMouseEnter={(e)=>onMouseEnter(po.id, e)}
                                    onMouseMove={onMouseMove}
                                    onMouseLeave={onMouseLeave}
                                >
                                    <td className="table-body-cell text-center hidden md:table-cell" onClick={(e)=>e.stopPropagation()}>
                                        <button onClick={()=>handleToggleSelect(po.id)} aria-label={isSelected?`Deselect bill ${po.id}`:`Select bill ${po.id}`} className="inline-flex items-center justify-center w-5 h-5 rounded border border-slate-300 hover:border-blue-400 hover:bg-blue-50 transition-colors">
                                            {isSelected?<CheckSquare size={14} className="text-blue-600"/>:<Square size={14} className="text-slate-400"/>}
                                        </button>
                                    </td>
                                    <td className="table-body-cell text-left font-mono text-slate-500 font-bold truncate">
                                        <DocLink docNumber={po.id} targetPage="/procurement/bills" rowId={`bill-${po.id}`} currentPage={location.pathname} />
                                    </td>
                                    <td className="table-body-cell text-left font-normal truncate hidden sm:table-cell">{po.date ? new Date(po.date).toLocaleDateString() : '-'}</td>
                                    <td className="table-body-cell text-left font-medium text-slate-900 truncate">
                                        <span className="truncate block max-w-[160px]">{supplierName || po.supplierId}</span>
                                        <span className="block text-[10px] font-normal text-slate-400 md:hidden mt-0.5 truncate">
                                            {(po.reference || 'No ref')} · {po.dueDate ? new Date(po.dueDate).toLocaleDateString() : 'No due'} · {currency}{totalVal.toLocaleString()}
                                        </span>
                                    </td>
                                    <td className="table-body-cell text-left font-normal truncate hidden md:table-cell">
                                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 truncate">
                                            <FileText size={11} className="text-slate-400 shrink-0 hidden lg:inline" />
                                            <span className="truncate max-w-[110px]">{po.reference || '-'}</span>
                                        </span>
                                    </td>
                                    <td className={`table-body-cell text-left truncate hidden lg:table-cell ${isOverdue ? 'text-rose-600 font-bold' : 'text-slate-500 font-normal'}`}>
                                        {po.dueDate ? new Date(po.dueDate).toLocaleDateString() : '-'}
                                    </td>
                                    <td className="table-body-cell text-right font-bold finance-nums truncate hidden sm:table-cell">
                                        <span className={isCancelled ? 'text-slate-400 line-through' : 'text-slate-900'}>{currency} {totalVal.toLocaleString()}</span>
                                    </td>
                                    <td className="table-body-cell text-center">
                                        <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${getPaymentBadge(po.paymentStatus)}`}>{po.paymentStatus || 'Unpaid'}</span>
                                    </td>
                                    <td className="table-body-cell text-center">
                                        <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${getStatusBadge(po.status)}`}>{po.status}</span>
                                    </td>
                                    <td className="table-body-cell text-center" onClick={e => e.stopPropagation()}>
                                        <div className="flex justify-center gap-0.5 md:gap-1 items-center shrink-0">
                                            <button onClick={(e)=>{e.stopPropagation();handlePreview('PO',enrichPO(po))}} className="p-1 md:p-1.5 text-slate-500 hover:text-blue-600 bg-slate-50 hover:bg-white border border-transparent hover:border-slate-200 rounded transition-all hidden sm:flex" title="Preview Bill">
                                                <Eye size={14} />
                                            </button>
                                            <button onClick={(e)=>{e.stopPropagation();handleDownloadPDF(po)}} className="p-1 md:p-1.5 text-slate-500 hover:text-blue-600 bg-slate-50 hover:bg-white border border-transparent hover:border-slate-200 rounded transition-all hidden sm:flex" title="Download PDF">
                                                <Download size={14} />
                                            </button>
                                            {(po.status==='Ordered'||po.status==='Partially Received'||po.status==='Draft')?(
                                                <button onClick={(e)=>{e.stopPropagation();onReceive(po.id)}} className={`hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors ${po.status==='Draft' ? 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                                                    <Package size={11}/> {po.status==='Draft'?'Process':'Receive'}
                                                </button>
                                            ): isCancelled ? (
                                                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 line-through"><XCircle size={11}/> Cancelled</span>
                                            ):(
                                                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600"><CheckCircle size={11}/> Done</span>
                                            )}
                                            <button onClick={(e)=>{e.stopPropagation(); handleRowClick(e, po.id)}} className="p-1 md:p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"><MoreVertical size={14} /></button>
                                        </div>
                                    </td>
                                </tr>
                            )})}
                        </tbody>
                    </table>
                </div>
                <Pagination currentPage={currentPage} maxPage={maxPage} totalItems={totalItems} itemsPerPage={itemsPerPage} onNext={next} onPrev={prev} onFirst={first} onLast={last} onItemsPerPageChange={setItemsPerPage} />
            </div>

        {adminPasswordModal.open && (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
                onClick={(e) => {
                    if (e.target === e.currentTarget) {
                        setAdminPasswordModal({ open: false, po: null });
                    }
                }}
            >
                <div className="w-full max-w-md animate-in zoom-in-95 duration-200" role="dialog" aria-modal="true">
                    <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
                        <div className="flex items-center justify-between py-4 px-6 border-b border-slate-100">
                            <h2 className="text-lg font-semibold text-slate-800">Admin Verification</h2>
                            <button
                                onClick={() => setAdminPasswordModal({ open: false, po: null })}
                                className="text-slate-400 hover:text-slate-600 transition-colors text-xl font-bold"
                                type="button"
                                aria-label="Close"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="px-6 py-5">
                            <p className="text-sm text-slate-600 leading-relaxed mb-4">
                                This bill has payments. Enter Admin Password to cancel:
                            </p>
                            <input
                                type="password"
                                value={adminPasswordInput}
                                onChange={(e) => setAdminPasswordInput(e.target.value)}
                                placeholder="Enter admin password..."
                                className="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400"
                                autoFocus
                            />
                        </div>

                        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                            <button
                                onClick={() => setAdminPasswordModal({ open: false, po: null })}
                                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-all"
                                type="button"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => {
                                    if (adminPasswordInput !== 'password') {
                                        notify("Incorrect Password. Action Cancelled.", "error");
                                        setAdminPasswordModal({ open: false, po: null });
                                        return;
                                    }
                                    setAdminPasswordModal({ open: false, po: null });
                                    const po = adminPasswordModal.po;
                                    if (po && confirm("Cancel this Bill? This will mark both the order and payment status as Cancelled.")) {
                                        updatePurchase({ ...po, status: 'Cancelled', paymentStatus: 'Cancelled' } as Purchase);
                                        notify("Bill Cancelled", "success");
                                    }
                                }}
                                disabled={!adminPasswordInput.trim()}
                                className="px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-xl hover:bg-red-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                type="button"
                            >
                                Verify & Cancel
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}
        </div>
    );
};
