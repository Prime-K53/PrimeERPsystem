import React, { useMemo } from 'react';
import { Copy, Archive, Trash2, Barcode, QrCode, Package, Edit3, TrendingUp, Layers, Box, Tag, Globe, Eye } from 'lucide-react';
import type { Item } from '../../../../types';
import { RowIndicators } from './RowIndicators';
import { resolveMinimumMarkup } from '../../../../services/pricingValidationService';
import {
  ResponsiveDataTable,
  StatusBadge,
  formatKwacha,
  type ResponsiveColumn,
  type RowAction,
} from '../../../../components/data-table';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  'Raw Material': <Layers size={16} />,
  Material: <Box size={16} />,
  Product: <Package size={16} />,
  Stationery: <Tag size={16} />,
  Service: <Globe size={16} />,
};

interface Props {
  items: Item[];
  paginatedItems: Item[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  sortKey: string;
  sortDir: string;
  onSort: (key: string) => void;
  onView: (item: Item) => void;
  onEdit: (item: Item) => void;
  onDuplicate: (item: Item) => void;
  onArchive: (item: Item) => void;
  onDelete: (item: Item) => void;
  onPrintBarcode: (item: Item) => void;
  onPrintQR: (item: Item) => void;
  onAdjustStock: (item: Item) => void;
  onTransferStock: (item: Item) => void;
  columns: string[];
}

const SECONDARY = new Set(['Status', 'Selling Price', 'SKU']);
const MONEY_COLS = new Set(['Cost Price', 'Selling Price', 'Inventory Value']);
const RIGHT_COLS = new Set(['Stock', 'Available', 'Reserved', 'Cost Price', 'Selling Price', 'Markup', 'Inventory Value']);

function priorityFor(col: string): 'primary' | 'secondary' | 'detail' {
  if (col === 'Name' || col === 'Stock') return 'primary';
  if (SECONDARY.has(col)) return 'secondary';
  return 'detail';
}

export const InventoryTable: React.FC<Props> = (p) => {
  const rows = useMemo(
    () => (p.paginatedItems && p.paginatedItems.length > 0 ? p.paginatedItems : p.items),
    [p.paginatedItems, p.items],
  );

  const columns: ResponsiveColumn<Item>[] = useMemo(
    () =>
      p.columns.map((col) => ({
        key: col,
        label: col,
        priority: priorityFor(col),
        hideBelow: col === 'SKU' ? 'md' : undefined,
        align: RIGHT_COLS.has(col) ? 'right' : 'left',
        sortable: true,
        kind:
          col === 'Status'
            ? 'status'
            : MONEY_COLS.has(col)
              ? 'money'
              : col === 'Stock' || col === 'Available' || col === 'Reserved'
                ? 'number'
                : col === 'SKU'
                  ? 'mono'
                  : 'text',
        value: (item: Item) => cellValue(item, col),
        render: (item: Item) => renderCell(item, col),
      })),
    [p.columns],
  );

  const actions: RowAction<Item>[] = useMemo(
    () => [
      { key: 'view', label: 'View', icon: <Eye size={14} aria-hidden="true" />, onSelect: p.onView },
      { key: 'edit', label: 'Edit', primary: true, icon: <Edit3 size={14} aria-hidden="true" />, onSelect: p.onEdit },
      { key: 'adjust', label: 'Adjust stock', icon: <Package size={14} aria-hidden="true" />, onSelect: p.onAdjustStock },
      { key: 'transfer', label: 'Transfer stock', icon: <TrendingUp size={14} aria-hidden="true" />, onSelect: p.onTransferStock },
      { key: 'duplicate', label: 'Duplicate', icon: <Copy size={14} aria-hidden="true" />, onSelect: p.onDuplicate },
      { key: 'barcode', label: 'Print barcode', icon: <Barcode size={14} aria-hidden="true" />, onSelect: p.onPrintBarcode },
      { key: 'qr', label: 'Print QR', icon: <QrCode size={14} aria-hidden="true" />, onSelect: p.onPrintQR },
      { key: 'archive', label: 'Archive', icon: <Archive size={14} aria-hidden="true" />, onSelect: p.onArchive },
      { key: 'delete', label: 'Delete', danger: true, icon: <Trash2 size={14} aria-hidden="true" />, onSelect: p.onDelete },
    ],
    [p.onView, p.onEdit, p.onAdjustStock, p.onTransferStock, p.onDuplicate, p.onPrintBarcode, p.onPrintQR, p.onArchive, p.onDelete],
  );

  return (
    <div className="ref-inv-panel" style={{ padding: 0 }}>
      <ResponsiveDataTable<Item>
        columns={columns}
        data={rows}
        keyOf={(item, idx) => `${item.id}-${idx}`}
        sort={p.sortKey ? { key: p.sortKey, direction: p.sortDir === 'desc' ? 'desc' : 'asc' } : null}
        onSort={p.onSort}
        selectable={{
          selectedIds: Array.from(p.selectedIds),
          onToggle: p.onToggleSelect,
          onToggleAll: p.onToggleSelectAll,
        }}
        actions={actions}
        onRowClick={p.onView}
        caption="Inventory items"
        emptyTitle="No inventory items found"
        emptyDescription="There are no inventory items matching your current filters."
        titleOf={(item) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ color: '#64748b', flexShrink: 0 }} aria-hidden="true">
              {TYPE_ICONS[(item as Item).type || ''] || <Package size={16} />}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{(item as Item).name}</span>
            <RowIndicators item={item as Item} />
          </span>
        )}
        amountOf={(item) => (
          <span>{formatKwacha(Number((item as unknown as Record<string, unknown>).sellingPrice ?? (item as unknown as Record<string, unknown>).price ?? 0))}</span>
        )}
        statusOf={(item) => <StatusBadge status={String((item as unknown as Record<string, unknown>).status || 'Active')} size="sm" />}
      />
    </div>
  );
};

