import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ResolvedTenant, TenantRegistry } from '~/tenancy/registry';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface TenantOpenIdMiddlewareDeps {
  registry: Pick<TenantRegistry, 'resolve'>;
  /** Builds (or refreshes) the tenant's OpenID client and strategy. */
  ensure(tenant: ResolvedTenant): Promise<void>;
  /** Answers a request whose tenant's provider cannot be reached. Defaults to a 503 JSON body. */
  onFailure?(req: Request, res: Response): void;
}

const defaultFailure = (_req: Request, res: Response): void => {
  res
    .status(503)
    .json({ message: 'Sign-in is temporarily unavailable', code: 'OPENID_UNAVAILABLE' });
};

/**
 * Prepares the host tenant's OpenID client before a route that needs it. It reads the tenant
 * from the host middleware (`req.tenantSlug`) and the settings from the registry, so the client
 * secret never travels on the request.
 *
 * - `blocking: true`: the request waits and is answered with `onFailure` if the provider cannot
 *   be reached. Use it on the sign-in and token routes.
 * - `blocking: false`: the work starts in the background and the request continues at once, so an
 *   identity-provider outage cannot take down pages and assets. Later calls find it ready.
 */
export function createTenantOpenIdMiddleware(
  deps: TenantOpenIdMiddlewareDeps,
  { blocking }: { blocking: boolean },
): RequestHandler {
  const onFailure = deps.onFailure ?? defaultFailure;

  const prepare = async (req: Request): Promise<void> => {
    const slug = (req as Request & { tenantSlug?: string }).tenantSlug;
    if (!slug) {
      return;
    }
    const lookup = await deps.registry.resolve(slug);
    if (lookup.kind === 'active') {
      await deps.ensure(lookup.tenant);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!blocking) {
      prepare(req).catch((error: unknown) => {
        logger.warn('[tenancy] Background OpenID preparation failed', getSafeErrorMetadata(error));
      });
      next();
      return;
    }

    prepare(req).then(
      () => next(),
      (error: unknown) => {
        logger.error(
          '[tenancy] OpenID is not available for the tenant',
          getSafeErrorMetadata(error),
        );
        if (!res.headersSent) {
          onFailure(req, res);
        }
      },
    );
  };
}
