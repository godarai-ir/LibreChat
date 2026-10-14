const { tenantStorage } = require('@librechat/data-schemas');
const client = require('openid-client');
const passport = require('passport');
const { findUser } = require('~/models');
const { ensureTenantOpenId, forgetTenantOpenId, getOpenIdConfig } = require('./openidStrategy');

jest.mock('undici', () => ({ fetch: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Files/images/avatar', () => ({ resizeAvatar: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('~/cache/getLogStores', () => jest.fn(() => ({ get: jest.fn(), set: jest.fn() })));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUserIfAbsent: jest.fn(),
  updateUser: jest.fn(),
  findRolesByNames: jest.fn(),
  findBalanceByUser: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('openid-client', () => ({
  discovery: jest.fn(),
  fetchUserInfo: jest.fn().mockResolvedValue({}),
  customFetch: Symbol('customFetch'),
}));

jest.mock('openid-client/passport', () => {
  const mockStrategy = jest.fn(function (options, verify) {
    this.options = options;
    this.verify = verify;
  });
  mockStrategy.prototype.authorizationRequestParams = jest.fn(() => new URLSearchParams());
  return { Strategy: mockStrategy };
});

jest.mock('passport', () => {
  const strategies = new Map();
  return {
    use: jest.fn((name, strategy) => strategies.set(name, strategy)),
    unuse: jest.fn((name) => strategies.delete(name)),
    __strategies: strategies,
  };
});

const tenant = (slug, overrides = {}) => ({
  tenantId: `tenant-${slug}`,
  slug,
  oidc: {
    issuer: `https://${slug}.example.com`,
    clientId: `client-${slug}`,
    clientSecret: `secret-${slug}`,
    scopes: ['openid', 'email'],
    ...overrides,
  },
});

const configFor = (issuer) => ({ issuer, serverMetadata: () => ({ issuer }) });

describe('per-tenant OpenID (host multi-tenancy)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, OPENID_CALLBACK_URL: '/oauth/openid/callback' };
    delete process.env.TENANT_OIDC_REQUIRE_TID;
    forgetTenantOpenId();
    client.discovery.mockImplementation(async (url) => configFor(url.toString()));
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('discovers each tenant with its own issuer and client credentials', async () => {
    await ensureTenantOpenId(tenant('acme'));
    await ensureTenantOpenId(tenant('beta'));

    expect(client.discovery).toHaveBeenCalledTimes(2);
    const [acmeUrl, acmeClientId, acmeMetadata] = client.discovery.mock.calls[0];
    expect(acmeUrl.toString()).toBe('https://acme.example.com/');
    expect(acmeClientId).toBe('client-acme');
    expect(acmeMetadata).toMatchObject({ client_id: 'client-acme', client_secret: 'secret-acme' });
    const [betaUrl, betaClientId, betaMetadata] = client.discovery.mock.calls[1];
    expect(betaUrl.toString()).toBe('https://beta.example.com/');
    expect(betaClientId).toBe('client-beta');
    expect(betaMetadata).toMatchObject({ client_secret: 'secret-beta' });
  });

  it('registers one strategy per tenant, named after the tenant, with its scopes', async () => {
    await ensureTenantOpenId(tenant('acme'));
    await ensureTenantOpenId(tenant('beta', { scopes: ['openid'] }));

    expect([...passport.__strategies.keys()].sort()).toEqual([
      'openid:tenant-acme',
      'openid:tenant-beta',
    ]);
    expect(passport.__strategies.get('openid:tenant-acme').options.scope).toBe('openid email');
    expect(passport.__strategies.get('openid:tenant-beta').options.scope).toBe('openid');
    expect(passport.__strategies.has('openid')).toBe(false);
  });

  it('does not rediscover or re-register while the settings are unchanged', async () => {
    await ensureTenantOpenId(tenant('acme'));
    await ensureTenantOpenId(tenant('acme'));

    expect(client.discovery).toHaveBeenCalledTimes(1);
    expect(passport.use).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client and strategy when the client secret is rotated', async () => {
    await ensureTenantOpenId(tenant('acme'));
    const before = passport.__strategies.get('openid:tenant-acme');

    await ensureTenantOpenId(tenant('acme', { clientSecret: 'rotated' }));

    expect(client.discovery).toHaveBeenCalledTimes(2);
    expect(client.discovery.mock.calls[1][2]).toMatchObject({ client_secret: 'rotated' });
    expect(passport.use).toHaveBeenCalledTimes(2);
    expect(passport.__strategies.get('openid:tenant-acme')).not.toBe(before);
  });

  describe('getOpenIdConfig', () => {
    it('returns the client of the tenant in the current request context', async () => {
      await ensureTenantOpenId(tenant('acme'));
      await ensureTenantOpenId(tenant('beta'));

      await tenantStorage.run({ tenantId: 'tenant-acme' }, async () => {
        await Promise.resolve();
        expect(getOpenIdConfig().serverMetadata().issuer).toBe('https://acme.example.com/');
      });
      await tenantStorage.run({ tenantId: 'tenant-beta' }, async () => {
        expect(getOpenIdConfig().serverMetadata().issuer).toBe('https://beta.example.com/');
      });
    });

    it('does not hand one tenant the client of another', async () => {
      await ensureTenantOpenId(tenant('acme'));

      await tenantStorage.run({ tenantId: 'tenant-unknown' }, async () => {
        expect(() => getOpenIdConfig()).toThrow(/not initialized/);
      });
    });

    it('keeps concurrent tenants apart', async () => {
      await ensureTenantOpenId(tenant('acme'));
      await ensureTenantOpenId(tenant('beta'));
      const seen = [];

      await Promise.all(
        [
          ['tenant-acme', 10],
          ['tenant-beta', 1],
        ].map(([tenantId, delay]) =>
          tenantStorage.run({ tenantId }, async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            seen.push(getOpenIdConfig().serverMetadata().issuer);
          }),
        ),
      );

      expect(seen.sort()).toEqual(['https://acme.example.com/', 'https://beta.example.com/']);
    });
  });

  describe('redirect and callback URLs', () => {
    it('are built from the origin of the request, not from DOMAIN_SERVER', async () => {
      process.env.DOMAIN_SERVER = 'https://fixed.example.com';
      await ensureTenantOpenId(tenant('acme'));
      const strategy = passport.__strategies.get('openid:tenant-acme');

      const callback = strategy.currentUrl({
        tenantOrigin: 'https://acme.chat.example.com',
        originalUrl: '/oauth/openid/callback?code=abc&state=xyz',
      });
      expect(callback.toString()).toBe(
        'https://acme.chat.example.com/oauth/openid/callback?code=abc&state=xyz',
      );

      const params = strategy.authorizationRequestParams(
        { tenantOrigin: 'https://acme.chat.example.com' },
        {},
      );
      expect(params.get('redirect_uri')).toBe(
        'https://acme.chat.example.com/oauth/openid/callback',
      );
    });
  });

  describe('tenant claims', () => {
    const verifyFor = async (slug) => {
      await ensureTenantOpenId(tenant(slug));
      const { verify } = passport.__strategies.get(`openid:tenant-${slug}`);
      return (claims) =>
        new Promise((resolve) => {
          const tokenset = { claims: () => claims };
          tenantStorage
            .run({ tenantId: `tenant-${slug}` }, async () =>
              verify(tokenset, (err, user, info) => resolve({ err, user, info })),
            )
            .catch((err) => resolve({ err }));
        });
    };

    it('rejects a token issued for another tenant before any user is looked up', async () => {
      const verify = await verifyFor('acme');

      const result = await verify({
        sub: 's1',
        email: 'a@x.com',
        tid: 'tenant-beta',
        tenant: 'beta',
      });

      expect(result.user).toBe(false);
      expect(result.info).toEqual({ message: 'auth_failed' });
      expect(findUser).not.toHaveBeenCalled();
    });

    it('rejects a token with the right tid but another tenant slug', async () => {
      const verify = await verifyFor('acme');

      const result = await verify({
        sub: 's1',
        email: 'a@x.com',
        tid: 'tenant-acme',
        tenant: 'beta',
      });

      expect(result.user).toBe(false);
      expect(findUser).not.toHaveBeenCalled();
    });

    it('rejects a token without tid by default', async () => {
      const verify = await verifyFor('acme');

      const result = await verify({ sub: 's1', email: 'a@x.com' });

      expect(result.user).toBe(false);
      expect(findUser).not.toHaveBeenCalled();
    });

    it('lets a matching token through to the user lookup', async () => {
      const verify = await verifyFor('acme');

      await verify({ sub: 's1', email: 'a@x.com', tid: 'tenant-acme', tenant: 'acme' });

      expect(findUser).toHaveBeenCalled();
    });

    it('accepts a provider without tid when the operator relaxes the requirement', async () => {
      process.env.TENANT_OIDC_REQUIRE_TID = 'false';
      const verify = await verifyFor('acme');

      await verify({ sub: 's1', email: 'a@x.com', tenant: 'acme' });

      expect(findUser).toHaveBeenCalled();
    });
  });

  describe('forgetTenantOpenId', () => {
    it('removes the strategy and the client of one tenant', async () => {
      await ensureTenantOpenId(tenant('acme'));
      await ensureTenantOpenId(tenant('beta'));

      forgetTenantOpenId('tenant-acme');

      expect(passport.unuse).toHaveBeenCalledWith('openid:tenant-acme');
      expect(passport.__strategies.has('openid:tenant-acme')).toBe(false);
      expect(passport.__strategies.has('openid:tenant-beta')).toBe(true);
      await tenantStorage.run({ tenantId: 'tenant-acme' }, async () => {
        expect(() => getOpenIdConfig()).toThrow(/not initialized/);
      });
    });

    it('removes every tenant when called without an id', async () => {
      await ensureTenantOpenId(tenant('acme'));
      await ensureTenantOpenId(tenant('beta'));

      forgetTenantOpenId();

      expect(passport.__strategies.size).toBe(0);
    });
  });
});