function cellValue(item: unknown, col: string): unknown {
  const r = item as Record<string, unknown>;
  switch (col) {
    case 'Name': return r.name;
    case 'SKU': return r.sku;
    case 'Classification':
    case 'Type': return r.type ?? r.classification;
    case 'Status': return r.status || 'Active';
    case 'Stock': return r.stock ?? 0;
    case 'Available': return Number(r.stock || 0) - Number(r.reserved || 0);
    case 'Reserved': return r.reserved ?? 0;
    case 'Base Unit': return r.unit || 'pcs';
    case 'Cost Price': return r.costPrice ?? r.cost ?? 0;
    case 'Selling Price': return r.sellingPrice ?? r.price ?? 0;
    case 'Inventory Value': return Number(r.stock || 0) * Number((r.costPrice as number) ?? (r.cost as number) ?? 0);
    case 'Supplier': return r.preferredSupplierId;
    case 'Warehouse': return r.warehouseId;
    case 'Category': return r.category;
    case 'Brand': return r.brand;
    case 'Last Updated': return r.updatedAt ?? r.validationTimestamp;
    case 'Markup': {
      const cost = Number(r.costPrice ?? r.cost ?? 0);
      const sell = Number(r.sellingPrice ?? r.price ?? 0);
      return cost > 0 ? ((sell - cost) / cost) * 100 : 0;
    }
    default: return r[col];
  }
}

function renderCell(item: unknown, col: string): React.ReactNode {
  const r = item as Record<string, unknown>;
  switch (col) {
    case 'Name':
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: '#64748b', flexShrink: 0 }} aria-hidden="true">
            {TYPE_ICONS[String(r.type || '')] || <Package size={16} />}
          </span>
          <span style={{ fontWeight: 500, color: '#0f172a' }}>{String(r.name ?? '—')}</span>
          <RowIndicators item={item as Item} />
        </span>
      );
    case 'SKU':
      return <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{String(r.sku || '—')}</span>;
    case 'Classification':
    case 'Type':
      return <span style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 8, fontSize: 12, background: '#f1f5f9', color: '#334155' }}>{String(r.type ?? r.classification ?? '—')}</span>;
    case 'Status':
      return <StatusBadge status={String(r.status || 'Active')} size="sm" />;
    case 'Stock':
      return <span style={{ fontFamily: 'monospace', color: Number(r.stock || 0) <= 0 ? '#dc2626' : '#0f172a' }}>{Number(r.stock || 0).toLocaleString('en-US')}</span>;
    case 'Available': {
      const v = Number(r.stock || 0) - Number(r.reserved || 0);
      return <span style={{ fontFamily: 'monospace', color: v <= 0 ? '#dc2626' : '#334155' }}>{v.toLocaleString('en-US')}</span>;
    }
    case 'Reserved':
      return <span style={{ fontFamily: 'monospace', color: '#d97706' }}>{Number(r.reserved || 0).toLocaleString('en-US')}</span>;
    case 'Base Unit':
      return <span style={{ color: '#64748b' }}>{String(r.unit || 'pcs')}</span>;
    case 'Cost Price':
      return <span style={{ fontWeight: 600, color: '#111827' }}>{formatKwacha(Number(r.costPrice ?? r.cost ?? 0))}</span>;
    case 'Selling Price':
      return <span style={{ fontWeight: 600, color: '#111827' }}>{formatKwacha(Number(r.sellingPrice ?? r.price ?? 0))}</span>;
    case 'Markup': {
      const cost = Number(r.costPrice ?? r.cost ?? 0);
      const sell = Number(r.sellingPrice ?? r.price ?? 0);
      const markup = cost > 0 ? ((sell - cost) / cost) * 100 : 0;
      const healthy = markup >= resolveMinimumMarkup(item as Item);
      return <span style={{ fontFamily: 'monospace', color: healthy ? '#059669' : '#dc2626' }}>{markup.toFixed(1)}%</span>;
    }
    case 'Inventory Value': {
      const val = Number(r.stock || 0) * Number((r.costPrice as number) ?? (r.cost as number) ?? 0);
      return <span style={{ fontWeight: 600, color: '#111827' }}>{formatKwacha(val)}</span>;
    }
    case 'Supplier': return <span style={{ color: '#64748b' }}>{String(r.preferredSupplierId || '—')}</span>;
    case 'Warehouse': return <span style={{ color: '#64748b' }}>{String(r.warehouseId || '—')}</span>;
    case 'Category': return <span style={{ color: '#64748b' }}>{String(r.category || '—')}</span>;
    case 'Brand': return <span style={{ color: '#64748b' }}>{String(r.brand || '—')}</span>;
    case 'Last Updated': {
      const v = r.updatedAt ?? r.validationTimestamp;
      return <span style={{ fontSize: 12, color: '#94a3b8' }}>{v ? new Date(String(v)).toLocaleDateString() : '—'}</span>;
    }
    default:
      return <span style={{ color: '#64748b' }}>—</span>;
  }
}

