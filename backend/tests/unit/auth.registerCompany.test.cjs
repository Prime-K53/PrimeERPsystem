process.env.JWT_SECRET = 'test-jwt-secret-for-company-registration';

const request = require('supertest');
const express = require('express');

jest.mock('../../services/authService.cjs', () => ({
  registerUser: jest.fn(),
  authenticateUser: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('../../services/portalAuthService.cjs', () => ({
  authenticatePortalUser: jest.fn(),
  isTwoFactorEnabled: jest.fn(),
  getTwoFactorSecret: jest.fn(),
  verifyTwoFactorToken: jest.fn(),
  createSession: jest.fn(),
  recordLoginHistory: jest.fn(),
}));

jest.mock('../../services/supabaseRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
}));

const authService = require('../../services/authService.cjs');
const repo = require('../../services/supabaseRepository.cjs');
const authRoutes = require('../../routes/auth.cjs');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
};

const validPayload = () => ({
  companyName: 'Acme Corporation',
  companyEmail: 'contact@acme.com',
  companyPhone: '+265 884 000 000',
  addressLine1: '123 Business Way',
  city: 'Lilongwe',
  country: 'Malawi',
  currencySymbol: 'K',
  adminFullName: 'Jane Doe',
  adminUsername: 'jane_admin',
  adminEmail: 'jane@acme.com',
  adminPassword: 'secret123',
});

describe('POST /api/auth/register-company — public company creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.getAll.mockResolvedValue([]);
    repo.upsert.mockResolvedValue({ id: 'companyConfig' });
    authService.registerUser.mockImplementation(async ({ username, email }) => ({
      id: 'usr_test_company',
      username,
      email,
      role: 'Admin',
      permissions: [],
    }));
  });

  it('provisions a company + Admin and returns a token (201)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-company')
      .send(validPayload());

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/registered/i);
    expect(res.body.user.role).toBe('Admin');
    expect(res.body.token).toBeDefined();
    expect(res.body.company.name).toBe('Acme Corporation');
    // Server forces the Admin role — never trusts client input.
    expect(authService.registerUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jane_admin', email: 'jane@acme.com', role: 'Admin' })
    );
  });

  it('rejects a duplicate email/username with 409 without creating', async () => {
    repo.getAll.mockResolvedValue([
      { id: 'u1', data: { username: 'jane_admin', email: 'jane@acme.com' } },
    ]);
    const res = await request(buildApp())
      .post('/api/auth/register-company')
      .send(validPayload());

    expect(res.status).toBe(409);
    expect(authService.registerUser).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads (short company + bad email + short password)', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-company')
      .send({ ...validPayload(), companyName: 'A', adminEmail: 'bad', adminPassword: '123' });

    expect(res.status).toBe(400);
    expect(authService.registerUser).not.toHaveBeenCalled();
  });

  it('never honors a client-supplied role', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register-company')
      .send({ ...validPayload(), role: 'Super Admin', permissions: ['everything'] });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('Admin');
    expect(authService.registerUser).toHaveBeenCalledWith(
      expect.not.objectContaining({ permissions: ['everything'] })
    );
  });
});
