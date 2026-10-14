import type { Mongoose } from 'mongoose';
import { SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * Models whose rows without a `tenantId` are deliberately shared by every tenant, so they must
 * stay untenanted when an existing single-tenant deployment is assigned to its first tenant:
 *
 * - `Tenant`: the registry itself.
 * - `SystemGrant`, `AuditLog`, `SkillSyncStatus`: an absent `tenantId` means a platform-level row.
 * - `Role`, `AccessRole`, `AgentCategory`: seeded defaults that tenants fall back to.
 * - `Config`: an absent `tenantId` is the deployment-wide base override.
 * - `Banner`: a deployment-wide announcement.
 */
export const SHARED_UNTENANTED_MODELS: readonly string[] = [
  'Tenant',
  'SystemGrant',
  'AuditLog',
  'SkillSyncStatus',
  'Role',
  'AccessRole',
  'AgentCategory',
  'Config',
  'Banner',
];

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AssignTenantOptions {
  /** The tenant that takes ownership of every untenanted row. */
  tenantId: string;
  /** Count only. This is the default of the command line tool; the function itself requires it. */
  dryRun: boolean;
  /** Models to leave alone in addition to {@link SHARED_UNTENANTED_MODELS}. */
  skipModels?: readonly string[];
}

export interface AssignTenantModelResult {
  model: string;
  collection: string;
  /** Rows without a tenant before the run. */
  untenanted: number;
  /** Rows given the tenant by this run; always 0 for a dry run. */
  updated: number;
}

export interface AssignTenantResult {
  tenantId: string;
  dryRun: boolean;
  models: AssignTenantModelResult[];
}

const UNTENANTED = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };

/**
 * Gives every row that has no `tenantId` to one tenant, for moving an existing single-tenant
 * deployment into host mode. It is the one sanctioned bulk writer and so goes through the native
 * collection on purpose: the isolation plugin would (correctly) refuse to write across tenants.
 *
 * It only touches rows that have no tenant, so it is safe to run again, and it never moves a row
 * from one tenant to another. Rows of models that are shared on purpose are left untenanted.
 *
 * Run `migrate:tenant-indexes` first: the legacy global unique indexes would otherwise reject
 * the tenant-scoped ones. Rebuild the search index afterwards.
 */
export async function assignTenantToUntenantedRows(
  mongoose: Mongoose,
  { tenantId, dryRun, skipModels = [] }: AssignTenantOptions,
): Promise<AssignTenantResult> {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('tenantId must start with a letter or digit and contain only [A-Za-z0-9._-]');
  }
  if (tenantId === SYSTEM_TENANT_ID) {
    throw new Error('The system tenant cannot own data');
  }

  const skipped = new Set([...SHARED_UNTENANTED_MODELS, ...skipModels]);
  const models: AssignTenantModelResult[] = [];

  for (const [name, model] of Object.entries(mongoose.models)) {
    if (skipped.has(name) || !model.schema.path('tenantId')) {
      continue;
    }

    /* The reason is the same for the three raw accesses below: this migration reads and updates
     * rows that have NO tenant, which the isolation plugin cannot express and, correctly, refuses
     * to do through the model. */
    // eslint-disable-next-line no-restricted-syntax -- deliberate bulk migration of untenanted rows
    const untenanted = await model.collection.countDocuments(UNTENANTED);
    let updated = 0;
    if (!dryRun && untenanted > 0) {
      // eslint-disable-next-line no-restricted-syntax -- deliberate bulk migration of untenanted rows
      const outcome = await model.collection.updateMany(UNTENANTED, { $set: { tenantId } });
      updated = outcome.modifiedCount;
    }
    // eslint-disable-next-line no-restricted-syntax -- reads only the collection's name, not its data
    const collection = model.collection.collectionName;
    models.push({ model: name, collection, untenanted, updated });
  }

  models.sort((a, b) => a.model.localeCompare(b.model));
  return { tenantId, dryRun, models };
}
