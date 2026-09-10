# Portal Login Timeout + Blank Dashboard — Diagnostic Report

**Status:** read-only diagnostics only. No source, data, config, or infrastructure was modified.
**Date:** 2026-09-11. **Scope:** production symptoms on `prime265.vercel.app` (portal) → `primeerpsystem.onrender.com` (shared backend).

---

## 1. Executive Summary

Both symptoms are explained without inventing causes; each maps to code that was read:

- **Timeouts ("Request timed out")** come from the **portal frontend's own 15 s abort** (`portalApiClient.fetchWithTimeout`, `DEFAULT_TIMEOUT_MS = 15000`), not from the backend or the network per se. The message customers see is produced client-side whenever any portal request — including the ~8 concurrent dashboard-bootstrap requests fired immediately after login — takes longer than 15 s. The backend has **no request timeouts of its own** and slow paths to exceed 15 s with: Render cold starts (bootstrap runs Supabase checks, schema verifies, a backup, and seeding **before `listen`**), a login flow that performs **4–6 sequential Supabase round-trips plus up to two sequential bcrypt-10 verifications**, and a dashboard endpoint that fans out to **9 parallel Supabase reads** (slowest wins).
- **Blank dashboard fixed by re-login** is driven by the portal auth layer, chiefly a deterministic bug in `CustomerAuthContext` init: `expires_in` is stored as the string `'30m'`, so `Number('30m')` → `NaN` forces a server-side refresh on **every** page load, and the success path of that refresh **never calls `setUser`** — the user stays `null`, the layout redirects to `/portal/login`, and the customer perceives a blank/failed dashboard until they log in again (login *does* set the user). A second, independent session-killer is the **revoke-first refresh-token rotation** (`routes/portalAuth.cjs` `/refresh`): any concurrent/duplicate refresh (second tab, retry after a timeout, StrictMode-style double mount) permanently 401s the loser, wipes `sessionStorage`, and drops the UI to login.

The code-level causes were identified from the repository; production runtime confirmation (Render cold-start timing, live 401/timeout counts) still requires production telemetry (see §14).

---

## 2. Exact Login Flow

```
Portal login form (views/portal/CustomerLogin.tsx:handleSubmit)
  → loginWithApi() (services/authApiClient.ts:49 — RAW fetch, NO timeout, NO retry)
  → POST {API_BASE_URL}/auth/login  (same-origin /api → Vercel rewrite → Render)
  → index.cjs:303: global express-rate-limit (200/15min/IP) + authLimiter (10/15min per IP+username)
  → routes/auth.cjs:30 POST /login → validateBody → authService.authenticateUser (staff: Supabase read + bcrypt IF staff row exists)
                                          → portalAuthService.authenticatePortalUser (Supabase portal_users read + bcrypt.compare, 10 rounds)
                                          → isTwoFactorEnabled (Supabase read)
  → loginCustomer: generatePortalToken (JWT 30m, role portal_customer) + createSession (Supabase insert) + recordLoginHistory (Supabase insert, fire-and-forget)
  → 200 { user, access_token, refresh_token, expires_in: '30m' }
  → savePortalSession → sessionStorage['portal_session'] (TAB-SCOPED)
  → setUser(user) → navigate('/portal/dashboard', replace)
```

Per-request Supabase REST timeouts: reads 10 s, writes 20 s (`services/supabaseRepository.cjs`). No Express-level timeout anywhere.

---

## 3. Exact Dashboard Bootstrap Flow

On mounting `/portal/dashboard` (`views/portal/CustomerDashboard.tsx`), all of the following fire effectively at once (each via `portalApi`, 15 s abort, `Authorization: Bearer <access_token>` read synchronously from `sessionStorage`):

| # | Request | Code |
|---|---------|------|
| 1 | `GET /dashboard` (+ nested `GET /invoices?status=Unpaid` inside its `onData`) | `CustomerDashboard.tsx:276-289` via `usePortalData` (own 15 s `withTimeout`) |
| 2 | `GET /deliveries/banner` (+ 60 s poll) | `:291-302` |
| 3 | `GET /promotions`, `GET /ads` | `:304-309` |
| 4 | `GET /loyalty` | `:311-315` |
| 5 | `GET /notifications/unread-count` | `:320-326` |
| 6 | `POST /events-ticket` (SSE ticket; then EventSource) | `:328-346` via `portalApiClient.subscribe` |

Backend `GET /dashboard` (`routes/portal.cjs:686` → `portalService.getDashboard`) fans out to **9 parallel Supabase reads** (customer, invoices, 2× orders tables, requests, quotations, notifications, loyalty points, wallet, shipments); any single slow/failed read delays or 500s the whole response (`getAllStrict` throws on any Supabase failure).

