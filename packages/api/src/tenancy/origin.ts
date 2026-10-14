import { getTenantOrigin } from '@librechat/data-schemas';

/** The slice of the request the origin helpers read. `HostTenantRequest` satisfies it. */
export interface TenantOriginRequest {
  tenantOrigin?: string;
}

/** Any request-like object: the helpers read `tenantOrigin` from it when it is there. */
export type TenantOriginSource = object | null | undefined;

type Env = Readonly<Record<string, string | undefined>>;

export interface TenantOriginParts {
  scheme: string;
  slug: string;
  baseDomain: string;
  /** Only present when the client connected on an explicit port (local development). */
  port?: string;
}

/**
 * The public origin of a tenant, built from validated parts only: the slug has already been
 * checked against the registry, so no header-controlled text reaches the result.
 */
export function buildTenantOrigin({ scheme, slug, baseDomain, port }: TenantOriginParts): string {
  return `${scheme}://${slug}.${baseDomain}${port ? `:${port}` : ''}`;
}

const isHostMode = (env: Env): boolean => env.MULTI_TENANT_MODE?.trim().toLowerCase() === 'host';

/**
 * The tenant's own origin: from the request when there is one, otherwise (host mode only) from
 * the async tenant context, so code running inside a request without `req` (tools, OAuth
 * managers) still gets it. Single-tenant deployments never touch the async context here.
 */
function tenantOriginOf(req: TenantOriginSource, env: Env): string | undefined {
  const requestOrigin = (req as TenantOriginRequest | null | undefined)?.tenantOrigin;
  return requestOrigin ?? (isHostMode(env) ? getTenantOrigin() : undefined);
}

/**
 * Where the browser app lives for this request. In host mode that is the tenant's own origin; in
 * single-tenant mode it is `DOMAIN_CLIENT`, exactly as before.
 */
export function getClientOrigin(
  req?: TenantOriginSource,
  env: Env = process.env,
): string | undefined {
  return tenantOriginOf(req, env) ?? env.DOMAIN_CLIENT;
}

/** Where the API lives for this request: the tenant origin in host mode, else `DOMAIN_SERVER`. */
export function getServerOrigin(
  req?: TenantOriginSource,
  env: Env = process.env,
): string | undefined {
  return tenantOriginOf(req, env) ?? env.DOMAIN_SERVER;
}
