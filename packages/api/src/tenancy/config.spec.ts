import {
  enforceHostTenancy,
  DEFAULT_RESERVED_SLUGS,
  HostTenancyConfigError,
  isHostTenancyEnabled,
  resolveHostTenancyConfig,
  validateHostTenancyEnv,
  validateHostTenancyAppConfig,
} from './config';

const validEnv = {
  MULTI_TENANT_MODE: 'host',
  TENANT_HOST_BASE_DOMAIN: 'chat.example.com',
  TENANT_OIDC_ISSUER_TEMPLATE: 'https://{slug}.example.com',
  TENANT_ISOLATION_STRICT: 'true',
  USE_REDIS: 'true',
  OPENID_SESSION_SECRET: 'session-secret',
};

const problemsFor = (env: Record<string, string | undefined>): string[] =>
  validateHostTenancyEnv(resolveHostTenancyConfig(env), env);

describe('isHostTenancyEnabled', () => {
  it('is true only for host mode and never throws on a bad value', () => {
    expect(isHostTenancyEnabled({ MULTI_TENANT_MODE: ' Host ' })).toBe(true);
    expect(isHostTenancyEnabled({ MULTI_TENANT_MODE: 'hots' })).toBe(false);
    expect(isHostTenancyEnabled({})).toBe(false);
  });
});

describe('resolveHostTenancyConfig', () => {
  it.each([undefined, '', '  ', 'off', 'OFF'])('is disabled for %p', (mode) => {
    const config = resolveHostTenancyConfig({ MULTI_TENANT_MODE: mode });
    expect(config.enabled).toBe(false);
    expect(validateHostTenancyEnv(config, {})).toEqual([]);
    expect(validateHostTenancyAppConfig(config, { fileStrategy: 'local' })).toEqual([]);
  });

  it('is enabled by "host" in any case with surrounding whitespace', () => {
    expect(resolveHostTenancyConfig({ MULTI_TENANT_MODE: ' Host ' }).enabled).toBe(true);
  });

  it.each(['true', '1', 'hots', 'subdomain'])(
    'rejects the unknown mode %p instead of disabling',
    (mode) => {
      expect(() => resolveHostTenancyConfig({ MULTI_TENANT_MODE: mode })).toThrow(
        HostTenancyConfigError,
      );
    },
  );

  it('normalizes the base domain and keeps the issuer template', () => {
    const config = resolveHostTenancyConfig({
      ...validEnv,
      TENANT_HOST_BASE_DOMAIN: ' Chat.Example.COM ',
    });
    expect(config.baseDomain).toBe('chat.example.com');
    expect(config.issuerTemplate).toBe('https://{slug}.example.com');
  });

  it('always reserves the default slugs and adds operator slugs', () => {
    const config = resolveHostTenancyConfig({
      ...validEnv,
      TENANT_RESERVED_SLUGS: 'Internal, staging ,,',
    });
    for (const slug of DEFAULT_RESERVED_SLUGS) {
      expect(config.reservedSlugs.has(slug)).toBe(true);
    }
    expect(config.reservedSlugs.has('internal')).toBe(true);
    expect(config.reservedSlugs.has('staging')).toBe(true);
    expect(config.reservedSlugs.has('chat')).toBe(true);
  });

  it('does not let the operator un-reserve a default slug', () => {
    const config = resolveHostTenancyConfig({ ...validEnv, TENANT_RESERVED_SLUGS: 'extra' });
    expect(config.reservedSlugs.has('auth')).toBe(true);
  });

  it.each(['bad slug', 'a.b', '-x', 'x-', 'ü'])('rejects the invalid reserved slug %p', (slug) => {
    expect(() => resolveHostTenancyConfig({ ...validEnv, TENANT_RESERVED_SLUGS: slug })).toThrow(
      HostTenancyConfigError,
    );
  });
});

