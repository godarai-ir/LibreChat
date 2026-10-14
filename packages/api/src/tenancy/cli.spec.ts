import type { TenantCliDeps } from './cli';
import { runTenantCommand } from './cli';

const tenant = {
  tenantId: 'tenant-1',
  slug: 'acme',
  status: 'active' as const,
  oidc: { clientId: 'client-1', clientSecret: 'v3:stored' },
};

const setup = (overrides: Partial<TenantCliDeps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const methods = {
    getTenantById: jest.fn(async () => tenant),
    getTenantBySlug: jest.fn(async () => tenant),
    listTenants: jest.fn(async () => [tenant]),
    createTenant: jest.fn(async () => ({ ok: true as const, value: tenant })),
    updateTenant: jest.fn(async () => ({ ok: true as const, value: tenant })),
  };
  const deps: TenantCliDeps = {
    methods,
    encryptSecret: (plain) => `v3:enc(${plain})`,
    readSecret: async () => 'super-secret',
    env: {},
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    ...overrides,
  };
  return { deps, methods, out, err };
};

const run = (args: string[], deps: TenantCliDeps) => runTenantCommand(args, deps);

describe('help and parsing', () => {
  it('prints usage and fails without a command', async () => {
    const { deps, out } = setup();
    expect(await run([], deps)).toBe(1);
    expect(out.join('\n')).toContain('Usage:');
  });

  it('prints usage and succeeds for --help', async () => {
    const { deps, out } = setup();
    expect(await run(['--help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('create');
  });

  it('rejects an unknown command', async () => {
    const { deps, err } = setup();
    expect(await run(['explode', '--tenant-id', 'x'], deps)).toBe(1);
    expect(err.join('\n')).toContain('Unknown command');
  });

  it('rejects a flag without a value, a bare word and a duplicate', async () => {
    const { deps } = setup();
    expect(await run(['create', '--slug'], deps)).toBe(1);
    expect(await run(['create', 'slug', 'acme'], deps)).toBe(1);
    expect(await run(['create', '--slug', 'a', '--slug', 'b'], deps)).toBe(1);
  });
});

describe('create', () => {
  const args = ['create', '--tenant-id', 'tenant-1', '--slug', 'Acme', '--client-id', 'client-1'];

  it('stores an encrypted secret and a lowercase slug', async () => {
    const { deps, methods, out } = setup();
    expect(await run(args, deps)).toBe(0);
    expect(methods.createTenant).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      slug: 'acme',
      oidc: { clientId: 'client-1', clientSecret: 'v3:enc(super-secret)' },
    });
    expect(out.join('\n')).toContain('slug=acme');
  });

  it('never prints the secret, plain or encrypted', async () => {
    const { deps, out, err } = setup();
    await run(args, deps);
    const everything = [...out, ...err].join('\n');
    expect(everything).not.toContain('super-secret');
    expect(everything).not.toContain('enc(');
    expect(everything).not.toContain('v3:');
  });

  it('passes an https issuer and scopes through', async () => {
    const { deps, methods } = setup();
    await run([...args, '--issuer', 'https://login.acme.test', '--scopes', 'openid  email'], deps);
    expect(methods.createTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        oidc: expect.objectContaining({
          issuer: 'https://login.acme.test',
          scopes: ['openid', 'email'],
        }),
      }),
    );
  });

  it('refuses a non-https issuer', async () => {
    const { deps, methods } = setup();
    expect(await run([...args, '--issuer', 'http://x.test'], deps)).toBe(1);
    expect(methods.createTenant).not.toHaveBeenCalled();
  });

  it('fails when no secret is available', async () => {
    const { deps, methods, err } = setup({ readSecret: async () => undefined });
    expect(await run(args, deps)).toBe(1);
    expect(err.join('\n')).toContain('No client secret');
    expect(methods.createTenant).not.toHaveBeenCalled();
  });

  it.each(['auth', 'chat', 'default', 'www'])('refuses the reserved slug %s', async (slug) => {
    const { deps, methods } = setup();
    const code = await run(
      ['create', '--tenant-id', 't', '--slug', slug, '--client-id', 'c'],
      deps,
    );
    expect(code).toBe(1);
    expect(methods.createTenant).not.toHaveBeenCalled();
  });

  it('also honors operator-reserved slugs', async () => {
    const { deps, methods } = setup({ env: { TENANT_RESERVED_SLUGS: 'internal' } });
    const code = await run(
      ['create', '--tenant-id', 't', '--slug', 'internal', '--client-id', 'c'],
      deps,
    );
    expect(code).toBe(1);
    expect(methods.createTenant).not.toHaveBeenCalled();
  });

  it.each(['-bad', 'bad-', 'a.b', 'a_b', 'a b', '', 'x'.repeat(64)])(
    'refuses the slug %p',
    async (slug) => {
      const { deps, methods } = setup();
      const code = await run(
        ['create', '--tenant-id', 't', '--slug', slug, '--client-id', 'c'],
        deps,
      );
      expect(code).toBe(1);
      expect(methods.createTenant).not.toHaveBeenCalled();
    },
  );

  it.each(['__SYSTEM__', '-x', 'a/b', '../x'])('refuses the tenant id %p', async (id) => {
    const { deps, methods } = setup();
    const code = await run(
      ['create', '--tenant-id', id, '--slug', 'acme', '--client-id', 'c'],
      deps,
    );
    expect(code).toBe(1);
    expect(methods.createTenant).not.toHaveBeenCalled();
  });

  it('turns a duplicate into a clear failure', async () => {
    const { deps, err } = setup();
    (deps.methods.createTenant as jest.Mock).mockResolvedValueOnce({
      ok: false,
      error: { code: 'DUPLICATE_SLUG' },
    });
    expect(await run(args, deps)).toBe(1);
    expect(err.join('\n')).toContain('DUPLICATE_SLUG');
  });
});

