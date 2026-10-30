import type { NextFunction, Request, Response } from 'express';
import { ADMIN_PANEL_DISABLED, requireTenantAdminOrigin } from './admin';

const run = (req: Record<string, unknown>) => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  requireTenantAdminOrigin(
    req as unknown as Request,
    res as unknown as Response,
    next as unknown as NextFunction,
  );
  return { res, next };
};

describe('requireTenantAdminOrigin', () => {
  const original = process.env.MULTI_TENANT_MODE;
  afterEach(() => {
    process.env.MULTI_TENANT_MODE = original;
  });

  it('passes every request outside host mode', () => {
    delete process.env.MULTI_TENANT_MODE;
    expect(run({}).next).toHaveBeenCalledTimes(1);
  });

  it('passes a host-mode request whose tenant has an admin panel origin', () => {
    process.env.MULTI_TENANT_MODE = 'host';
    expect(run({ tenantAdminOrigin: 'https://acme.admin.example.com' }).next).toHaveBeenCalled();
  });

  it('answers 404 in host mode when the tenant has no admin panel origin', () => {
    process.env.MULTI_TENANT_MODE = 'host';
    const { res, next } = run({ tenantId: 'tenant-acme' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not found', code: ADMIN_PANEL_DISABLED });
  });
});
