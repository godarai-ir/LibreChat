import { createHash } from 'node:crypto';
import { getTenantId, logger } from '@librechat/data-schemas';

/** What a tenant's OpenID Connect client needs to be built. The secret is already decrypted. */
export interface TenantOpenIdSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
}

export const TENANT_OPENID_DISCOVERY_FAILED = 'TENANT_OPENID_DISCOVERY_FAILED';

/** Discovery for one tenant failed; the message never carries the client secret. */
export class TenantOpenIdDiscoveryError extends Error {
  readonly code: string = TENANT_OPENID_DISCOVERY_FAILED;

  constructor(readonly tenantId: string) {
    super(`OpenID discovery failed for tenant ${tenantId}`);
    this.name = 'TenantOpenIdDiscoveryError';
  }
}

export interface TenantOpenIdClientsOptions<TConfig> {
  /** Performs discovery for one tenant (the caller owns proxies, custom fetch and client auth). */
  discover(settings: TenantOpenIdSettings): Promise<TConfig>;
  /** How long a discovered configuration is reused before it is refreshed. */
  ttlMs?: number;
  /** How long a failed discovery is remembered, so a down provider is not hit on every request. */
  failureTtlMs?: number;
  /** How long an expired configuration may still be served when refreshing it fails. */
  maxStaleMs?: number;
  now?: () => number;
}

export interface TenantOpenIdClients<TConfig> {
  /** Makes sure the tenant has a usable configuration for these settings and returns it. */
  ensure(tenantId: string, settings: TenantOpenIdSettings): Promise<TConfig>;
  /** The configuration of the tenant in the current async context, if one was ensured. */
  current(): TConfig | undefined;
  forget(tenantId?: string): void;
  /** Changes whenever the settings behind a tenant's configuration change (secret rotation). */
  fingerprintOf(tenantId: string): string | undefined;
}

interface Entry<TConfig> {
  config: TConfig;
  fingerprint: string;
  refreshAt: number;
  staleUntil: number;
}

/** A short, non-reversible identity of the settings: lets a rotated secret replace a client. */
export function fingerprintTenantOpenId(settings: TenantOpenIdSettings): string {
  return createHash('sha256')
    .update(
      [settings.issuer, settings.clientId, settings.clientSecret, settings.scopes.join(' ')].join(
        '\n',
      ),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * One OpenID configuration per tenant. Discovery is single-flight, a rotated client secret or a
 * changed issuer replaces the entry at once (a stale client is never served for new settings),
 * and a provider outage keeps the last good configuration for a while instead of failing logins.
 */
export function createTenantOpenIdClients<TConfig>(
  options: TenantOpenIdClientsOptions<TConfig>,
): TenantOpenIdClients<TConfig> {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const failureTtlMs = options.failureTtlMs ?? 5_000;
  const maxStaleMs = options.maxStaleMs ?? 60 * 60_000;
  const now = options.now ?? Date.now;

  const entries = new Map<string, Entry<TConfig>>();
  const failures = new Map<string, { fingerprint: string; until: number }>();
  const inflight = new Map<string, Promise<TConfig>>();
  /** Bumped by `forget` so a discovery that started earlier cannot repopulate a dropped tenant. */
  let epoch = 0;

  const discoverFresh = async (
    tenantId: string,
    settings: TenantOpenIdSettings,
    fingerprint: string,
  ): Promise<TConfig> => {
    const startedAt = epoch;
    const config = await options.discover(settings);
    if (epoch === startedAt) {
      const at = now();
      entries.set(tenantId, {
        config,
        fingerprint,
        refreshAt: at + ttlMs,
        staleUntil: at + ttlMs + maxStaleMs,
      });
      failures.delete(tenantId);
    }
    return config;
  };

  async function ensure(tenantId: string, settings: TenantOpenIdSettings): Promise<TConfig> {
    const fingerprint = fingerprintTenantOpenId(settings);
    const entry = entries.get(tenantId);
    const at = now();

    if (entry && entry.fingerprint === fingerprint && entry.refreshAt > at) {
      return entry.config;
    }

    const failure = failures.get(tenantId);
    const usableStale =
      entry && entry.fingerprint === fingerprint && entry.staleUntil > at ? entry : undefined;
    if (failure && failure.fingerprint === fingerprint && failure.until > at) {
      if (usableStale) {
        return usableStale.config;
      }
      throw new TenantOpenIdDiscoveryError(tenantId);
    }

    const key = `${tenantId}:${fingerprint}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = discoverFresh(tenantId, settings, fingerprint).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending);
    }

    try {
      return await pending;
    } catch {
      failures.set(tenantId, { fingerprint, until: now() + failureTtlMs });
      if (usableStale) {
        logger.warn('[tenancy] OpenID refresh failed; serving the last good configuration', {
          tenantId,
        });
        return usableStale.config;
      }
      throw new TenantOpenIdDiscoveryError(tenantId);
    }
  }

  function current(): TConfig | undefined {
    const tenantId = getTenantId();
    return tenantId ? entries.get(tenantId)?.config : undefined;
  }

  function forget(tenantId?: string): void {
    epoch += 1;
    if (tenantId == null) {
      entries.clear();
      failures.clear();
      inflight.clear();
      return;
    }
    entries.delete(tenantId);
    failures.delete(tenantId);
    for (const key of [...inflight.keys()]) {
      if (key.startsWith(`${tenantId}:`)) {
        inflight.delete(key);
      }
    }
  }

  return {
    ensure,
    current,
    forget,
    fingerprintOf: (tenantId) => entries.get(tenantId)?.fingerprint,
  };
}

/** The passport strategy name for one tenant. */
export function tenantOpenIdStrategyName(tenantId: string): string {
  return `openid:${tenantId}`;
}

/** The passport strategy name for one tenant's admin panel sign-in. */
export function tenantOpenIdAdminStrategyName(tenantId: string): string {
  return `openidAdmin:${tenantId}`;
}

export type TenantClaimFailure = 'TID_MISSING' | 'TID_MISMATCH' | 'TENANT_MISMATCH';

export type TenantClaimCheck = { ok: true } | { ok: false; reason: TenantClaimFailure };

/**
 * A token issued for one tenant must be accepted only on that tenant's host. The issuer already
 * differs per tenant; these claims are a second, independent check that the registry and the
 * identity provider agree on who the tenant is.
 */
export function checkTenantClaims(
  claims: Readonly<Record<string, unknown>>,
  expected: { tenantId: string; slug: string },
  { requireTid = true }: { requireTid?: boolean } = {},
): TenantClaimCheck {
  const tid = claims.tid;
  if (tid == null || tid === '') {
    if (requireTid) {
      return { ok: false, reason: 'TID_MISSING' };
    }
  } else if (tid !== expected.tenantId) {
    return { ok: false, reason: 'TID_MISMATCH' };
  }

  const tenant = claims.tenant;
  if (
    tenant != null &&
    tenant !== '' &&
    (typeof tenant !== 'string' || tenant.toLowerCase() !== expected.slug)
  ) {
    return { ok: false, reason: 'TENANT_MISMATCH' };
  }

  return { ok: true };
}
