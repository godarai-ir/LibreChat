import type { Model } from 'mongoose';
import type { ITenant, Tenant, TenantOidc, TenantStatus } from '~/types';

export type TenantFailureCode = 'DUPLICATE_SLUG' | 'DUPLICATE_TENANT_ID' | 'NOT_FOUND';

export type TenantResult =
  | { ok: true; value: Tenant }
  | { ok: false; error: { code: TenantFailureCode; message?: string } };

export type CreateTenantInput = Omit<Tenant, 'status'> & { status?: TenantStatus };

/** `tenantId` is immutable and deliberately absent: it cannot be changed through this API. */
export type UpdateTenantInput = {
  slug?: string;
  status?: TenantStatus;
  oidc?: Partial<TenantOidc>;
};

export interface TenantMethods {
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  getTenantById(tenantId: string): Promise<Tenant | null>;
  listTenants(filter?: { status?: TenantStatus }): Promise<Tenant[]>;
  createTenant(input: CreateTenantInput): Promise<TenantResult>;
  updateTenant(tenantId: string, update: UpdateTenantInput): Promise<TenantResult>;
}

const MONGO_DUPLICATE_KEY = 11000;

const toTenant = (doc: ITenant | (Tenant & Record<string, unknown>)): Tenant => {
  const { clientId, clientSecret, issuer, scopes } = doc.oidc;
  return {
    tenantId: doc.tenantId,
    slug: doc.slug,
    status: doc.status,
    oidc: {
      clientId,
      clientSecret,
      ...(issuer != null && { issuer }),
      ...(scopes != null && { scopes: [...scopes] }),
    },
  };
};

const normalizeSlug = (slug: string): string => slug.trim().toLowerCase();

/** Maps a unique-index violation to a stable code; anything else is an unexpected failure. */
function duplicateFailure(error: unknown): TenantFailureCode | null {
  const failure = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (failure?.code !== MONGO_DUPLICATE_KEY) {
    return null;
  }
  if (failure.keyPattern && 'tenantId' in failure.keyPattern) {
    return 'DUPLICATE_TENANT_ID';
  }
  return 'DUPLICATE_SLUG';
}

export function createTenantMethods(mongoose: typeof import('mongoose')): TenantMethods {
  const model = (): Model<ITenant> => mongoose.models.Tenant as Model<ITenant>;

  async function getTenantBySlug(slug: string): Promise<Tenant | null> {
    if (typeof slug !== 'string') {
      return null;
    }
    const doc = await model()
      .findOne({ slug: normalizeSlug(slug) })
      .lean<Tenant & Record<string, unknown>>();
    return doc ? toTenant(doc) : null;
  }

  async function getTenantById(tenantId: string): Promise<Tenant | null> {
    if (typeof tenantId !== 'string') {
      return null;
    }
    const doc = await model().findOne({ tenantId }).lean<Tenant & Record<string, unknown>>();
    return doc ? toTenant(doc) : null;
  }

  async function listTenants(filter: { status?: TenantStatus } = {}): Promise<Tenant[]> {
    const docs = await model()
      .find(filter.status ? { status: filter.status } : {})
      .sort({ slug: 1 })
      .lean<Array<Tenant & Record<string, unknown>>>();
    return docs.map(toTenant);
  }

  async function createTenant(input: CreateTenantInput): Promise<TenantResult> {
    try {
      const created = await model().create({
        tenantId: input.tenantId,
        slug: normalizeSlug(input.slug),
        status: input.status ?? 'active',
        oidc: input.oidc,
      });
      return { ok: true, value: toTenant(created) };
    } catch (error) {
      const code = duplicateFailure(error);
      if (code) {
        return { ok: false, error: { code } };
      }
      throw error;
    }
  }

  async function updateTenant(tenantId: string, update: UpdateTenantInput): Promise<TenantResult> {
    const set: Record<string, unknown> = {};
    if (update.slug != null) {
      set.slug = normalizeSlug(update.slug);
    }
    if (update.status != null) {
      set.status = update.status;
    }
    for (const [key, value] of Object.entries(update.oidc ?? {})) {
      if (value !== undefined) {
        set[`oidc.${key}`] = value;
      }
    }

    try {
      const updated = await model()
        .findOneAndUpdate({ tenantId }, Object.keys(set).length > 0 ? { $set: set } : {}, {
          new: true,
          runValidators: true,
        })
        .lean<Tenant & Record<string, unknown>>();
      if (!updated) {
        return { ok: false, error: { code: 'NOT_FOUND' } };
      }
      return { ok: true, value: toTenant(updated) };
    } catch (error) {
      const code = duplicateFailure(error);
      if (code) {
        return { ok: false, error: { code } };
      }
      throw error;
    }
  }

  return { getTenantBySlug, getTenantById, listTenants, createTenant, updateTenant };
}
