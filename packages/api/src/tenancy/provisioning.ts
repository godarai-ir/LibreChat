import { createServer } from 'node:http';
import { logger } from '@librechat/data-schemas';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { SLUG_PATTERN, TENANT_ID_PATTERN } from './validation';
import { getSafeErrorMetadata } from '~/utils/errors';
import { reservedSlugsFromEnv } from './config';

/** A shared secret shorter than this is refused at startup. */
export const MIN_PROVISIONING_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16 * 1024;
const TENANT_PATH = /^\/tenants\/([^/]+)$/;

type Status = 'active' | 'suspended' | 'deleting';

interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  status: Status;
  oidc: { issuer?: string; clientId: string; clientSecret: string; scopes?: string[] };
}

type MethodResult =
  | { ok: true; value: ProvisionedTenant }
  | { ok: false; error: { code: string; message?: string } };

export interface TenantProvisioningDeps {
  methods: {
    getTenantById(tenantId: string): Promise<ProvisionedTenant | null>;
    createTenant(input: {
      tenantId: string;
      slug: string;
      oidc: ProvisionedTenant['oidc'];
    }): Promise<MethodResult>;
    updateTenant(
      tenantId: string,
      update: { slug?: string; status?: Status; oidc?: Partial<ProvisionedTenant['oidc']> },
    ): Promise<MethodResult>;
  };
  /** Encrypts a client secret for storage (`encryptV3`). */
  encryptSecret(plain: string): string;
  /** Drops what this process cached about tenants, so a change applies at once here. */
  invalidate(tenantId: string): void;
  /** Resolves the tenant fresh and tries OpenID discovery, so the caller learns if sign-in works. */
  checkReady(slug: string): Promise<{ ready: boolean; reason?: string }>;
  /**
   * Prepares what a new tenant needs beyond its record, such as syncing its roles with
   * `librechat.yaml`. A failure is logged, not returned: the tenant already exists.
   */
  onTenantCreated?(tenantId: string): Promise<void>;
  /** The shared secret callers present as a bearer token. */
  token: string;
  env: Readonly<Record<string, string | undefined>>;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time comparison; hashing first makes the lengths equal. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) {
    return false;
  }
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const [scheme, value, ...extra] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value && extra.length === 0 ? value : undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'BODY_TOO_LARGE');
    }
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', 'The body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** Only the fields a tenant may expose: the stored secret never leaves the process. */
const publicView = (tenant: ProvisionedTenant) => ({
  tenantId: tenant.tenantId,
  slug: tenant.slug,
  status: tenant.status,
  oidc: {
    clientId: tenant.oidc.clientId,
    ...(tenant.oidc.scopes && { scopes: tenant.oidc.scopes }),
  },
});

function parseSlug(value: unknown, env: TenantProvisioningDeps['env']): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SLUG_PATTERN.test(slug)) {
    throw new HttpError(400, 'INVALID_SLUG', 'slug must be a lowercase DNS label');
  }
  if (reservedSlugsFromEnv(env).has(slug)) {
    throw new HttpError(400, 'RESERVED_SLUG', `slug "${slug}" is reserved`);
  }
  return slug;
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((scope) => nonEmptyString(scope, 128))) {
    throw new HttpError(400, 'INVALID_SCOPES', 'scopes must be a list of strings');
  }
  return value as string[];
}