Failure behavior per request: network/timeout on GET → cached snapshot if present, else thrown timeout error; HTTP ≥500 on GET → cache fallback; 401 → single mutex-guarded refresh + one retry, else **session wiped + `portal-session-expired` event → redirect to login**; other 4xx (incl. 429) → thrown error (429 message, never a timeout message).

---

## 4. Timeout Root Cause

> Why does the customer see "Request has timed out"?

The string is manufactured client-side: `services/portalApiClient.ts:113-114` (`Request timed out after ${timeoutMs}ms…`, default 15 s) and `services/portalCache.ts:128` (`${label} timed out after ${timeoutMs}ms`, used by `usePortalData`). The login POST itself uses raw `fetch` with no timeout, so the message users report is overwhelmingly from a **dashboard-bootstrap request aborting at 15 s** (perceived as "login failed"), or from the 10 s refresh abort cascading into session expiry.

Layers that can push a request past 15 s (all verified in code; production timing unconfirmed):

- **Render cold start (likely chief contributor):** `index.cjs:startServer` awaits `bootstrap()` (Supabase check, auth schema, portal schema with 4× up-to-5 s probes, referral migration, backup, seed-count) **before `app.listen`**. A sleeping instance serves nothing for tens of seconds; first queries afterwards are also slow.
- **Login cost:** 2 Supabase reads + up to 2 sequential bcrypt-10 compares (measured ~128 ms/compare warm on dev hardware; materially slower on throttled shared CPU) + 1–2 Supabase writes, all sequential.
- **Dashboard fan-out:** 9 parallel Supabase reads; PostgREST latency spikes or cold connections delay all of them; any failure → 500 → error banner.
- **Supabase-side failures** observed in local logs (`PGRST205` missing tables, `PGRST303` "JWT issued at future" clock-skew 401s) prove the strict-read→500 path is real, though those log lines are local/dev, not production.

Ruled out as the timeout source: backend Express timeouts (none exist), rate limiting (429 carries its own message), CORS (Vercel rewrites to same-origin `/api`).

---

## 5. Blank Dashboard Root Cause

> Why does the dashboard sometimes load blank until logout/login again?

Primary (deterministic, code-proven) — **stale-session bounce in `CustomerAuthContext` init** (`context/CustomerAuthContext.tsx:86-131`):

1. Login stores `expires_in: '30m'` (string, from the backend).
2. On every subsequent page load, init computes `tokenAge = Date.now() - Number('30m')*60000` → `Number('30m')` is `NaN` → `NaN || 0` → `0` → `tokenAge` ≈ 49 days → **always > 5 min** → always takes the "validate against server" branch (the trust-fresh-token branch is dead code).
3. On refresh **success** the code schedules the next refresh and clears `loading` — but **never calls `setUser`**. `user` stays `null` → `CustomerLayout` redirects to `/portal/login`.
4. Logging in again calls `setUser` directly → dashboard renders. Logging "out and in" also works because it replaces the session.

Secondary (race, code-proven) — **refresh-token rotation kills concurrent refreshers** (`routes/portalAuth.cjs:122-154` revokes the presented token *before* issuing the new one; the frontend mutex in `portalApiClient.ts:58-95` is per-tab only). A second tab, a retried refresh after a timeout, or a duplicate mount loses: 401 → `clearPortalSession()` + `portal-session-expired` → dropped to login with a previously valid session destroyed.

Tertiary contributors: cold-start 10 s refresh abort with the same session-wipe consequence; multi-tab refresh races; a stale SW-cached JS bundle across deploys (mitigated by versioned caches + `clients.claim`, §10).

Note on "blank" vs "login form": the dashboard component itself always renders skeleton/error/content (never blank); the user-visible blank/bounce is the layout-level redirect loop or a stalled spinner, both downstream of the auth-state defects above.

---

## 6. Evidence

