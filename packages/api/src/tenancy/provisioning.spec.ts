import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TenantProvisioningDeps } from './provisioning';
import { createTenantProvisioningHandler, startTenantProvisioningServer } from './provisioning';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const TOKEN = 'a'.repeat(40);

type Row = Awaited<ReturnType<TenantProvisioningDeps['methods']['getTenantById']>> & object;

const buildDeps = () => {
  const rows = new Map<string, Row>();
  const methods: TenantProvisioningDeps['methods'] = {
    getTenantById: async (id) => rows.get(id) ?? null,
    createTenant: async (input) => {
      if (rows.has(input.tenantId)) {
        return { ok: false, error: { code: 'DUPLICATE_TENANT_ID' } };
      }
      if ([...rows.values()].some((row) => row.slug === input.slug)) {
        return { ok: false, error: { code: 'DUPLICATE_SLUG' } };
      }
      const row: Row = { ...input, status: 'active' };
      rows.set(input.tenantId, row);
      return { ok: true, value: row };
    },
    updateTenant: async (id, update) => {
      const row = rows.get(id);
      if (!row) {
        return { ok: false, error: { code: 'NOT_FOUND' } };
      }
      if (update.slug && [...rows.values()].some((r) => r !== row && r.slug === update.slug)) {
        return { ok: false, error: { code: 'DUPLICATE_SLUG' } };
      }
      const next: Row = {
        ...row,
        ...(update.slug && { slug: update.slug }),
        ...(update.status && { status: update.status }),
        oidc: { ...row.oidc, ...update.oidc },
      };
      rows.set(id, next);
      return { ok: true, value: next };
    },
  };
  const invalidate = jest.fn();
  const checkReady = jest.fn(
    async (_slug: string): Promise<{ ready: boolean; reason?: string }> => ({
      ready: true,
    }),
  );
  const deps: TenantProvisioningDeps = {
    methods,
    encryptSecret: (plain) => `v3:enc(${plain})`,
    invalidate,
    checkReady,
    token: TOKEN,
    env: {},
  };
  return { deps, rows, invalidate, checkReady };
};

let server: Server;
let base: string;
let ctx: ReturnType<typeof buildDeps>;

beforeEach(async () => {
  ctx = buildDeps();
  server = createServer(createTenantProvisioningHandler(ctx.deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
};

const create = (tenantId = 'tid-1', slug = 'acme') =>
  call('PUT', `/tenants/${tenantId}`, {
    slug,
    oidc: { clientId: 'godarchat', clientSecret: 'super-secret' },
  });

describe('authentication', () => {
  it.each([
    ['no header', {}],
    ['a wrong token', { Authorization: `Bearer ${'b'.repeat(40)}` }],
    ['a non-bearer scheme', { Authorization: `Basic ${TOKEN}` }],
    ['a token with trailing parts', { Authorization: `Bearer ${TOKEN} extra` }],
  ])('refuses %s', async (_name, headers) => {
    const response = await call('GET', '/tenants/tid-1', undefined, headers);

    expect(response.status).toBe(401);
    expect(ctx.rows.size).toBe(0);
  });

  it('refuses a write without the token and changes nothing', async () => {
    const response = await call(
      'PUT',
      '/tenants/tid-1',
      { slug: 'acme', oidc: { clientId: 'c', clientSecret: 's' } },
      {},
    );

    expect(response.status).toBe(401);
    expect(ctx.rows.size).toBe(0);
  });

  it('answers the health probe without a token', async () => {
    const response = await call('GET', '/healthz', undefined, {});

    expect(response.status).toBe(200);
  });

  it('does not serve any other path', async () => {
    expect((await call('GET', '/api/auth', undefined, {})).status).toBe(404);
    expect((await call('GET', '/tenants', undefined)).status).toBe(404);
  });
});

describe('PUT /tenants/:id', () => {
  it('creates the tenant, stores the secret encrypted and never returns it', async () => {
    const response = await create();

    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({
      tenantId: 'tid-1',
      slug: 'acme',
      status: 'active',
      ready: true,
    });
    expect(response.text).not.toContain('super-secret');
    expect(response.text).not.toContain('enc(');
    expect(ctx.rows.get('tid-1')?.oidc.clientSecret).toBe('v3:enc(super-secret)');
    expect(ctx.invalidate).toHaveBeenCalledWith('tid-1');
  });

  it('is idempotent: the same call again changes nothing and still succeeds', async () => {
    await create();
    const again = await create();

    expect(again.status).toBe(200);
    expect(ctx.rows.size).toBe(1);
  });

  it('renames an existing tenant and keeps its secret when none is sent', async () => {
    await create();
    const response = await call('PUT', '/tenants/tid-1', { slug: 'acme-two' });

    expect(response.status).toBe(200);
    expect(response.json.slug).toBe('acme-two');
    expect(ctx.rows.get('tid-1')?.oidc.clientSecret).toBe('v3:enc(super-secret)');
  });

  it('does not bring a tenant that is being deleted back to active', async () => {
    await create();
    await call('DELETE', '/tenants/tid-1');
    const response = await create();

    expect(response.json.status).toBe('deleting');
  });

  it('refuses a slug that another tenant owns', async () => {
    await create('tid-1', 'acme');
    const response = await create('tid-2', 'acme');

    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe('SLUG_TAKEN');
    expect(ctx.rows.has('tid-2')).toBe(false);
  });

  it.each(['Bad Slug', '-lead', 'a.b', '', 'x'.repeat(64), 'chat', 'www'])(
    'refuses the slug %p',
    async (slug) => {
      const response = await call('PUT', '/tenants/tid-1', {
        slug,
        oidc: { clientId: 'c', clientSecret: 's' },
      });

      expect(response.status).toBe(400);
      expect(ctx.rows.size).toBe(0);
    },
  );

  it('requires a client id and secret to create', async () => {
    const response = await call('PUT', '/tenants/tid-1', {
      slug: 'acme',
      oidc: { clientId: 'c' },
    });

    expect(response.status).toBe(400);
  });

  it('refuses fields it does not know, instead of ignoring them', async () => {
    const withTenantId = await call('PUT', '/tenants/tid-1', {
      slug: 'acme',
      tenantId: 'other',
      oidc: { clientId: 'c', clientSecret: 's' },
    });
    const withIssuer = await call('PUT', '/tenants/tid-1', {
      slug: 'acme',
      oidc: { clientId: 'c', clientSecret: 's', issuer: 'https://evil.example.com' },
    });

    expect(withTenantId.status).toBe(400);
    expect(withIssuer.status).toBe(400);
    expect(ctx.rows.size).toBe(0);
  });

  it.each(['has space', '../x', '-lead'])('refuses the tenant id %p', async (tenantId) => {
    const response = await create(encodeURIComponent(tenantId));

    expect(response.status).toBe(400);
  });

  it('refuses a body that is not json or not an object', async () => {
    expect((await call('PUT', '/tenants/tid-1', '{not json')).status).toBe(400);
    expect((await call('PUT', '/tenants/tid-1', '[]')).status).toBe(400);
  });

  it('refuses a body that is not declared as json', async () => {
    const response = await fetch(`${base}/tenants/tid-1`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });

    expect(response.status).toBe(415);
  });

  it('refuses a body over the size limit', async () => {
    const response = await call('PUT', '/tenants/tid-1', {
      slug: 'acme',
      oidc: { clientId: 'c', clientSecret: 's'.repeat(20_000) },
    });

    expect([400, 413]).toContain(response.status);
    expect(ctx.rows.size).toBe(0);
  });

  it('reports a tenant whose sign-in does not work as not ready', async () => {
    ctx.checkReady.mockResolvedValueOnce({ ready: false, reason: 'DISCOVERY_FAILED' });
    const response = await create();

    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ ready: false, reason: 'DISCOVERY_FAILED' });
  });

  it('reports not ready, not an error, when the readiness check itself throws', async () => {
    ctx.checkReady.mockRejectedValueOnce(new Error('boom'));
    const response = await create();

    expect(response.status).toBe(201);
    expect(response.json.ready).toBe(false);
  });
});

