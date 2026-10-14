import { tenantStorage } from '@librechat/data-schemas';
import type { TenantOpenIdSettings } from './tenant';
import {
  checkTenantClaims,
  createTenantOpenIdClients,
  fingerprintTenantOpenId,
  tenantOpenIdStrategyName,
  TenantOpenIdDiscoveryError,
} from './tenant';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const settings = (overrides: Partial<TenantOpenIdSettings> = {}): TenantOpenIdSettings => ({
  issuer: 'https://acme.example.com',
  clientId: 'client-acme',
  clientSecret: 'secret-1',
  scopes: ['openid', 'email'],
  ...overrides,
});

const setup = () => {
  let clock = 1_000;
  const discover = jest.fn(async (s: TenantOpenIdSettings) => ({
    issuer: s.issuer,
    id: Math.random(),
  }));
  const clients = createTenantOpenIdClients({
    discover,
    ttlMs: 1_000,
    failureTtlMs: 100,
    maxStaleMs: 5_000,
    now: () => clock,
  });
  return {
    clients,
    discover,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('fingerprintTenantOpenId', () => {
  it('changes with the secret, issuer, client id and scopes, and never contains the secret', () => {
    const base = fingerprintTenantOpenId(settings());
    expect(fingerprintTenantOpenId(settings())).toBe(base);
    expect(fingerprintTenantOpenId(settings({ clientSecret: 'secret-2' }))).not.toBe(base);
    expect(fingerprintTenantOpenId(settings({ issuer: 'https://b.example.com' }))).not.toBe(base);
    expect(fingerprintTenantOpenId(settings({ clientId: 'other' }))).not.toBe(base);
    expect(fingerprintTenantOpenId(settings({ scopes: ['openid'] }))).not.toBe(base);
    expect(base).not.toContain('secret-1');
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createTenantOpenIdClients', () => {
  it('discovers once and reuses the configuration until it is due for refresh', async () => {
    const { clients, discover, advance } = setup();

    const first = await clients.ensure('t1', settings());
    const second = await clients.ensure('t1', settings());
    expect(second).toBe(first);
    expect(discover).toHaveBeenCalledTimes(1);

    advance(1_001);
    const refreshed = await clients.ensure('t1', settings());
    expect(discover).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
  });

  it('shares one discovery between concurrent requests', async () => {
    const { clients, discover } = setup();
    const results = await Promise.all([
      clients.ensure('t1', settings()),
      clients.ensure('t1', settings()),
      clients.ensure('t1', settings()),
    ]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it('keeps tenants apart', async () => {
    const { clients, discover } = setup();
    const a = await clients.ensure('t1', settings());
    const b = await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));
    expect(a).not.toBe(b);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('replaces the client at once when the secret is rotated', async () => {
    const { clients, discover } = setup();
    const before = await clients.ensure('t1', settings());
    const after = await clients.ensure('t1', settings({ clientSecret: 'secret-2' }));

    expect(after).not.toBe(before);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(clients.fingerprintOf('t1')).toBe(
      fingerprintTenantOpenId(settings({ clientSecret: 'secret-2' })),
    );
  });

  it('does not serve the old client for new settings when discovery fails', async () => {
    const { clients, discover } = setup();
    await clients.ensure('t1', settings());
    discover.mockRejectedValueOnce(new Error('idp down'));

    await expect(clients.ensure('t1', settings({ clientSecret: 'secret-2' }))).rejects.toThrow(
      TenantOpenIdDiscoveryError,
    );
  });

  it('fails with a typed error that does not leak the cause or the secret', async () => {
    const { clients, discover } = setup();
    discover.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-1'));

    const error = await clients.ensure('t1', settings()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TenantOpenIdDiscoveryError);
    expect((error as TenantOpenIdDiscoveryError).code).toBe('TENANT_OPENID_DISCOVERY_FAILED');
    expect((error as Error).message).not.toContain('secret-1');
    expect((error as Error).message).not.toContain('ECONNREFUSED');
  });

  it('remembers a failure briefly so a down provider is not hit on every request', async () => {
    const { clients, discover, advance } = setup();
    discover.mockRejectedValue(new Error('idp down'));

    await expect(clients.ensure('t1', settings())).rejects.toThrow();
    await expect(clients.ensure('t1', settings())).rejects.toThrow();
    expect(discover).toHaveBeenCalledTimes(1);

    discover.mockResolvedValue({ issuer: 'https://acme.example.com', id: 1 });
    advance(101);
    await expect(clients.ensure('t1', settings())).resolves.toBeDefined();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('serves the last good configuration when a refresh fails, until it is too old', async () => {
    const { clients, discover, advance } = setup();
    const good = await clients.ensure('t1', settings());

    advance(1_001);
    discover.mockRejectedValue(new Error('idp down'));
    await expect(clients.ensure('t1', settings())).resolves.toBe(good);

    advance(6_000);
    await expect(clients.ensure('t1', settings())).rejects.toThrow(TenantOpenIdDiscoveryError);
  });

  describe('current', () => {
    it('is the configuration of the tenant in the current async context', async () => {
      const { clients } = setup();
      const a = await clients.ensure('t1', settings());
      const b = await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));

      expect(clients.current()).toBeUndefined();
      await tenantStorage.run({ tenantId: 't1' }, async () => {
        expect(clients.current()).toBe(a);
      });
      await tenantStorage.run({ tenantId: 't2' }, async () => {
        await Promise.resolve();
        expect(clients.current()).toBe(b);
      });
      await tenantStorage.run({ tenantId: 'unknown' }, async () => {
        expect(clients.current()).toBeUndefined();
      });
    });

    it('keeps concurrent tenants apart', async () => {
      const { clients } = setup();
      const a = await clients.ensure('t1', settings());
      const b = await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));
      const seen: unknown[] = [];

      await Promise.all(
        [
          ['t1', 10],
          ['t2', 1],
        ].map(([tenantId, delay]) =>
          tenantStorage.run({ tenantId: tenantId as string }, async () => {
            await new Promise((resolve) => setTimeout(resolve, delay as number));
            seen.push(clients.current());
          }),
        ),
      );

      expect(seen).toContain(a);
      expect(seen).toContain(b);
      expect(seen).toHaveLength(2);
    });
  });

  describe('forget', () => {
    it('drops one tenant, or all of them', async () => {
      const { clients, discover } = setup();
      await clients.ensure('t1', settings());
      await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));

      clients.forget('t1');
      await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));
      expect(discover).toHaveBeenCalledTimes(2);
      await clients.ensure('t1', settings());
      expect(discover).toHaveBeenCalledTimes(3);

      clients.forget();
      await clients.ensure('t2', settings({ issuer: 'https://beta.example.com' }));
      expect(discover).toHaveBeenCalledTimes(4);
    });

    it('does not let a discovery that started before it repopulate the tenant', async () => {
      const { clients, discover } = setup();
      let release: (value: { issuer: string; id: number }) => void = () => undefined;
      discover.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const slow = clients.ensure('t1', settings());
      clients.forget('t1');
      release({ issuer: 'https://acme.example.com', id: 42 });
      await slow;

      await tenantStorage.run({ tenantId: 't1' }, async () => {
        expect(clients.current()).toBeUndefined();
      });
    });
  });
});

describe('tenantOpenIdStrategyName', () => {
  it('is distinct for every tenant and from the single-tenant strategy', () => {
    expect(tenantOpenIdStrategyName('t1')).toBe('openid:t1');
    expect(tenantOpenIdStrategyName('t1')).not.toBe(tenantOpenIdStrategyName('t2'));
    expect(tenantOpenIdStrategyName('t1')).not.toBe('openid');
  });
});

describe('checkTenantClaims', () => {
  const expected = { tenantId: 'tid-1', slug: 'acme' };

  it('accepts matching claims', () => {
    expect(checkTenantClaims({ tid: 'tid-1', tenant: 'acme' }, expected)).toEqual({ ok: true });
    expect(checkTenantClaims({ tid: 'tid-1', tenant: 'ACME' }, expected)).toEqual({ ok: true });
  });

  it('rejects another tenant id', () => {
    expect(checkTenantClaims({ tid: 'tid-2', tenant: 'acme' }, expected)).toEqual({
      ok: false,
      reason: 'TID_MISMATCH',
    });
  });

  it('rejects another tenant slug even when the id matches', () => {
    expect(checkTenantClaims({ tid: 'tid-1', tenant: 'beta' }, expected)).toEqual({
      ok: false,
      reason: 'TENANT_MISMATCH',
    });
  });

  it('requires tid by default and can be relaxed', () => {
    expect(checkTenantClaims({ tenant: 'acme' }, expected)).toEqual({
      ok: false,
      reason: 'TID_MISSING',
    });
    expect(checkTenantClaims({ tid: '' }, expected)).toEqual({ ok: false, reason: 'TID_MISSING' });
    expect(checkTenantClaims({ tenant: 'acme' }, expected, { requireTid: false })).toEqual({
      ok: true,
    });
  });

  it('still rejects a wrong tid when tid is optional', () => {
    expect(checkTenantClaims({ tid: 'tid-2' }, expected, { requireTid: false })).toEqual({
      ok: false,
      reason: 'TID_MISMATCH',
    });
  });

  it('rejects a tenant claim of the wrong type', () => {
    expect(checkTenantClaims({ tid: 'tid-1', tenant: ['acme'] }, expected)).toEqual({
      ok: false,
      reason: 'TENANT_MISMATCH',
    });
    expect(checkTenantClaims({ tid: 'tid-1', tenant: 7 }, expected)).toEqual({
      ok: false,
      reason: 'TENANT_MISMATCH',
    });
  });

  it('does not coerce a numeric tid into a match', () => {
    expect(checkTenantClaims({ tid: 1 }, { tenantId: '1', slug: 'acme' })).toEqual({
      ok: false,
      reason: 'TID_MISMATCH',
    });
  });
});
