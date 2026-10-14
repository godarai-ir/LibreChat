import type { StoredTenant, TenantRegistryDeps } from './registry';
import { createTenantRegistry, DEFAULT_TENANT_SCOPES } from './registry';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const stored = (overrides: Partial<StoredTenant> = {}): StoredTenant => ({
  tenantId: 'tenant-1',
  slug: 'acme',
  status: 'active',
  oidc: { clientId: 'client-1', clientSecret: 'v3:encrypted' },
  ...overrides,
});

const setup = (rows: Record<string, StoredTenant> = { acme: stored() }) => {
  let clock = 1_000;
  const findBySlug = jest.fn(async (slug: string) => rows[slug] ?? null);
  const decryptSecret = jest.fn((value: string) => `plain(${value})`);
  const deps: TenantRegistryDeps = { findBySlug, decryptSecret };
  const registry = createTenantRegistry(deps, {
    issuerTemplate: 'https://{slug}.example.com',
    ttlMs: 1_000,
    negativeTtlMs: 100,
    maxEntries: 2,
    maxNegativeEntries: 2,
    now: () => clock,
  });
  return {
    registry,
    findBySlug,
    decryptSecret,
    advance: (ms: number) => {
      clock += ms;
    },
    rows,
  };
};

describe('resolve', () => {
  it('returns an active tenant with a decrypted secret and the templated issuer', async () => {
    const { registry } = setup();

    expect(await registry.resolve('acme')).toEqual({
      kind: 'active',
      tenant: {
        tenantId: 'tenant-1',
        slug: 'acme',
        oidc: {
          issuer: 'https://acme.example.com',
          clientId: 'client-1',
          clientSecret: 'plain(v3:encrypted)',
          scopes: [...DEFAULT_TENANT_SCOPES],
        },
      },
    });
  });

  it('prefers the tenant issuer and scopes over the defaults', async () => {
    const { registry } = setup({
      acme: stored({
        oidc: {
          clientId: 'c',
          clientSecret: 'v3:x',
          issuer: 'https://login.acme.test',
          scopes: ['openid'],
        },
      }),
    });

    const result = await registry.resolve('acme');
    expect(result.kind === 'active' && result.tenant.oidc.issuer).toBe('https://login.acme.test');
    expect(result.kind === 'active' && result.tenant.oidc.scopes).toEqual(['openid']);
  });

  it('is case-insensitive', async () => {
    const { registry, findBySlug } = setup();
    await registry.resolve('ACME');
    expect(findBySlug).toHaveBeenCalledWith('acme');
  });

  it('reports an unknown slug', async () => {
    const { registry } = setup();
    expect(await registry.resolve('ghost')).toEqual({ kind: 'unknown' });
  });

  it.each(['', 'a.b', '-x', 'x-', 'a b', '../x', 'a'.repeat(64), 'ü'])(
    'treats the malformed slug %p as unknown without touching the database',
    async (slug) => {
      const { registry, findBySlug } = setup();
      expect(await registry.resolve(slug)).toEqual({ kind: 'unknown' });
      expect(findBySlug).not.toHaveBeenCalled();
    },
  );

  it('treats a non-string slug as unknown', async () => {
    const { registry, findBySlug } = setup();
    expect(await registry.resolve({ $ne: 'x' } as unknown as string)).toEqual({ kind: 'unknown' });
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'deleting'] as const)(
    'reports a %s tenant without decrypting its secret',
    async (status) => {
      const { registry, decryptSecret } = setup({ acme: stored({ status }) });
      expect(await registry.resolve('acme')).toEqual({
        kind: 'inactive',
        tenantId: 'tenant-1',
        slug: 'acme',
        status,
      });
      expect(decryptSecret).not.toHaveBeenCalled();
    },
  );

  it('flags a tenant whose secret cannot be decrypted and never exposes it', async () => {
    const { registry, decryptSecret } = setup();
    decryptSecret.mockImplementation(() => {
      throw new Error('bad key');
    });

    const result = await registry.resolve('acme');
    expect(result).toEqual({
      kind: 'misconfigured',
      tenantId: 'tenant-1',
      slug: 'acme',
      reason: 'SECRET_UNREADABLE',
    });
    expect(JSON.stringify(result)).not.toContain('encrypted');
  });

  it('flags a tenant with no issuer when there is no template', async () => {
    const registry = createTenantRegistry(
      { findBySlug: async () => stored(), decryptSecret: (v) => v },
      { issuerTemplate: null },
    );
    expect(await registry.resolve('acme')).toMatchObject({
      kind: 'misconfigured',
      reason: 'ISSUER_MISSING',
    });
  });

  it('refuses a non-https issuer override', async () => {
    const { registry } = setup({
      acme: stored({
        oidc: { clientId: 'c', clientSecret: 'v3:x', issuer: 'http://acme.example.com' },
      }),
    });
    expect(await registry.resolve('acme')).toMatchObject({
      kind: 'misconfigured',
      reason: 'ISSUER_MISSING',
    });
  });
});

