import { randomUUID } from 'crypto';
import { tenantStorage } from '@librechat/data-schemas';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';

/** A global invalidation must move the fence every tenant's fills are checked against. */
describe('ReadThroughAllCache in host multi-tenancy (real Redis)', () => {
  const tenantId = `tenant-${randomUUID()}`;
  const inTenant = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
  let cache: InstanceType<typeof import('../ReadThroughAllCache').ReadThroughAllCache<string>>;

  beforeAll(async () => {
    process.env.MULTI_TENANT_MODE = 'host';
    const { keyvRedisClientReady } = await import('~/cache/redisClients');
    const { ReadThroughAllCache } = await import('../ReadThroughAllCache');
    await keyvRedisClientReady;
    cache = new ReadThroughAllCache<string>(`rtac-tenancy-${randomUUID()}`, 60_000);
  }, 180_000);

  afterAll(async () => {
    delete process.env.MULTI_TENANT_MODE;
    await closeRedisClients();
  });

  it('fences a tenant fill that started before an operator-wide invalidation', async () => {
    const before = await inTenant(() => cache.get('user'));
    await cache.invalidateAllGlobal();
    await inTenant(() => cache.set('user', 'stale', before.fill));
    await expect(inTenant(() => cache.get('user'))).resolves.toMatchObject({ hit: false });
  });
});
