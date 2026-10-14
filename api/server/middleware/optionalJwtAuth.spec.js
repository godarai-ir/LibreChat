const mockAuthenticate = jest.fn();
const mockTenantContextMiddleware = jest.fn((_req, _res, next) => next());
const mockIsTwoFactorEnrollmentRequired = jest.fn(() => false);
const mockClearCloudFrontCookies = jest.fn();

jest.mock('passport', () => ({
  _strategy: jest.fn(() => undefined),
  authenticate: (...args) => mockAuthenticate(...args),
}));

jest.mock('@librechat/api', () => ({
  continueAfterOptionalAuth: jest.requireActual('@librechat/api').continueAfterOptionalAuth,
  belongsToRequestTenant: jest.requireActual('@librechat/api').belongsToRequestTenant,
  logTenantMismatch: jest.fn(),
  isEnabled: jest.fn(() => false),
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
  isTwoFactorEnrollmentRequired: (...args) => mockIsTwoFactorEnrollmentRequired(...args),
  tenantContextMiddleware: (...args) => mockTenantContextMiddleware(...args),
}));

const optionalJwtAuth = require('./optionalJwtAuth');

const run = (user, extra = {}) => {
  const req = { headers: {}, _mockUser: user, ...extra };
  const res = {};
  const next = jest.fn();
  optionalJwtAuth(req, res, next);
  return { req, res, next };
};

describe('optionalJwtAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(false);
    mockAuthenticate.mockImplementation((_strategy, _options, callback) => {
      return (req) => callback(null, req._mockUser ?? false);
    });
  });

  it('establishes authenticated context when enrollment is not required', () => {
    const user = { id: 'viewer-1', provider: 'local', twoFactorEnabled: true };

    const { req, next } = run(user);

    expect(req.user).toBe(user);
    expect(req.authStrategy).toBe('jwt');
    expect(mockTenantContextMiddleware).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('host multi-tenancy binding', () => {
    it('treats a user of another tenant as anonymous and sets no tenant context', () => {
      const user = { id: 'viewer-a', provider: 'local', tenantId: 'tenant-a' };

      const { req, next } = run(user, { tenantId: 'tenant-b' });

      expect(req.user).toBeUndefined();
      expect(req.authStrategy).toBeUndefined();
      expect(mockTenantContextMiddleware).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('keeps a user of the host tenant authenticated', () => {
      const user = { id: 'viewer-b', provider: 'local', tenantId: 'tenant-b' };

      const { req, next } = run(user, { tenantId: 'tenant-b' });

      expect(req.user).toBe(user);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('is unchanged without a host tenant', () => {
      const user = { id: 'viewer-a', provider: 'local', tenantId: 'tenant-a' };

      const { req } = run(user);

      expect(req.user).toBe(user);
    });
  });

  it('treats a viewer with incomplete required enrollment as unauthenticated', () => {
    const user = { id: 'viewer-required', provider: 'local', twoFactorEnabled: false };
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(true);

    const { req, res, next } = run(user);

    expect(req.user).toBeUndefined();
    expect(req.authStrategy).toBeUndefined();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: 'viewer-required',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(mockTenantContextMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('continues anonymously when authentication does not resolve a user', () => {
    const { req, next } = run(undefined);

    expect(req.user).toBeUndefined();
    expect(mockTenantContextMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
