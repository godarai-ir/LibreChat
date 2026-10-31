import { Keyv } from 'keyv';
import { tenantStorage } from '@librechat/data-schemas';
import { scopeKeyvByTenant } from './tenantScope';
import { consumeCacheEntry } from './consume';

const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

describe('consumeCacheEntry', () => {
  it('returns an entry once and removes it', async () => {
    const cache = new Keyv({ namespace: 'consume-plain' });
    await cache.set('code', 'value');

    expect(await consumeCacheEntry(cache, 'code')).toBe('value');
    expect(await consumeCacheEntry(cache, 'code')).toBeUndefined();
    expect(await cache.get('code')).toBeUndefined();
  });

  it('does not return an expired entry', async () => {
    const cache = new Keyv({ namespace: 'consume-expired' });
    await cache.set('code', 'value', 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await consumeCacheEntry(cache, 'code')).toBeUndefined();
  });

  it('finds an entry a tenant-scoped cache stored for the same tenant', async () => {
    const cache = scopeKeyvByTenant(new Keyv({ namespace: 'consume-tenant' }));
    await inTenant('tenant-a', () => cache.set('code', 'a-value'));

    expect(await inTenant('tenant-a', () => consumeCacheEntry(cache, 'code'))).toBe('a-value');
    expect(await inTenant('tenant-a', () => cache.get('code'))).toBeUndefined();
  });

  it('does not let another tenant consume the entry', async () => {
    const cache = scopeKeyvByTenant(new Keyv({ namespace: 'consume-other-tenant' }));
    await inTenant('tenant-a', () => cache.set('code', 'a-value'));

    expect(await inTenant('tenant-b', () => consumeCacheEntry(cache, 'code'))).toBeUndefined();
    expect(await consumeCacheEntry(cache, 'code')).toBeUndefined();
    expect(await inTenant('tenant-a', () => cache.get('code'))).toBe('a-value');
  });
});
