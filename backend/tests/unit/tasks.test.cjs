process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
}));

jest.mock('../../utils/errors.cjs', () => ({
  sendSafeError: jest.fn((res, status, code) => res.status(status).json({ error: code })),
}));

jest.mock('../../middleware/validation.cjs', () => ({
  validateBody: jest.fn(() => (req, res, next) => next()),
  taskSchemas: { create: {} },
}));

const express = require('express');
const request = require('supertest');
const repoCanonical = require('../../services/supabaseCanonicalRepository.cjs');
const tasksRoutes = require('../../routes/tasks.cjs');

const app = express();
app.use(express.json());
app.use('/tasks', tasksRoutes);

describe('tasks CRUD endpoints', () => {
  beforeEach(() => {
    repoCanonical.getAll.mockResolvedValue([]);
    repoCanonical.getById.mockResolvedValue(null);
    repoCanonical.upsert.mockResolvedValue(null);
    repoCanonical.softDelete.mockResolvedValue(null);
  });

  // ─── GET / ───
  describe('GET /', () => {
    it('should list tasks via repoCanonical.getAll', async () => {
      const now = new Date().toISOString();
      repoCanonical.getAll.mockResolvedValue([
        { id: 'T1', title: 'Task 1', created_at: now, completed: 1, has_alarm: 0 },
      ]);

      const res = await request(app).get('/tasks');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('tasks');
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
      expect(res.body[0]).toHaveProperty('title', 'Task 1');
    });

    it('should return empty array when no tasks', async () => {
      const res = await request(app).get('/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ─── POST / ───
  describe('POST /', () => {
    it('should create task via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue(null);

      const res = await request(app).post('/tasks').send({
        title: 'New Task', description: 'Test task', status: 'Pending',
      });

      expect(repoCanonical.upsert).toHaveBeenCalledWith('tasks', expect.objectContaining({
        title: 'New Task',
      }));
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('title', 'New Task');
    });

    it('should return 500 on repository failure', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));
      const res = await request(app).post('/tasks').send({ title: 'Fail' });
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /:id ───
  describe('PUT /:id', () => {
    it('should update existing task via repoCanonical.getById and repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'T1', title: 'Old Task', status: 'Pending' });
      repoCanonical.upsert.mockResolvedValue(null);

      const res = await request(app).put('/tasks/T1').send({ title: 'Updated Task' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('tasks', 'T1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('tasks', expect.objectContaining({ title: 'Updated Task' }));
      expect(res.status).toBe(200);
    });

    it('should return 404 when updating non-existent task', async () => {
      repoCanonical.getById.mockResolvedValue(null);
      const res = await request(app).put('/tasks/NOT_FOUND').send({ title: 'New' });
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Task not found');
    });
  });

  // ─── DELETE /:id ───
  describe('DELETE /:id', () => {
    it('should soft-delete task via repoCanonical.softDelete', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'T1', title: 'Task 1' });
      repoCanonical.softDelete.mockResolvedValue(null);

      const res = await request(app).delete('/tasks/T1');

      expect(repoCanonical.getById).toHaveBeenCalledWith('tasks', 'T1');
      expect(repoCanonical.softDelete).toHaveBeenCalledWith('tasks', 'T1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should return 404 when deleting non-existent task', async () => {
      repoCanonical.getById.mockResolvedValue(null);
      const res = await request(app).delete('/tasks/NOT_FOUND');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Task not found');
    });
  });
});