describe('validateHostTenancyEnv', () => {
  it('accepts a complete configuration', () => {
    expect(problemsFor(validEnv)).toEqual([]);
  });

  it('accepts a configuration without an issuer template (registry supplies each issuer)', () => {
    expect(problemsFor({ ...validEnv, TENANT_OIDC_ISSUER_TEMPLATE: undefined })).toEqual([]);
  });

  it('requires strict tenant isolation', () => {
    expect(problemsFor({ ...validEnv, TENANT_ISOLATION_STRICT: 'false' })).toEqual([
      expect.stringContaining('TENANT_ISOLATION_STRICT'),
    ]);
    expect(problemsFor({ ...validEnv, TENANT_ISOLATION_STRICT: undefined })).toHaveLength(1);
  });

  it('requires Redis', () => {
    expect(problemsFor({ ...validEnv, USE_REDIS: undefined })).toEqual([
      expect.stringContaining('USE_REDIS'),
    ]);
  });

  it('refuses the trusted tenant header', () => {
    expect(problemsFor({ ...validEnv, TRUST_TENANT_HEADER: 'true' })).toEqual([
      expect.stringContaining('TRUST_TENANT_HEADER'),
    ]);
  });

  it('defaults the scheme to https and accepts only https or http-on-localhost', () => {
    expect(resolveHostTenancyConfig(validEnv).scheme).toBe('https');
    expect(problemsFor({ ...validEnv, TENANT_HOST_SCHEME: 'ftp' })).toEqual([
      expect.stringContaining('TENANT_HOST_SCHEME'),
    ]);
    expect(problemsFor({ ...validEnv, TENANT_HOST_SCHEME: 'http' })).toEqual([
      expect.stringContaining('.localhost'),
    ]);
    expect(
      problemsFor({
        ...validEnv,
        TENANT_HOST_SCHEME: 'HTTP',
        TENANT_HOST_BASE_DOMAIN: 'chat.localhost',
      }),
    ).toEqual([]);
  });

  it.each(['DOMAIN_CLIENT', 'DOMAIN_SERVER'])('refuses a fixed %s', (name) => {
    const problems = problemsFor({ ...validEnv, [name]: 'https://one.example.com' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
    expect(problems[0]).toContain('must be unset');
  });

  it('names both fixed origins in one problem and ignores blank values', () => {
    const both = problemsFor({
      ...validEnv,
      DOMAIN_CLIENT: 'https://a.example.com',
      DOMAIN_SERVER: 'https://a.example.com',
    });
    expect(both).toEqual([expect.stringContaining('DOMAIN_CLIENT and DOMAIN_SERVER')]);
    expect(problemsFor({ ...validEnv, DOMAIN_CLIENT: '  ' })).toEqual([]);
  });

  it('requires the session secret that signs every tenant sign-in', () => {
    expect(problemsFor({ ...validEnv, OPENID_SESSION_SECRET: undefined })).toEqual([
      expect.stringContaining('OPENID_SESSION_SECRET'),
    ]);
    expect(problemsFor({ ...validEnv, OPENID_SESSION_SECRET: '  ' })).toHaveLength(1);
  });

  it.each(['OPENID_ISSUER', 'OPENID_CLIENT_ID', 'OPENID_CLIENT_SECRET'])(
    'refuses a global %s, which would shadow the tenant registry',
    (name) => {
      const problems = problemsFor({ ...validEnv, [name]: 'x' });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).toContain('tenant registry');
    },
  );

  it('refuses OpenID token reuse until it is tenant-aware', () => {
    expect(problemsFor({ ...validEnv, OPENID_REUSE_TOKENS: 'true' })).toEqual([
      expect.stringContaining('OPENID_REUSE_TOKENS'),
    ]);
    expect(problemsFor({ ...validEnv, OPENID_REUSE_TOKENS: 'false' })).toEqual([]);
  });

  it('refuses an admin panel origin, which every tenant would otherwise trust', () => {
    expect(problemsFor({ ...validEnv, ADMIN_PANEL_URL: 'https://admin.example.com' })).toEqual([
      expect.stringContaining('ADMIN_PANEL_URL'),
    ]);
  });

  it('refuses passkey login, which is bound to a single relying-party host', () => {
    expect(problemsFor({ ...validEnv, ALLOW_PASSKEY_LOGIN: 'true' })).toEqual([
      expect.stringContaining('ALLOW_PASSKEY_LOGIN'),
    ]);
    expect(problemsFor({ ...validEnv, ALLOW_PASSKEY_LOGIN: 'false' })).toEqual([]);
  });

  it('requires a base domain', () => {
    expect(problemsFor({ ...validEnv, TENANT_HOST_BASE_DOMAIN: undefined })).toEqual([
      expect.stringContaining('TENANT_HOST_BASE_DOMAIN is required'),
    ]);
  });

  it.each([
    'https://chat.example.com',
    'chat.example.com:3080',
    '*.chat.example.com',
    '.chat.example.com',
    'chat.example.com.',
    'localhost',
    'chat example.com',
    'chat..example.com',
    'chat_x.example.com',
  ])('rejects the base domain %p', (baseDomain) => {
    expect(problemsFor({ ...validEnv, TENANT_HOST_BASE_DOMAIN: baseDomain })).toEqual([
      expect.stringContaining('TENANT_HOST_BASE_DOMAIN'),
    ]);
  });

  it.each([
    ['http://{slug}.example.com', 'https'],
    ['https://example.com', '{slug} exactly once'],
    ['https://{slug}.{slug}.example.com', '{slug} exactly once'],
    ['https://a-{slug}.example.com', 'leftmost'],
    ['https://example.com/{slug}', 'leftmost'],
    ['https://{slug}.example.com/?x=1', 'query'],
    ['https://user:pw@{slug}.example.com', 'credentials'],
    ['not a url {slug}', 'valid URL'],
  ])('rejects the issuer template %p', (template, expected) => {
    const problems = problemsFor({ ...validEnv, TENANT_OIDC_ISSUER_TEMPLATE: template });
    expect(problems.join('\n')).toContain(expected);
  });

  it('allows a path on the issuer template', () => {
    expect(
      problemsFor({ ...validEnv, TENANT_OIDC_ISSUER_TEMPLATE: 'https://{slug}.example.com/realm' }),
    ).toEqual([]);
  });

  it.each([
    ['SAML_ENTRY_POINT', 'https://idp.example.com/sso', 'SAML'],
    ['LDAP_URL', 'ldaps://ldap.example.com', 'LDAP'],
    ['GOOGLE_CLIENT_ID', 'id', 'Google'],
    ['FACEBOOK_CLIENT_ID', 'id', 'Facebook'],
    ['GITHUB_CLIENT_ID', 'id', 'GitHub'],
    ['DISCORD_CLIENT_ID', 'id', 'Discord'],
    ['APPLE_CLIENT_ID', 'id', 'Apple'],
  ])('refuses %s because it is one global credential set', (name, value, provider) => {
    const problems = problemsFor({ ...validEnv, [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(provider);
    expect(problems[0]).toContain(name);
  });

  it('ignores blank provider variables', () => {
    expect(problemsFor({ ...validEnv, GOOGLE_CLIENT_ID: '   ', LDAP_URL: '' })).toEqual([]);
  });

  it('reports every problem at once', () => {
    const problems = problemsFor({
      MULTI_TENANT_MODE: 'host',
      TRUST_TENANT_HEADER: 'true',
      LDAP_URL: 'ldap://x',
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe('validateHostTenancyAppConfig', () => {
  const config = resolveHostTenancyConfig(validEnv);

  it('accepts S3-backed storage', () => {
    expect(
      validateHostTenancyAppConfig(config, {
        fileStrategy: 's3',
        fileStrategies: { avatar: 's3', image: 'cloudfront' },
      }),
    ).toEqual([]);
  });

  it.each(['local', 'firebase', 'azure_blob'])('rejects the %s file strategy', (strategy) => {
    const problems = validateHostTenancyAppConfig(config, { fileStrategy: strategy });
    expect(problems).toEqual([expect.stringContaining(`"${strategy}"`)]);
  });

  it('rejects a non-tenant-aware per-kind strategy', () => {
    const problems = validateHostTenancyAppConfig(config, {
      fileStrategy: 's3',
      fileStrategies: { avatar: 'local' },
    });
    expect(problems).toEqual([expect.stringContaining('fileStrategies.avatar')]);
  });

  it('requires an explicit file strategy', () => {
    expect(validateHostTenancyAppConfig(config, {})).toEqual([
      expect.stringContaining('fileStrategy must be set explicitly'),
    ]);
    expect(validateHostTenancyAppConfig(config, undefined)).toHaveLength(1);
  });
});

describe('enforceHostTenancy', () => {
  it('does nothing without problems', () => {
    expect(() => enforceHostTenancy([])).not.toThrow();
  });

  it('throws a coded error that lists every problem', () => {
    try {
      enforceHostTenancy(['first', 'second']);
      throw new Error('expected enforceHostTenancy to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HostTenancyConfigError);
      const failure = error as HostTenancyConfigError;
      expect(failure.code).toBe('HOST_TENANCY_CONFIG_INVALID');
      expect(failure.problems).toEqual(['first', 'second']);
      expect(failure.message).toContain('first');
      expect(failure.message).toContain('second');
    }
  });
});
