import { randomUUID } from 'crypto';
import { tenantStorage } from '@librechat/data-schemas';
import type { Keyv } from 'keyv';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';
import { FlowStateManager } from '~/flow/manager';

const FLOW_TYPE = 'mcp_oauth';
const FLOW_TTL = 30_000;

/** Host multi-tenancy wraps the flows cache with `scopeKeyvByTenant`; the guarded scripts must agree. */
describe('FlowStateManager in host multi-tenancy (real Redis)', () => {
  let store: Keyv;
  let manager: FlowStateManager<string>;
  const tenantId = `tenant-${randomUUID()}`;
  const inTenant = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

  beforeAll(async () => {
    process.env.MULTI_TENANT_MODE = 'host';
    const { keyvRedisClientReady, evalKeyvRedisScript } = await import('~/cache/redisClients');
    const { standardCache } = await import('~/cache/cacheFactory');
    const { isTenantScopedCache } = await import('~/cache/tenantScope');
    await keyvRedisClientReady;
    store = standardCache(`FlowTenancy-${randomUUID()}`, FLOW_TTL);
    if (!isTenantScopedCache(store)) {
      throw new Error('Expected the host-mode flows cache to be tenant-scoped');
    }
    manager = new FlowStateManager<string>(store, {
      ttl: FLOW_TTL,
      retainedFailureTypes: [FLOW_TYPE],
      redisScriptExecutor: evalKeyvRedisScript,
      ci: true,
    });
  }, 180_000);

  afterAll(async () => {
    delete process.env.MULTI_TENANT_MODE;
    await closeRedisClients();
  });

  it('completes an OAuth flow it started inside the same tenant', async () => {
    const flowId = randomUUID();
    await inTenant(async () => {
      await manager.initFlow(flowId, FLOW_TYPE, { state: 'oauth-state' });
      const flow = await manager.getFlowState(flowId, FLOW_TYPE);
      expect(flow).toEqual(expect.objectContaining({ status: 'PENDING' }));

      await expect(
        manager.completeFlowIfCurrent(flowId, FLOW_TYPE, flow!.createdAt, 'oauth-state', 'tokens'),
      ).resolves.toBe('updated');
      await expect(manager.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
        expect.objectContaining({ status: 'COMPLETED', result: 'tokens' }),
      );
    });
  });

  it('deletes the attempt it observed inside the same tenant', async () => {
    const flowId = randomUUID();
    await inTenant(async () => {
      await manager.initFlow(flowId, FLOW_TYPE, { state: 'oauth-state' });
      const flow = await manager.getFlowState(flowId, FLOW_TYPE);
      await expect(
        manager.deleteFlowIfCurrent(flowId, FLOW_TYPE, flow!.createdAt, 'oauth-state'),
      ).resolves.toBe('updated');
      await expect(manager.getFlowState(flowId, FLOW_TYPE)).resolves.toBeUndefined();
    });
  });
});
