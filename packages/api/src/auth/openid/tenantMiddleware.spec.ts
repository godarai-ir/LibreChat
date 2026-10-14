import type { NextFunction, Request, Response } from 'express';
import type { TenantLookup } from '~/tenancy/registry';
import { createTenantOpenIdMiddleware } from './tenantMiddleware';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const tenant = {
  tenantId: 'tenant-acme',
  slug: 'acme',
  oidc: { issuer: 'https://acme.example.com', clientId: 'c', clientSecret: 's', scopes: [] },
};

const setup = (lookup: TenantLookup = { kind: 'active', tenant }) => {
  const registry = { resolve: jest.fn(async () => lookup) };
  const ensure = jest.fn(async () => undefined);
  const onFailure = jest.fn();
  const res = { headersSent: false, status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  const next = jest.fn();
  const run = async (
    options: { blocking: boolean },
    req: Record<string, unknown> = { tenantSlug: 'acme' },
    withFailure = false,
  ) => {
    const middleware = createTenantOpenIdMiddleware(
      { registry, ensure, ...(withFailure && { onFailure }) },
      options,
    );
    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { registry, ensure, onFailure, res, next, run };
};

describe('blocking', () => {
  it('prepares the tenant before letting the request through', async () => {
    const { ensure, next, run, registry } = setup();
    await run({ blocking: true });

    expect(registry.resolve).toHaveBeenCalledWith('acme');
    expect(ensure).toHaveBeenCalledWith(tenant);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not continue until the preparation finished', async () => {
    const { ensure, next, run } = setup();
    let release: () => void = () => undefined;
    ensure.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    await run({ blocking: true });
    expect(next).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('answers 503 with a stable code when the provider cannot be reached', async () => {
    const { ensure, next, res, run } = setup();
    ensure.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:443'));

    await run({ blocking: true });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OPENID_UNAVAILABLE' }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('ECONNREFUSED');
  });

  it('lets the caller shape the failure response', async () => {
    const { ensure, next, res, onFailure, run } = setup();
    ensure.mockRejectedValueOnce(new Error('down'));

    await run({ blocking: true }, { tenantSlug: 'acme' }, true);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('does nothing for a request without a host tenant', async () => {
    const { ensure, next, run, registry } = setup();
    await run({ blocking: true }, {});

    expect(registry.resolve).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'unknown' },
    { kind: 'inactive', tenantId: 't', slug: 'acme', status: 'suspended' },
    { kind: 'misconfigured', tenantId: 't', slug: 'acme', reason: 'SECRET_UNREADABLE' },
  ] as TenantLookup[])('does not prepare a tenant that is %p', async (lookup) => {
    const { ensure, next, run } = setup(lookup);
    await run({ blocking: true });

    expect(ensure).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('background', () => {
  it('continues at once and prepares the tenant without waiting', async () => {
    const { ensure, next, run } = setup();
    ensure.mockImplementationOnce(() => new Promise<undefined>(() => undefined));

    await run({ blocking: false });

    expect(next).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(tenant);
  });

  it('swallows a failure so an identity-provider outage cannot break the page', async () => {
    const { ensure, next, res, run } = setup();
    ensure.mockRejectedValueOnce(new Error('idp down'));

    await run({ blocking: false });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('swallows a registry failure too', async () => {
    const { registry, next, run } = setup();
    registry.resolve.mockRejectedValueOnce(new Error('mongo down'));

    await run({ blocking: false });

    expect(next).toHaveBeenCalledTimes(1);
  });
});
