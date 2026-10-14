import { tenantStorage } from '@librechat/data-schemas';
import { standardCache } from '~/cache/cacheFactory';

const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

describe('standardCache and host multi-tenancy', () => {
  const original = process.env.MULTI_TENANT_MODE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MULTI_TENANT_MODE;
    } else {
      process.env.MULTI_TENANT_MODE = original;
    }
  });

  it('scopes every key to the tenant of the request in host mode', async () => {
    process.env.MULTI_TENANT_MODE = 'host';
    const cache = standardCache('tenant-host-mode-namespace');

    await inTenant('tenant-a', () => cache.set('models', 'a-models'));
    await inTenant('tenant-b', () => cache.set('models', 'b-models'));

    expect(await inTenant('tenant-a', () => cache.get('models'))).toBe('a-models');
    expect(await inTenant('tenant-b', () => cache.get('models'))).toBe('b-models');
    expect(await cache.get('models')).toBeUndefined();
  });

  it('returns the same shared instance for a namespace, scoped once', async () => {
    process.env.MULTI_TENANT_MODE = 'host';
    const first = standardCache('tenant-host-mode-shared');
    const second = standardCache('tenant-host-mode-shared');

    expect(second).toBe(first);
    await inTenant('tenant-a', () => first.set('k', 'v'));
    expect(await inTenant('tenant-a', () => second.get('k'))).toBe('v');
  });

  it('leaves the cache untouched outside host mode, even inside a tenant context', async () => {
    delete process.env.MULTI_TENANT_MODE;
    const cache = standardCache('tenant-single-mode-namespace');

    await inTenant('tenant-a', () => cache.set('k', 'v'));

    expect(await cache.get('k')).toBe('v');
    expect(await inTenant('tenant-b', () => cache.get('k'))).toBe('v');
  });
});
