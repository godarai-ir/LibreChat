import type { NextFunction, Request, Response } from 'express';
import type { HostTenantRequest } from './host';
import { isHostTenancyEnabled } from './config';

export const ADMIN_PANEL_DISABLED = 'ADMIN_PANEL_DISABLED';

/**
 * Host mode: the admin API answers only on a tenant host whose admin panel origin is known
 * (`ADMIN_HOST_BASE_DOMAIN`). Without it there is no origin to send an admin back to or to bind
 * an exchange code to, so the admin API stays closed, as it was before per-tenant admin panels.
 */
export function requireTenantAdminOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!isHostTenancyEnabled() || (req as HostTenantRequest).tenantAdminOrigin) {
    next();
    return;
  }
  res.status(404).json({ message: 'Not found', code: ADMIN_PANEL_DISABLED });
}
