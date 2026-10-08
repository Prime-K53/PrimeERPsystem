/**
 * examinationBatchNotificationDate.test.ts — batch-created notification date
 * regression suite.
 *
 * Symptom: creating an examination batch produced a notification carrying
 * an invalid examination date — the record-creation timestamp was
 * substituted as "Examination date: <ISO timestamp>" even though the
 * creation forms never capture an exam date.
 *
 * Contract (same convention as formatInvoiceDueDateForNotification):
 * only a genuine exam_date is ever presented as the examination date;
 * missing/unparseable values omit the clause entirely and never emit
 * "Invalid Date".
 */
import { describe, it, expect } from 'vitest';
import { examinationNotificationService } from '../../services/examinationNotificationService';

// Realistic result of examinationBatchService.createBatch from either
// creation form: school_id + batch fields, created_at stamped, and NO
// exam_date (neither form captures one).
const FRESH_BATCH: Record<string, unknown> = {
    id: 'EXM-BATCH-2026-0007',
    batch_number: 'EXM-BATCH-2026-0007',
    batchNumber: 'EXM-BATCH-2026-0007',
    name: 'New Batch',
    school_id: 'SCH-1',
    academic_year: '2026',
    term: '1',
    exam_type: 'Mid-Term',
    status: 'Draft',
    created_at: '2026-10-08T13:00:00.000Z',
    updated_at: '2026-10-08T13:00:00.000Z',
};

describe('batch-created notification date', () => {
    it('never presents the creation timestamp as the examination date', () => {
        const content = examinationNotificationService.generateNotificationContent('BATCH_CREATED', FRESH_BATCH);
        expect(content.message).not.toContain('2026-10-08T13:00:00.000Z');
        expect(content.message).not.toContain('Invalid Date');
        expect(content.message).toContain('A new examination batch has been created');
    });

    it('omits the exam-date clause when no exam date was captured', () => {
        const content = examinationNotificationService.generateNotificationContent('BATCH_CREATED', FRESH_BATCH);
        expect(content.message).not.toContain('Examination date:');
    });

    it('shows a human-readable exam date when a genuine exam_date exists', () => {
        const withExamDate = { ...FRESH_BATCH, exam_date: '2026-11-20' };
        const content = examinationNotificationService.generateNotificationContent('BATCH_CREATED', withExamDate);
        expect(content.message).toContain('Examination date:');
        expect(content.message).toMatch(/Nov 20, 2026/);
        expect(content.message).not.toContain('Invalid Date');
    });

    it('omits the clause for a malformed exam_date instead of "Invalid Date"', () => {
        const content = examinationNotificationService.generateNotificationContent(
            'BATCH_CREATED',
            { ...FRESH_BATCH, exam_date: 'not-a-date' }
        );
        expect(content.message).not.toContain('Examination date:');
        expect(content.message).not.toContain('Invalid Date');
    });

    it('applies the same rule to the calculated notification', () => {
        const created = examinationNotificationService.generateNotificationContent(
            'BATCH_CALCULATED',
            { ...FRESH_BATCH, total_amount: 45000 }
        );
        expect(created.message).not.toContain('Examination date:');
        expect(created.message).not.toContain('Invalid Date');
        expect(created.message).toContain('45000');
    });
});