- Timeout strings: `frontend/services/portalApiClient.ts:5,113-114,121-146` (15 s default; refresh 10 s at `:65`); `frontend/services/portalCache.ts:121-141`.
- Raw-fetch login (no timeout/retry): `frontend/services/authApiClient.ts:55-59`.
- Always-refresh + missing `setUser`: `frontend/context/CustomerAuthContext.tsx:96-115` (`Number('30m')` → `NaN`); contrast `refreshSession()` at `:55-75` which *does* set the user.
- Session storage scope: `portalApiClient.ts:26-46` (`sessionStorage`, per-tab).
- Rotation hazard: `backend/routes/portalAuth.cjs:122-154` (revoke-before-issue); per-tab-only mutex `frontend/services/portalApiClient.ts:58-95`.
- Double-auth login: `backend/routes/auth.cjs:38-39` (+bcrypt 10 rounds both services); measured ~128 ms/compare warm.
- Dashboard fan-out: `backend/services/portalService.cjs:101-112` (9 parallel reads); strict-read throws `backend/services/supabaseRepository.cjs:95-101`; per-call timeouts 10 s reads / 20 s writes.
- Bootstrap-before-listen: `backend/index.cjs:657-663` + `backend/bootstrap.cjs:8-71` (incl. 4×5 s schema probes).
- Rate limits: `backend/index.cjs:87-94` (global 200/15 min), `:303` (auth 10/15 min), `:319-320` (`portalAuthLimiter` 100/15 min, refresh 200/15 min); in-memory fallback `backend/services/redisRateLimiter.cjs:44-54` (per-instance — uneven on multi-instance Render).
- Tests: `backend/tests/portalAuthErrors.test.cjs` + `portalRateLimit.test.cjs` — **28/28 pass** (run 2026-09-11; auth error semantics and limiter buckets behave as designed; notably refresh rotation 401s a reused token by design).
- Logs: only stale local `backend/server.out` (2026-09-03) + `server.err` available; show request volume, Supabase 404s on `support_articles`, `PGRST303` clock-skew 401s, and strict-read 500s — mechanism evidence only, not production proof. No 429/timeout lines present.
- bcrypt benchmark (throwaway script in system temp dir, repo untouched): ~128 ms/compare.

---

## 7. Shared Backend Risk

ERP activity **can** delay portal auth, through these verified shared resources:

- **Single Node event loop, no timeouts:** any long ERP request (report generation, PDF rendering via `@react-pdf`/pdfkit, bulk imports, reconciliation scripts) starves the loop; portal login/refresh/dashboard calls queue behind it until the frontend aborts at 15 s/10 s.
- **Supabase as the single data plane:** portal auth/session/dashboard reads are Supabase REST calls from the backend; ERP-driven load or Supabase-side slowness affects both apps identically. No per-tenant/per-app prioritization exists.
- **SQLite (`backend/db.cjs`, WAL, singleton connection)** serves ERP-heavy paths and sync; portal hot paths use Supabase, so SQLite locks are a *secondary* risk, not the primary one. No connection pool to exhaust (single connection + WAL).
- **In-memory rate limiting is per backend instance:** on multi-instance Render, limits are uneven; behind carrier NAT, unrelated users share IP buckets (global 200/15 min + auth buckets) → possible 429s (distinct message; contributor, not the reported symptom).
- **Render free-tier sleep** (infrastructure, unverified from repo): cold boot runs the full bootstrap before `listen`; first portal AND ERP requests after idle all stall together.

---

## 8. Authentication Findings

- Storage: `sessionStorage['portal_session']` (`{access_token, refresh_token, expires_in: '30m', user}`) — per-tab; no cross-tab sync; logout clears it (and best-effort server logout).
- Restoration: on provider mount, session is read; user is set only via the fresh-token path, which is unreachable due to the `Number('30m')` bug (§5).
- Authorization header: attached synchronously per request from `sessionStorage` (`portalApiClient.ts:173-176`); always current within a tab.
- Hydration: dashboard effects do not wait for auth init; safe only because the token is read synchronously from storage.
- 401: one mutex-guarded refresh + single retry; failure wipes the session and fires `portal-session-expired` (aggressive: also fires after a mere 10 s refresh timeout on a cold backend).
- 429: surfaced as errors, never retried; login bucket 10/15 min per IP+username on `/api/auth`; portal bucket 100/15 min.
- Expiry: access 30 m, proactive refresh scheduled at 25 m post-login; refresh tokens 30 d, single-use rotation, server-side expiry + revocation checks.
- Logout: revokes server session(s), clears storage, clears timer, nulls user.

---

## 9. Dashboard Findings

Bootstrap APIs (§3 table) and their failure behavior: `/dashboard` (+ nested unpaid-invoices) shows skeleton → error banner (never blank); deliveries/promotions/ads/loyalty/notifications fail silent to defaults; SSE ticket failure only breaks realtime. A fully blank authenticated shell is not producible from these components — the observed blank is the auth-redirect/spinner path (§5). Identity uses `businessName → companyName → full_name` (`utils/customerDisplay.ts`); `contactName` is never used for identity (§9 check passed).

---

## 10. Performance Findings