describe('GET, PATCH and DELETE', () => {
  it('reads a tenant without its secret and 404s for an unknown one', async () => {
    await create();
    const found = await call('GET', '/tenants/tid-1');

    expect(found.json).toMatchObject({ slug: 'acme', oidc: { clientId: 'godarchat' } });
    expect(found.text).not.toContain('secret');
    expect((await call('GET', '/tenants/missing')).status).toBe(404);
  });

  it('rotates the secret and suspends with one patch', async () => {
    await create();
    const response = await call('PATCH', '/tenants/tid-1', {
      status: 'suspended',
      oidc: { clientSecret: 'rotated' },
    });

    expect(response.json.status).toBe('suspended');
    expect(ctx.rows.get('tid-1')?.oidc.clientSecret).toBe('v3:enc(rotated)');
  });

  it('refuses an empty patch, an unknown status and an unknown tenant', async () => {
    await create();

    expect((await call('PATCH', '/tenants/tid-1', {})).status).toBe(400);
    expect((await call('PATCH', '/tenants/tid-1', { status: 'gone' })).status).toBe(400);
    expect((await call('PATCH', '/tenants/missing', { status: 'active' })).status).toBe(404);
  });

  it('marks a tenant deleting on DELETE and keeps its row', async () => {
    await create();
    const response = await call('DELETE', '/tenants/tid-1');

    expect(response.json.status).toBe('deleting');
    expect(ctx.rows.has('tid-1')).toBe(true);
    expect((await call('DELETE', '/tenants/missing')).status).toBe(404);
  });

  it('answers an unsupported method with 405', async () => {
    expect((await call('POST', '/tenants/tid-1', {})).status).toBe(405);
  });
});

describe('startTenantProvisioningServer', () => {
  const deps = () => {
    const { deps: all } = buildDeps();
    const { token: _token, ...rest } = all;
    return rest;
  };

  it('stays off without a token', () => {
    expect(startTenantProvisioningServer({ deps: deps(), env: {} })).toBeNull();
  });

  it('refuses a short token and a bad port', () => {
    expect(() =>
      startTenantProvisioningServer({ deps: deps(), env: { TENANT_PROVISIONING_TOKEN: 'short' } }),
    ).toThrow('at least');
    expect(() =>
      startTenantProvisioningServer({
        deps: deps(),
        env: { TENANT_PROVISIONING_TOKEN: TOKEN, TENANT_PROVISIONING_PORT: 'abc' },
      }),
    ).toThrow('port');
  });

  it('listens on the configured port and serves the health probe', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const started = startTenantProvisioningServer({
      deps: deps(),
      env: {
        TENANT_PROVISIONING_TOKEN: TOKEN,
        TENANT_PROVISIONING_PORT: String(freePort),
        TENANT_PROVISIONING_HOST: '127.0.0.1',
      },
    }) as Server;
    await new Promise<void>((resolve) => started.once('listening', () => resolve()));

    const response = await fetch(
      `http://127.0.0.1:${(started.address() as AddressInfo).port}/healthz`,
    );

    expect(response.status).toBe(200);
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });
});
