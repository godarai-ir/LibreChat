import mongoose from 'mongoose';
import { createModels } from '../index';

/**
 * Global symbol set by applyTenantIsolation() on every schema it processes.
 * Recreated here via Symbol.for (the global registry) so the guard can detect
 * plugin application without the plugin exporting anything.
 */
const TENANT_ISOLATION_APPLIED = Symbol.for('librechat:tenantIsolation');

/**
 * Models that carry a `tenantId` field but intentionally do NOT use the
 * tenant-isolation plugin. SystemGrant scopes tenancy manually inside its
 * methods (see models/systemGrant). SkillSyncStatus stores both app-wide YAML
 * status rows and tenant-scoped override rows, so its methods apply explicit
 * tenant filters instead of ambient ALS scoping. AuditLog composes its tenant
 * filter from the JWT-resolved caller and uses `{ tenantId: { $exists: false } }`
 * for platform-level entries. RefreshTokenBridge resolves tenant context from
 * the signed OpenID marker cookie during unauthenticated refresh recovery, and
 * its methods apply explicit tenant filters. Tenant is the host-mode registry that
 * resolves which tenant a request belongs to before any tenant context exists; it carries
 * `tenantId` as data and is read by slug or id through the tenant methods only. Adding an
 * entry here must be a deliberate, reviewed decision — that is the whole point of this guard.
 */
const MANUAL_TENANT_SCOPING = new Set<string>([
  'SystemGrant',
  'SkillSyncStatus',
  'AuditLog',
  'RefreshTokenBridge',
  'Tenant',
]);

/**
 * Models with no `tenantId` field at all, each with the reason that is safe. The check above
 * only looks at models that already have the field, so a new model that forgot it would pass
 * silently; this list makes that a failing test until someone reviews it.
 */
const NO_TENANT_FIELD: Readonly<Record<string, string>> = {
  OpenIDRefreshFlight:
    'single-flight state of the OpenID token-reuse refresh, which host mode refuses at startup',
  SkillSyncCredential:
    'deployment-wide GitHub credential; written only with a platform-level capability, which a tenant user cannot hold',
};

function isPluginApplied(schema: mongoose.Schema): boolean {
  return (schema as unknown as { [key: symbol]: boolean })[TENANT_ISOLATION_APPLIED] === true;
}

describe('tenant-isolation plugin coverage', () => {
  beforeAll(() => {
    createModels(mongoose);
  });

  it('applies the tenant-isolation plugin to every model that has a tenantId field', () => {
    const missing: string[] = [];

    for (const [name, model] of Object.entries(mongoose.models)) {
      const hasTenantId = Boolean(model.schema.path('tenantId'));
      if (!hasTenantId || MANUAL_TENANT_SCOPING.has(name)) {
        continue;
      }
      if (!isPluginApplied(model.schema)) {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
  });

  it('lets only reviewed models exist without a tenantId field', () => {
    const unreviewed = Object.entries(mongoose.models)
      .filter(([name, model]) => !model.schema.path('tenantId') && !(name in NO_TENANT_FIELD))
      .map(([name]) => name);

    expect(unreviewed).toEqual([]);
  });

  it('keeps the no-tenant list accurate (the model exists and has no tenantId)', () => {
    for (const name of Object.keys(NO_TENANT_FIELD)) {
      const model = mongoose.models[name];
      expect(model).toBeDefined();
      expect(Boolean(model.schema.path('tenantId'))).toBe(false);
    }
  });

  it('keeps the manual-scoping allowlist accurate (tenantId field, no plugin)', () => {
    for (const name of MANUAL_TENANT_SCOPING) {
      const model = mongoose.models[name];
      expect(model).toBeDefined();
      expect(Boolean(model.schema.path('tenantId'))).toBe(true);
      expect(isPluginApplied(model.schema)).toBe(false);
    }
  });
});
