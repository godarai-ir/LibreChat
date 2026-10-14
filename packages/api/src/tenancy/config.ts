/**
 * Host-based multi-tenancy configuration (`MULTI_TENANT_MODE=host`).
 *
 * The mode is read from the environment, not `librechat.yaml`, on purpose: it decides how every
 * request is routed to a tenant and must be known before configuration is loaded, and a tenant's
 * own configuration must never be able to change it.
 */

export const HOST_TENANCY_ERROR_CODE = 'HOST_TENANCY_CONFIG_INVALID';

/** Never routable as a tenant. The operator can add slugs but not remove these. */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'chat',
  'default',
  'help',
  'localhost',
  'login',
  'root',
  'shahrah',
  'signup',
  'support',
  'system',
  'www',
];

/** Storage backends whose object keys carry the tenant. Anything else is refused in host mode. */
export const HOST_TENANCY_FILE_STRATEGIES: readonly string[] = ['s3', 'cloudfront'];

/**
 * Environment variables that enable an identity provider other than the per-tenant OpenID flow.
 * Each provider has one global credential set, so it cannot be tenant-safe.
 */
const UNSUPPORTED_AUTH_ENV: ReadonlyArray<{ provider: string; vars: readonly string[] }> = [
  { provider: 'SAML', vars: ['SAML_ENTRY_POINT', 'SAML_ISSUER', 'SAML_CERT'] },
  { provider: 'LDAP', vars: ['LDAP_URL'] },
  { provider: 'Google', vars: ['GOOGLE_CLIENT_ID'] },
  { provider: 'Facebook', vars: ['FACEBOOK_CLIENT_ID'] },
  { provider: 'GitHub', vars: ['GITHUB_CLIENT_ID'] },
  { provider: 'Discord', vars: ['DISCORD_CLIENT_ID'] },
  { provider: 'Apple', vars: ['APPLE_CLIENT_ID'] },
];

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const BASE_DOMAIN_PATTERN = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);
const SLUG_PATTERN = new RegExp(`^${DNS_LABEL}$`);
const ISSUER_SLUG_PLACEHOLDER = '{slug}';

export class HostTenancyConfigError extends Error {
  readonly code: string = HOST_TENANCY_ERROR_CODE;