| Request | Expected purpose | Observed timing | Timeout risk | Finding |
|---|---|---|---|---|
| `POST /api/auth/login` | portal login | not measured live; 2 reads + ≤2 bcrypt (~128 ms each warm) + 2 writes, sequential | medium-high when cold | double-auth design wastes one lookup + one hash |
| `POST /api/portal/auth/refresh` | silent refresh (every page load due to §5 bug) | 10 s client abort | high when cold | failure destroys a valid session |
| `GET /api/portal/dashboard` | dashboard data (9 parallel Supabase reads) | slowest-read-wins; Supabase default 10 s/read | high | 15 s client abort → timeout message |
| deliveries/promotions/ads/loyalty/notifications/ticket | dashboard widgets | same 15 s aborts; silent fallbacks | low user impact | contribute load, not blankness |
| backend cold boot | Render wake | bootstrap-before-listen (probes ≤20 s + backup + migrations) | very high (all requests stall) | needs Render metrics to confirm plan/sleep |
| bcrypt.compare (10 rounds) | password check | ~128 ms warm (measured) | low alone | doubles in unified login |
| backend jest auth suites | regression | 28/28 pass in ~16 s | n/a | error semantics + limiter buckets correct |

---

## 11. Root Cause Classification

- **CONFIRMED ROOT CAUSE (code-proven):** blank/bounced dashboard after reload — `CustomerAuthContext` init never `setUser` on the always-taken refresh path (`Number('30m')` bug). Re-login works because login sets the user directly.
- **CONFIRMED ROOT CAUSE (code-proven):** concurrent-refresh session kill — revoke-before-issue rotation + per-tab-only mutex; loser gets 401, session wiped, redirect to login.
- **HIGH-CONFIDENCE ROOT CAUSE:** "Request has timed out" — client-side 15 s abort (10 s for refresh) firing on cold/slow backend responses; backend has no timeouts, login does 4–6 sequential Supabase ops + double bcrypt, dashboard needs 9 parallel Supabase reads.
- **LIKELY CONTRIBUTOR:** Render cold starts (bootstrap-before-listen) making the above bite "frequently".
- **LIKELY CONTRIBUTOR:** multi-tab refresh races; carrier-NAT 429s (different message, adjacent pain).
- **UNCONFIRMED:** production cold-start durations, live 401/timeout rates, Supabase latency, clock skew in prod (seen only in local logs).
- **RULED OUT:** backend request timeouts (none exist); rate limiting as the timeout message; CORS (same-origin rewrite); SW caching of API (NetworkOnly); contactName identity mix-up; realtime/SSE as a blocker (best-effort with catch).

---

## 12. Recommended Fix

Smallest safe set, in order:

### Backend fix
1. Make `/refresh` rotation tolerant: grace window accepting the just-revoked token once (or create-before-revoke), so concurrent refreshes stop killing sessions.

### Portal authentication fix
2. Parse `expires_in` properly (`'30m'` → ms) and `setUser(session.user)` after a successful init refresh — fixes the reload bounce with a two-line change.
3. On refresh timeout/abort, retry once before wiping the session; only clear on explicit 401-invalid.

### Dashboard bootstrap fix
4. Nothing structural needed; optionally stagger non-critical widgets (promotions/ads/loyalty) after first paint to cut cold-start concurrency.

### Infrastructure fix
5. Confirm Render plan/sleep; add a lightweight warmup ping; consider `listen`-before-bootstrap or readiness probe so cold boots fail fast instead of hanging past the 15 s client abort.

---

## 13. Files That Would Need Modification

- `frontend/context/CustomerAuthContext.tsx` (expires_in parsing, missing `setUser`)
- `frontend/services/portalApiClient.ts` (refresh retry-before-wipe policy)
- `backend/routes/portalAuth.cjs` (rotation grace window)
- Possibly `backend/routes/auth.cjs` (skip staff lookup when `portal: 'customer'` and vice versa — halves login cost; needs care with the wrong-portal 403 contract)
- Possibly `backend/index.cjs` (readiness/cold-start behavior)
- No dashboard component changes required.

---

## 14. Production Verification Plan

## 15. Implementation Completed

Implemented 2026-09-11 in the working tree (uncommitted at time of writing).
All changes are narrowly scoped to authentication/session reliability; no
UI, business-logic, security-contract, or infrastructure changes.

### Files changed

