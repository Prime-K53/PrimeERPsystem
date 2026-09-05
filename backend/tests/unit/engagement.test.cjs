process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  isConfigured: jest.fn(() => true),
}));

jest.mock('../../services/cloudSyncStore.cjs', () => ({
  upsertRow: jest.fn(),
  softDeleteRow: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const repoCanonical = require('../../services/supabaseCanonicalRepository.cjs');
const engagementRoutes = require('../../routes/engagement.cjs');

const app = express();
app.use(express.json());
app.use('/', engagementRoutes);

describe('engagement WRITE endpoints', () => {
  beforeEach(() => {
    repoCanonical.isConfigured.mockReturnValue(true);
    repoCanonical.getAll.mockResolvedValue([]);
    repoCanonical.getById.mockResolvedValue(null);
    repoCanonical.upsert.mockResolvedValue(null);
    repoCanonical.softDelete.mockResolvedValue(null);
  });

  // ─── POST /tiers ───
  describe('POST /tiers', () => {
    it('should create a tier via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue({ id: 'T1', name: 'Basic' });

      const res = await request(app)
        .post('/tiers')
        .send({ name: 'Basic', level: 1 });

      expect(repoCanonical.upsert).toHaveBeenCalledWith(
        'engagement_membership_tiers',
        expect.objectContaining({ name: 'Basic', level: 1 })
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/tiers')
        .send({ name: 'Basic', level: 1 });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /tiers/:id ───
  describe('PUT /tiers/:id', () => {
    it('should update an existing tier via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'T1', name: 'Basic', level: 1 });
      repoCanonical.upsert.mockResolvedValue({ id: 'T1', name: 'Premium', level: 2 });

      const res = await request(app)
        .put('/tiers/T1')
        .send({ name: 'Premium', level: 2 });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_membership_tiers', 'T1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_membership_tiers', expect.objectContaining({ name: 'Premium' }));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should return 404 when tier does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).put('/tiers/NOT_FOUND').send({ name: 'New' });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not found');
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.getById.mockRejectedValue(new Error('DB error'));

      const res = await request(app).put('/tiers/T1').send({ name: 'New' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── DELETE /tiers/:id ───
  describe('DELETE /tiers/:id', () => {
    it('should soft-delete a tier via repoCanonical.softDelete', async () => {
      repoCanonical.softDelete.mockResolvedValue({ id: 'T1' });

      const res = await request(app).delete('/tiers/T1');

      expect(repoCanonical.softDelete).toHaveBeenCalledWith('engagement_membership_tiers', 'T1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.softDelete.mockRejectedValue(new Error('DB error'));

      const res = await request(app).delete('/tiers/T1');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── POST /gift-cards ───
  describe('POST /gift-cards', () => {
    it('should create a gift card via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue({ id: 'GC1', code: 'CARD001' });

      const res = await request(app)
        .post('/gift-cards')
        .send({ code: 'CARD001', initialBalance: 100 });

      expect(repoCanonical.upsert).toHaveBeenCalledWith(
        'engagement_gift_cards',
        expect.objectContaining({ code: 'CARD001' })
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/gift-cards')
        .send({ code: 'CARD001' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /gift-cards/:id ───
  describe('PUT /gift-cards/:id', () => {
    it('should update an existing gift card via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'GC1', code: 'CARD001', current_balance: 100 });
      repoCanonical.upsert.mockResolvedValue({ id: 'GC1', code: 'CARD001', current_balance: 150 });

      const res = await request(app)
        .put('/gift-cards/GC1')
        .send({ current_balance: 150 });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_gift_cards', 'GC1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_gift_cards', expect.objectContaining({ current_balance: 150 }));
      expect(res.status).toBe(200);
    });

    it('should return 404 when gift card does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).put('/gift-cards/NOT_FOUND').send({ code: 'NEW' });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not found');
    });
  });

  // ─── POST /promotions ───
  describe('POST /promotions', () => {
    it('should create a promotion via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue({ id: 'PROMO1', name: 'Summer Sale' });

      const res = await request(app)
        .post('/promotions')
        .send({ name: 'Summer Sale', type: 'discount' });

      expect(repoCanonical.upsert).toHaveBeenCalledWith(
        'engagement_promotions',
        expect.objectContaining({ name: 'Summer Sale' })
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/promotions')
        .send({ name: 'Summer Sale' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /promotions/:id ───
  describe('PUT /promotions/:id', () => {
    it('should update an existing promotion via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'PROMO1', name: 'Summer Sale' });
      repoCanonical.upsert.mockResolvedValue({ id: 'PROMO1', name: 'Winter Sale' });

      const res = await request(app)
        .put('/promotions/PROMO1')
        .send({ name: 'Winter Sale' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_promotions', 'PROMO1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_promotions', expect.objectContaining({ name: 'Winter Sale' }));
      expect(res.status).toBe(200);
    });

    it('should return 404 when promotion does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).put('/promotions/NOT_FOUND').send({ name: 'New' });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not found');
    });
  });

  // ─── DELETE /promotions/:id ───
  describe('DELETE /promotions/:id', () => {
    it('should soft-delete a promotion via repoCanonical.softDelete', async () => {
      repoCanonical.softDelete.mockResolvedValue({ id: 'PROMO1' });

      const res = await request(app).delete('/promotions/PROMO1');

      expect(repoCanonical.softDelete).toHaveBeenCalledWith('engagement_promotions', 'PROMO1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.softDelete.mockRejectedValue(new Error('DB error'));

      const res = await request(app).delete('/promotions/PROMO1');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PATCH /cashback/:id/approve ───
  describe('PATCH /cashback/:id/approve', () => {
    it('should approve a cashback entry via repoCanonical.upsert', async () => {
      let callCount = 0;
      repoCanonical.getById.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? { id: 'CB1', status: 'pending' } : { id: 'CB1', status: 'approved' };
      });

      const res = await request(app).patch('/cashback/CB1/approve');

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_cashback', 'CB1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_cashback', expect.objectContaining({ status: 'approved' }));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should return 404 when cashback entry does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).patch('/cashback/NOT_FOUND/approve');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Cashback entry not found');
    });
  });

  // ─── PATCH /cashback/:id/pay ───
  describe('PATCH /cashback/:id/pay', () => {
    it('should pay a cashback entry via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockImplementation(() => ({ id: 'CB1', status: 'approved' }));
      repoCanonical.upsert.mockImplementation(() => ({ id: 'CB1', status: 'paid' }));

      const res = await request(app).patch('/cashback/CB1/pay').send({ walletTxId: 'WT123' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_cashback', 'CB1');
      expect(res.status).toBe(200);
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_cashback', expect.objectContaining({ status: 'paid' }));
    });

    it('should return 404 when cashback entry does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).patch('/cashback/NOT_FOUND/pay');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not found');
    });
  });

  // ─── POST /points ───
  describe('POST /points', () => {
    it('should create points via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue({ id: 'PT1', points: 50 });

      const res = await request(app)
        .post('/points')
        .send({ customerId: 'C1', points: 50, type: 'earned' });

      expect(repoCanonical.upsert).toHaveBeenCalledWith(
        'engagement_points',
        expect.objectContaining({ customer_id: 'C1', points: 50 })
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/points')
        .send({ customerId: 'C1', points: 50 });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── POST /affiliates ───
  describe('POST /affiliates', () => {
    it('should create an affiliate via repoCanonical.upsert', async () => {
      repoCanonical.upsert.mockResolvedValue({ id: 'AFF1', name: 'Affiliate A' });

      const res = await request(app)
        .post('/affiliates')
        .send({ name: 'Affiliate A' });

      expect(repoCanonical.upsert).toHaveBeenCalledWith(
        'engagement_affiliates',
        expect.objectContaining({ name: 'Affiliate A' })
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.upsert.mockRejectedValue(new Error('DB error'));

      const res = await request(app).post('/affiliates').send({ name: 'Affiliate A' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /affiliates/:id ───
  describe('PUT /affiliates/:id', () => {
    it('should update an existing affiliate via repoCanonical.upsert', async () => {
      repoCanonical.getById.mockResolvedValue({ id: 'AFF1', name: 'Affiliate A' });
      repoCanonical.upsert.mockResolvedValue({ id: 'AFF1', name: 'Affiliate B' });

      const res = await request(app).put('/affiliates/AFF1').send({ name: 'Affiliate B' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_affiliates', 'AFF1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_affiliates', expect.objectContaining({ name: 'Affiliate B' }));
      expect(res.status).toBe(200);
    });

    it('should return 404 when affiliate does not exist', async () => {
      repoCanonical.getById.mockResolvedValue(null);

      const res = await request(app).put('/affiliates/NOT_FOUND').send({ name: 'New' });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not found');
    });
  });

  // ─── DELETE /affiliates/:id ───
  describe('DELETE /affiliates/:id', () => {
    it('should soft-delete an affiliate via repoCanonical.softDelete', async () => {
      repoCanonical.softDelete.mockResolvedValue({ id: 'AFF1' });

      const res = await request(app).delete('/affiliates/AFF1');

      expect(repoCanonical.softDelete).toHaveBeenCalledWith('engagement_affiliates', 'AFF1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.softDelete.mockRejectedValue(new Error('DB error'));

      const res = await request(app).delete('/affiliates/AFF1');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── PUT /settings ───
  describe('PUT /settings', () => {
    it('should update settings via repoCanonical.upsert when record exists', async () => {
      repoCanonical.getById.mockResolvedValue([{ id: 'S1', name: 'Old Name' }]);
      repoCanonical.upsert.mockResolvedValue({ id: 'S1', name: 'New Name' });

      const res = await request(app).put('/settings').send({ id: 'S1', name: 'New Name' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_settings', 'S1');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_settings', expect.objectContaining({ name: 'New Name' }));
      expect(res.status).toBe(200);
    });

    it('should create new setting when no existing record', async () => {
      repoCanonical.getById.mockResolvedValue([]);
      repoCanonical.upsert.mockResolvedValue({ id: 'S2', name: 'New Setting' });

      const res = await request(app).put('/settings').send({ id: 'S2', name: 'New Setting' });

      expect(repoCanonical.getById).toHaveBeenCalledWith('engagement_settings', 'S2');
      expect(repoCanonical.upsert).toHaveBeenCalledWith('engagement_settings', expect.objectContaining({ id: 'S2' }));
      expect(res.status).toBe(200);
    });

    it('should handle repository failure gracefully', async () => {
      repoCanonical.getById.mockRejectedValue(new Error('DB error'));

      const res = await request(app).put('/settings').send({ id: 'S1', name: 'Test' });

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });
});

describe('engagement READ endpoints', () => {
  beforeEach(() => {
    repoCanonical.isConfigured.mockReturnValue(true);
    repoCanonical.getAll.mockImplementation(() => []);
    repoCanonical.getById.mockImplementation(() => null);
    repoCanonical.upsert.mockImplementation(() => null);
    repoCanonical.softDelete.mockImplementation(() => null);
  });

  describe('GET /tiers', () => {
    it('should return all membership tiers using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([
        { id: 'tier-1', name: 'Basic', level: 1 },
        { id: 'tier-2', name: 'Premium', level: 2 },
      ]);

      const res = await request(app).get('/tiers');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_membership_tiers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should return empty array when no tiers exist', async () => {
      repoCanonical.getAll.mockResolvedValue([]);

      const res = await request(app).get('/tiers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should handle repository errors gracefully', async () => {
      repoCanonical.getAll.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/tiers');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('GET /gift-cards', () => {
    it('should return all gift cards using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'gc-1', code: 'CARD001' }]);

      const res = await request(app).get('/gift-cards');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_gift_cards');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /promotions', () => {
    it('should return all promotions using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'promo-1', name: 'Summer Sale' }]);

      const res = await request(app).get('/promotions');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_promotions');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /cashback', () => {
    it('should return all cashback entries using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'cb-1', amount: 100 }]);

      const res = await request(app).get('/cashback');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_cashback');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /points', () => {
    it('should return all points entries using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'pt-1', points: 50 }]);

      const res = await request(app).get('/points');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_points');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /point-balances', () => {
    it('should return all point balances using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'pb-1', balance: 1000 }]);

      const res = await request(app).get('/point-balances');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_point_balances');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /customer-tiers', () => {
    it('should return all customer tiers using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'ct-1', name: 'Gold' }]);

      const res = await request(app).get('/customer-tiers');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_customer_tiers');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /affiliates', () => {
    it('should return all affiliates using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'aff-1', name: 'Affiliate A' }]);

      const res = await request(app).get('/affiliates');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_affiliates');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /affiliate-commissions', () => {
    it('should return all affiliate commissions using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'ac-1', amount: 500 }]);

      const res = await request(app).get('/affiliate-commissions');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_affiliate_commissions');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /rewards', () => {
    it('should return all rewards using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'rw-1', name: 'Free Shipping' }]);

      const res = await request(app).get('/rewards');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_rewards');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /timeline', () => {
    it('should return timeline entries using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([
        { id: 'tl-1', customer_id: 'cust-1', timestamp: '2026-01-01' },
        { id: 'tl-2', customer_id: 'cust-2', timestamp: '2026-01-02' },
      ]);

      const res = await request(app).get('/timeline');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_timeline');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should filter timeline by customerId', async () => {
      repoCanonical.getAll.mockResolvedValue([
        { id: 'tl-1', customer_id: 'cust-1', timestamp: '2026-01-01' },
        { id: 'tl-2', customer_id: 'cust-2', timestamp: '2026-01-02' },
      ]);

      const res = await request(app).get('/timeline?customerId=cust-1');

      expect(res.body).toHaveLength(1);
      expect(res.body[0].customer_id).toBe('cust-1');
    });
  });

  describe('GET /audit', () => {
    it('should return audit entries using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'au-1', action: 'CREATE' }]);

      const res = await request(app).get('/audit');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_audit');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /analytics', () => {
    it('should return analytics entries using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'an-1', period: '2026-01' }]);

      const res = await request(app).get('/analytics');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_analytics');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /settings', () => {
    it('should return settings using repoCanonical.getAll', async () => {
      repoCanonical.getAll.mockResolvedValue([{ id: 'st-1', name: 'App Settings' }]);

      const res = await request(app).get('/settings');

      expect(repoCanonical.getAll).toHaveBeenCalledWith('engagement_settings');
      expect(res.status).toBe(200);
    });
  });
});
