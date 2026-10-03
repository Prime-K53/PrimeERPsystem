import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Calendar, Clock, AlertTriangle, RotateCw } from 'lucide-react';
import { PosModal } from './PosModal';
import { Button } from './Button';
import { useAuth } from '../../../context/AuthContext';
import { inventoryTransactionService } from '../../../services/inventoryTransactionService';
import { formatMoney } from '../../../utils/posMoney';
import {
    FOCUS_RING,
    NUMERIC_FONT,
    borderWarning,
    danger,
    success,
    hairline,
    inkSoft,
    radius,
    surfaceWarning,
    textWarning,
    teal,
} from '../theme';

interface BatchSelection {
    batchId: string;
    batchNumber: string;
    quantity: number;
}

type LoadState = 'loading' | 'ready' | 'error';

const BatchPickerModal: React.FC<{
    itemId: string;
    itemName: string;
    targetQuantity: number;
    isOpen: boolean;
    onConfirm: (selections: BatchSelection[]) => void;
    onClose: () => void;
}> = ({ itemId, itemName, targetQuantity, isOpen, onClose, onConfirm }) => {
    const { companyConfig, notify } = useAuth();
    const currencySymbol = companyConfig?.currencySymbol || '';
    const currencyCode = companyConfig?.currencySymbol || null;

    const [batches, setBatches] = useState<any[]>([]);
    const [selections, setSelections] = useState<Record<string, number>>({});
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [loadError, setLoadError] = useState<string>('');
    const [requestId, setRequestId] = useState(0);

    const load = useCallback(() => {
        let cancelled = false;
        setLoadState('loading');
        setLoadError('');

        inventoryTransactionService
            .getActiveBatches(itemId)
            .then(data => {
                if (cancelled) return;
                const list = Array.isArray(data) ? data : [];
                setBatches(list);
                const initial: Record<string, number> = {};
                list.forEach(b => { initial[b.id] = 0; });
                setSelections(initial);
                setLoadState('ready');
            })
            .catch((err: unknown) => {
                // Previously unhandled: the dialog hung on "Loading batches..."
                // forever with no escape other than closing the tab.
                if (cancelled) return;
                setBatches([]);
                setSelections({});
                setLoadError(err instanceof Error ? err.message : String(err || 'Unknown error'));
                setLoadState('error');
            });

        return () => { cancelled = true; };
    }, [itemId]);

    useEffect(() => {
        if (!isOpen) return;
        load();
    }, [isOpen, requestId, load]);

    const totalSelected = useMemo(
        () => Object.values(selections).reduce((sum, q) => sum + (Number(q) || 0), 0),
        [selections]
    );
    const remaining = Math.max(0, targetQuantity - totalSelected);
    const isComplete = totalSelected === targetQuantity;
    const overselected = totalSelected > targetQuantity;

    const updateSelection = (batchId: string, value: number) => {
        const batch = batches.find(b => b.id === batchId);
        const max = batch ? Math.max(0, Number(batch.remainingQuantity) || 0) : 0;
        const clamped = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, max));
        setSelections(prev => ({ ...prev, [batchId]: clamped }));
    };

    const quickFill = (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch) return;
        const canTake = Math.min(remaining, Math.max(0, Number(batch.remainingQuantity) || 0));
        if (canTake <= 0) return;
        updateSelection(batchId, (selections[batchId] || 0) + canTake);
    };

    /**
     * Partial allocation is refused outright. The old dialog warned "Remaining
     * will use general stock" and then handed POS only the batch lines, so the
     * remainder was never deducted from anywhere — a silent stock leak on every
     * partial batch sale. Now the operator must either allocate in full or take
     * the explicit, clearly-labelled untracked path.
     */
    const handleConfirm = () => {
        if (overselected) {
            notify(`Selected ${totalSelected} exceeds the ${targetQuantity} required`, 'error');
            return;
        }
        if (!isComplete) {
            notify(`Allocate all ${targetQuantity} units, or continue without batch tracking`, 'error');
            return;
        }
        const result = Object.entries(selections)
            .filter(([, qty]) => qty > 0)
            .map(([batchId, qty]) => ({
                batchId,
                batchNumber: batches.find(b => b.id === batchId)?.batchNumber || batchId,
                quantity: qty,
            }));
        onConfirm(result);
    };

    if (!isOpen) return null;

    const statusBar = (
        <div
            style={{
                padding: '10px 20px',
                background: teal[50],
                borderBottom: `1px solid ${hairline}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                fontSize: 12,
                fontWeight: 700,
                color: inkSoft,
            }}
        >
            <span style={{ fontFamily: NUMERIC_FONT }}>
                Selected {totalSelected} / {targetQuantity}
            </span>
            <span style={{ color: isComplete ? success : overselected ? danger : textWarning }}>
                {isComplete ? 'Fully allocated' : overselected ? `${totalSelected - targetQuantity} over` : `${remaining} still to allocate`}
            </span>
        </div>
    );

    const footer = (
        <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
                variant="danger"
                onClick={() => onConfirm([])}
                srLabel="Continue without batch tracking. Stock will not be deducted for these units."
            >
                Continue without tracking
            </Button>
            <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={!isComplete || overselected}
                srLabel={isComplete ? 'Confirm batch allocation' : `Allocate all ${targetQuantity} units first`}
            >
                {isComplete ? 'Confirm Allocation' : `Allocate ${remaining} more`}
            </Button>
        </>
    );

    return (
        <PosModal
            open={isOpen}
            onClose={onClose}
            title="Select Batch / Lot"
            subtitle={`${itemName} — need ${targetQuantity} unit${targetQuantity === 1 ? '' : 's'}`}
            icon={<Package size={19} color="#fff" />}
            size="lg"
            footer={
                loadState === 'ready' && batches.length > 0 ? footer : undefined
            }
        >
            {loadState === 'loading' && (
                <div role="status" aria-live="polite" style={{ padding: 40, textAlign: 'center', color: inkSoft, fontSize: 13 }}>
                    Loading batches…
                </div>
            )}

            {loadState === 'error' && (
                <div role="alert" style={{ padding: '40px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={32} style={{ color: danger }} />
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Could not load batches</p>
                    <p style={{ margin: 0, fontSize: 12.5, color: inkSoft, maxWidth: 380, lineHeight: 1.5 }}>{loadError}</p>
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                        <Button variant="secondary" onClick={() => setRequestId(n => n + 1)} icon={<RotateCw size={14} />}>
                            Retry
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => onConfirm([])}
                            srLabel="Continue without batch tracking. Stock will not be deducted for these units."
                        >
                            Continue without tracking
                        </Button>
                    </div>
                </div>
            )}

            {loadState === 'ready' && batches.length === 0 && (
                <div style={{ padding: '40px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={32} style={{ color: '#d99a3f' }} />
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>No active batches for this item</p>
                    <p style={{ margin: 0, fontSize: 12.5, color: inkSoft, maxWidth: 400, lineHeight: 1.5 }}>
                        This item is not currently batch-tracked. These units can be sold, but no batch will be
                        assigned and no batch stock will be deducted.
                    </p>
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                        <Button variant="primary" onClick={() => onConfirm([])}>
                            Add without batch
                        </Button>
                    </div>
                </div>
            )}

            {loadState === 'ready' && batches.length > 0 && (
                <>
                    {statusBar}

                    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                        <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                            <caption className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                                Active batches for {itemName}. Enter the quantity to allocate from each batch.
                            </caption>
                            <thead>
                                <tr style={{ background: teal[50], fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                                    <th scope="col" style={{ textAlign: 'left', padding: '10px 16px' }}>Batch #</th>
                                    <th scope="col" style={{ textAlign: 'right', padding: '10px 12px' }}>Available</th>
                                    <th scope="col" style={{ textAlign: 'center', padding: '10px 12px' }}>Expiry</th>
                                    <th scope="col" style={{ textAlign: 'right', padding: '10px 12px' }}>Unit cost</th>
                                    <th scope="col" style={{ textAlign: 'center', padding: '10px 12px' }}>Use</th>
                                </tr>
                            </thead>
                            <tbody style={{ borderTop: `1px solid ${hairline}` }}>
                                {batches.map(batch => {
                                    const available = Math.max(0, Number(batch.remainingQuantity) || 0);
                                    return (
                                        <tr key={batch.id} style={{ borderBottom: `1px solid ${hairline}` }}>
                                            <td style={{ padding: '10px 16px', fontFamily: NUMERIC_FONT, fontWeight: 700 }}>{batch.batchNumber}</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: NUMERIC_FONT }}>{available}</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                                {batch.expiryDate ? (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: inkSoft }}>
                                                        <Calendar size={10} />{new Date(batch.expiryDate).toLocaleDateString()}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: inkSoft }} aria-label="No expiry date">&mdash;</span>
                                                )}
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: NUMERIC_FONT, color: inkSoft }}>
                                                {formatMoney(Number(batch.costPerUnit) || 0, currencySymbol, currencyCode)}
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        max={available}
                                                        disabled={available === 0}
                                                        aria-label={`Quantity to allocate from batch ${batch.batchNumber}`}
                                                        style={{
                                                            width: 64,
                                                            padding: '5px 6px',
                                                            borderRadius: radius.sm,
                                                            border: `1.2px solid ${hairline}`,
                                                            fontSize: 12,
                                                            fontWeight: 600,
                                                            textAlign: 'center',
                                                            outline: 'none',
                                                            color: ink,
                                                            background: '#FEFDFB',
                                                            fontFamily: NUMERIC_FONT,
                                                        }}
                                                        value={selections[batch.id] || 0}
                                                        onChange={e => {
                                                            const raw = e.target.value;
                                                            if (raw === '') { updateSelection(batch.id, 0); return; }
                                                            updateSelection(batch.id, parseInt(raw, 10) || 0);
                                                        }}
                                                        onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                                                        onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                                                    />
                                                    {remaining > 0 && available > 0 && (
                                                        <Button
                                                            size="sm"
                                                            variant="secondary"
                                                            onClick={() => quickFill(batch.id)}
                                                            srLabel={`Fill remaining ${remaining} units from batch ${batch.batchNumber}`}
                                                        >
                                                            Fill
                                                        </Button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {!isComplete && (
                        <p
                            role="status"
                            style={{
                                margin: 0,
                                padding: '10px 20px',
                                fontSize: 12,
                                lineHeight: 1.45,
                                background: surfaceWarning,
                                borderTop: `1px solid ${borderWarning}`,
                                color: textWarning,
                            }}
                        >
                            All {targetQuantity} unit{targetQuantity === 1 ? '' : 's'} must be allocated to a batch before
                            this sale can be recorded. Use <strong>Fill</strong>, or choose
                            &ldquo;Continue without tracking&rdquo; to sell these units untracked.
                        </p>
                    )}
                </>
            )}
        </PosModal>
    );
};

export default BatchPickerModal;