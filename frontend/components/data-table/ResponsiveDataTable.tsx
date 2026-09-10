import React, { useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Density, DetailField, PaginationState, ResponsiveColumn, RowAction } from './types';
import { TableEmptyState, TableErrorState, TableLoadingSkeleton } from './TableStates';

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

interface Props<T> {
  columns: ResponsiveColumn<T>[];
  data: T[];
  keyOf: (row: T, index: number) => string;
  /** Controlled sort (preferred when the host already sorts). */
  sort?: SortState | null;
  onSort?: (key: string) => void;
  /** Controlled pagination; omit for unpaginated lists. */
  pagination?: PaginationState & {
    onPageChange: (page: number) => void;
    onPageSizeChange?: (size: number) => void;
    pageSizeOptions?: number[];
  };
  selectable?: {
    selectedIds: string[];
    onToggle: (id: string) => void;
    onToggleAll: () => void;
  };
  actions?: RowAction<T>[];
  /** Mobile card headline: defaults to first primary column value. */
  titleOf?: (row: T) => React.ReactNode;
  /** Mobile card amount slot (right-aligned money). Defaults to first primary money column. */
  amountOf?: (row: T) => React.ReactNode;
  /** Mobile card sub-line: defaults to secondary column values joined. */
  subtitleOf?: (row: T) => React.ReactNode;
  /** Detail sheet / expanded content. Defaults to detail-priority columns + secondary remainder. */
  detailOf?: (row: T) => { title: string; subtitle?: string; amount?: React.ReactNode; status?: React.ReactNode; fields: DetailField[] };
  statusOf?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  density?: Density;
  /** Caption for screen readers. */
  caption?: string;
  minTableWidth?: number;
}

function defaultCell<T>(col: ResponsiveColumn<T>, row: T): React.ReactNode {
  if (col.render) return col.render(row);
  const v = col.value?.(row);
  if (v == null || v === '') return <span style={{ color: '#94a3b8' }}>—</span>;
  if (col.kind === 'date') {
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v);
}

