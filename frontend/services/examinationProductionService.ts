/**
 * Examination-Production Integration Service
 * Connects examination batches to production work orders
 * When a batch is calculated, it creates work orders in the Production Queue
 */

import { logger } from './logger';
import { notificationService } from './notificationService';
import { dbService } from './db';
import { createWorkOrdersFromBatch, type WorkOrderPayload } from '../src/adapters/productionAdapter';

export interface ExaminationProductionJob {
  id: string;
  batchId: string;
  batchName: string;
  workOrderId: string;
  subject: string;
  className: string;
  schoolName: string;
  quantity: number;
  totalPages: number;
  totalSheets: number;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  createdAt: string;
  updatedAt: string;
  dueDate: string;
  /**
   * Approved calculation version this job was released for. A recalculation
   * mints a new version; releases are idempotent per (batchId, version) so
   * the same calculation can never create duplicate production work.
   */
  calculationVersion?: number;
  /** Set when a newer calculation version supersedes this release. */
  superseded?: boolean;
  attributes: {
    pages: number;
    candidates: number;
    base_sheets: number;
    total_sheets: number;
    total_pages: number;
    production_copies: number;
    extra_copies: number;
  };
}

export interface BatchToProductionPayload {
  batchId: string;
  batchName: string;
  schoolName: string;
  /** Approved calculation version being released (0 = unknown/legacy). */
  calculationVersion?: number;
  /**
   * The immutable approved pricing snapshot this release is built from.
   * Production work is derived EXCLUSIVELY from the snapshot — never from
   * live batch/class values or current material costs. Missing, corrupt, or
   * version-mismatched snapshots fail closed (no work is created).
   */
  snapshot?: Record<string, any> | null;
  /** Calculation version pinned at approval; must equal snapshot's version. */
  approvedVersion?: number;
  /** Batch status at release time; only 'Approved' releases production. */
  batchStatus?: string;
  subjects: Array<{
    subject: string;
    className: string;
    pages: number;
    candidates: number;
    extraCopies: number;
    baseSheets: number;
    totalSheets: number;
    totalPages: number;
    productionCopies: number;
  }>;
  priority?: 'Low' | 'Medium' | 'High' | 'Critical';
  dueDate?: string;
}

const EXAM_PRODUCTION_JOBS_KEY = 'examination_production_jobs';

/** Approved snapshot provenances allowed to release production work. */
const PRODUCTION_SNAPSHOT_PROVENANCES = new Set(['CANONICAL', 'RECONSTRUCTED_LEGACY']);

/**
 * Derives production subjects EXCLUSIVELY from an approved pricing snapshot.
 * Physical quantities (sheets/pages/copies) are recomputed deterministically
 * from the frozen inputs — current material costs, live class fees, and
 * mutable batch values are never consulted, so production can never become
 * financial truth and can never silently upgrade an old calculation.
 */
export const buildProductionSubjectsFromSnapshot = (
  snapshot: Record<string, any> | null | undefined
): BatchToProductionPayload['subjects'] => {
  const inputClasses = (snapshot as any)?.inputs?.classes;
  if (!Array.isArray(inputClasses) || inputClasses.length === 0) {
    throw new Error('Cannot release production: approved snapshot has no frozen class inputs');
  }
  const subjects: BatchToProductionPayload['subjects'] = [];
  for (const cls of inputClasses) {
    const learners = Math.max(1, Math.floor(Number(cls?.learners) || 0));
    const className = String(cls?.className || 'Unknown Class');
    const classSubjects = Array.isArray(cls?.subjects) ? cls.subjects : [];
    if (classSubjects.length === 0) {
      throw new Error('Cannot release production: approved snapshot class has no frozen subjects');
    }
    for (const sub of classSubjects) {
      const pages = Math.max(1, Math.floor(Number(sub?.pages) || 0));
      const extraCopies = Math.max(0, Math.floor(Number(sub?.extraCopies) || 0));
      const productionCopies = learners + extraCopies;
      const totalSheets = Math.ceil(pages / 2) * productionCopies;
      subjects.push({
        subject: String(sub?.name || 'Unknown Subject'),
        className,
        pages,
        candidates: learners,
        extraCopies,
        baseSheets: totalSheets,
        totalSheets,
        totalPages: pages * productionCopies,
        productionCopies,
      });
    }
  }
  if (subjects.length === 0) {
    throw new Error('Cannot release production: approved snapshot yields no subjects');
  }
  return subjects;
};

