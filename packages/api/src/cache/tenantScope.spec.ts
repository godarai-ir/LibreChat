import { Keyv } from 'keyv';
import { tenantStorage, runAsSystem, scopedCacheKey } from '@librechat/data-schemas';
import { scopeCacheKey, scopeKeyvByTenant, scopeLimiterStoreByTenant } from './tenantScope';

const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const memoryCache = () => scopeKeyvByTenant(new Keyv({ namespace: 'test' }));

describe('scopeCacheKey', () => {
  it('leaves the key alone without a tenant context', () => {
    expect(scopeCacheKey('config')).toBe('config');
  });

  it('appends the tenant inside a tenant context', async () => {
    await inTenant('tenant-a', async () => {
      expect(scopeCacheKey('config')).toBe('config:tenant-a');
    });
  });

  it('leaves the key alone in a deliberate system context', async () => {
    await inTenant('tenant-a', () =>
      runAsSystem(async () => {
        expect(scopeCacheKey('config')).toBe('config');
      }),
    );
  });

  it('does not scope a key twice, so callers that already scope it keep working', async () => {
    await inTenant('tenant-a', async () => {
      const once = scopedCacheKey('config');
      expect(once).toBe('config:tenant-a');
      expect(scopeCacheKey(once)).toBe('config:tenant-a');
    });
  });

  it('keeps tenants apart even when one id is the suffix of another', async () => {
    await inTenant('b', async () => {
      expect(scopeCacheKey('x:ab')).toBe('x:ab:b');
    });
  });

  it('passes a non-string key through untouched', async () => {
    await inTenant('tenant-a', async () => {
      expect(scopeCacheKey(undefined as unknown as string)).toBeUndefined();
    });
  });
});