describe('caching', () => {
  it('serves a found tenant from memory until the ttl expires', async () => {
    const { registry, findBySlug, advance } = setup();
    await registry.resolve('acme');
    await registry.resolve('acme');
    expect(findBySlug).toHaveBeenCalledTimes(1);

    advance(1_001);
    await registry.resolve('acme');
    expect(findBySlug).toHaveBeenCalledTimes(2);
  });

  it('remembers an unknown slug only briefly so a new tenant appears quickly', async () => {
    const { registry, findBySlug, rows, advance } = setup({});
    expect(await registry.resolve('newco')).toEqual({ kind: 'unknown' });
    expect(await registry.resolve('newco')).toEqual({ kind: 'unknown' });
    expect(findBySlug).toHaveBeenCalledTimes(1);

    rows.newco = stored({ slug: 'newco' });
    advance(101);
    expect((await registry.resolve('newco')).kind).toBe('active');
  });

  it('shares one lookup between concurrent requests', async () => {
    const { registry, findBySlug } = setup();
    await Promise.all([
      registry.resolve('acme'),
      registry.resolve('acme'),
      registry.resolve('acme'),
    ]);
    expect(findBySlug).toHaveBeenCalledTimes(1);
  });

  it('does not cache a database failure and does not report it as unknown', async () => {
    const { registry, findBySlug } = setup();
    findBySlug.mockRejectedValueOnce(new Error('mongo down'));

    await expect(registry.resolve('acme')).rejects.toThrow('mongo down');
    expect((await registry.resolve('acme')).kind).toBe('active');
    expect(findBySlug).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the cached tenant for a flood of unknown hosts', async () => {
    const { registry, findBySlug } = setup();
    await registry.resolve('acme');

    for (let i = 0; i < 20; i += 1) {
      await registry.resolve(`ghost-${i}`);
    }

    findBySlug.mockClear();
    expect((await registry.resolve('acme')).kind).toBe('active');
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('bounds the number of remembered tenants', async () => {
    const { registry, findBySlug } = setup({
      a1: stored({ slug: 'a1', tenantId: 't1' }),
      a2: stored({ slug: 'a2', tenantId: 't2' }),
      a3: stored({ slug: 'a3', tenantId: 't3' }),
    });
    await registry.resolve('a1');
    await registry.resolve('a2');
    await registry.resolve('a3');

    findBySlug.mockClear();
    await registry.resolve('a1');
    expect(findBySlug).toHaveBeenCalledTimes(1);
  });
});

describe('invalidate', () => {
  it('drops one slug so the next request re-reads the row', async () => {
    const { registry, findBySlug, rows } = setup();
    await registry.resolve('acme');

    rows.acme = stored({ status: 'suspended' });
    registry.invalidate('ACME');

    expect((await registry.resolve('acme')).kind).toBe('inactive');
    expect(findBySlug).toHaveBeenCalledTimes(2);
  });

  it('drops everything when called without a slug', async () => {
    const { registry, findBySlug } = setup();
    await registry.resolve('acme');
    registry.invalidate();
    await registry.resolve('acme');
    expect(findBySlug).toHaveBeenCalledTimes(2);
  });

  it('does not let a lookup that began before the invalidation cache stale data', async () => {
    const { registry, findBySlug, rows } = setup();
    let release: () => void = () => undefined;
    findBySlug.mockImplementationOnce(
      (slug: string) =>
        new Promise((resolve) => {
          const snapshot = rows[slug] ?? null;
          release = () => resolve(snapshot);
        }),
    );

    const slow = registry.resolve('acme');
    rows.acme = stored({ status: 'suspended' });
    registry.invalidate('acme');
    release();
    expect((await slow).kind).toBe('active');

    expect((await registry.resolve('acme')).kind).toBe('inactive');
  });
});
