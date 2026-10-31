import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';

const TENANT_SCOPED = Symbol.for('librechat:tenantScopedCache');

/** Keyv methods whose first argument is one key. */
const SINGLE_KEY_METHODS = ['get', 'getRaw', 'has', 'set', 'delete'] as const;
/** Keyv methods whose first argument is a list of keys. */
const KEY_LIST_METHODS = ['getMany', 'getManyRaw', 'hasMany', 'deleteMany'] as const;
/** `RedisStore` (rate limiting) methods whose first argument is one key. */
const LIMITER_METHODS = ['increment', 'decrement', 'resetKey', 'get'] as const;

/**
 * The key a cache entry is stored under for the current request: `<key>:<tenantId>`. Without a
 * tenant context, or in a deliberate system context, the key is returned unchanged. A key that
 * already ends with the tenant (callers that use `scopedCacheKey` themselves) is not scoped twice.
 */
export function scopeCacheKey(key: string): string {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID || typeof key !== 'string') {
    return key;
  }
  return key.endsWith(`:${tenantId}`) ? key : `${key}:${tenantId}`;
}

type Patchable = Record<PropertyKey, unknown>;

/**
 * Whether `scopeKeyvByTenant` patched this cache. Code that reaches past the Keyv methods to the
 * store (atomic `getDel`, for example) must scope the key itself with `scopeCacheKey`.
 */
export function isTenantScopedCache(cache: object): boolean {
  return (cache as Patchable)[TENANT_SCOPED] === true;
}

/**
 * Makes every key of a Keyv cache tenant-scoped, so one tenant can never read, overwrite or
 * delete another tenant's entry whatever the caller forgot. Patches the instance in place, like
 * the Redis instrumentation does, and is safe to apply twice. `clear()` still clears the whole
 * namespace for every tenant, which is what its callers mean.
 */
export function scopeKeyvByTenant<T extends object>(cache: T): T {
  const target = cache as Patchable;
  if (target[TENANT_SCOPED]) {
    return cache;
  }

  for (const method of SINGLE_KEY_METHODS) {
    const original = target[method];
    if (typeof original === 'function') {
      target[method] = (key: string, ...rest: unknown[]) =>
        Reflect.apply(original, cache, [scopeCacheKey(key), ...rest]);
    }
  }

  for (const method of KEY_LIST_METHODS) {
    const original = target[method];
    if (typeof original === 'function') {
      target[method] = (keys: string[], ...rest: unknown[]) =>
        Reflect.apply(original, cache, [
          Array.isArray(keys) ? keys.map(scopeCacheKey) : keys,
          ...rest,
        ]);
    }
  }

  const setMany = target.setMany;
  if (typeof setMany === 'function') {
    target.setMany = (entries: Array<{ key: string }>, ...rest: unknown[]) =>
      Reflect.apply(setMany, cache, [
        Array.isArray(entries)
          ? entries.map((entry) => ({ ...entry, key: scopeCacheKey(entry.key) }))
          : entries,
        ...rest,
      ]);
  }

  target[TENANT_SCOPED] = true;
  return cache;
}

/**
 * Gives every tenant its own rate-limit counters. Limiters key by IP address, so without this a
 * tenant's traffic (or one noisy address) would use up the budget of every other tenant.
 */
export function scopeLimiterStoreByTenant<T extends object>(store: T): T {
  const target = store as Patchable;
  if (target[TENANT_SCOPED]) {
    return store;
  }

  for (const method of LIMITER_METHODS) {
    const original = target[method];
    if (typeof original === 'function') {
      target[method] = (key: string, ...rest: unknown[]) =>
        Reflect.apply(original, store, [scopeCacheKey(key), ...rest]);
    }
  }

  target[TENANT_SCOPED] = true;
  return store;
}
