/**
 * portalAuthMappingReport.cjs — PHASE 1 read-only diagnostic.
 *
 * Prints the portal_users → Supabase Auth mapping/coverage report as JSON.
 *
 *   node scripts/portalAuthMappingReport.cjs
 *
 * READ-ONLY: performs GETs only. Repairs nothing, populates nothing,
 * creates no Supabase users, changes no RLS, touches no passwords.
 *
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in the environment (same
 * service-role read path as the backend repository layer).
 */

const { getPortalAuthMappingReport } = require('../services/supabasePortalIdentity.cjs');

(async () => {
  try {
    const report = await getPortalAuthMappingReport();
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      error: 'mapping-report-failed',
      message: (err && err.message) || String(err),
    }));
    process.exitCode = 1;
  }
})();
