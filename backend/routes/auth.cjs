const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authService = require('../services/authService.cjs');
const portalAuthService = require('../services/portalAuthService.cjs');
const { generateToken, verifyToken, requireRole } = require('../middleware/auth.cjs');
const { validateBody, userSchemas } = require('../middleware/validation.cjs');

// Shared in-memory store for pending 2FA verification during login.
// In production, use Redis or a database for multi-instance deployments.
const pendingTwoFactorMap = new Map();

// ERP user creation is an ADMINISTRATIVE operation. This route used to be
// reachable without a token and minted a valid 'Clerk' JWT to any anonymous
// caller; that token passes verifyToken and the Clerk read allow-lists on
// every list endpoint (invoices, customers, suppliers, inventory, ...), i.e.
// it handed protected ERP data to unauthenticated visitors. No client calls
// this endpoint, so it is now gated to an already-authenticated Admin. The
// client-supplied role/permissions are still ignored (see authService).
router.post('/register', verifyToken, requireRole('Admin'), validateBody(userSchemas.publicRegister), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const user = await authService.registerUser({ username, email, password });
    const token = generateToken({ ...user });
    res.status(201).json({ message: 'User registered successfully', user, token });
  } catch (err) {
    if (err.message === 'Username already exists') {
      return res.status(409).json({ error: err.message });
    }
    console.error('[Auth] Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', validateBody(userSchemas.login), async (req, res) => {
  try {
    const { email, username, password, portal, two_factor_code } = req.body;
    const requestedPortal = portal === 'customer' ? 'customer' : 'admin';
    const identifier = String(email || username || '').trim();

    // Same API serves both portals. Detect the account type (staff vs customer)
    // and enforce that the account is used from its own portal only.
    const staff = await authService.authenticateUser(identifier, password);
    const portalUser = await portalAuthService.authenticatePortalUser(identifier, password);

    if (!staff && !portalUser) {
      console.warn(`[Auth] Login failed for ${identifier}: staff=${Boolean(staff)} portalUser=${Boolean(portalUser)}`);
      return res.status(401).json({ error: 'Invalid credentials', message: 'Email or password is incorrect' });
    }

    if (requestedPortal === 'customer') {
      if (portalUser) {
        // Check 2FA
        const twoFactorEnabled = await portalAuthService.isTwoFactorEnabled(portalUser.id);
        if (twoFactorEnabled && !two_factor_code) {
          const pendingToken = crypto.randomBytes(32).toString('hex');
          pendingTwoFactorMap.set(pendingToken, { userId: portalUser.id, email: portalUser.email });
          // Expire after 10 minutes
          setTimeout(() => pendingTwoFactorMap.delete(pendingToken), 10 * 60 * 1000);
          return res.json({
            requires_two_factor: true,
            pending_token: pendingToken,
            user: { id: portalUser.id, email: portalUser.email }
          });
        }
        if (twoFactorEnabled && two_factor_code) {
          const secret = await portalAuthService.getTwoFactorSecret(portalUser.id);
          const isValid = await portalAuthService.verifyTwoFactorToken(secret, two_factor_code);
          if (!isValid) {
            return res.status(401).json({ error: 'Invalid verification code' });
          }
        }
        return loginCustomer(res, portalUser);
      }
      if (staff) {
        return res.status(403).json({
          error: 'Wrong portal',
          code: 'ACCOUNT_BELONGS_TO_ADMIN',
          message: 'This account is an administrator account. Please sign in through the ERP.',
          role: 'admin'
        });
      }
    } else {
      if (staff) return loginStaff(res, staff);
      if (portalUser) {
        return res.status(403).json({
          error: 'Wrong portal',
          code: 'ACCOUNT_BELONGS_TO_CUSTOMER',
          message: 'This account belongs to the Customer Portal. Please sign in at portal.primeerp.com.',
          role: 'customer'
        });
      }
    }
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

async function loginStaff(res, user) {
  const token = generateToken({ ...user });
  res.json({
    message: 'Login successful',
    userId: user.id,
    role: 'admin',
    user: {
      id: user.id, username: user.username, email: user.email,
      role: user.role, permissions: user.permissions,
    },
    token
  });
}

async function loginCustomer(res, user) {
  const crypto = require('crypto');
  const { generatePortalToken } = require('../middleware/portalAuth.cjs');
  const token = generatePortalToken(user);
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const ip = res.req.ip || res.req.connection?.remoteAddress;
  const ua = res.req.headers['user-agent'];
  await portalAuthService.createSession(user.id, refreshToken, ip, ua);
  portalAuthService.recordLoginHistory(user.id, ip, ua).catch(() => {});
  res.json({
    message: 'Login successful',
    userId: user.id,
    role: 'customer',
    user: {
      id: user.id,
      customer_id: user.customer_id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone
    },
    access_token: token,
    refresh_token: refreshToken,
    expires_in: '30m'
  });
}

// Self-service company creation from the login page ("Create new company").
// Public by design (no session exists yet); rate-limited at the mount point
// (/api/auth shares the authLimiter bucket). The backend always provisions
// the first user as an Admin — role/permissions are never accepted from the
// client. Company config persistence is best-effort: the client's sync engine
// uploads the full normalized config after signup, so a best-effort settings
// row here must never fail the request.
router.post('/register-company', validateBody(userSchemas.registerCompany), async (req, res) => {
  try {
    const {
      companyName,
      companyEmail,
      companyPhone,
      addressLine1,
      city,
      country,
      currencySymbol,
      adminFullName,
      adminUsername,
      adminEmail,
      adminPassword,
    } = req.body;

    const normalizedEmail = String(adminEmail || '').toLowerCase().trim();
    const normalizedUsername = String(adminUsername || '').trim();

    // Duplicate check (best-effort when the store is unreachable).
    try {
      const repo = require('../services/supabaseRepository.cjs');
      const existing = await repo.getAll('users');
      const clash = (existing || []).find((r) => {
        const d = r.data || r;
        const email = String(d.email || '').toLowerCase().trim();
        const username = String(d.username || '').trim().toLowerCase();
        return (
          (email && email === normalizedEmail) ||
          (username && username === normalizedUsername.toLowerCase())
        );
      });
      if (clash) {
        return res.status(409).json({ error: 'An account with this email or username already exists' });
      }
    } catch {
      // Non-fatal: continue to creation; persistence layer will enforce uniqueness.
    }

    const user = await authService.registerUser({
      username: normalizedUsername,
      email: normalizedEmail,
      password: adminPassword,
      role: 'Admin',
      permissions: [],
    });

    const adminUser = {
      ...user,
      role: 'Admin',
      full_name: String(adminFullName || '').trim(),
    };

    // Best-effort company workspace record. Never fails the request.
    try {
      const repo = require('../services/supabaseRepository.cjs');
      const companyConfig = {
        companyName: String(companyName || '').trim(),
        email: companyEmail ? String(companyEmail).trim() : normalizedEmail,
        phone: companyPhone ? String(companyPhone).trim() : '',
        addressLine1: addressLine1 ? String(addressLine1).trim() : '',
        city: city ? String(city).trim() : '',
        country: country ? String(country).trim() : '',
        currencySymbol: currencySymbol ? String(currencySymbol).trim() : 'K',
        createdBy: adminUser.id,
        createdAt: new Date().toISOString(),
      };
      await repo.upsert('settings', {
        id: 'companyConfig',
        key: 'companyConfig',
        value: JSON.stringify(companyConfig),
      });
    } catch {
      // Ignored — client sync uploads the full config after signup.
    }

    const token = generateToken({ ...adminUser });
    res.status(201).json({
      message: 'Company registered successfully',
      user: adminUser,
      token,
      company: { name: String(companyName || '').trim() },
    });
  } catch (err) {
    if (err && err.message === 'Username already exists') {
      return res.status(409).json({ error: 'An account with this email or username already exists' });
    }
    console.error('[Auth] Register-company error:', err);
    res.status(500).json({ error: 'Company registration failed' });
  }
});

router.post('/request-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = await (require('../services/emailVerificationService.cjs')).requestVerification({ email });
    res.json({ success: true, message: 'Verification code sent to email', expiresAt: result.expiresAt });
  } catch (err) {
    console.error('[Auth] request-verification error:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

router.post('/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
    const result = await (require('../services/emailVerificationService.cjs')).verifyCode({ email, code });
    if (result.success) {
      res.json({ success: true, message: 'Email verified successfully' });
    } else {
      res.status(400).json({ success: false, error: result.error || 'Invalid or expired code' });
    }
  } catch (err) {
    console.error('[Auth] verify-code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ ...user });
  } catch (err) {
    console.error('[Auth] Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

module.exports = router;
