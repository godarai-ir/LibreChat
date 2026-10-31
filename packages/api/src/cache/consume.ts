/**
 * @keyv/redis's CommonJS default export requires the same interop as cacheFactory.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KeyvRedis = require('@keyv/redis').default as typeof import('@keyv/redis').default;
import type { Keyv, DeserializedData } from 'keyv';
import { isTenantScopedCache, scopeCacheKey } from './tenantScope';
import { observeRedisOperation } from './redisTelemetry';

/** Removes a Keyv entry atomically, including its serialized expiry. */
export async function consumeCacheEntry<T>(cache: Keyv, key: string): Promise<T | undefined> {
  // The store is read directly, past the methods a tenant-scoped cache patches, so the key gets
  // the tenant suffix `set` stored it under here.
  const storedKey = isTenantScopedCache(cache) ? scopeCacheKey(key) : key;
  const prefixedKey =
    cache.useKeyPrefix && cache.namespace && !storedKey.startsWith(`${cache.namespace}:`)
      ? `${cache.namespace}:${storedKey}`
      : storedKey;
  const store = cache.store;
  let raw: string | DeserializedData<T> | null | undefined;

  if (store instanceof Map) {
    raw = store.get(prefixedKey);
    store.delete(prefixedKey);
  } else if (store instanceof KeyvRedis) {
    const client = await store.getClient();
    try {
      raw = await observeRedisOperation('keyv', cache.namespace ?? '', 'getDel', () =>
        client.getDel(store.createKeyPrefix(prefixedKey, store.namespace)),
      );
    } catch (error) {
      cache.emit('error', error);
      throw error;
    }
  } else {
    throw new Error('Atomic cache consumption requires an in-memory or Redis store');
  }

  if (raw == null) {
    return undefined;
  }
  const entry = typeof raw === 'string' ? await cache.deserializeData<T>(raw) : raw;
  if (!entry || (typeof entry.expires === 'number' && Date.now() > entry.expires)) {
    return undefined;
  }
  return entry.value;
}
