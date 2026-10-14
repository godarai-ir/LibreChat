import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { CreateTenantInput } from './tenant';
import { tenantStorage } from '~/config/tenantContext';
import { createTenantModel } from '~/models/tenant';
import { createTenantMethods } from './tenant';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTenantMethods>;

const TENANT_ID = '3f2b8c1e-8d7a-4c53-9b1f-2a6d4e5f7a10';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createTenantModel(mongoose);
  methods = createTenantMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await mongoose.models.Tenant.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Tenant.deleteMany({});
});

const input = (overrides: Partial<CreateTenantInput> = {}): CreateTenantInput => ({
  tenantId: TENANT_ID,
  slug: 'acme',
  oidc: { clientId: 'client-acme', clientSecret: 'v3:iv:ciphertext' },
  ...overrides,
});

describe('createTenant', () => {
  it('creates an active tenant and returns plain data', async () => {
    const result = await methods.createTenant(input());

    expect(result).toEqual({
      ok: true,
      value: {
        tenantId: TENANT_ID,
        slug: 'acme',
        status: 'active',
        oidc: { clientId: 'client-acme', clientSecret: 'v3:iv:ciphertext' },
      },
    });
  });

  it('normalizes the slug to lowercase', async () => {
    const result = await methods.createTenant(input({ slug: '  AcMe ' }));
    expect(result.ok && result.value.slug).toBe('acme');
  });

  it('keeps an issuer override and scopes', async () => {
    const result = await methods.createTenant(
      input({
        oidc: {
          clientId: 'c',
          clientSecret: 'v3:a:b',
          issuer: 'https://acme.example.com',
          scopes: ['openid', 'email'],
        },
      }),
    );
    expect(result.ok && result.value.oidc).toEqual({
      clientId: 'c',
      clientSecret: 'v3:a:b',
      issuer: 'https://acme.example.com',
      scopes: ['openid', 'email'],
    });
  });

  it('reports a duplicate slug as a typed failure', async () => {
    await methods.createTenant(input());
    const result = await methods.createTenant(input({ tenantId: 'other-id' }));
    expect(result).toEqual({ ok: false, error: { code: 'DUPLICATE_SLUG' } });
  });

  it('reports a duplicate tenantId as a typed failure', async () => {
    await methods.createTenant(input());
    const result = await methods.createTenant(input({ slug: 'other' }));
    expect(result).toEqual({ ok: false, error: { code: 'DUPLICATE_TENANT_ID' } });
  });

  it('refuses a plaintext client secret', async () => {
    await expect(
      methods.createTenant(input({ oidc: { clientId: 'c', clientSecret: 'plaintext-secret' } })),
    ).rejects.toThrow(/encrypted/);
    expect(await methods.listTenants()).toEqual([]);
  });

  it('refuses an http issuer override', async () => {
    await expect(
      methods.createTenant(
        input({ oidc: { clientId: 'c', clientSecret: 'v3:a:b', issuer: 'http://x.example.com' } }),
      ),
    ).rejects.toThrow(/https/);
  });

  it.each(['__SYSTEM__', '-lead', 'has space', 'a/b', '../x', ''])(
    'refuses the tenantId %p',
    async (tenantId) => {
      await expect(methods.createTenant(input({ tenantId }))).rejects.toThrow();
    },
  );

  it.each(['-bad', 'bad-', 'has.dot', 'has_underscore', 'a'.repeat(64)])(
    'refuses the slug %p',
    async (slug) => {
      await expect(methods.createTenant(input({ slug }))).rejects.toThrow();
    },
  );
});

describe('lookups', () => {
  beforeEach(async () => {
    await methods.createTenant(input());
    await methods.createTenant(input({ tenantId: 'tenant-b', slug: 'beta', status: 'suspended' }));
  });

  it('finds by slug case-insensitively and by id', async () => {
    expect((await methods.getTenantBySlug('ACME'))?.tenantId).toBe(TENANT_ID);
    expect((await methods.getTenantById('tenant-b'))?.slug).toBe('beta');
  });

  it('returns null for an unknown slug or id', async () => {
    expect(await methods.getTenantBySlug('ghost')).toBeNull();
    expect(await methods.getTenantById('ghost')).toBeNull();
  });

  it('does not treat a query operator as a lookup value', async () => {
    const operator = { $ne: 'nobody' } as unknown as string;
    expect(await methods.getTenantBySlug(operator)).toBeNull();
    expect(await methods.getTenantById(operator)).toBeNull();
  });

  it('lists all tenants sorted by slug, or only one status', async () => {
    expect((await methods.listTenants()).map((t) => t.slug)).toEqual(['acme', 'beta']);
    expect((await methods.listTenants({ status: 'suspended' })).map((t) => t.slug)).toEqual([
      'beta',
    ]);
  });

  it('ignores the ambient tenant context: the registry is cross-tenant', async () => {
    const found = await tenantStorage.run({ tenantId: 'someone-else' }, () =>
      methods.getTenantBySlug('acme'),
    );
    expect(found?.slug).toBe('acme');
  });
});

describe('updateTenant', () => {
  beforeEach(async () => {
    await methods.createTenant(input());
  });

  it('changes status', async () => {
    const result = await methods.updateTenant(TENANT_ID, { status: 'suspended' });
    expect(result.ok && result.value.status).toBe('suspended');
  });

  it('renames the slug without touching the tenantId', async () => {
    const result = await methods.updateTenant(TENANT_ID, { slug: 'Acme-New' });
    expect(result.ok && result.value.slug).toBe('acme-new');
    expect(result.ok && result.value.tenantId).toBe(TENANT_ID);
    expect(await methods.getTenantBySlug('acme')).toBeNull();
  });

  it('rotates only the given oidc fields', async () => {
    const result = await methods.updateTenant(TENANT_ID, {
      oidc: { clientSecret: 'v3:new:secret' },
    });
    expect(result.ok && result.value.oidc).toEqual({
      clientId: 'client-acme',
      clientSecret: 'v3:new:secret',
    });
  });

  it('refuses to rotate to a plaintext secret', async () => {
    await expect(
      methods.updateTenant(TENANT_ID, { oidc: { clientSecret: 'plain' } }),
    ).rejects.toThrow(/encrypted/);
    expect((await methods.getTenantById(TENANT_ID))?.oidc.clientSecret).toBe('v3:iv:ciphertext');
  });

  it('reports a slug that another tenant owns', async () => {
    await methods.createTenant(input({ tenantId: 'tenant-b', slug: 'beta' }));
    const result = await methods.updateTenant('tenant-b', { slug: 'acme' });
    expect(result).toEqual({ ok: false, error: { code: 'DUPLICATE_SLUG' } });
  });

  it('reports an unknown tenant', async () => {
    expect(await methods.updateTenant('ghost', { status: 'active' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('cannot change the tenantId through a smuggled field', async () => {
    const smuggled = { status: 'active', tenantId: 'hijacked' } as never;
    await methods.updateTenant(TENANT_ID, smuggled);
    expect(await methods.getTenantById('hijacked')).toBeNull();
    expect(await methods.getTenantById(TENANT_ID)).not.toBeNull();
  });
});