/** Reads the writable OIDC fields of a request body; unknown fields are rejected, not ignored. */
function parseOidc(raw: unknown, requireSecret: boolean) {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, 'INVALID_OIDC', 'oidc must be an object');
  }
  const unknown = Object.keys(raw).filter(
    (key) => !['clientId', 'clientSecret', 'scopes'].includes(key),
  );
  if (unknown.length > 0) {
    throw new HttpError(400, 'INVALID_OIDC', `Unsupported oidc field: ${unknown[0].slice(0, 40)}`);
  }
  const oidc: { clientId?: string; clientSecret?: string; scopes?: string[] } = {};
  if (raw.clientId !== undefined) {
    if (!nonEmptyString(raw.clientId)) {
      throw new HttpError(400, 'INVALID_OIDC', 'oidc.clientId must be a non-empty string');
    }
    oidc.clientId = raw.clientId;
  }
  if (raw.clientSecret !== undefined) {
    if (!nonEmptyString(raw.clientSecret, 4096)) {
      throw new HttpError(400, 'INVALID_OIDC', 'oidc.clientSecret must be a non-empty string');
    }
    oidc.clientSecret = raw.clientSecret;
  }
  if (raw.scopes !== undefined) {
    oidc.scopes = parseScopes(raw.scopes);
  }
  if (requireSecret && (!oidc.clientId || !oidc.clientSecret)) {
    throw new HttpError(400, 'INVALID_OIDC', 'oidc.clientId and oidc.clientSecret are required');
  }
  return oidc;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'INVALID_BODY', `Unsupported field: ${unknown[0].slice(0, 40)}`);
  }
}

function failureToHttp(result: Extract<MethodResult, { ok: false }>): HttpError {
  switch (result.error.code) {
    case 'DUPLICATE_SLUG':
      return new HttpError(409, 'SLUG_TAKEN', 'That slug belongs to another tenant');
    case 'DUPLICATE_TENANT_ID':
      return new HttpError(409, 'TENANT_EXISTS');
    case 'NOT_FOUND':
      return new HttpError(404, 'NOT_FOUND');
    default:
      return new HttpError(500, 'INTERNAL');
  }
}

/**
 * The request handler of the internal tenant provisioning API. It is idempotent so the control
 * plane can retry any call:
 *
 *   PUT    /tenants/:tenantId  create the tenant, or bring an existing one to the described state
 *   GET    /tenants/:tenantId  read it (the client secret is never returned)
 *   PATCH  /tenants/:tenantId  change slug, status or OIDC settings
 *   DELETE /tenants/:tenantId  mark it `deleting` (sign-in stops; data is not purged here)
 *
 * It is meant for a private port that no ingress exposes; the bearer token is a second lock.
 */
