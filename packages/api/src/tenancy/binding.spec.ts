import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import {
  belongsToRequestTenant,
  createTenantBindingMiddleware,
  logTenantMismatch,
} from './binding';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe('belongsToRequestTenant', () => {
  it('passes everything when the request has no host tenant (single-tenant mode)', () => {
    expect(belongsToRequestTenant({}, { tenantId: 'tenant-a' })).toBe(true);
    expect(belongsToRequestTenant({}, {})).toBe(true);
    expect(belongsToRequestTenant({}, null)).toBe(true);
    expect(belongsToRequestTenant(undefined, undefined)).toBe(true);
    expect(belongsToRequestTenant({ tenantId: '' }, { tenantId: 'tenant-a' })).toBe(true);
  });

  it('accepts a user of the host tenant', () => {
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, { tenantId: 'tenant-a' })).toBe(true);
  });

  it('rejects a user of another tenant', () => {
    expect(belongsToRequestTenant({ tenantId: 'tenant-b' }, { tenantId: 'tenant-a' })).toBe(false);
  });

  it('rejects a user without a tenant instead of letting an unmigrated account in', () => {
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, {})).toBe(false);
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, { tenantId: null })).toBe(false);
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, { tenantId: '' })).toBe(false);
  });

  it('rejects a missing user', () => {
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, null)).toBe(false);
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, undefined)).toBe(false);
  });

  it('does not coerce a non-string tenant id into a match', () => {
    expect(belongsToRequestTenant({ tenantId: '1' }, { tenantId: 1 as unknown as string })).toBe(
      false,
    );
    expect(
      belongsToRequestTenant(
        { tenantId: 'tenant-a' },
        { tenantId: ['tenant-a'] as unknown as string },
      ),
    ).toBe(false);
  });

  it('is case sensitive: tenant ids are identities, not host names', () => {
    expect(belongsToRequestTenant({ tenantId: 'tenant-a' }, { tenantId: 'Tenant-A' })).toBe(false);
  });
});

describe('logTenantMismatch', () => {
  it('logs tenant ids and the source, and nothing about the user', () => {
    logTenantMismatch('jwt', { tenantId: 'tenant-b' }, {
      tenantId: 'tenant-a',
      email: 'a@x.com',
      password: 'p',
    } as never);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, context] = (logger.warn as jest.Mock).mock.calls[0];
    expect(context).toMatchObject({
      source: 'jwt',
      hostTenantId: 'tenant-b',
      userTenantId: 'tenant-a',
    });
    expect(JSON.stringify(context)).not.toContain('a@x.com');
    expect(JSON.stringify(context)).not.toContain('"p"');
  });
});

describe('createTenantBindingMiddleware', () => {
  const run = (req: Record<string, unknown>) => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    const next = jest.fn();
    createTenantBindingMiddleware()(
      req as unknown as Request,
      res as unknown as Response,
      next as NextFunction,
    );
    return { res, next };
  };

  beforeEach(() => jest.clearAllMocks());

  it('lets a user of the host tenant through', () => {
    const { next, res } = run({ tenantId: 'tenant-a', user: { tenantId: 'tenant-a' } });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('lets everyone through outside host mode', () => {
    const { next } = run({ user: { tenantId: 'tenant-a' } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('answers 403 with a stable code for a user of another tenant', () => {
    const { next, res } = run({ tenantId: 'tenant-b', user: { tenantId: 'tenant-a' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden', code: 'TENANT_MISMATCH' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not reveal which tenant the user belongs to', () => {
    const { res } = run({ tenantId: 'tenant-b', user: { tenantId: 'tenant-secret' } });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('tenant-secret');
  });

  it('rejects a request that was authenticated as nobody', () => {
    const { next, res } = run({ tenantId: 'tenant-a' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