- `frontend/services/portalApiClient.ts` — added `parseExpiresInToMs`
  (never NaN; handles `'30m'`, suffixed durations, numeric seconds/ms),
  `getAccessTokenAgeMs` (timestamp-based, null when unknown),
  `computeRefreshDelayMs` (clamped to [60 s, 25 m]), `RefreshOutcome`
  (`{ok, token?, reason?: 'transient' | 'invalid'}`),
  `classifyRefreshFailure` (timeouts/aborts/network/5xx/429 → transient;
  400/401/403/404/422 → invalid), one-retry-with-750 ms-backoff refresh
  with per-tab in-flight mutex preserved, `refreshPortalSessionDetailed()`,
  and transient-aware 401 handlers in `request()`/`requestDownload()`
  (transient → cache-or-retryable-error, session kept; invalid → wipe +
  existing `portal-session-expired` event). Sessions now record
  `refreshed_at` on login/refresh/activate.
- `frontend/context/CustomerAuthContext.tsx` — init trusts tokens younger
  than 5 min by recorded timestamp (no server round-trip); successful
  refresh **always restores `setUser`**; transient refresh failure keeps the
  signed-in user with a 60 s retry instead of bouncing to login; only
  definitive failures clear the session. `loading` resolves on every path.
- `backend/routes/portalAuth.cjs` — `/refresh` uses create-before-revoke
  ordering plus a single-use, rotation-recorded 60 s grace window
  (`recentRotations`, lazy expiry, per-process like existing limiters):
  concurrent duplicates each receive valid distinct pairs; logout/admin
  revokes stay immediately dead; replays after consumption 401.
- `backend/services/portalAuthService.cjs` — added
  `findAnySessionByRefreshToken` (revocation-agnostic lookup for the grace
  check); no signature changes to existing functions.
- `frontend/tests/portal/tokenRefreshPolicy.test.ts` (new) — expiry
  parsing, failure classification, retry/mutex/session-preservation policy.
- `frontend/tests/portal/customerAuthRestore.test.tsx` (new) — restore,
  refresh-restore, transient-init, invalid-init, and no-session init flows.
- `backend/tests/portalRefreshConcurrency.test.cjs` (new) — concurrent
  same-token refreshes both succeed with usable distinct pairs; one grace
  use then single-use restored; unknown tokens rejected.
- `backend/tests/portalAuthErrors.test.cjs` — ONE assertion updated to the
  specified grace contract (immediate reuse → 200 once via grace, next
  reuse → 401); all other 20 assertions byte-identical.

### Exact fixes implemented

1. Blank/bounced dashboard: init sets the user on every successful restore;
   fresh tokens skip server validation (no more every-load refresh storm).
2. Timeout/session wipe: refresh timeouts get exactly one retry, then keep
   the session; only explicit 401-class rejections destroy it.
3. Refresh race: create-before-revoke + single-use rotation-recorded grace;
   per-tab mutex retained, no cross-tab behavior introduced.
4. Deliberately NOT changed: staff/portal double lookup in
   `/api/auth/login` (required for the 403 wrong-portal contract —
   correctness over a small gain), 15 s/10 s timeouts (only retry policy
   added), dashboard fan-out and components, bootstrap/listen ordering
   (infra recommendation stands), rate limits, JWT validation.

### Tests run

- Backend jest: `portalAuthErrors` (21) + `portalRateLimit` (7) +
  `portalRefreshConcurrency` (4) = **32/32 passed** (one intentional
  assertion update documented above; no other modifications to existing
  tests; pre-existing `setInterval` open-handle warning from the rate
  limiter module, handled by `--forceExit`).
- Frontend vitest: **unable to execute in this environment** (worker-spawn
  timeout affects all suites, pre-existing). New suites were instead
  verified by executing the real bundled code in Node: **26/26 assertions
  pass** (parse/classify/retry/mutex/session-preservation + GET-timeout
  behavior). React-context tests were syntax-verified only.
- esbuild transform check: all 8 touched/added files parse.

### Remaining production risks (code-proven vs production-confirmed)

- Code-proven and fixed: init bounce, session wipe on transient refresh,
  concurrent-refresh destruction, every-load refresh storm.
- Production-confirmed still required: Render cold-start timing, live
  Supabase latency, real timeout/401 rates, multi-tab race frequency,
  multi-instance grace behavior (per-process grace may grant one use per
  instance — bounded and safe, but unmeasured).

1. Deploy to staging; cold-start the backend; time `POST /api/auth/login` and `GET /api/portal/dashboard` (expect login < 3 s warm).
2. Reload `/portal/dashboard` with a valid session → must stay logged in without a refresh round-trip (proves §5 fix).
3. Open two tabs, force concurrent refreshes → both stay authenticated (proves rotation fix).
4. Cold-start + immediate login → expect either success or a clear error, never a wiped valid session (proves retry policy).
5. Monitor Render metrics + backend `http_request` correlation logs for 401/timeout rates over one week; confirm customer reports stop.