  constructor(readonly problems: readonly string[]) {
    super(`Invalid host multi-tenancy configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'HostTenancyConfigError';
  }
}

export interface HostTenancyConfig {
  enabled: boolean;
  /** Tenant hosts are `<slug>.<baseDomain>`. Empty when disabled. */
  baseDomain: string;
  /** Scheme of the public tenant URL. `http` is accepted only on a `.localhost` base domain. */
  scheme: string;
  /** Issuer URL with a `{slug}` placeholder. A registry entry may override it per tenant. */
  issuerTemplate: string | null;
  reservedSlugs: ReadonlySet<string>;
}

export interface HostTenancyAppConfig {
  fileStrategy?: string;
  fileStrategies?: Record<string, string | undefined>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** True when `MULTI_TENANT_MODE=host`. Never throws; startup validation reports a bad value. */
export function isHostTenancyEnabled(env: Env = process.env): boolean {
  return env.MULTI_TENANT_MODE?.trim().toLowerCase() === 'host';
}

const isTrue = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true';

const clean = (value: string | undefined): string => value?.trim() ?? '';

const parseMode = (raw: string | undefined): 'off' | 'host' => {
  const mode = clean(raw).toLowerCase();
  if (mode === '' || mode === 'off') {
    return 'off';
  }
  if (mode === 'host') {
    return 'host';
  }
  throw new HostTenancyConfigError([
    `MULTI_TENANT_MODE must be "host" or unset, received "${mode.slice(0, 32)}"`,
  ]);
};

/**
 * The slugs that may never become tenants: the defaults plus `TENANT_RESERVED_SLUGS`. Usable
 * without host mode, so tooling that writes the registry applies the same rule as the server.
 */
export function reservedSlugsFromEnv(env: Env = process.env): ReadonlySet<string> {
  const problems: string[] = [];
  const reserved = parseReservedSlugs(env.TENANT_RESERVED_SLUGS, problems);
  enforceHostTenancy(problems);
  return reserved;
}

const parseReservedSlugs = (raw: string | undefined, problems: string[]): Set<string> => {
  const reserved = new Set(DEFAULT_RESERVED_SLUGS);
  for (const entry of clean(raw).split(',')) {
    const slug = entry.trim().toLowerCase();
    if (!slug) {
      continue;
    }
    if (!SLUG_PATTERN.test(slug)) {
      problems.push(`TENANT_RESERVED_SLUGS contains an invalid slug "${slug.slice(0, 64)}"`);
      continue;
    }
    reserved.add(slug);
  }
  return reserved;
};

const validateIssuerTemplate = (
  template: string,
  allowLocalHttp: boolean,
  problems: string[],
): void => {
  const occurrences = template.split(ISSUER_SLUG_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    problems.push(
      `TENANT_OIDC_ISSUER_TEMPLATE must contain ${ISSUER_SLUG_PLACEHOLDER} exactly once`,
    );
    return;
  }
  let url: URL;
  try {
    url = new URL(template.replace(ISSUER_SLUG_PLACEHOLDER, 'tenant'));
  } catch {
    problems.push('TENANT_OIDC_ISSUER_TEMPLATE is not a valid URL');
    return;
  }
  if (url.protocol === 'http:' && allowLocalHttp) {
    /* Development only: `TENANT_HOST_SCHEME=http` already requires a .localhost base domain. */
    if (!/(^|\.)localhost$/.test(url.hostname)) {
      problems.push('TENANT_OIDC_ISSUER_TEMPLATE may use http only on a .localhost host');
    }
  } else if (url.protocol !== 'https:') {
    problems.push(
      'TENANT_OIDC_ISSUER_TEMPLATE must use https (http is accepted on .localhost when TENANT_HOST_SCHEME=http)',
    );
  }
  if (url.search || url.hash || url.username || url.password) {
    problems.push('TENANT_OIDC_ISSUER_TEMPLATE must not contain a query, fragment or credentials');
  }
  if (url.hostname.split('.')[0] !== 'tenant') {
    problems.push('TENANT_OIDC_ISSUER_TEMPLATE must place {slug} as the whole leftmost host label');
  }
};

/**
 * Reads the multi-tenancy settings from the environment. Throws {@link HostTenancyConfigError}
 * for an unrecognized `MULTI_TENANT_MODE` so a typo fails closed instead of silently disabling
 * tenant routing. Cross-setting checks live in {@link validateHostTenancyEnv}.
 */
export function resolveHostTenancyConfig(env: Env = process.env): HostTenancyConfig {
  const enabled = parseMode(env.MULTI_TENANT_MODE) === 'host';
  if (!enabled) {
    return {
      enabled,
      baseDomain: '',
      scheme: 'https',
      issuerTemplate: null,
      reservedSlugs: new Set(),
    };
  }

  const problems: string[] = [];
  const reservedSlugs = parseReservedSlugs(env.TENANT_RESERVED_SLUGS, problems);
  if (problems.length > 0) {
    throw new HostTenancyConfigError(problems);
  }

  return {
    enabled,
    baseDomain: clean(env.TENANT_HOST_BASE_DOMAIN).toLowerCase(),
    scheme: clean(env.TENANT_HOST_SCHEME).toLowerCase() || 'https',
    issuerTemplate: clean(env.TENANT_OIDC_ISSUER_TEMPLATE) || null,
    reservedSlugs,
  };
}

/** Returns every reason the environment cannot run in host mode. Empty when disabled or valid. */
export function validateHostTenancyEnv(
  config: HostTenancyConfig,
  env: Env = process.env,
): string[] {
  if (!config.enabled) {
    return [];
  }

  const problems: string[] = [];

  if (!isTrue(env.TENANT_ISOLATION_STRICT)) {
    problems.push(
      'TENANT_ISOLATION_STRICT must be "true" so a request without a tenant fails closed',
    );
  }
  if (!config.baseDomain) {
    problems.push('TENANT_HOST_BASE_DOMAIN is required (for example chat.example.com)');
  } else if (!BASE_DOMAIN_PATTERN.test(config.baseDomain)) {
    problems.push(
      'TENANT_HOST_BASE_DOMAIN must be a bare lowercase host name: no scheme, port, wildcard or trailing dot',
    );
  }
  if (config.scheme !== 'https' && config.scheme !== 'http') {
    problems.push('TENANT_HOST_SCHEME must be "https" (or "http" on a .localhost base domain)');
  } else if (config.scheme === 'http' && !/(^|\.)localhost$/.test(config.baseDomain)) {
    problems.push(
      'TENANT_HOST_SCHEME "http" is only allowed when the base domain ends in .localhost',
    );
  }
  if (config.issuerTemplate) {
    validateIssuerTemplate(config.issuerTemplate, config.scheme === 'http', problems);
  }
  if (isTrue(env.TRUST_TENANT_HEADER)) {
    problems.push('TRUST_TENANT_HEADER must not be enabled: the tenant comes from the Host header');
  }
  if (!isTrue(env.USE_REDIS)) {
    problems.push('USE_REDIS must be "true" so sessions, streams and rate limits are shared');
  }
  const fixedOrigins = ['DOMAIN_CLIENT', 'DOMAIN_SERVER'].filter((name) => clean(env[name]) !== '');
  if (fixedOrigins.length > 0) {
    problems.push(
      `${fixedOrigins.join(' and ')} must be unset: each request's origin comes from its Host, ` +
        'and one fixed origin would put links to the wrong tenant in redirects and emails',
    );
  }
  if (clean(env.OPENID_SESSION_SECRET) === '') {
    problems.push(
      'OPENID_SESSION_SECRET is required: it signs the sign-in session of every tenant',
    );
  }
  const globalOpenId = ['OPENID_ISSUER', 'OPENID_CLIENT_ID', 'OPENID_CLIENT_SECRET'].filter(
    (name) => clean(env[name]) !== '',
  );
  if (globalOpenId.length > 0) {
    problems.push(
      `${globalOpenId.join(', ')} must be unset: each tenant's issuer and client come from the tenant registry`,
    );
  }
  if (isTrue(env.OPENID_REUSE_TOKENS)) {
    problems.push(
      'OPENID_REUSE_TOKENS is not supported in host mode yet: bearer tokens would need a per-tenant issuer and JWKS',
    );
  }
  if (clean(env.ADMIN_PANEL_URL) !== '') {
    problems.push(
      'ADMIN_PANEL_URL must be unset: the admin panel has one SSO and is not supported in host mode, ' +
        'and a trusted admin origin would be trusted by every tenant',
    );
  }
  if (isTrue(env.ALLOW_PASSKEY_LOGIN)) {
    problems.push(
      'ALLOW_PASSKEY_LOGIN is not supported in host mode: a passkey is bound to one relying-party host',
    );
  }
  for (const { provider, vars } of UNSUPPORTED_AUTH_ENV) {
    const configured = vars.filter((name) => clean(env[name]) !== '');
    if (configured.length > 0) {
      problems.push(
        `${provider} sign-in has one global credential set and is not supported in host mode ` +
          `(unset ${configured.join(', ')})`,
      );
    }
  }