describe('rotate-secret, set-status, rename', () => {
  it('rotates only the secret, encrypted', async () => {
    const { deps, methods } = setup();
    expect(await run(['rotate-secret', '--tenant-id', 'tenant-1'], deps)).toBe(0);
    expect(methods.updateTenant).toHaveBeenCalledWith('tenant-1', {
      oidc: { clientSecret: 'v3:enc(super-secret)' },
    });
  });

  it('sets a valid status and refuses an invalid one', async () => {
    const { deps, methods } = setup();
    expect(
      await run(['set-status', '--tenant-id', 'tenant-1', '--status', 'suspended'], deps),
    ).toBe(0);
    expect(methods.updateTenant).toHaveBeenCalledWith('tenant-1', { status: 'suspended' });
    expect(await run(['set-status', '--tenant-id', 'tenant-1', '--status', 'gone'], deps)).toBe(1);
  });

  it('renames to a valid, non-reserved slug only', async () => {
    const { deps, methods } = setup();
    expect(await run(['rename', '--tenant-id', 'tenant-1', '--slug', 'Acme-Two'], deps)).toBe(0);
    expect(methods.updateTenant).toHaveBeenCalledWith('tenant-1', { slug: 'acme-two' });
    expect(await run(['rename', '--tenant-id', 'tenant-1', '--slug', 'auth'], deps)).toBe(1);
  });

  it('reports an unknown tenant', async () => {
    const { deps, err } = setup();
    (deps.methods.updateTenant as jest.Mock).mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await run(['set-status', '--tenant-id', 'ghost', '--status', 'active'], deps)).toBe(1);
    expect(err.join('\n')).toContain('NOT_FOUND');
  });
});

describe('list', () => {
  it('prints one line per tenant and a count, without secrets', async () => {
    const { deps, out } = setup();
    expect(await run(['list'], deps)).toBe(0);
    expect(out[0]).toContain('slug=acme');
    expect(out[out.length - 1]).toBe('1 tenant(s)');
    expect(out.join('\n')).not.toContain('stored');
  });

  it('filters by status', async () => {
    const { deps, methods } = setup();
    await run(['list', '--status', 'suspended'], deps);
    expect(methods.listTenants).toHaveBeenCalledWith({ status: 'suspended' });
    expect(await run(['list', '--status', 'nope'], deps)).toBe(1);
  });
});
