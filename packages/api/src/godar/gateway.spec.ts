import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { ErrorTypes } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { GodarGatewayDeps } from './gateway';
import { createGodarGateway } from './gateway';

type GatewayCall = { path?: string; method?: string; authorization?: string; body: string };

const USER = { id: 'lc-1', openidId: 'idp-sub-1', tenantId: 'tenant-a', provider: 'openid' };

/** The key store's own absence error, thrown from its async lookup. */
async function noKey(): Promise<never> {
  throw new Error(JSON.stringify({ type: ErrorTypes.NO_USER_KEY }));
}

describe('createGodarGateway', () => {
  const calls: GatewayCall[] = [];
  let server: http.Server;
  let baseURL: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        calls.push({
          path: req.url,
          method: req.method,
          authorization: req.headers.authorization,
          body,
        });
        res.setHeader('content-type', 'application/json');
        if (!req.headers.authorization) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ seat: { type: 'pro' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    calls.length = 0;
    delete process.env.USER_ASSERTION_PRIVATE_KEY;
    delete process.env.USER_ASSERTION_AUDIENCE;
  });

  function setup(
    endpoint: Record<string, unknown> | null,
    overrides: Partial<GodarGatewayDeps> = {},
  ) {
    const appConfig = {
      endpoints: { custom: endpoint ? [{ name: 'Godar', baseURL, ...endpoint }] : [] },
    } as unknown as AppConfig;
    const deps: GodarGatewayDeps = {
      getAppConfig: jest.fn(async () => appConfig),
      getUserKeyValues: jest.fn(async () => ({ apiKey: 'pat-member-1' })),
      getUserKeyExpiry: jest.fn(async () => ({ expiresAt: 'never' as const })),
      now: () => Date.parse('2026-10-21T00:00:00Z'),
      ...overrides,
    };
    return { deps, call: createGodarGateway(deps) };
  }

  it('authenticates with the saved key when the endpoint takes a user-provided key', async () => {
    const { deps, call } = setup({ apiKey: 'user_provided' });

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: true, status: 200, body: { seat: { type: 'pro' } } });
    expect(calls).toEqual([
      expect.objectContaining({ path: '/v1/budget/me', authorization: 'Bearer pat-member-1' }),
    ]);
    expect(deps.getUserKeyValues).toHaveBeenCalledWith({ userId: 'lc-1', name: 'Godar' });
  });

  it('prefers the signed assertion and never reads the saved key', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.USER_ASSERTION_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.USER_ASSERTION_AUDIENCE = 'godar-gateway';
    const { deps, call } = setup({
      apiKey: 'user_provided',
      headers: { Authorization: 'Bearer {{LIBRECHAT_USER_ASSERTION}}' },
    });

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result.ok).toBe(true);
    expect(calls[0].authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[0].authorization).not.toContain('pat-member-1');
    expect(deps.getUserKeyValues).not.toHaveBeenCalled();
  });

  it('falls back to the saved key when the assertion cannot be signed', async () => {
    const { call } = setup({
      apiKey: 'user_provided',
      headers: { Authorization: 'Bearer {{LIBRECHAT_USER_ASSERTION}}' },
    });

    await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(calls[0].authorization).toBe('Bearer pat-member-1');
  });

  it('refuses without calling the gateway when the member saved no key', async () => {
    const { call } = setup({ apiKey: 'user_provided' }, { getUserKeyValues: jest.fn(noKey) });

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: false, error: { code: 'godar_auth_unavailable' } });
    expect(calls).toHaveLength(0);
  });

  it('does not use a saved key that has expired', async () => {
    const { call } = setup(
      { apiKey: 'user_provided' },
      { getUserKeyExpiry: jest.fn(async () => ({ expiresAt: new Date('2026-10-20T00:00:00Z') })) },
    );

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: false, error: { code: 'godar_auth_unavailable' } });
    expect(calls).toHaveLength(0);
  });

  it('never sends a static endpoint key as the member', async () => {
    process.env.GODAR_SPEC_KEY = 'tenant-wide-key';
    const { deps, call } = setup({ apiKey: '${GODAR_SPEC_KEY}' });

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: false, error: { code: 'godar_auth_unavailable' } });
    expect(deps.getUserKeyValues).not.toHaveBeenCalled();
    delete process.env.GODAR_SPEC_KEY;
  });

  it('lets a key-store outage reach the caller instead of reporting no key', async () => {
    const outage = new Error('connection refused');
    const { call } = setup(
      { apiKey: 'user_provided' },
      { getUserKeyValues: jest.fn(async () => Promise.reject(outage)) },
    );

    await expect(call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' })).rejects.toBe(
      outage,
    );
    expect(calls).toHaveLength(0);
  });

  it('reports a tenant without a Godar endpoint as not configured', async () => {
    const { call } = setup(null);

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: false, error: { code: 'godar_not_configured' } });
  });

  it('reports an unreachable gateway without exposing the error', async () => {
    const { call } = setup(
      { apiKey: 'user_provided' },
      { fetch: jest.fn(async () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1'))) },
    );

    const result = await call({ user: USER, tenantId: 'tenant-a', path: '/budget/me' });

    expect(result).toEqual({ ok: false, error: { code: 'godar_gateway_unavailable' } });
  });

  it('sends a JSON body on POST', async () => {
    const { call } = setup({ apiKey: 'user_provided' });

    await call({
      user: USER,
      tenantId: 'tenant-a',
      path: '/seat-requests',
      method: 'POST',
      body: { seat: 'max' },
    });

    expect(calls[0]).toMatchObject({ method: 'POST', body: '{"seat":"max"}' });
  });
});
