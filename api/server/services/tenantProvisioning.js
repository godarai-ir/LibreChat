const { startTenantProvisioningServer, encryptV3 } = require('@librechat/api');
const { getTenantById, createTenant, updateTenant } = require('~/models');
const { ensureTenantOpenId, forgetTenantOpenId } = require('~/strategies');

/**
 * Starts the internal provisioning API when `TENANT_PROVISIONING_TOKEN` is set (host mode only).
 * All behavior lives in `@librechat/api`; this supplies the models, the secret encryption and the
 * two caches that a change must drop: the tenant registry and the tenant's OpenID client.
 * @param {{ registry: { resolve: Function, invalidate: Function } } | null} hostTenancy
 * @returns {import('http').Server | null}
 */
function startProvisioning(hostTenancy) {
  if (!hostTenancy) {
    return null;
  }
  const { registry } = hostTenancy;

  return startTenantProvisioningServer({
    deps: {
      methods: { getTenantById, createTenant, updateTenant },
      encryptSecret: encryptV3,
      env: process.env,
      invalidate: (tenantId) => {
        registry.invalidate();
        forgetTenantOpenId(tenantId);
      },
      checkReady: async (slug) => {
        const lookup = await registry.resolve(slug);
        if (lookup.kind !== 'active') {
          return { ready: false, reason: lookup.kind };
        }
        try {
          await ensureTenantOpenId(lookup.tenant);
          return { ready: true };
        } catch {
          return { ready: false, reason: 'DISCOVERY_FAILED' };
        }
      },
    },
  });
}

module.exports = { startProvisioning };