export function ResponsiveDataTable<T>(props: Props<T>) {
  const {
    columns, data, keyOf, sort, onSort, pagination, selectable, actions,
    loading, error, onRetry, density = 'compact', caption,
  } = props;
  const tableId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sheetKey, setSheetKey] = useState<string | null>(null);

  const tableColumns = useMemo(() => columns.filter((c) => c.priority !== 'detail'), [columns]);
  const detailColumns = useMemo(() => columns.filter((c) => c.priority === 'detail'), [columns]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const titleOf = (row: T, index: number): React.ReactNode => {
    if (props.titleOf) return props.titleOf(row);
    const first = columns.find((c) => c.priority === 'primary' && c.kind !== 'money');
    const col = first ?? columns.find((c) => c.priority === 'primary') ?? columns[0];
    return col ? defaultCell(col, row) : `Record ${index + 1}`;
  };

  const amountOf = (row: T): React.ReactNode => {
    if (props.amountOf) return props.amountOf(row);
    const money = columns.find((c) => c.kind === 'money' && c.priority !== 'detail');
    const fallback = money ?? columns.find((c) => c.kind === 'money');
    return fallback ? defaultCell(fallback, row) : null;
  };

  const subtitleOf = (row: T): React.ReactNode => {
    if (props.subtitleOf) return props.subtitleOf(row);
    const secs = columns.filter((c) => c.priority === 'secondary').slice(0, 2);
    if (secs.length === 0) return null;
    return secs.map((c) => {
      const v = c.value?.(row);
      const rendered = c.render ? c.render(row) : null;
      const text = rendered && typeof rendered !== 'string' && typeof rendered !== 'number' ? null : (rendered ?? (v == null ? null : String(v)));
      return text ? `${c.label} ${text}` : null;
    }).filter(Boolean).join(' • ') || null;
  };

  const statusOf = (row: T): React.ReactNode => {
    if (props.statusOf) return props.statusOf(row);
    const s = columns.find((c) => c.kind === 'status');
    return s ? defaultCell(s, row) : null;
  };

  const detailOf = (row: T, index: number) => {
    if (props.detailOf) return props.detailOf(row);
    const fields: DetailField[] = [
      ...detailColumns.map((c) => ({ label: c.label, value: defaultCell(c, row) })),
      ...columns.filter((c) => c.priority === 'secondary').map((c) => ({ label: c.label, value: defaultCell(c, row) })),
    ];
    const titleNode = titleOf(row, index);
    return {
      title: typeof titleNode === 'string' ? titleNode : `Record ${index + 1}`,
      subtitle: typeof subtitleOf(row) === 'string' ? (subtitleOf(row) as string) : undefined,
      amount: amountOf(row),
      status: statusOf(row),
      fields,
    };
  };

  const allSelected = selectable && data.length > 0 && data.every((r, i) => selectable.selectedIds.includes(keyOf(r, i)));
  const colSpan = tableColumns.length + (selectable ? 1 : 0) + 1; // +1 expander

  const start = pagination ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const end = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : data.length;
  const maxPage = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;

  return (
    <div className={`rpt-wrap density-${density}`} data-density={density}>
      {/* ── Wide: semantic table ─────────────────────────────── */}
      <div className="rpt-only-wide">
        <div className="rpt-scroll" style={{ overflowX: 'auto' }}>
          <table className="rpt-table" aria-label={caption ?? 'Records'} style={{ minWidth: props.minTableWidth ?? 640 }}>
            {caption && <caption className="rpt-caption">{caption}</caption>}
            <thead>
              <tr>
                {selectable && (
                  <th scope="col" className="rpt-th rpt-th-check">
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={!!allSelected}
                      onChange={selectable.onToggleAll}
                    />
                  </th>
                )}
                {tableColumns.map((col) => {
                  const active = sort?.key === col.key;
                  const align = col.align ?? (col.kind === 'money' || col.kind === 'number' ? 'right' : 'left');
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={col.sortable ? (active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                      data-priority={col.priority}
                      data-hide-below={col.hideBelow}
                      className={`rpt-th rpt-align-${align}`}
                      style={col.width ? { width: col.width } : undefined}
                    >
                      {col.sortable && onSort ? (
                        <button type="button" className="rpt-sort-btn" onClick={() => onSort(col.key)} aria-label={`Sort by ${col.label}`}>
                          {col.label}
                          {active ? (
                            sort?.direction === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUpDown size={12} aria-hidden="true" className="rpt-sort-idle" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  );
                })}
                <th scope="col" className="rpt-th rpt-align-right">
                  <span className="rpt-visually-hidden">Row details</span>
                  <span aria-hidden="true">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={colSpan} style={{ padding: 0 }}><TableLoadingSkeleton rows={6} columns={tableColumns.length} /></td></tr>
              ) : error ? (
                <tr><td colSpan={colSpan} style={{ padding: 0 }}><TableErrorState message={error} onRetry={onRetry} /></td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={colSpan} style={{ padding: 0 }}>
                  <TableEmptyState title={props.emptyTitle ?? 'No records found'} description={props.emptyDescription ?? 'There are no records matching your current filters.'} actionLabel={props.emptyActionLabel} onAction={props.onEmptyAction} />
                </td></tr>
              ) : (
                data.map((row, i) => {
                  const id = keyOf(row, i);
                  const isOpen = expanded.has(id);
                  const detailId = `${tableId}-detail-${i}`;
                  return (
                    <React.Fragment key={id}>
                      <tr
                        className="rpt-tr"
                        onClick={props.onRowClick ? () => props.onRowClick?.(row) : undefined}
                        style={props.onRowClick ? { cursor: 'pointer' } : undefined}
                      >
                        {selectable && (
                          <td className="rpt-td rpt-td-check" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select row ${i + 1}`} checked={selectable.selectedIds.includes(id)} onChange={() => selectable.onToggle(id)} />
                          </td>
                        )}
                        {tableColumns.map((col) => {
                          const align = col.align ?? (col.kind === 'money' || col.kind === 'number' ? 'right' : 'left');
                          return (
                            <td
                              key={col.key}
                              className={`rpt-td rpt-align-${align}${col.kind === 'money' || col.kind === 'number' ? ' rpt-num' : ''}`}
                              data-priority={col.priority}
                              data-hide-below={col.hideBelow}
                            >
                              {defaultCell(col, row)}
                            </td>
                          );
                        })}
                        <td className="rpt-td rpt-align-right" onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {actions?.filter((a) => a.primary).slice(0, 1).map((a) => (
                              <button key={a.key} type="button" className="rpt-row-btn" onClick={() => a.onSelect(row)} aria-label={`${a.label} row ${i + 1}`}>
                                {a.icon}{a.label}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="rpt-icon-btn"
                              aria-expanded={isOpen}
                              aria-controls={detailId}
                              aria-label={isOpen ? `Collapse row ${i + 1}` : `Expand row ${i + 1}`}
                              onClick={() => toggleExpand(id)}
                            >
                              <ChevronDown size={16} aria-hidden="true" className={isOpen ? 'rpt-chevron-open' : ''} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="rpt-detail-tr">
                          <td colSpan={colSpan} id={detailId} className="rpt-detail-td">
                            <RowDetail
                              fields={detailOf(row, i).fields}
                              actions={actions?.map((a) => (
                                <button key={a.key} type="button" className={a.primary ? 'rpt-btn-primary' : a.danger ? 'rpt-btn-danger' : 'rpt-btn-secondary'} onClick={() => a.onSelect(row)}>
                                  {a.icon}{a.label}
                                </button>
                              ))}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Narrow: stacked record cards ─────────────────────── */}
      <div className="rpt-only-narrow">
        <ul className="rpt-cards" aria-label={caption ?? 'Records'}>
          {loading ? (
            <li><TableLoadingSkeleton rows={5} columns={3} /></li>
          ) : error ? (
            <li><TableErrorState message={error} onRetry={onRetry} /></li>
          ) : data.length === 0 ? (
            <li>
              <TableEmptyState title={props.emptyTitle ?? 'No records found'} description={props.emptyDescription ?? 'There are no records matching your current filters.'} actionLabel={props.emptyActionLabel} onAction={props.onEmptyAction} />
            </li>
          ) : (
            data.map((row, i) => {
              const id = keyOf(row, i);
              const isOpen = expanded.has(id) || sheetKey === id;
              const detailId = `${tableId}-m-${i}`;
              const d = detailOf(row, i);
              const primaryAction = actions?.find((a) => a.primary);
              const sub = subtitleOf(row);
              const status = statusOf(row);
              return (
                <li key={id} className="rpt-card">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    aria-controls={detailId}
                    aria-label={`Record ${i + 1}: ${typeof d.title === 'string' ? d.title : 'details'}. Activate to ${isOpen ? 'collapse' : 'expand'}.`}
                    className="rpt-card-hit"
                    onClick={() => toggleExpand(id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(id); }
                    }}
                  >
                    <div className="rpt-card-top">
                      <div className="rpt-card-title">{titleOf(row, i)}</div>
                      <div className="rpt-card-amount rpt-num">{amountOf(row)}</div>
                    </div>
                    <div className="rpt-card-sub">
                      <span className="rpt-card-meta">{sub}</span>
                      {status && <span className="rpt-card-status">{status}</span>}
                    </div>
                    <div className="rpt-card-foot">
                      {primaryAction ? (
                        <button
                          type="button"
                          className="rpt-btn-primary rpt-card-cta"
                          onClick={(e) => { e.stopPropagation(); primaryAction.onSelect(row); }}
                        >
                          {primaryAction.icon}{primaryAction.label}
                        </button>
                      ) : <span />}
                      <span className="rpt-card-hint" aria-hidden="true">
                        <ChevronDown size={16} className={isOpen ? 'rpt-chevron-open' : ''} />
                      </span>
                    </div>
                  </div>
                  {expanded.has(id) && (
                    <div id={detailId} className="rpt-card-detail">
                      <RowDetail
                        fields={d.fields}
                        actions={actions?.map((a) => (
                          <button key={a.key} type="button" className={a.primary ? 'rpt-btn-primary' : a.danger ? 'rpt-btn-danger' : 'rpt-btn-secondary'} onClick={() => a.onSelect(row)}>
                            {a.icon}{a.label}
                          </button>
                        ))}
                      />
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>

      {/* ── Footer: pagination (shared) ──────────────────────── */}
      {pagination && pagination.total > 0 && (
        <nav className="rpt-footer" aria-label="Pagination">
          <span className="rpt-count" aria-live="polite">
            Showing <strong>{pagination.total === 0 ? 0 : start}</strong> to <strong>{end}</strong> of <strong>{pagination.total}</strong>
          </span>
          <div className="rpt-pages">
            {pagination.onPageSizeChange && (
              <label className="rpt-perpage">
                <span>Per page</span>
                <select value={pagination.pageSize} onChange={(e) => pagination.onPageSizeChange?.(Number(e.target.value))} aria-label="Rows per page">
                  {(pagination.pageSizeOptions ?? [10, 25, 50, 100]).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="rpt-icon-btn" disabled={pagination.page <= 1} onClick={() => pagination.onPageChange(pagination.page - 1)} aria-label="Previous page">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span className="rpt-page-ind" aria-current="page">{pagination.page} / {maxPage}</span>
            <button type="button" className="rpt-icon-btn" disabled={pagination.page >= maxPage} onClick={() => pagination.onPageChange(pagination.page + 1)} aria-label="Next page">
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

const RowDetail: React.FC<{ fields: DetailField[]; actions?: React.ReactNode }> = ({ fields, actions }) => (
  <div className="rpt-detail">
    <dl className="rpt-detail-grid">
      {fields.map((f) => (
        <div key={f.label} className="rpt-detail-item">
          <dt>{f.label}</dt>
          <dd>{f.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
    {actions && <div className="rpt-detail-actions">{actions}</div>}
  </div>
);

export default ResponsiveDataTable;
