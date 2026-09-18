import { API_BASE_URL } from '../config/api.js';

export interface StaffUserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  permissions: string[];
}

export interface PortalUserInfo {
  id: string;
  customer_id: string;
  email: string;
  full_name?: string;
  phone?: string;
}

export interface UnifiedLoginResponse {
  message: string;
  userId: string;
  role: 'admin' | 'customer';
  token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: string;
  user: StaffUserInfo | PortalUserInfo;
  requires_two_factor?: boolean;
  pending_token?: string;
}

export class ApiError extends Error {
  status: number;
  body: any;

  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Unified login used by BOTH portals (admin.primeerp.com and portal.primeerp.com).
 * The backend authenticates the account and returns its role ('admin' | 'customer').
 * Wrong-portal attempts are rejected with a 403 and a friendly message.
 */
export async function loginWithApi(payload: {
  email: string;
  password: string;
  portal: 'admin' | 'customer';
  two_factor_code?: string;
}): Promise<UnifiedLoginResponse> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      body.message || body.error || `Login failed (${response.status})`,
      response.status,
      body
    );
  }

  return body as UnifiedLoginResponse;
}

export interface RegisterCompanyPayload {
  companyName: string;
  companyEmail?: string;
  companyPhone?: string;
  addressLine1?: string;
  city?: string;
  country?: string;
  currencySymbol?: string;
  adminFullName: string;
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
}

export interface RegisterCompanyResponse {
  message: string;
  user: StaffUserInfo & { full_name?: string };
  token: string;
  company: { name: string };
}

/**
 * Self-service company creation from the login page. Public endpoint —
 * no session exists yet. The backend provisions the company workspace and
 * its first Admin, returning a JWT for immediate sign-in.
 */
export async function registerCompany(payload: RegisterCompanyPayload): Promise<RegisterCompanyResponse> {
  const response = await fetch(`${API_BASE_URL}/auth/register-company`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      body.message || body.error || `Company registration failed (${response.status})`,
      response.status,
      body
    );
  }

  return body as RegisterCompanyResponse;
}
