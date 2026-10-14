import { tenantStorage, runAsSystem } from '@librechat/data-schemas';
import { buildTenantOrigin, getClientOrigin, getServerOrigin } from './origin';

describe('buildTenantOrigin', () => {
  it('builds the public origin from validated parts', () => {
    expect(
      buildTenantOrigin({ scheme: 'https', slug: 'acme', baseDomain: 'chat.example.com' }),
    ).toBe('https://acme.chat.example.com');
  });

  it('keeps an explicit development port', () => {
    expect(
      buildTenantOrigin({
        scheme: 'http',
        slug: 'acme',
        baseDomain: 'chat.localhost',
        port: '3080',
      }),
    ).toBe('http://acme.chat.localhost:3080');
  });
});

describe('getClientOrigin / getServerOrigin', () => {
  const env = {
    DOMAIN_CLIENT: 'https://single.example.com',
    DOMAIN_SERVER: 'https://api.example.com',
  };

  it('prefers the tenant origin in host mode', () => {
    const req = { tenantOrigin: 'https://acme.chat.example.com' };
    expect(getClientOrigin(req, env)).toBe('https://acme.chat.example.com');
    expect(getServerOrigin(req, env)).toBe('https://acme.chat.example.com');
  });

  it('falls back to the environment exactly as single-tenant mode always did', () => {
    expect(getClientOrigin({}, env)).toBe('https://single.example.com');
    expect(getServerOrigin(undefined, env)).toBe('https://api.example.com');
    expect(getClientOrigin(null, env)).toBe('https://single.example.com');
  });

  it('is undefined when neither is set, so callers cannot build a link to another tenant', () => {
    expect(getClientOrigin({}, {})).toBeUndefined();
    expect(getServerOrigin({}, {})).toBeUndefined();
  });
});

describe('origin from the async tenant context', () => {
  const env = {
    MULTI_TENANT_MODE: 'host',
    DOMAIN_CLIENT: 'https://single.example.com',
    DOMAIN_SERVER: 'https://api.example.com',
  };
  const origin = 'https://acme.chat.example.com';

  it('is used when code runs inside a request but has no req', async () => {
    await tenantStorage.run({ tenantId: 'tenant-acme', origin }, async () => {
      expect(getServerOrigin(undefined, env)).toBe(origin);
      expect(getClientOrigin(null, env)).toBe(origin);
      await Promise.resolve();
      expect(getServerOrigin(undefined, env)).toBe(origin);
    });
  });

  it('is ignored outside host mode, so single-tenant behavior cannot change', async () => {
    const singleTenant = { DOMAIN_SERVER: 'https://api.example.com' };
    await tenantStorage.run({ tenantId: 'tenant-acme', origin }, async () => {
      expect(getServerOrigin(undefined, singleTenant)).toBe('https://api.example.com');
    });
  });

  it('lets the request win over the ambient context', async () => {
    await tenantStorage.run({ tenantId: 'tenant-acme', origin }, async () => {
      expect(getClientOrigin({ tenantOrigin: 'https://beta.chat.example.com' }, env)).toBe(
        'https://beta.chat.example.com',
      );
    });
  });

  it('is not inherited by a system context', async () => {
    await tenantStorage.run({ tenantId: 'tenant-acme', origin }, async () => {
      await runAsSystem(async () => {
        expect(getServerOrigin(undefined, env)).toBe('https://api.example.com');
      });
    });
  });

  it('keeps two concurrent tenants apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b'].map((slug) =>
        tenantStorage.run(
          { tenantId: `tenant-${slug}`, origin: `https://${slug}.chat.example.com` },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, slug === 'a' ? 10 : 1));
            seen.push(`${slug}=${getServerOrigin(undefined, env)}`);
          },
        ),
      ),
    );
    expect(seen.sort()).toEqual(['a=https://a.chat.example.com', 'b=https://b.chat.example.com']);
  });
});
