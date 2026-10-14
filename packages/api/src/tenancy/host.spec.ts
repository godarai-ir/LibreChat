import { getTenantId, getRequestId } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { TenantLookup, TenantRegistry } from './registry';
import type { HostTenancyConfig } from './config';
import { createHostTenantMiddleware, parseTenantHost } from './host';
import { preAuthTenantMiddleware } from '~/middleware/preAuthTenant';
import { createHostTenancyRuntime } from './runtime';
import { resolveHostTenancyConfig } from './config';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const BASE = 'chat.example.com';

describe('parseTenantHost', () => {
  it.each([
    ['acme.chat.example.com', 'acme'],
    ['ACME.Chat.Example.COM', 'acme'],
    ['  acme.chat.example.com  ', 'acme'],
    ['a.chat.example.com', 'a'],
    ['my-company-2.chat.example.com', 'my-company-2'],
    [`${'a'.repeat(63)}.chat.example.com`, 'a'.repeat(63)],
  ])('maps %p to the slug %p', (host, slug) => {
    expect(parseTenantHost(host, BASE)).toEqual({ kind: 'slug', slug });
  });

  it('reports an explicit port separately from the slug', () => {
    expect(parseTenantHost('acme.chat.example.com:3080', BASE)).toEqual({
      kind: 'slug',
      slug: 'acme',
      port: '3080',
    });
  });

  it.each([
    undefined,
    null,
    42,
    ['acme.chat.example.com'],
    {},
    '',
    '   ',
    'chat.example.com',
    '.chat.example.com',
    'acme.chat.example.com.',
    'a.b.chat.example.com',
    'acme.chat.example.com.evil.com',
    'evilchat.example.com',
    'acme.example.com',
    'acme.chat.example.org',
    'localhost',
    '127.0.0.1',
    '[::1]:3080',
    'acme.chat.example.com:',
    'acme.chat.example.com:80:80',
    'acme.chat.example.com:abc',
    'acme.chat.example.com:1234567',
    'user@acme.chat.example.com',
    'acme.chat.example.com/x',
    'acme chat.example.com',
    '-acme.chat.example.com',
    'acme-.chat.example.com',
    'ac_me.chat.example.com',
    'xn--acme-9qa.chat.example.com',
    'ünï.chat.example.com',
    `${'a'.repeat(64)}.chat.example.com`,
    `${'a'.repeat(300)}.chat.example.com`,
  ])('rejects %p', (host) => {
    expect(parseTenantHost(host, BASE)).toEqual({ kind: 'not-tenant' });
  });

  it('never matches without a base domain', () => {
    expect(parseTenantHost('acme.chat.example.com', '')).toEqual({ kind: 'not-tenant' });
  });
});

const config: HostTenancyConfig = resolveHostTenancyConfig({
  MULTI_TENANT_MODE: 'host',
  TENANT_HOST_BASE_DOMAIN: BASE,
});

const active = (tenantId: string, slug: string): TenantLookup => ({
  kind: 'active',
  tenant: {
    tenantId,
    slug,
    oidc: { issuer: `https://${slug}.example.com`, clientId: 'c', clientSecret: 's', scopes: [] },
  },
});

const makeRegistry = (lookups: Record<string, TenantLookup | Error>) => {
  const resolve = jest.fn(async (slug: string) => {
    const found = lookups[slug] ?? { kind: 'unknown' as const };
    if (found instanceof Error) {
      throw found;
    }
    return found;
  });
  const registry: TenantRegistry = { resolve, invalidate: jest.fn() };
  return { registry, resolve };
};

