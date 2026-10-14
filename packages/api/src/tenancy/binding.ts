import { getRequestId, logger } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** The tenant the host middleware resolved for the request. Absent outside host mode. */
export interface TenantBoundRequest {
  tenantId?: string;
}

export interface TenantBoundUser {
  tenantId?: string | null;
}

/**
 * Whether an authenticated user may act on this request's host.
 *
 * Outside host mode there is no host tenant, so everything passes and behavior is unchanged. In
 * host mode the user must belong to the host's tenant; a user without a tenant (created before
 * multi-tenancy) never matches, so an unmigrated account fails closed instead of being let in.
 *
 * Several authentication paths load the user across tenants first (`runAsSystem`) and only then
 * learn which tenant it is in. Without this check a token minted for tenant A and presented on
 * tenant B's host would run as A's user inside B's tenant context.
 */
export function belongsToRequestTenant(
  req: TenantBoundRequest | null | undefined,
  user: TenantBoundUser | null | undefined,
): boolean {
  const hostTenantId = req?.tenantId;
  if (!hostTenantId) {
    return true;
  }
  return user != null && typeof user.tenantId === 'string' && user.tenantId === hostTenantId;
}

/** Records a mismatch with tenant ids and the request id only: never a token, email or name. */
export function logTenantMismatch(
  source: string,
  req: TenantBoundRequest | null | undefined,
  user: TenantBoundUser | null | undefined,
): void {
  logger.warn('[tenancy] Authenticated user does not belong to the host tenant', {
    source,
    hostTenantId: req?.tenantId,
    userTenantId: user?.tenantId ?? null,
    requestId: getRequestId(),
  });
}

/**
 * Backstop for any authentication strategy: after `req.user` is set, reject a user from another
 * tenant. The answer is the same for every mismatch so it does not reveal which tenant exists.
 */
export function createTenantBindingMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const request = req as Request & TenantBoundRequest;
    if (belongsToRequestTenant(request, req.user as TenantBoundUser | undefined)) {
      next();
      return;
    }
    logTenantMismatch('middleware', request, req.user as TenantBoundUser | undefined);
    res.status(403).json({ message: 'Forbidden', code: 'TENANT_MISMATCH' });
  };
}
