import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ExaminationProductionService, examinationProductionService, BatchToProductionPayload } from '../../../services/examinationProductionService';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
});

// Mock logger
vi.mock('../../../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock notification service
vi.mock('../../../services/notificationService', () => ({
  notificationService: {
    notify: vi.fn(),
  },
}));

describe('ExaminationProductionService', () => {
  let service: ExaminationProductionService;
  let mockCreateWorkOrder: ReturnType<typeof vi.fn>;

  /**
   * Builds an approved-snapshot release payload. Production subjects are
   * derived exclusively from the snapshot by the service under test.
   */
  const approvedPayload = (
    batchId: string,
    version: number,
    classes: Array<{
      className: string;
      learners: number;
      subjects: Array<{ name: string; pages: number; extraCopies?: number }>;
    }>,
    batchName = 'Test Batch',
    schoolName = 'Test School',
    extra: Partial<BatchToProductionPayload> = {}
  ): BatchToProductionPayload => ({
    batchId,
    batchName,
    schoolName,
    subjects: [],
    calculationVersion: version,
    approvedVersion: version,
    batchStatus: 'Approved',
    snapshot: {
      engineVersion: 'EXAM-2026.1',
      calculationVersion: version,
      provenance: 'CANONICAL',
      inputs: {
        classes: classes.map((c, ci) => ({
          classId: `c-${ci}`,
          className: c.className,
          learners: c.learners,
          subjects: c.subjects.map((s) => ({
            name: s.name,
            pages: s.pages,
            extraCopies: s.extraCopies ?? 0,
          })),
        })),
      },
      result: { classes: [] },
    },
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    service = new ExaminationProductionService();
    mockCreateWorkOrder = vi.fn();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await service.initialize();
      // Should not throw
      expect(true).toBe(true);
    });

    it('should not initialize twice', async () => {
      await service.initialize();
      await service.initialize();
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('sendBatchToProduction', () => {
    it('should create work orders for batch subjects', async () => {
      await service.initialize();

      const payload = approvedPayload(
        'BATCH-001',
        1,
        [
          {
            className: 'Form 1',
            learners: 50,
            subjects: [
              { name: 'Mathematics', pages: 20, extraCopies: 5 },
              { name: 'English', pages: 15, extraCopies: 3 },
            ],
          },
        ],
        'Term 1 2026',
        'Test School',
        { priority: 'High' }
      );

      const jobs = await service.sendBatchToProduction(payload, mockCreateWorkOrder);

      expect(jobs).toHaveLength(2);
      expect(mockCreateWorkOrder).toHaveBeenCalledTimes(2);
      expect(jobs[0].subject).toBe('Mathematics');
      expect(jobs[1].subject).toBe('English');
      expect(jobs[0].batchId).toBe('BATCH-001');
      expect(jobs[0].schoolName).toBe('Test School');
    });

    it('should set correct attributes on work orders', async () => {
      await service.initialize();

      const payload = approvedPayload(
        'BATCH-002',
        1,
        [{ className: 'Form 2', learners: 40, subjects: [{ name: 'Science', pages: 25, extraCopies: 4 }] }],
        'Term 2 2026',
        'Another School'
      );

      await service.sendBatchToProduction(payload, mockCreateWorkOrder);

      // Snapshot-derived: copies 44, sheets ceil(25/2)*44 = 572, pages 1100.
      expect(mockCreateWorkOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'EXAM-PRINT',
          productName: expect.stringContaining('Science'),
          quantityPlanned: 44,
          status: 'Scheduled',
          customerName: 'Another School',
          tags: expect.arrayContaining(['Examination', 'Form 2', 'BATCH-002']),
          attributes: expect.objectContaining({
            pages: 25,
            candidates: 40,
            total_sheets: 572,
            total_pages: 1100,
          }),
        })
      );
    });

    it('should fail closed when the approved snapshot is missing', async () => {
      await service.initialize();

      const payload: BatchToProductionPayload = {
        batchId: 'BATCH-003',
        batchName: 'Empty Batch',
        schoolName: 'Test School',
        subjects: [],
      };

      await expect(service.sendBatchToProduction(payload, mockCreateWorkOrder)).rejects.toThrow(/not Approved|no approved pricing snapshot/i);
      expect(mockCreateWorkOrder).not.toHaveBeenCalled();
    });

    it('should fail closed for non-approved batches', async () => {
      await service.initialize();

      const payload = approvedPayload('BATCH-003b', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10 }] },
      ]);
      await expect(
        service.sendBatchToProduction({ ...payload, batchStatus: 'Calculated' }, mockCreateWorkOrder)
      ).rejects.toThrow(/not Approved/i);
      expect(mockCreateWorkOrder).not.toHaveBeenCalled();
    });

    it('should fail closed on version mismatch and corrupt snapshots', async () => {
      await service.initialize();

      const base = approvedPayload('BATCH-003c', 2, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10 }] },
      ]);
      await expect(
        service.sendBatchToProduction({ ...base, approvedVersion: 1 }, mockCreateWorkOrder)
      ).rejects.toThrow(/does not match approved version/i);
      await expect(
        service.sendBatchToProduction(
          { ...base, snapshot: { ...(base.snapshot as object), provenance: 'whatever' } },
          mockCreateWorkOrder
        )
      ).rejects.toThrow(/unrecognized snapshot provenance/i);
      expect(mockCreateWorkOrder).not.toHaveBeenCalled();
    });
  });

  describe('getJobs', () => {
    it('should return all jobs', async () => {
      await service.initialize();

      const payload: BatchToProductionPayload = approvedPayload('BATCH-004', 1, [
        {
          className: 'Form 1',
          learners: 20,
          subjects: [
            { name: 'Math', pages: 10, extraCopies: 2 },
            { name: 'English', pages: 8, extraCopies: 2 },
          ],
        },
      ]);

      await service.sendBatchToProduction(payload, mockCreateWorkOrder);

      const jobs = service.getJobs();
      expect(jobs).toHaveLength(2);
    });
  });

  describe('getJobsByBatch', () => {
    it('should return jobs for a specific batch', async () => {
      await service.initialize();

      // Create jobs for batch 1
      await service.sendBatchToProduction(approvedPayload('BATCH-005', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10, extraCopies: 2 }] },
      ], 'Batch 1', 'School A'), mockCreateWorkOrder);

      // Create jobs for batch 2
      await service.sendBatchToProduction(approvedPayload('BATCH-006', 1, [
        { className: 'Form 2', learners: 30, subjects: [{ name: 'Science', pages: 15, extraCopies: 3 }] },
      ], 'Batch 2', 'School B'), mockCreateWorkOrder);

      const batch1Jobs = service.getJobsByBatch('BATCH-005');
      expect(batch1Jobs).toHaveLength(1);
      expect(batch1Jobs[0].batchName).toBe('Batch 1');
    });
  });

  describe('getJobsByStatus', () => {
    it('should return jobs by status', async () => {
      await service.initialize();

      await service.sendBatchToProduction(approvedPayload('BATCH-007', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10, extraCopies: 2 }] },
      ]), mockCreateWorkOrder);

      const pendingJobs = service.getJobsByStatus('pending');
      const inProgressJobs = service.getJobsByStatus('in_progress');

      // Jobs should be in_progress after creation (work order created)
      expect(inProgressJobs.length).toBeGreaterThan(0);
    });
  });

  describe('getPendingJobs', () => {
    it('should return pending jobs', async () => {
      await service.initialize();

      const pendingJobs = service.getPendingJobs();
      expect(Array.isArray(pendingJobs)).toBe(true);
    });
  });

  describe('getJobByWorkOrder', () => {
    it('should find job by work order ID', async () => {
      await service.initialize();

      await service.sendBatchToProduction(approvedPayload('BATCH-008', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10, extraCopies: 2 }] },
      ]), mockCreateWorkOrder);

      // Get the work order ID from the mock call
      const workOrderId = mockCreateWorkOrder.mock.calls[0][0].id;
      const job = service.getJobByWorkOrder(workOrderId);

      expect(job).toBeDefined();
      expect(job?.workOrderId).toBe(workOrderId);
    });
  });

  describe('updateJobStatus', () => {
    it('should update job status', async () => {
      await service.initialize();

      await service.sendBatchToProduction(approvedPayload('BATCH-009', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10, extraCopies: 2 }] },
      ]), mockCreateWorkOrder);

      const jobs = service.getJobs();
      const jobId = jobs[0].id;

      const updated = await service.updateJobStatus(jobId, 'completed');
      expect(updated?.status).toBe('completed');
    });

    it('should return null for non-existent job', async () => {
      await service.initialize();

      const result = await service.updateJobStatus('non-existent-id', 'completed');
      expect(result).toBeNull();
    });
  });

  describe('getStatistics', () => {
    it('should return correct statistics', async () => {
      await service.initialize();

      await service.sendBatchToProduction(approvedPayload('BATCH-010', 1, [
        {
          className: 'Form 1',
          learners: 20,
          subjects: [
            { name: 'Math', pages: 10, extraCopies: 2 },
            { name: 'English', pages: 8, extraCopies: 2 },
          ],
        },
      ]), mockCreateWorkOrder);

      const stats = service.getStatistics();

      expect(stats.total).toBe(2);
      expect(stats.inProgress).toBe(2); // Jobs are in_progress after creation
      expect(stats.totalQuantity).toBe(44); // 22 + 22
      expect(stats.totalSheets).toBe(198); // snapshot-derived: 110 + 88
    });
  });

  describe('clearJobs', () => {
    it('should clear all jobs', async () => {
      await service.initialize();

      await service.sendBatchToProduction(approvedPayload('BATCH-011', 1, [
        { className: 'Form 1', learners: 20, subjects: [{ name: 'Math', pages: 10, extraCopies: 2 }] },
      ]), mockCreateWorkOrder);

      expect(service.getJobs().length).toBeGreaterThan(0);

      await service.clearJobs();
      expect(service.getJobs()).toHaveLength(0);
    });
  });

  describe('singleton instance', () => {
    it('should export a singleton instance', () => {
      expect(examinationProductionService).toBeDefined();
      expect(examinationProductionService).toBeInstanceOf(ExaminationProductionService);
    });
  });
});