export function createTenantProvisioningHandler(
  deps: TenantProvisioningDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { methods } = deps;

  const respondWithState = async (
    res: ServerResponse,
    status: number,
    tenant: ProvisionedTenant,
  ): Promise<void> => {
    deps.invalidate(tenant.tenantId);
    const readiness = await deps.checkReady(tenant.slug).catch(() => ({
      ready: false,
      reason: 'CHECK_FAILED',
    }));
    send(res, status, { ...publicView(tenant), ...readiness });
  };

  const put = async (req: IncomingMessage, res: ServerResponse, tenantId: string) => {
    const body = await readJson(req);
    rejectUnknownKeys(body, ['slug', 'oidc']);
    const slug = parseSlug(body.slug, deps.env);
    const existing = await methods.getTenantById(tenantId);

    if (!existing) {
      const oidc = parseOidc(body.oidc, true);
      const created = await methods.createTenant({
        tenantId,
        slug,
        oidc: {
          clientId: oidc.clientId as string,
          clientSecret: deps.encryptSecret(oidc.clientSecret as string),
          ...(oidc.scopes && { scopes: oidc.scopes }),
        },
      });
      if (!created.ok) {
        throw failureToHttp(created);
      }
      await deps.onTenantCreated?.(tenantId).catch((error: unknown) => {
        logger.error(
          `[provisioning] could not prepare new tenant '${tenantId}'`,
          getSafeErrorMetadata(error),
        );
      });
      return respondWithState(res, 201, created.value);
    }

    const oidc = body.oidc === undefined ? {} : parseOidc(body.oidc, false);
    const { clientSecret, ...rest } = oidc;
    const updated = await methods.updateTenant(tenantId, {
      slug,
      oidc: {
        ...rest,
        ...(clientSecret !== undefined && { clientSecret: deps.encryptSecret(clientSecret) }),
      },
    });
    if (!updated.ok) {
      throw failureToHttp(updated);
    }
    return respondWithState(res, 200, updated.value);
  };

  const patch = async (req: IncomingMessage, res: ServerResponse, tenantId: string) => {
    const body = await readJson(req);
    rejectUnknownKeys(body, ['slug', 'status', 'oidc']);
    const update: Parameters<TenantProvisioningDeps['methods']['updateTenant']>[1] = {};
    if (body.slug !== undefined) {
      update.slug = parseSlug(body.slug, deps.env);
    }
    if (body.status !== undefined) {
      if (!['active', 'suspended', 'deleting'].includes(body.status as string)) {
        throw new HttpError(400, 'INVALID_STATUS');
      }
      update.status = body.status as Status;
    }
    if (body.oidc !== undefined) {
      const { clientSecret, ...rest } = parseOidc(body.oidc, false);
      update.oidc = {
        ...rest,
        ...(clientSecret !== undefined && { clientSecret: deps.encryptSecret(clientSecret) }),
      };
    }
    if (Object.keys(update).length === 0) {
      throw new HttpError(400, 'INVALID_BODY', 'Nothing to change');
    }
    const updated = await methods.updateTenant(tenantId, update);
    if (!updated.ok) {
      throw failureToHttp(updated);
    }
    return respondWithState(res, 200, updated.value);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];

    if (path === '/healthz' && req.method === 'GET') {
      return send(res, 200, { status: 'ok' });
    }

    const match = TENANT_PATH.exec(path);
    if (!match) {
      throw new HttpError(404, 'NOT_FOUND');
    }
    if (!tokenMatches(bearerToken(req), deps.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'UNAUTHORIZED');
    }

    let tenantId: string;
    try {
      tenantId = decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(400, 'INVALID_TENANT_ID');
    }
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new HttpError(400, 'INVALID_TENANT_ID');
    }

    switch (req.method) {
      case 'PUT':
        return put(req, res, tenantId);
      case 'PATCH':
        return patch(req, res, tenantId);
      case 'GET': {
        const tenant = await methods.getTenantById(tenantId);
        if (!tenant) {
          throw new HttpError(404, 'NOT_FOUND');
        }
        return respondWithState(res, 200, tenant);
      }
      case 'DELETE': {
        const result = await methods.updateTenant(tenantId, { status: 'deleting' });
        if (!result.ok) {
          throw failureToHttp(result);
        }
        return respondWithState(res, 200, result.value);
      }
      default:
        res.setHeader('Allow', 'GET, PUT, PATCH, DELETE');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    }
  };

  return (req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) {
          send(res, error.status, { error: { code: error.code, message: error.message } });
        }
        return;
      }
      logger.error('[tenancy] Provisioning request failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      if (!res.headersSent) {
        send(res, 500, { error: { code: 'INTERNAL' } });
      }
    });
  };
}

export interface TenantProvisioningServerOptions {
  deps: Omit<TenantProvisioningDeps, 'token'>;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Starts the provisioning API on its own port when `TENANT_PROVISIONING_TOKEN` is set, and
 * returns `null` when it is not. The port is separate from the public one so no tenant host,
 * ingress or proxy rule can reach it by accident.
 */
export function startTenantProvisioningServer({
  deps,
  env = process.env,
}: TenantProvisioningServerOptions): Server | null {
  const token = env.TENANT_PROVISIONING_TOKEN?.trim();
  if (!token) {
    return null;
  }
  if (token.length < MIN_PROVISIONING_TOKEN_LENGTH) {
    throw new Error(
      `TENANT_PROVISIONING_TOKEN must be at least ${MIN_PROVISIONING_TOKEN_LENGTH} characters`,
    );
  }
  const port = Number(env.TENANT_PROVISIONING_PORT?.trim() || 3081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TENANT_PROVISIONING_PORT must be a port number');
  }
  const host = env.TENANT_PROVISIONING_HOST?.trim() || '0.0.0.0';

  const server = createServer(createTenantProvisioningHandler({ ...deps, token, env }));
  server.listen(port, host, () => {
    logger.info(`[tenancy] Provisioning API listening on ${host}:${port}`);
  });
  return server;
}