describe('scopeKeyvByTenant', () => {
  it('stores each tenant its own value under the same key', async () => {
    const cache = memoryCache();

    await inTenant('tenant-a', () => cache.set('models', 'a-models'));
    await inTenant('tenant-b', () => cache.set('models', 'b-models'));

    expect(await inTenant('tenant-a', () => cache.get('models'))).toBe('a-models');
    expect(await inTenant('tenant-b', () => cache.get('models'))).toBe('b-models');
  });

  it('does not show one tenant an entry that only another tenant wrote', async () => {
    const cache = memoryCache();
    await inTenant('tenant-a', () => cache.set('secret', 'a-only'));

    expect(await inTenant('tenant-b', () => cache.get('secret'))).toBeUndefined();
    expect(await inTenant('tenant-b', () => cache.has('secret'))).toBe(false);
    expect(await cache.get('secret')).toBeUndefined();
  });

  it('does not let a tenant delete another tenant entry', async () => {
    const cache = memoryCache();
    await inTenant('tenant-a', () => cache.set('k', 'a'));

    await inTenant('tenant-b', () => cache.delete('k'));

    expect(await inTenant('tenant-a', () => cache.get('k'))).toBe('a');
  });

  it('scopes the batch methods too', async () => {
    const cache = memoryCache();
    await inTenant('tenant-a', () =>
      cache.setMany([
        { key: 'x', value: 'ax' },
        { key: 'y', value: 'ay' },
      ]),
    );
    await inTenant('tenant-b', () => cache.set('x', 'bx'));

    expect(await inTenant('tenant-a', () => cache.getMany(['x', 'y']))).toEqual(['ax', 'ay']);
    expect(await inTenant('tenant-b', () => cache.getMany(['x', 'y']))).toEqual(['bx', undefined]);
    expect(await inTenant('tenant-b', () => cache.hasMany(['x', 'y']))).toEqual([true, false]);

    await inTenant('tenant-b', () => cache.deleteMany(['x', 'y']));
    expect(await inTenant('tenant-a', () => cache.getMany(['x', 'y']))).toEqual(['ax', 'ay']);
  });

  it('uses the plain key outside a tenant context, as single-tenant mode always did', async () => {
    const cache = memoryCache();
    await cache.set('plain', 'value');

    expect(await cache.get('plain')).toBe('value');
    expect(await inTenant('tenant-a', () => cache.get('plain'))).toBeUndefined();
  });

  it('shares system-context entries between system calls only', async () => {
    const cache = memoryCache();
    await runAsSystem(() => cache.set('shared', 'system-value'));

    expect(await runAsSystem(() => cache.get('shared'))).toBe('system-value');
    expect(await inTenant('tenant-a', () => cache.get('shared'))).toBeUndefined();
  });

  it('keeps concurrent tenants apart', async () => {
    const cache = memoryCache();

    await Promise.all(
      ['a', 'b', 'c'].map((tenant, index) =>
        inTenant(`tenant-${tenant}`, async () => {
          await new Promise((resolve) => setTimeout(resolve, (3 - index) * 5));
          await cache.set('value', tenant);
        }),
      ),
    );

    for (const tenant of ['a', 'b', 'c']) {
      expect(await inTenant(`tenant-${tenant}`, () => cache.get('value'))).toBe(tenant);
    }
  });

  it('still clears the whole namespace for every tenant', async () => {
    const cache = memoryCache();
    await inTenant('tenant-a', () => cache.set('k', 'a'));
    await inTenant('tenant-b', () => cache.set('k', 'b'));

    await cache.clear();

    expect(await inTenant('tenant-a', () => cache.get('k'))).toBeUndefined();
    expect(await inTenant('tenant-b', () => cache.get('k'))).toBeUndefined();
  });

  it('is safe to apply twice', async () => {
    const cache = scopeKeyvByTenant(scopeKeyvByTenant(new Keyv({ namespace: 'twice' })));
    await inTenant('tenant-a', () => cache.set('k', 'v'));

    expect(await inTenant('tenant-a', () => cache.get('k'))).toBe('v');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('honors a key that the caller already scoped', async () => {
    const cache = memoryCache();
    await inTenant('tenant-a', () => cache.set(scopedCacheKey('mcp'), 'servers'));

    expect(await inTenant('tenant-a', () => cache.get(scopedCacheKey('mcp')))).toBe('servers');
    expect(await inTenant('tenant-a', () => cache.get('mcp'))).toBe('servers');
  });
});

describe('scopeLimiterStoreByTenant', () => {
  const fakeStore = () => {
    const counts = new Map<string, number>();
    return {
      counts,
      increment: jest.fn(async (key: string) => {
        const totalHits = (counts.get(key) ?? 0) + 1;
        counts.set(key, totalHits);
        return { totalHits };
      }),
      decrement: jest.fn(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 1) - 1);
      }),
      resetKey: jest.fn(async (key: string) => {
        counts.delete(key);
      }),
      get: jest.fn(async (key: string) => ({ totalHits: counts.get(key) ?? 0 })),
    };
  };

  it('gives every tenant its own counter for the same address', async () => {
    const store = scopeLimiterStoreByTenant(fakeStore());

    await inTenant('tenant-a', () => store.increment('203.0.113.7'));
    await inTenant('tenant-a', () => store.increment('203.0.113.7'));
    const b = await inTenant('tenant-b', () => store.increment('203.0.113.7'));

    expect(b.totalHits).toBe(1);
    expect((await inTenant('tenant-a', () => store.get('203.0.113.7'))).totalHits).toBe(2);
  });

  it('resets and decrements only the counter of the current tenant', async () => {
    const store = scopeLimiterStoreByTenant(fakeStore());
    await inTenant('tenant-a', () => store.increment('ip'));
    await inTenant('tenant-b', () => store.increment('ip'));

    await inTenant('tenant-a', () => store.resetKey('ip'));
    await inTenant('tenant-b', () => store.decrement('ip'));

    expect((await inTenant('tenant-a', () => store.get('ip'))).totalHits).toBe(0);
    expect((await inTenant('tenant-b', () => store.get('ip'))).totalHits).toBe(0);
  });

  it('uses the plain key outside a tenant context', async () => {
    const raw = fakeStore();
    const store = scopeLimiterStoreByTenant(raw);

    await store.increment('ip');

    expect(raw.counts.has('ip')).toBe(true);
  });

  it('is safe to apply twice', async () => {
    const raw = fakeStore();
    const store = scopeLimiterStoreByTenant(scopeLimiterStoreByTenant(raw));

    await inTenant('tenant-a', () => store.increment('ip'));

    expect([...raw.counts.keys()]).toEqual(['ip:tenant-a']);
  });
});
