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

const express = require('express');
const request = require('supertest');
const repoCanonical = require('../../services/supabaseCanonicalRepository.cjs');
const assetsRoutes = require('../../routes/assets.cjs');

const app = express();
app.use(express.json());
app.use('/assets', assetsRoutes);

describe('assets CRUD endpoints', () => {
  beforeEach(() => {
    repoCanonical.getAll.mockResolvedValue([]);
    repoCanonical.getById.mockResolvedValue(null);
    repoCanonical.upsert.mockResolvedValue(null);
    repoCanonical.softDelete.mockResolvedValue(null);
  });

  // ─── GET / ───
  describe('GET /', () => {
    it('should list assets via repoCanonical.getAll', async () => {
      const now = new Date().toISOString();
      repoCanonical.getAll.mockResolvedValue([
        { id: 'AST1', name: 'Laptop', asset_type: 'computer', created_at: now },
      ]);

      const res = await request(app).get('/assets');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('assets');
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
      expect(res.body[0]).toHaveProperty('name', 'Laptop');
    });

    it('should return empty array when no assets', async () => {
      const res = await request(app).get('/assets');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ─── GET /:id ───
  describe('GET /:id', () => {
    it('should get existing asset via repoCanonical.getById', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'AST1', name: 'Laptop', asset_type: 'computer' });

      const res = await request(app).get('/assets/AST1');

      expect(repoCanonical.getById).toHaveBeenCalledWith('assets', 'AST1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('name', 'Laptop');
    });

    it('should return 404 when asset not found', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).get('/assets/NOT_FOUND');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Asset not found');
    });
  });

  // ─── POST / ───
  describe('POST /', () => {
    it('should create asset via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue(null);
      repoCanonical.upsert.mockResolvedValue(null);
      repoCanonical.getAll.mockResolvedValue([]);

      const res = await request(app).post('/assets').send({
        name: 'Server', asset_type: 'hardware', purchase_cost: 5000,
      });

      expect(repoCanonical.upsert).toHaveBeenCalledWith('assets', expect.objectContaining({
        name: 'Server', asset_type: 'hardware',
      }));
      expect(res.status).toBe(201);
    });

    it('should return 400 when name and asset_type missing', async () => {
      const res = await request(app).post('/assets').send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /:id ───
  describe('PUT /:id', () => {
    it('should update existing asset via repoCanonical.getById and repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'AST1', name: 'Laptop', asset_type: 'computer', status: 'active' });
      repoCanonical.upsert.mockResolvedValue(null);
      repoCanonical.getAll.mockResolvedValue([]);

      const res = await request(app).put('/assets/AST1').send({ name: 'Updated Laptop' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('assets', 'AST1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('assets', expect.objectContaining({ name: 'Updated Laptop' }));
      expect(res.status).toBe(200);
    });

    it('should return 404 when updating non-existent asset', async () => {
      repoCanonical.getById.mockResolvedValue(null);
      const res = await request(app).put('/assets/NOT_FOUND').send({ name: 'New' });
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Asset not found');
    });
  });

  // ─── DELETE /:id ───
  describe('DELETE /:id', () => {
    it('should soft-delete asset via repoCanonical.softDelete', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'AST1', name: 'Laptop' });
      repoCanonical.softDelete.mockResolvedValue(null);

      const res = await request(app).delete('/assets/AST1');

      expect(repoCanonical.getById).toHaveBeenCalledWith('assets', 'AST1');
      expect(repoCanonical.softDelete).toHaveBeenCalledWith('assets', 'AST1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should return 404 when deleting non-existent asset', async () => {
      repoCanonical.getById.mockResolvedValue(null);
      const res = await request(app).delete('/assets/NOT_FOUND');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Asset not found');
    });
  });
});
