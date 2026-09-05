process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
  count: jest.fn(),
  softDelete: jest.fn(),
  isConfigured: jest.fn(() => true),
}));

jest.mock('../../services/licenseService.cjs', () => ({
  getFingerprint: jest.fn(() => 'test-fingerprint'),
  validateLicense: jest.fn(() => ({ mode: 'trial', valid: true })),
  generateTrialLicense: jest.fn(),
  licensePath: '/tmp/test.license',
}));

jest.mock('../../services/backupService.cjs', () => {
  return class {
    constructor() {}
    createBackup() { return Promise.resolve(); }
  };
});

jest.mock('../../runtimePaths.cjs', () => ({
  getDbPath: jest.fn(() => '/tmp/test.db'),
  backupDir: '/tmp/backup',
  ensureRuntimeDirs: jest.fn(),
}));

const repo = require('../../services/supabaseCanonicalRepository.cjs');
const bootstrap = require('../../bootstrap.cjs');

describe('bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('bootstrap()', () => {
    it('should verify Supabase connection using repo.getAll for settings', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(2);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      expect(repo.getAll).toHaveBeenCalledWith('settings', { select: 'id', limit: 1 });
      expect(consoleSpy).toHaveBeenCalledWith('Supabase connection verified.');

      consoleSpy.mockRestore();
    });

    it('should call repo.count for schools after connection check', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      expect(repo.count).toHaveBeenCalledWith('schools');
      expect(consoleSpy).toHaveBeenCalledWith('First run detected. Seeding default data...');

      consoleSpy.mockRestore();
    });

    it('should skip seeding when schools count > 0', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(5);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      expect(repo.count).toHaveBeenCalledWith('schools');
      expect(consoleSpy).not.toHaveBeenCalledWith('First run detected. Seeding default data...');

      consoleSpy.mockRestore();
    });

    it('should call repo.upsert for each school during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      expect(repo.upsert).toHaveBeenCalledWith('schools', expect.objectContaining({ id: 'school-1', name: 'Sample Academy' }));
      expect(repo.upsert).toHaveBeenCalledWith('schools', expect.objectContaining({ id: 'school-2', name: 'City Primary' }));

      consoleSpy.mockRestore();
    });

    it('should call repo.upsert for classes during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const classCalls = repo.upsert.mock.calls.filter(c => c[0] === 'classes');
      expect(classCalls.length).toBe(8);
      expect(classCalls[0]).toEqual(['classes', { id: 'class-standard-1', name: 'Standard 1' }]);
    });

    it('should call repo.upsert for subjects during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const subjectCalls = repo.upsert.mock.calls.filter(c => c[0] === 'subjects');
      expect(subjectCalls.length).toBe(12);
    });

    it('should call repo.upsert for inventory during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const invCalls = repo.upsert.mock.calls.filter(c => c[0] === 'inventory');
      expect(invCalls.length).toBe(2);
    });

    it('should call repo.upsert for work_centers during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const wcCalls = repo.upsert.mock.calls.filter(c => c[0] === 'work_centers');
      expect(wcCalls.length).toBe(3);
    });

    it('should call repo.upsert for production_resources during seeding', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const prCalls = repo.upsert.mock.calls.filter(c => c[0] === 'production_resources');
      expect(prCalls.length).toBe(3);
    });
  });

  describe('seedDefaultData()', () => {
    it('should seed 2 schools via repo.upsert', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      const schoolCalls = repo.upsert.mock.calls.filter(c => c[0] === 'schools');
      expect(schoolCalls.length).toBe(2);
      expect(schoolCalls[0][1]).toMatchObject({ id: 'school-1', name: 'Sample Academy' });
      expect(schoolCalls[1][1]).toMatchObject({ id: 'school-2', name: 'City Primary' });

      consoleSpy.mockRestore();
    });

    it('should seed classes with correct ids', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const classCalls = repo.upsert.mock.calls.filter(c => c[0] === 'classes');
      expect(classCalls[0][1]).toEqual({ id: 'class-standard-1', name: 'Standard 1' });
      expect(classCalls[7][1]).toEqual({ id: 'class-standard-8', name: 'Standard 8' });
    });

    it('should seed 12 subjects', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const subjectCalls = repo.upsert.mock.calls.filter(c => c[0] === 'subjects');
      expect(subjectCalls.length).toBe(12);
      expect(subjectCalls[0][1]).toMatchObject({ id: 'subject-1', name: 'Agriculture', code: 'AGRI' });
      expect(subjectCalls[11][1]).toMatchObject({ id: 'subject-12', name: 'Social & BK', code: 'SBK' });
    });

    it('should seed 2 inventory items', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const invCalls = repo.upsert.mock.calls.filter(c => c[0] === 'inventory');
      expect(invCalls.length).toBe(2);
      expect(invCalls[0][1]).toMatchObject({ id: 'INV-PAPER', name: 'Paper', quantity: 5000 });
      expect(invCalls[1][1]).toMatchObject({ id: 'INV-TONER', name: 'Toner', cost_per_unit: 0.25 });
    });

    it('should seed 3 work centers', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const wcCalls = repo.upsert.mock.calls.filter(c => c[0] === 'work_centers');
      expect(wcCalls.length).toBe(3);
      expect(wcCalls[0][1]).toMatchObject({ id: 'WC-PRN-01', name: 'Offset Printing Line 1', hourly_rate: 45.00 });
    });

    it('should seed 3 production resources', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: '1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      const prCalls = repo.upsert.mock.calls.filter(c => c[0] === 'production_resources');
      expect(prCalls.length).toBe(3);
      expect(prCalls[0][1]).toMatchObject({ id: 'RES-PRN-01', work_center_id: 'WC-PRN-01' });
    });
  });

  describe('Connection verification', () => {
    it('should call repo.getAll with settings table for connection check', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: 'settings-1' }]);
      repo.count.mockResolvedValueOnce(0);

      await bootstrap();

      expect(repo.getAll).toHaveBeenCalledWith('settings', { select: 'id', limit: 1 });
    });

    it('should warn if connection check returns no data', async () => {
      repo.getAll.mockResolvedValueOnce(null);
      repo.count.mockResolvedValueOnce(0);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      await bootstrap();

      expect(warnSpy).toHaveBeenCalledWith('[Bootstrap] Supabase connection check returned no data.');

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
