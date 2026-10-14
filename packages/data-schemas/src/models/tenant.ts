import { Model } from 'mongoose';
import type * as t from '~/types';
import tenantSchema from '~/schema/tenant';

/**
 * Tenant is the platform-level registry that decides which tenant a request belongs to, so it is
 * read before any tenant context exists. It carries a `tenantId` field as data, but the
 * tenant-isolation plugin must NOT be applied: its equality filter would hide every other
 * tenant's row from the resolver. Access goes through the tenant methods only.
 */
export function createTenantModel(mongoose: typeof import('mongoose')): Model<t.ITenant> {
  return mongoose.models.Tenant || mongoose.model<t.ITenant>('Tenant', tenantSchema);
}
