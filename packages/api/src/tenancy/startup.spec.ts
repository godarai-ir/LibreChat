import { assertHostTenancyEnv, assertHostTenancyAppConfig } from './startup';
import { HostTenancyConfigError } from './config';

const validEnv = {
  MULTI_TENANT_MODE: 'host',
  TENANT_HOST_BASE_DOMAIN: 'chat.example.com',
  TENANT_ISOLATION_STRICT: 'true',
  USE_REDIS: 'true',
  OPENID_SESSION_SECRET: 'session-secret',
};

describe('assertHostTenancyEnv', () => {
  it('is a no-op when the mode is off, whatever else is configured', () => {
    const config = assertHostTenancyEnv({ LDAP_URL: 'ldap://x', USE_REDIS: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('returns the resolved configuration when valid', () => {
    const config = assertHostTenancyEnv(validEnv);
    expect(config.enabled).toBe(true);
    expect(config.baseDomain).toBe('chat.example.com');
  });

  it('refuses to start with an invalid environment', () => {
    expect(() => assertHostTenancyEnv({ ...validEnv, TENANT_ISOLATION_STRICT: 'false' })).toThrow(
      HostTenancyConfigError,
    );
  });

  it('refuses to start with an unknown mode', () => {
    expect(() => assertHostTenancyEnv({ MULTI_TENANT_MODE: 'yes' })).toThrow(
      HostTenancyConfigError,
    );
  });
});

describe('assertHostTenancyAppConfig', () => {
  it('ignores the file strategy when the mode is off', () => {
    expect(() => assertHostTenancyAppConfig({ fileStrategy: 'local' }, {})).not.toThrow();
  });

  it('refuses a local file strategy in host mode', () => {
    expect(() => assertHostTenancyAppConfig({ fileStrategy: 'local' }, validEnv)).toThrow(
      HostTenancyConfigError,
    );
  });

  it('accepts S3 in host mode', () => {
    expect(() => assertHostTenancyAppConfig({ fileStrategy: 's3' }, validEnv)).not.toThrow();
  });
});