/**
 * Validates the production-release boundary. Production work requires an
 * approved batch whose pinned version matches an immutable snapshot with
 * recognised provenance. Anything else fails closed.
 */
const assertApprovableRelease = (payload: BatchToProductionPayload): { snapshot: Record<string, any>; version: number } => {
  const status = String(payload?.batchStatus || '').trim().toLowerCase();
  if (status !== 'approved') {
    throw new Error(
      `Cannot release production: batch ${String(payload?.batchId || '')} is not Approved (status: ${String(payload?.batchStatus || 'unknown')})`
    );
  }
  const snapshot = (payload?.snapshot || null) as Record<string, any> | null;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error(`Cannot release production: batch ${String(payload?.batchId || '')} has no approved pricing snapshot`);
  }
  const version = Math.max(0, Math.floor(Number(payload?.calculationVersion) || 0));
  const approvedVersion = Math.max(0, Math.floor(Number(payload?.approvedVersion ?? version) || 0));
  const snapshotVersion = Math.max(0, Math.floor(Number((snapshot as any)?.calculationVersion) || 0));
  if (version <= 0 || approvedVersion <= 0 || snapshotVersion <= 0) {
    throw new Error(`Cannot release production: batch ${String(payload?.batchId || '')} has no approved calculation version`);
  }
  if (snapshotVersion !== version || snapshotVersion !== approvedVersion) {
    throw new Error(
      `Cannot release production: snapshot version ${snapshotVersion} does not match approved version ${approvedVersion} for batch ${String(payload?.batchId || '')}`
    );
  }
  if (!PRODUCTION_SNAPSHOT_PROVENANCES.has(String((snapshot as any)?.provenance || ''))) {
    throw new Error(
      `Cannot release production: unrecognized snapshot provenance '${String((snapshot as any)?.provenance || '')}' for batch ${String(payload?.batchId || '')}`
    );
  }
  return { snapshot, version };
};

