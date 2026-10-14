import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { HostTenancyConfig } from './config';
import type { TenantRegistry } from './registry';
import { buildTenantContext, runWithTenantContext } from '~/middleware/tenant';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildTenantOrigin } from './origin';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT_PATTERN = /^\d{1,5}$/;
const MAX_HOST_LENGTH = 255;
const IDN_PREFIX = 'xn--';

export type HostParse = { kind: 'slug'; slug: string; port?: string } | { kind: 'not-tenant' };

/**
 * Extracts the tenant slug from a `Host` header. Only the exact shape `<slug>.<baseDomain>`
 * (one DNS label, optional numeric port) is a tenant host; everything else is not, so a
 * crafted header can neither name another tenant nor escape into a different namespace.
 *
 * Rejected on purpose: a trailing dot (a second spelling of the same host), several labels,
 * IPv6 literals, userinfo, non-ASCII, and `xn--` labels (IDN look-alikes).
 */
export function parseTenantHost(hostHeader: unknown, baseDomain: string): HostParse {
  const notTenant: HostParse = { kind: 'not-tenant' };
  if (typeof hostHeader !== 'string' || !baseDomain) {
    return notTenant;
  }

  let host = hostHeader.trim().toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return notTenant;
  }

  let port: string | undefined;
  const portSeparator = host.lastIndexOf(':');
  if (portSeparator !== -1) {
    port = host.slice(portSeparator + 1);
    if (!PORT_PATTERN.test(port)) {
      return notTenant;
    }
    host = host.slice(0, portSeparator);
  }

  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) {
    return notTenant;
  }

  const slug = host.slice(0, host.length - suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.startsWith(IDN_PREFIX)) {
    return notTenant;
  }

  return { kind: 'slug', slug, ...(port && { port }) };
}

export interface HostTenantMiddlewareOptions {
  config: HostTenancyConfig;
  registry: TenantRegistry;
}

export type HostTenantRequest = Request & {
  tenantId?: string;
  tenantSlug?: string;
  /** Public origin of the tenant, for redirects, callbacks and links built during this request. */
  tenantOrigin?: string;
};

const DEFAULT_PORTS: Readonly<Record<string, string>> = { https: '443', http: '80' };

const deny = (res: Response, status: number, message: string, code?: string): void => {
  res.status(status).json({ message, ...(code && { code }) });
};

/**
 * Resolves the tenant from the request `Host` and runs everything downstream inside that
 * tenant's context. It reads the raw `Host` header, never `X-Forwarded-Host`/`req.hostname`
 * and never `X-Tenant-Id`, so the only input a client controls is the host it connected to.
 *
 * Mount it first: before static files, sessions and passport, so every route, stream and
 * asset runs with tenant context and an unknown host reaches nothing.
 */
export function createHostTenantMiddleware({
  config,
  registry,
}: HostTenantMiddlewareOptions): RequestHandler {
  async function handle(req: HostTenantRequest, res: Response, next: NextFunction): Promise<void> {
    /** Never trust a value set before this middleware ran. */
    delete req.tenantId;
    delete req.tenantSlug;
    delete req.tenantOrigin;

    const parsed = parseTenantHost(req.headers.host, config.baseDomain);
    if (parsed.kind !== 'slug' || config.reservedSlugs.has(parsed.slug)) {
      deny(res, 404, 'Not found');
      return;
    }

    let lookup;
    try {
      lookup = await registry.resolve(parsed.slug);
    } catch (error) {
      logger.error('[tenancy] Tenant registry lookup failed', getSafeErrorMetadata(error));
      deny(res, 503, 'Service temporarily unavailable', 'TENANT_REGISTRY_UNAVAILABLE');
      return;
    }

    switch (lookup.kind) {
      case 'active':
        break;
      case 'inactive':
        if (lookup.status === 'suspended') {
          deny(res, 403, 'This workspace is suspended', 'TENANT_SUSPENDED');
        } else {
          deny(res, 404, 'Not found');
        }
        return;
      case 'misconfigured':
        logger.error('[tenancy] Tenant is misconfigured', {
          tenantId: lookup.tenantId,
          reason: lookup.reason,
        });
        deny(res, 503, 'Service temporarily unavailable', 'TENANT_MISCONFIGURED');
        return;
      default:
        deny(res, 404, 'Not found');
        return;
    }

    const { tenantId, slug } = lookup.tenant;
    req.tenantId = tenantId;
    req.tenantSlug = slug;
    req.tenantOrigin = buildTenantOrigin({
      scheme: config.scheme,
      slug,
      baseDomain: config.baseDomain,
      port: parsed.port === DEFAULT_PORTS[config.scheme] ? undefined : parsed.port,
    });
    runWithTenantContext(buildTenantContext(req, tenantId), next);
  }

  return (req, res, next) => {
    handle(req as HostTenantRequest, res, next).catch((error: unknown) => {
      logger.error('[tenancy] Host tenant middleware failed', getSafeErrorMetadata(error));
      if (!res.headersSent) {
        deny(res, 500, 'Internal server error');
      }
    });
  };
}
