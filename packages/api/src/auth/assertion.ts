import { SYSTEM_TENANT_ID, getTenantId } from '@librechat/data-schemas';
import { createPrivateKey, randomUUID, sign as cryptoSign } from 'crypto';
import type { KeyObject } from 'crypto';
import { isEnabled } from '~/utils/common';

/**
 * Header template for a short-lived JWT that LibreChat signs to name the requesting user to an
 * upstream model gateway, so users never paste a personal key. It is resolved only in model
 * headers, where the request tenant is authoritative, and only for admin-trusted base URLs.
 */
export const USER_ASSERTION_PLACEHOLDER = '{{LIBRECHAT_USER_ASSERTION}}';

type AssertionAlg = 'EdDSA' | 'RS256';

interface AssertionConfig {
  alg: AssertionAlg;
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  key: KeyObject;
}

/** The user fields an assertion names; `openidId` is the identity provider's subject. */
export interface AssertionUser {
  id?: string;
  openidId?: string;
  tenantId?: string;
}

export interface UserAssertionClaims {
  iss: string;
  aud: string;
  /** The identity provider's subject, which the gateway already knows the member by. */
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  tid?: string;
  /** LibreChat's own user id, for the gateway's audit trail. */
  uid?: string;
}

const DEFAULT_ISSUER = 'librechat';
const DEFAULT_KID = 'librechat-user-assertion';
const DEFAULT_TTL_SECONDS = 600;
const MAX_TTL_SECONDS = 3600;

let cachedConfig: { fingerprint: string; config: AssertionConfig } | null = null;

function readRawKey(env: NodeJS.ProcessEnv): string | undefined {
  const inlineKey = env.USER_ASSERTION_PRIVATE_KEY?.trim();
  if (inlineKey) {
    return inlineKey.replace(/\\n/g, '\n');
  }
  const base64Key = env.USER_ASSERTION_PRIVATE_KEY_BASE64?.trim();
  if (base64Key) {
    return Buffer.from(base64Key, 'base64').toString('utf8').trim();
  }
  return undefined;
}

function parseAlg(value: string | undefined): AssertionAlg {
  if (value === 'RS256') {
    return 'RS256';
  }
  if (value === undefined || value === '' || value === 'EdDSA') {
    return 'EdDSA';
  }
  throw new Error(`Unsupported user assertion algorithm: ${value}`);
}

function parseTtl(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);
}

/** Never echoes the key: a parse error can quote key material that callers would log. */
function createSigningKey(rawKey: string, alg: AssertionAlg): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(rawKey);
  } catch {
    throw new Error('User assertion signing key could not be loaded (PEM format)');
  }
  const keyType = key.asymmetricKeyType;
  if (alg === 'EdDSA' && keyType !== 'ed25519' && keyType !== 'ed448') {
    throw new Error(`User assertion algorithm EdDSA requires an EdDSA key, received ${keyType}`);
  }
  if (alg === 'RS256' && keyType !== 'rsa') {
    throw new Error(`User assertion algorithm RS256 requires an RSA key, received ${keyType}`);
  }
  return key;
}

/** Signing settings, or null when no key or audience is configured. A bad key throws. */
export function getUserAssertionConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssertionConfig | null {
  const rawKey = readRawKey(env);
  const audience = env.USER_ASSERTION_AUDIENCE?.trim();
  if (!rawKey || !audience) {
    return null;
  }

  const alg = parseAlg(env.USER_ASSERTION_ALGORITHM?.trim());
  const kid = env.USER_ASSERTION_KEY_ID?.trim() || DEFAULT_KID;
  const issuer = env.USER_ASSERTION_ISSUER?.trim() || DEFAULT_ISSUER;
  const ttlSeconds = parseTtl(env.USER_ASSERTION_TTL_SECONDS);
  const fingerprint = JSON.stringify([rawKey, alg, kid, issuer, audience, ttlSeconds]);
  if (cachedConfig?.fingerprint === fingerprint) {
    return cachedConfig.config;
  }

  const config = { alg, kid, issuer, audience, ttlSeconds, key: createSigningKey(rawKey, alg) };
  cachedConfig = { fingerprint, config };
  return config;
}

/**
 * `SYSTEM_TENANT_ID` marks a background context rather than a real tenant. Under strict tenant
 * isolation an assertion without a tenant is refused rather than minted tenant-less.
 */
function resolveTenantId(
  user: AssertionUser,
  tenantId: string | undefined,
): { ok: true; tid?: string } | { ok: false } {
  const candidate = tenantId || user.tenantId?.toString() || getTenantId();
  if (candidate && candidate !== SYSTEM_TENANT_ID) {
    return { ok: true, tid: candidate };
  }
  return isEnabled(process.env.TENANT_ISOLATION_STRICT) ? { ok: false } : { ok: true };
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Signs an assertion naming `user` for the configured audience. Returns null when signing is not
 * configured, the user has no identity-provider subject, or strict isolation finds no tenant.
 */
export function createUserAssertion({
  user,
  tenantId,
  now = Date.now(),
  env = process.env,
}: {
  user?: AssertionUser | null;
  tenantId?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const subject = user?.openidId?.toString();
  if (!user || !subject) {
    return null;
  }
  const config = getUserAssertionConfig(env);
  if (!config) {
    return null;
  }
  const tenant = resolveTenantId(user, tenantId);
  if (!tenant.ok) {
    return null;
  }

  const iat = Math.floor(now / 1000);
  const uid = user.id?.toString();
  const claims: UserAssertionClaims = {
    iss: config.issuer,
    aud: config.audience,
    sub: subject,
    iat,
    nbf: iat,
    exp: iat + config.ttlSeconds,
    jti: randomUUID(),
    ...(tenant.tid ? { tid: tenant.tid } : {}),
    ...(uid ? { uid } : {}),
  };
  const header = { alg: config.alg, typ: 'JWT', kid: config.kid };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = cryptoSign(
    config.alg === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from(signingInput),
    config.key,
  );
  return `${signingInput}.${base64Url(signature)}`;
}