  return problems;
}

/** Returns every reason the loaded application config cannot run in host mode. */
export function validateHostTenancyAppConfig(
  config: HostTenancyConfig,
  appConfig: HostTenancyAppConfig | undefined,
): string[] {
  if (!config.enabled) {
    return [];
  }

  const allowed = new Set(HOST_TENANCY_FILE_STRATEGIES);
  const configured = new Map<string, string | undefined>([
    ['fileStrategy', appConfig?.fileStrategy],
    ...Object.entries(appConfig?.fileStrategies ?? {}).map(
      ([kind, value]): [string, string | undefined] => [`fileStrategies.${kind}`, value],
    ),
  ]);

  const problems: string[] = [];
  for (const [name, value] of configured) {
    if (value != null && !allowed.has(value)) {
      problems.push(
        `${name} "${value}" does not isolate tenants; use one of: ${HOST_TENANCY_FILE_STRATEGIES.join(', ')}`,
      );
    }
  }
  if (appConfig?.fileStrategy == null) {
    problems.push(
      'fileStrategy must be set explicitly (the default, "local", is not tenant-aware)',
    );
  }

  return problems;
}

/** Throws {@link HostTenancyConfigError} when `problems` is not empty. */
export function enforceHostTenancy(problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new HostTenancyConfigError(problems);
  }
}