const makeRes = () => {
  const res = {
    headersSent: false,
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const call = async (
  middleware: ReturnType<typeof createHostTenantMiddleware>,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {},
) => {
  const req = { headers, ...extra } as unknown as Request & {
    tenantId?: string;
    tenantSlug?: string;
  };
  const res = makeRes();
  let seen: { tenantId?: string; afterAwait?: string } | undefined;
  const next = jest.fn(() => {
    seen = { tenantId: getTenantId() };
    return Promise.resolve().then(() => {
      if (seen) {
        seen.afterAwait = getTenantId();
      }
    });
  });
  middleware(req, res as unknown as Response, next as unknown as NextFunction);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  return { req, res, next, seen: () => seen };
};

describe('createHostTenantMiddleware', () => {
  it('runs the rest of the request inside the tenant context', async () => {
    const { registry } = makeRegistry({ acme: active('tenant-acme', 'acme') });
    const mw = createHostTenantMiddleware({ config, registry });

    const { req, next, seen, res } = await call(mw, { host: 'acme.chat.example.com' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-acme');
    expect(req.tenantSlug).toBe('acme');
    expect(seen()).toEqual({ tenantId: 'tenant-acme', afterAwait: 'tenant-acme' });
  });

  it('sets the tenant origin from validated parts, not from headers', async () => {
    const { registry } = makeRegistry({ acme: active('tenant-acme', 'acme') });
    const mw = createHostTenantMiddleware({ config, registry });

    const { req } = await call(
      mw,
      { host: 'ACME.chat.example.com', 'x-forwarded-host': 'evil.example.org' },
      { tenantOrigin: 'https://evil.example.org' },
    );

    expect((req as { tenantOrigin?: string }).tenantOrigin).toBe('https://acme.chat.example.com');
  });

  it('keeps a non-default port and drops the default one', async () => {
    const { registry } = makeRegistry({ acme: active('tenant-acme', 'acme') });
    const mw = createHostTenantMiddleware({ config, registry });

    const custom = await call(mw, { host: 'acme.chat.example.com:8443' });
    const standard = await call(mw, { host: 'acme.chat.example.com:443' });

    expect((custom.req as { tenantOrigin?: string }).tenantOrigin).toBe(
      'https://acme.chat.example.com:8443',
    );
    expect((standard.req as { tenantOrigin?: string }).tenantOrigin).toBe(
      'https://acme.chat.example.com',
    );
  });

  it('clears a pre-set tenant origin when the host is not a tenant host', async () => {
    const { registry } = makeRegistry({});
    const mw = createHostTenantMiddleware({ config, registry });

    const { req } = await call(
      mw,
      { host: 'example.org' },
      { tenantOrigin: 'https://evil.example.org' },
    );

    expect((req as { tenantOrigin?: string }).tenantOrigin).toBeUndefined();
  });

  it('keeps the request id in the context', async () => {
    const { registry } = makeRegistry({ acme: active('tenant-acme', 'acme') });
    const mw = createHostTenantMiddleware({ config, registry });
    let requestId: string | undefined;
    const req = {
      headers: { host: 'acme.chat.example.com' },
      requestId: 'req-1',
      method: 'GET',
    };
    const next = jest.fn(() => {
      requestId = getRequestId();
    });
    mw(req as unknown as Request, makeRes() as unknown as Response, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalled();
    expect(requestId).toBe('req-1');
  });

  it('ignores X-Tenant-Id, X-Forwarded-Host and a pre-set req.tenantId', async () => {
    const { registry, resolve } = makeRegistry({
      acme: active('tenant-acme', 'acme'),
      evil: active('tenant-evil', 'evil'),
    });
    const mw = createHostTenantMiddleware({ config, registry });

    const { req, seen } = await call(
      mw,
      {
        host: 'acme.chat.example.com',
        'x-tenant-id': 'tenant-evil',
        'x-forwarded-host': 'evil.chat.example.com',
      },
      { tenantId: 'tenant-evil', tenantSlug: 'evil' },
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('acme');
    expect(req.tenantId).toBe('tenant-acme');
    expect(seen()?.tenantId).toBe('tenant-acme');
  });

  it('clears a pre-set req.tenantId when the host is not a tenant host', async () => {
    const { registry } = makeRegistry({});
    const mw = createHostTenantMiddleware({ config, registry });

    const { req, next, res } = await call(mw, { host: 'example.org' }, { tenantId: 'tenant-evil' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(req.tenantId).toBeUndefined();
  });

  it('answers 404 without a registry lookup for non-tenant and reserved hosts', async () => {
    const { registry, resolve } = makeRegistry({ auth: active('t-auth', 'auth') });
    const mw = createHostTenantMiddleware({ config, registry });

    for (const host of [
      'example.org',
      'chat.example.com',
      'auth.chat.example.com',
      'chat.chat.example.com',
      '',
    ]) {
      const { res, next } = await call(mw, { host });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown tenant and never echoes the host', async () => {
    const { registry } = makeRegistry({});
    const mw = createHostTenantMiddleware({ config, registry });

    const { res, next } = await call(mw, { host: 'ghost.chat.example.com' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('ghost');
  });

  it('answers 403 TENANT_SUSPENDED for a suspended tenant', async () => {
    const { registry } = makeRegistry({
      acme: { kind: 'inactive', tenantId: 't', slug: 'acme', status: 'suspended' },
    });
    const mw = createHostTenantMiddleware({ config, registry });

    const { res, next } = await call(mw, { host: 'acme.chat.example.com' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_SUSPENDED' }));
  });

  it('answers 404 for a tenant being deleted', async () => {
    const { registry } = makeRegistry({
      acme: { kind: 'inactive', tenantId: 't', slug: 'acme', status: 'deleting' },
    });
    const mw = createHostTenantMiddleware({ config, registry });

    const { res } = await call(mw, { host: 'acme.chat.example.com' });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('answers 503 for a misconfigured tenant without leaking the reason', async () => {
    const { registry } = makeRegistry({
      acme: { kind: 'misconfigured', tenantId: 't', slug: 'acme', reason: 'SECRET_UNREADABLE' },
    });
    const mw = createHostTenantMiddleware({ config, registry });

    const { res, next } = await call(mw, { host: 'acme.chat.example.com' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('SECRET_UNREADABLE');
  });

  it('answers 503, not 404, when the registry fails, and hides the error', async () => {
    const { registry } = makeRegistry({ acme: new Error('mongodb://user:pw@db/secret failed') });
    const mw = createHostTenantMiddleware({ config, registry });

    const { res, next } = await call(mw, { host: 'acme.chat.example.com' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('mongodb');
  });

  it('keeps concurrent requests for different tenants in their own contexts', async () => {
    const { registry } = makeRegistry({
      a: active('tenant-a', 'a'),
      b: active('tenant-b', 'b'),
    });
    const mw = createHostTenantMiddleware({ config, registry });
    const observed: Record<string, string[]> = { a: [], b: [] };

    const run = (slug: 'a' | 'b') =>
      new Promise<void>((done) => {
        const req = { headers: { host: `${slug}.chat.example.com` } };
        mw(
          req as unknown as Request,
          makeRes() as unknown as Response,
          (() => {
            observed[slug].push(getTenantId() as string);
            setTimeout(
              () => {
                observed[slug].push(getTenantId() as string);
                done();
              },
              slug === 'a' ? 15 : 1,
            );
          }) as NextFunction,
        );
      });

    await Promise.all([run('a'), run('b'), run('a'), run('b')]);

    expect(observed.a).toEqual(['tenant-a', 'tenant-a', 'tenant-a', 'tenant-a']);
    expect(observed.b).toEqual(['tenant-b', 'tenant-b', 'tenant-b', 'tenant-b']);
  });
});

describe('preAuthTenantMiddleware in host mode', () => {
  const original = process.env.TRUST_TENANT_HEADER;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRUST_TENANT_HEADER;
    } else {
      process.env.TRUST_TENANT_HEADER = original;
    }
  });

  it('keeps the host tenant and ignores X-Tenant-Id even if the header is trusted', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    const { registry } = makeRegistry({ acme: active('tenant-acme', 'acme') });
    const mw = createHostTenantMiddleware({ config, registry });
    let seen: string | undefined;

    const req = {
      headers: { host: 'acme.chat.example.com', 'x-tenant-id': 'tenant-evil' },
    } as unknown as Request;
    mw(req, makeRes() as unknown as Response, () => {
      preAuthTenantMiddleware(req, makeRes() as unknown as Response, () => {
        seen = getTenantId();
      });
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toBe('tenant-acme');
  });

  it('still honors the trusted header when no host tenant was resolved', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    let seen: string | undefined;
    const req = { headers: { 'x-tenant-id': 'tenant-from-proxy' } } as unknown as Request;

    preAuthTenantMiddleware(req, makeRes() as unknown as Response, () => {
      seen = getTenantId();
    });

    expect(seen).toBe('tenant-from-proxy');
  });
});

describe('createHostTenancyRuntime', () => {
  const deps = {
    findBySlug: jest.fn(async () => null),
    decryptSecret: (value: string) => value,
  };

  it('is null when the mode is off', () => {
    const off = resolveHostTenancyConfig({});
    expect(createHostTenancyRuntime({ config: off, ...deps })).toBeNull();
  });

  it('wires the registry and middleware to the supplied lookups', async () => {
    deps.findBySlug.mockClear();
    const runtime = createHostTenancyRuntime({ config, ...deps });
    expect(runtime).not.toBeNull();

    const res = makeRes();
    runtime?.middleware(
      { headers: { host: 'ghost.chat.example.com' } } as unknown as Request,
      res as unknown as Response,
      jest.fn(),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.findBySlug).toHaveBeenCalledWith('ghost');
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
