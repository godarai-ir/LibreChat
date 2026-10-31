import { randomUUID } from 'crypto';
import { tenantStorage } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';

/** YAML servers are written at startup (no tenant) by Lua and read per request (tenant) by Keyv. */
describe('ServerConfigsCacheRedisAggregateKey in host multi-tenancy (real Redis)', () => {
  const config = { type: 'stdio', command: 'node', args: ['server.js'] } as ParsedServerConfig;
  const tenantId = `tenant-${randomUUID()}`;
  const inTenant = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
  let cache: InstanceType<
    typeof import('../ServerConfigsCacheRedisAggregateKey').ServerConfigsCacheRedisAggregateKey
  >;

  beforeAll(async () => {
    process.env.MULTI_TENANT_MODE = 'host';
    process.env.MCP_REGISTRY_CACHE_TTL = '0';
    const { keyvRedisClientReady } = await import('~/cache/redisClients');
    const { ServerConfigsCacheRedisAggregateKey } = await import(
      '../ServerConfigsCacheRedisAggregateKey'
    );
    await keyvRedisClientReady;
    cache = new ServerConfigsCacheRedisAggregateKey(`agg-tenancy-${randomUUID()}`, false);
  }, 180_000);

  afterAll(async () => {
    await cache.reset();
    delete process.env.MULTI_TENANT_MODE;
    await closeRedisClients();
  });

  it('serves a startup-loaded YAML server to a tenant request', async () => {
    await cache.add('yaml-server', config);
    await expect(cache.get('yaml-server')).resolves.toMatchObject(config);
    await expect(inTenant(() => cache.get('yaml-server'))).resolves.toMatchObject(config);
  });

  it('reads back a server a tenant request patched', async () => {
    await cache.upsert('patched', config);
    await inTenant(() => cache.patch('patched', { resolvedInstructions: 'use it' }));
    await expect(inTenant(() => cache.getCurrent('patched'))).resolves.toMatchObject({
      resolvedInstructions: 'use it',
    });
  });
});
