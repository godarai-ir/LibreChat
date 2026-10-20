import { generateKeyPairSync, verify } from 'crypto';
import { SYSTEM_TENANT_ID, tenantStorage } from '@librechat/data-schemas';
import type { KeyObject } from 'crypto';
import type { UserAssertionClaims } from './assertion';
import { createUserAssertion, getUserAssertionConfig } from './assertion';

const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

function pem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function decode(token: string, publicKey: KeyObject) {
  const [header, payload, signature] = token.split('.');
  const alg = JSON.parse(Buffer.from(header, 'base64url').toString()).alg;
  const valid = verify(
    alg === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString()) as UserAssertionClaims,
  };
}

const baseEnv = {
  USER_ASSERTION_PRIVATE_KEY: pem(ed.privateKey).replace(/\n/g, '\\n'),
  USER_ASSERTION_AUDIENCE: 'godar-gateway',
} as NodeJS.ProcessEnv;

const user = { id: 'lc-user-1', openidId: 'idp-sub-1', tenantId: 'tenant-a' };
const now = Date.UTC(2026, 9, 20, 12, 0, 0);

describe('createUserAssertion', () => {
  const originalStrict = process.env.TENANT_ISOLATION_STRICT;

  afterEach(() => {
    if (originalStrict === undefined) {
      delete process.env.TENANT_ISOLATION_STRICT;
    } else {
      process.env.TENANT_ISOLATION_STRICT = originalStrict;
    }
  });

  it('signs an EdDSA assertion naming the subject, tenant and audience', () => {
    const token = createUserAssertion({ user, now, env: baseEnv });
    expect(token).not.toBeNull();

    const { valid, header, claims } = decode(token as string, ed.publicKey);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'librechat-user-assertion' });
    expect(claims).toMatchObject({
      iss: 'librechat',
      aud: 'godar-gateway',
      sub: 'idp-sub-1',
      tid: 'tenant-a',
      uid: 'lc-user-1',
      iat: now / 1000,
      nbf: now / 1000,
      exp: now / 1000 + 600,
    });
    expect(claims.jti).toEqual(expect.any(String));
  });

  it('does not reuse a token id across requests', () => {
    const first = decode(createUserAssertion({ user, now, env: baseEnv }) as string, ed.publicKey);
    const second = decode(createUserAssertion({ user, now, env: baseEnv }) as string, ed.publicKey);
    expect(first.claims.jti).not.toBe(second.claims.jti);
  });

  it('signs RS256 with a base64 key and honours issuer, key id and a capped TTL', () => {
    const env = {
      USER_ASSERTION_PRIVATE_KEY_BASE64: Buffer.from(pem(rsa.privateKey)).toString('base64'),
      USER_ASSERTION_AUDIENCE: 'gw',
      USER_ASSERTION_ALGORITHM: 'RS256',
      USER_ASSERTION_ISSUER: 'https://chat.example',
      USER_ASSERTION_KEY_ID: 'k2',
      USER_ASSERTION_TTL_SECONDS: '999999',
    } as NodeJS.ProcessEnv;

    const { valid, header, claims } = decode(
      createUserAssertion({ user, now, env }) as string,
      rsa.publicKey,
    );
    expect(valid).toBe(true);
    expect(header.kid).toBe('k2');
    expect(claims.iss).toBe('https://chat.example');
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('prefers the request tenant over the stored one', () => {
    const token = createUserAssertion({ user, tenantId: 'tenant-b', now, env: baseEnv });
    expect(decode(token as string, ed.publicKey).claims.tid).toBe('tenant-b');
  });

  it('falls back to the async tenant context and ignores the system tenant', async () => {
    const tenantless = { id: 'u', openidId: 's' };
    const fromContext = await tenantStorage.run({ tenantId: 'tenant-ctx' }, async () =>
      createUserAssertion({ user: tenantless, now, env: baseEnv }),
    );
    expect(decode(fromContext as string, ed.publicKey).claims.tid).toBe('tenant-ctx');

    const system = createUserAssertion({
      user: tenantless,
      tenantId: SYSTEM_TENANT_ID,
      now,
      env: baseEnv,
    });
    expect(decode(system as string, ed.publicKey).claims).not.toHaveProperty('tid');
  });

  it('refuses a tenant-less assertion under strict isolation', () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    expect(createUserAssertion({ user: { id: 'u', openidId: 's' }, env: baseEnv })).toBeNull();
    expect(createUserAssertion({ user, env: baseEnv })).not.toBeNull();
  });

  it('returns null for a user without an identity-provider subject', () => {
    expect(createUserAssertion({ user: { id: 'local-user' }, env: baseEnv })).toBeNull();
    expect(createUserAssertion({ user: undefined, env: baseEnv })).toBeNull();
  });

  it('returns null when no key or no audience is configured', () => {
    expect(createUserAssertion({ user, env: {} as NodeJS.ProcessEnv })).toBeNull();
    expect(
      createUserAssertion({
        user,
        env: { USER_ASSERTION_PRIVATE_KEY: baseEnv.USER_ASSERTION_PRIVATE_KEY },
      }),
    ).toBeNull();
  });
});

describe('getUserAssertionConfig', () => {
  it('rejects an unreadable key without echoing it', () => {
    const secret = 'not-a-key-SECRETMATERIAL';
    const env = { USER_ASSERTION_PRIVATE_KEY: secret, USER_ASSERTION_AUDIENCE: 'gw' };
    expect(() => getUserAssertionConfig(env)).toThrow('could not be loaded (PEM format)');
    try {
      getUserAssertionConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRETMATERIAL');
    }
  });

  it('rejects a key that does not match the algorithm', () => {
    const env = { ...baseEnv, USER_ASSERTION_ALGORITHM: 'RS256' };
    expect(() => getUserAssertionConfig(env)).toThrow('RS256 requires an RSA key');
    expect(() => getUserAssertionConfig({ ...baseEnv, USER_ASSERTION_ALGORITHM: 'HS256' })).toThrow(
      'Unsupported user assertion algorithm',
    );
  });

  it('reuses the parsed key while the settings are unchanged', () => {
    expect(getUserAssertionConfig(baseEnv)).toBe(getUserAssertionConfig({ ...baseEnv }));
    expect(getUserAssertionConfig(baseEnv)).not.toBe(
      getUserAssertionConfig({ ...baseEnv, USER_ASSERTION_KEY_ID: 'rotated' }),
    );
  });
});
