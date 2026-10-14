import { logger } from '@librechat/data-schemas';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ISSUER_SLUG_PLACEHOLDER = '{slug}';

export const DEFAULT_TENANT_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
];

export type TenantLifecycle = 'active' | 'suspended' | 'deleting';

/** A registry row as the database method returns it. The client secret is still encrypted. */
export interface StoredTenant {
  tenantId: string;
  slug: string;
  status: TenantLifecycle;
  oidc: {
    issuer?: string;
    clientId: string;
    clientSecret: string;
    scopes?: string[];
  };
}

export interface TenantOidcSettings {
  issuer: string;
  clientId: string;
  /** Decrypted. Held in process memory only; never log or serialize it. */
  clientSecret: string;
  scopes: readonly string[];
}

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  oidc: TenantOidcSettings;
}

export type TenantMisconfiguration = 'ISSUER_MISSING' | 'SECRET_UNREADABLE';

export type TenantLookup =
  | { kind: 'active'; tenant: ResolvedTenant }
  | { kind: 'inactive'; tenantId: string; slug: string; status: 'suspended' | 'deleting' }
  | { kind: 'misconfigured'; tenantId: string; slug: string; reason: TenantMisconfiguration }
  | { kind: 'unknown' };

export interface TenantRegistryDeps {
  /** Resolves a stored row by (already normalized) slug; `null` only for a missing row. */
  findBySlug(slug: string): Promise<StoredTenant | null>;
  /** Decrypts a stored client secret; throws when the value cannot be read. */
  decryptSecret(encrypted: string): string;
}

export interface TenantRegistryOptions {
  /** Issuer URL with `{slug}`; used when a row has no `oidc.issuer`. */
  issuerTemplate: string | null;
  /** How long a found tenant is served from memory. Bounds how stale a suspension can be. */
  ttlMs?: number;
  /** How long an unknown or misconfigured slug is remembered. Kept short so a new tenant appears quickly. */
  negativeTtlMs?: number;
  maxEntries?: number;
  /** Unknown slugs are cached separately and bounded, so a flood of random hosts cannot evict real tenants. */
  maxNegativeEntries?: number;
  defaultScopes?: readonly string[];
  now?: () => number;
}

export interface TenantRegistry {
  resolve(slug: string): Promise<TenantLookup>;
  /** Drops one slug, or everything when omitted. Call after the registry is changed. */
  invalidate(slug?: string): void;
}

interface CacheEntry {
  lookup: TenantLookup;
  expiresAt: number;
}

const UNKNOWN: TenantLookup = { kind: 'unknown' };

function issuerFromTemplate(template: string | null, slug: string): string | null {
  if (!template) {
    return null;
  }
  return template.replace(ISSUER_SLUG_PLACEHOLDER, slug);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Looks tenants up by host slug with a short-lived cache. It is the only place that decrypts a
 * tenant's OIDC secret, and it never lets a database failure look like "no such tenant".
 */
export function createTenantRegistry(
  deps: TenantRegistryDeps,
  options: TenantRegistryOptions,
): TenantRegistry {
  const ttlMs = options.ttlMs ?? 30_000;
  const negativeTtlMs = options.negativeTtlMs ?? 5_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const maxNegativeEntries = options.maxNegativeEntries ?? 256;
  const defaultScopes = options.defaultScopes ?? DEFAULT_TENANT_SCOPES;
  const now = options.now ?? Date.now;

  const positive = new Map<string, CacheEntry>();
  const negative = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<TenantLookup>>();
  /** Bumped by every invalidation so a lookup that started earlier cannot cache stale data. */
  let epoch = 0;

  const remember = (slug: string, lookup: TenantLookup): void => {
    const isNegative = lookup.kind === 'unknown' || lookup.kind === 'misconfigured';
    const store = isNegative ? negative : positive;
    const limit = isNegative ? maxNegativeEntries : maxEntries;
    const entry = { lookup, expiresAt: now() + (isNegative ? negativeTtlMs : ttlMs) };

    store.delete(slug);
    while (store.size >= limit) {
      const oldest = store.keys().next();
      if (oldest.done) {
        break;
      }
      store.delete(oldest.value);
    }
    store.set(slug, entry);
  };

  const cached = (slug: string): TenantLookup | undefined => {
    for (const store of [positive, negative]) {
      const entry = store.get(slug);
      if (!entry) {
        continue;
      }
      if (entry.expiresAt > now()) {
        return entry.lookup;
      }
      store.delete(slug);
    }
    return undefined;
  };

  const toLookup = (stored: StoredTenant, slug: string): TenantLookup => {
    if (stored.status !== 'active') {
      return { kind: 'inactive', tenantId: stored.tenantId, slug, status: stored.status };
    }

    const issuer = stored.oidc.issuer ?? issuerFromTemplate(options.issuerTemplate, slug);
    if (!issuer || !isHttpsUrl(issuer)) {
      logger.error('[tenancy] Tenant has no usable OIDC issuer', { tenantId: stored.tenantId });
      return { kind: 'misconfigured', tenantId: stored.tenantId, slug, reason: 'ISSUER_MISSING' };
    }

    let clientSecret: string;
    try {
      clientSecret = deps.decryptSecret(stored.oidc.clientSecret);
    } catch {
      logger.error('[tenancy] Tenant OIDC client secret cannot be decrypted', {
        tenantId: stored.tenantId,
      });
      return {
        kind: 'misconfigured',
        tenantId: stored.tenantId,
        slug,
        reason: 'SECRET_UNREADABLE',
      };
    }

    return {
      kind: 'active',
      tenant: {
        tenantId: stored.tenantId,
        slug,
        oidc: {
          issuer,
          clientId: stored.oidc.clientId,
          clientSecret,
          scopes: stored.oidc.scopes?.length ? [...stored.oidc.scopes] : [...defaultScopes],
        },
      },
    };
  };

  const load = async (slug: string): Promise<TenantLookup> => {
    const startedAt = epoch;
    const stored = await deps.findBySlug(slug);
    const lookup = stored ? toLookup(stored, slug) : UNKNOWN;
    if (epoch === startedAt) {
      remember(slug, lookup);
    }
    return lookup;
  };

  async function resolve(rawSlug: string): Promise<TenantLookup> {
    if (typeof rawSlug !== 'string') {
      return UNKNOWN;
    }
    const slug = rawSlug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      return UNKNOWN;
    }

    const hit = cached(slug);
    if (hit) {
      return hit;
    }

    const pending = inflight.get(slug);
    if (pending) {
      return pending;
    }

    const started = load(slug).finally(() => {
      inflight.delete(slug);
    });
    inflight.set(slug, started);
    return started;
  }

  function invalidate(slug?: string): void {
    epoch += 1;
    if (slug == null) {
      positive.clear();
      negative.clear();
      inflight.clear();
      return;
    }
    const key = slug.toLowerCase();
    positive.delete(key);
    negative.delete(key);
    inflight.delete(key);
  }

  return { resolve, invalidate };
}
