import { logger } from '@librechat/data-schemas';
import { ErrorTypes, extractEnvVariable } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';
import type { GetUserKeyValuesFunction } from '~/types';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { resolveModelHeaders } from '~/utils/headers';
import { isUserProvided } from '~/utils/common';

/** The custom endpoint that talks to the GodarAI gateway. */
export const GODAR_ENDPOINT_NAME = 'Godar';
const GATEWAY_TIMEOUT_MS = 10_000;

/** Stored keys a member saved but that can no longer authenticate them. */
const UNUSABLE_KEY_TYPES = new Set<string>([ErrorTypes.NO_USER_KEY, ErrorTypes.INVALID_USER_KEY]);

export type GodarGatewayErrorCode =
  | 'godar_not_configured'
  | 'godar_reauth_required'
  | 'godar_auth_unavailable'
  | 'godar_gateway_unavailable';

export type GodarGatewayResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; error: { code: GodarGatewayErrorCode } };

export interface GodarGatewayDeps {
  getAppConfig: (params: GetAppConfigOptions) => Promise<AppConfig | null | undefined>;
  getUserKeyValues: GetUserKeyValuesFunction;
  getUserKeyExpiry: (params: {
    userId: string;
    name: string;
  }) => Promise<{ expiresAt: Date | 'never' | null }>;
  /** Defaults to `GODAR_ENDPOINT_NAME`. */
  endpointName?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface GodarGatewayRequest {
  user: Partial<IUser> & { id: string };
  tenantId?: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

export type GodarGatewayCall = (request: GodarGatewayRequest) => Promise<GodarGatewayResult>;

type GatewayEndpoint = NonNullable<NonNullable<AppConfig['endpoints']>['custom']>[number];

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

/** The `type` of a key-store error (`{"type":"no_user_key"}`), or null for anything else. */
function keyErrorType(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  try {
    const parsed = JSON.parse(error.message) as { type?: unknown };
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

/**
 * Calls the GodarAI gateway as the member. The endpoint's own headers (for example a signed
 * `{{LIBRECHAT_USER_ASSERTION}}`) come first. When they carry no Authorization and the endpoint
 * takes a user-provided key, the member's saved, unexpired key authenticates the call instead,
 * the same credential their chat requests already send.
 */
export function createGodarGateway(deps: GodarGatewayDeps): GodarGatewayCall {
  const {
    getAppConfig,
    getUserKeyValues,
    getUserKeyExpiry,
    endpointName = GODAR_ENDPOINT_NAME,
    fetch: fetchImpl = fetch,
    now = Date.now,
  } = deps;

  async function readUserKey(userId: string): Promise<string | null> {
    const [values, expiry] = await Promise.all([
      getUserKeyValues({ userId, name: endpointName }).catch((error: unknown) => {
        const type = keyErrorType(error);
        if (type != null && UNUSABLE_KEY_TYPES.has(type)) {
          return null;
        }
        throw error;
      }),
      getUserKeyExpiry({ userId, name: endpointName }),
    ]);
    const apiKey = typeof values?.apiKey === 'string' ? values.apiKey.trim() : '';
    if (!apiKey) {
      return null;
    }
    const expiresAt = expiry?.expiresAt;
    if (expiresAt instanceof Date && expiresAt.getTime() <= now()) {
      return null;
    }
    return apiKey;
  }

  async function resolveCredentialHeaders(
    endpoint: GatewayEndpoint,
    request: GodarGatewayRequest,
  ): Promise<Record<string, string> | GodarGatewayErrorCode> {
    let headers: Record<string, string>;
    try {
      headers = resolveModelHeaders({
        headers: endpoint.headers,
        user: request.user,
        tenantId: request.tenantId,
      });
    } catch (error) {
      if (error instanceof OpenIDReauthRequiredError) {
        return 'godar_reauth_required';
      }
      throw error;
    }
    if (hasAuthorization(headers)) {
      return headers;
    }

    if (isUserProvided(extractEnvVariable(endpoint.apiKey ?? ''))) {
      const apiKey = await readUserKey(request.user.id);
      if (apiKey) {
        return { ...headers, Authorization: `Bearer ${apiKey}` };
      }
    }

    logger.warn('[godar] no Authorization resolved for this member (no assertion, no saved key)');
    return 'godar_auth_unavailable';
  }

  return async function callGodarGateway(
    request: GodarGatewayRequest,
  ): Promise<GodarGatewayResult> {
    const appConfig = await getAppConfig(
      getAppConfigOptionsFromUser(request.user, request.tenantId),
    );
    const endpoint = appConfig?.endpoints?.custom?.find((item) => item?.name === endpointName);
    const baseURL = typeof endpoint?.baseURL === 'string' ? endpoint.baseURL.trim() : '';
    if (!endpoint || !baseURL) {
      return { ok: false, error: { code: 'godar_not_configured' } };
    }

    const headers = await resolveCredentialHeaders(endpoint, request);
    if (typeof headers === 'string') {
      return { ok: false, error: { code: headers } };
    }

    try {
      const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}${request.path}`, {
        method: request.method ?? 'GET',
        headers: {
          ...headers,
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: true, status: response.status, body: body ?? {} };
    } catch (error) {
      logger.warn(
        `[godar] gateway call ${request.path} failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return { ok: false, error: { code: 'godar_gateway_unavailable' } };
    }
  };
}
