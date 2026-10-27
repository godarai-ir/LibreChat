import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SystemRoles, Permissions, PermissionTypes } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  tenantStorage,
  loadDefaultInterface,
} from '@librechat/data-schemas';
import type { TConfigDefaults } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { updateTenantInterfacePermissions } from './permissions';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const oidc = { clientId: 'godarchat', clientSecret: 'v3:enc' };

async function buildAppConfig(): Promise<AppConfig> {
  const config = { interface: { mcpServers: { use: true, create: true } } };
  const configDefaults = { interface: {} } as TConfigDefaults;
  const interfaceConfig = await loadDefaultInterface({ config, configDefaults });
  return { config, interfaceConfig } as unknown as AppConfig;
}

type SyncDeps = Parameters<typeof updateTenantInterfacePermissions>[0];

/** The data-schemas method takes only set flags; the sync may hand it unset ones. */
const updateAccessPermissions: SyncDeps['updateAccessPermissions'] = (roleName, update, roleData) =>
  methods.updateAccessPermissions(
    roleName,
    Object.fromEntries(
      Object.entries(update).map(([type, perms]) => [
        type,
        Object.fromEntries(
          Object.entries(perms ?? {}).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        ),
      ]),
    ),
    roleData ?? undefined,
  );

async function sync(overrides: Partial<SyncDeps> = {}) {
  return updateTenantInterfacePermissions({
    appConfig: await buildAppConfig(),
    listTenants: methods.listTenants,
    getRoleByName: methods.getRoleByName,
    updateAccessPermissions,
    ...overrides,
  });
}

function mcpCreate(tenantId: string, roleName = SystemRoles.USER) {
  return tenantStorage.run({ tenantId }, async () => {
    const role = await methods.getRoleByName(roleName);
    return role?.permissions?.[PermissionTypes.MCP_SERVERS]?.[Permissions.CREATE];
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

beforeEach(async () => {
  await mongoose.models.Role.deleteMany({});
  await mongoose.models.Tenant.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('updateTenantInterfacePermissions', () => {
  it("applies the YAML interface permissions to each tenant's own roles", async () => {
    await methods.createTenant({ tenantId: 'tenant-a', slug: 'alpha', oidc });
    await methods.createTenant({ tenantId: 'tenant-b', slug: 'beta', oidc });
    /** The tenant's USER role already exists with the defaults, as it does in production. */
    expect(await mcpCreate('tenant-a')).toBe(false);

    const result = await sync();

    expect(result).toEqual({ synced: ['tenant-a', 'tenant-b'], failed: [] });
    expect(await mcpCreate('tenant-a')).toBe(true);
    expect(await mcpCreate('tenant-b')).toBe(true);
    expect(await mcpCreate('tenant-a', SystemRoles.ADMIN)).toBe(true);
  });

  it('leaves the system roles and tenants being deleted alone', async () => {
    await methods.createTenant({ tenantId: 'tenant-a', slug: 'alpha', oidc });
    await methods.createTenant({ tenantId: 'tenant-gone', slug: 'gone', oidc });
    await methods.updateTenant('tenant-gone', { status: 'deleting' });

    const result = await sync();

    expect(result.synced).toEqual(['tenant-a']);
    expect(
      await tenantStorage.run({ tenantId: 'tenant-gone' }, () =>
        mongoose.models.Role.countDocuments({}).exec(),
      ),
    ).toBe(0);
    expect(
      await mongoose.models.Role.collection.countDocuments({ tenantId: { $exists: false } }),
    ).toBe(0);
  });

  it('keeps syncing the other tenants when one fails', async () => {
    await methods.createTenant({ tenantId: 'tenant-a', slug: 'alpha', oidc });
    await methods.createTenant({ tenantId: 'tenant-b', slug: 'beta', oidc });
    const getRoleByName: typeof methods.getRoleByName = async (...args) => {
      if (tenantStorage.getStore()?.tenantId === 'tenant-a') {
        throw new Error('connection reset');
      }
      return methods.getRoleByName(...args);
    };

    const result = await sync({ getRoleByName });

    expect(result).toEqual({ synced: ['tenant-b'], failed: ['tenant-a'] });
    expect(await mcpCreate('tenant-b')).toBe(true);
  });
});