class ExaminationProductionService {
  private jobs: Map<string, ExaminationProductionJob> = new Map();
  private initialized: boolean = false;

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.loadJobs();
      this.initialized = true;
      logger.info('Examination-Production service initialized', {
        jobs: this.jobs.size,
      });
    } catch (error) {
      logger.error('Failed to initialize examination-production service', error as Error);
      throw error;
    }
  }

  /**
   * Load jobs from storage
   */
  private async loadJobs(): Promise<void> {
    try {
      const saved = await dbService.getSetting<ExaminationProductionJob[]>(EXAM_PRODUCTION_JOBS_KEY);
      if (saved && saved.length > 0) {
        saved.forEach(job => this.jobs.set(job.id, job));
      } else {
        const local = localStorage.getItem(EXAM_PRODUCTION_JOBS_KEY);
        if (local) {
          const jobs: ExaminationProductionJob[] = JSON.parse(local);
          jobs.forEach(job => this.jobs.set(job.id, job));
        }
      }
    } catch (error) {
      logger.error('Failed to load examination production jobs', error as Error);
    }
  }

  /**
   * Save jobs to storage
   */
  private async saveJobs(): Promise<void> {
    try {
      const jobs = Array.from(this.jobs.values());
      await dbService.saveSetting(EXAM_PRODUCTION_JOBS_KEY, jobs);
    } catch (error) {
      logger.error('Failed to save examination production jobs', error as Error);
    }
  }

  /**
   * Convert a calculated batch to production work orders
   * This is called when a batch status changes to 'Calculated'
   */
  async sendBatchToProduction(
    payload: BatchToProductionPayload,
    createWorkOrderFn: (wo: any) => void
  ): Promise<ExaminationProductionJob[]> {
    try {
      await this.initialize();

      // Strict boundary first: anything that is not an approved snapshot
      // release fails closed before any work is created or dispatched.
      const { snapshot, version: releaseVersion } = assertApprovableRelease(payload);
      // Subjects come ONLY from the approved snapshot — never from live
      // batch/class values or current material costs.
      const snapshotSubjects = buildProductionSubjectsFromSnapshot(snapshot);
      const snapshotPayload: BatchToProductionPayload = { ...payload, subjects: snapshotSubjects };

      const existing = Array.from(this.jobs.values()).filter(job => job.batchId === snapshotPayload.batchId);
      // Idempotency: the same calculation version is released at most once.
      // A newer version supersedes (but never deletes) earlier releases so
      // stale production work stays distinguishable from current work.
      if (existing.some(job => Number(job.calculationVersion) === releaseVersion)) {
        logger.info('Batch production release already exists for calculation version — skipping duplicates', {
          batchId: snapshotPayload.batchId,
          calculationVersion: releaseVersion,
        });
        return existing.filter(job => Number(job.calculationVersion) === releaseVersion);
      }
      let marked = false;
      for (const job of existing) {
        if (Number(job.calculationVersion || 0) < releaseVersion && !job.superseded) {
          job.superseded = true;
          job.updatedAt = new Date().toISOString();
          marked = true;
        }
      }
      if (marked) await this.saveJobs();

      const createdJobs: ExaminationProductionJob[] = [];
      const records = createWorkOrdersFromBatch(snapshotPayload);

      for (const record of records) {
        const job: ExaminationProductionJob = { ...record.job, calculationVersion: releaseVersion };
        this.jobs.set(job.id, job);
        createdJobs.push(job);

        try {
          createWorkOrderFn(record.workOrder as WorkOrderPayload);
          job.status = 'in_progress';
          job.updatedAt = new Date().toISOString();
        } catch (error) {
          logger.error('Failed to create work order for examination subject', error as Error, {
            batchId: snapshotPayload.batchId,
            subject: job.subject,
          });
        }
      }

      await this.saveJobs();

      // Send notification
      notificationService.notify({
        type: 'success',
        title: 'Examination Batch Sent to Production',
        message: `${createdJobs.length} work order(s) created for batch "${snapshotPayload.batchName}" (${snapshotPayload.schoolName})`,
        entityType: 'ExaminationBatch',
        entityId: snapshotPayload.batchId,
        actionUrl: '/industrial/work-orders',
      });

      logger.info('Batch sent to production', {
        batchId: snapshotPayload.batchId,
        batchName: snapshotPayload.batchName,
        jobsCreated: createdJobs.length,
      });

      return createdJobs;
    } catch (error) {
      logger.error('Failed to send batch to production', error as Error, {
        batchId: payload.batchId,
      });
      throw error;
    }
  }

  /**
   * Get all examination production jobs
   */
  getJobs(): ExaminationProductionJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get jobs by batch ID
   */
  getJobsByBatch(batchId: string): ExaminationProductionJob[] {
    return Array.from(this.jobs.values()).filter(job => job.batchId === batchId);
  }

  /**
   * Get jobs by status
   */
  getJobsByStatus(status: ExaminationProductionJob['status']): ExaminationProductionJob[] {
    return Array.from(this.jobs.values()).filter(job => job.status === status);
  }

  /**
   * Get pending jobs (ready for production)
   */
  getPendingJobs(): ExaminationProductionJob[] {
    return this.getJobsByStatus('pending');
  }

  /**
   * Get job by work order ID
   */
  getJobByWorkOrder(workOrderId: string): ExaminationProductionJob | undefined {
    return Array.from(this.jobs.values()).find(job => job.workOrderId === workOrderId);
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: ExaminationProductionJob['status']
  ): Promise<ExaminationProductionJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.status = status;
    job.updatedAt = new Date().toISOString();
    await this.saveJobs();

    return job;
  }

  /**
   * Update job by work order ID
   */
  async updateJobByWorkOrder(
    workOrderId: string,
    updates: Partial<ExaminationProductionJob>
  ): Promise<ExaminationProductionJob | null> {
    const job = this.getJobByWorkOrder(workOrderId);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    await this.saveJobs();

    return job;
  }

  /**
   * Get statistics for examination production jobs
   */
  getStatistics(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    totalQuantity: number;
    totalSheets: number;
  } {
    const jobs = Array.from(this.jobs.values());
    
    return {
      total: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      inProgress: jobs.filter(j => j.status === 'in_progress').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      cancelled: jobs.filter(j => j.status === 'cancelled').length,
      totalQuantity: jobs.reduce((sum, j) => sum + j.quantity, 0),
      totalSheets: jobs.reduce((sum, j) => sum + j.totalSheets, 0),
    };
  }

  /**
   * Clear all jobs (for testing/reset)
   */
  async clearJobs(): Promise<void> {
    this.jobs.clear();
    await this.saveJobs();
  }
}

// Export singleton instance
export const examinationProductionService = new ExaminationProductionService();

// Export class for testing
export { ExaminationProductionService };
