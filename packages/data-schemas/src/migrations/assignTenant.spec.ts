import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SHARED_UNTENANTED_MODELS, assignTenantToUntenantedRows } from './assignTenant';
import { createModels } from '~/models';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

/** Models are inserted through the native collection: this is how legacy rows look. */
const raw = (model: string) => mongoose.models[model].collection;

const find = (model: string, filter: Record<string, unknown> = {}) =>
  raw(model).find(filter).toArray();

beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) {
    await model.collection.deleteMany({});
  }
  await raw('User').insertMany([
    { email: 'legacy-1@example.com', name: 'One' },
    { email: 'legacy-2@example.com', name: 'Two' },
    { email: 'null-tenant@example.com', name: 'Null', tenantId: null },
    { email: 'owned@example.com', name: 'Owned', tenantId: 'tenant-existing' },
  ]);
  await raw('Conversation').insertMany([
    { conversationId: 'c1', user: 'u1', title: 'legacy' },
    { conversationId: 'c2', user: 'u2', title: 'owned', tenantId: 'tenant-existing' },
  ]);
  await raw('Role').insertMany([{ name: 'USER' }, { name: 'ADMIN' }]);
  await raw('SystemGrant').insertMany([{ principalType: 'role', capability: 'access:admin' }]);
  await raw('AccessRole').insertMany([{ accessRoleId: 'agent_owner', name: 'Owner' }]);
});

describe('assignTenantToUntenantedRows', () => {
  it('counts without writing in a dry run', async () => {
    const result = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: true,
    });

    const users = result.models.find((entry) => entry.model === 'User');
    expect(users).toMatchObject({ untenanted: 3, updated: 0 });
    expect(result.dryRun).toBe(true);
    expect(await find('User', { tenantId: 'tenant-a' })).toHaveLength(0);
  });

  it('gives every untenanted row, including a null tenant, to the tenant', async () => {
    const result = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: false,
    });

    expect(result.models.find((entry) => entry.model === 'User')).toMatchObject({
      untenanted: 3,
      updated: 3,
    });
    expect(await find('User', { tenantId: 'tenant-a' })).toHaveLength(3);
    expect(await find('Conversation', { tenantId: 'tenant-a' })).toHaveLength(1);
  });

  it('never moves a row that already belongs to a tenant', async () => {
    await assignTenantToUntenantedRows(mongoose, { tenantId: 'tenant-a', dryRun: false });

    const owned = await find('User', { email: 'owned@example.com' });
    expect(owned[0].tenantId).toBe('tenant-existing');
    const ownedConversation = await find('Conversation', { conversationId: 'c2' });
    expect(ownedConversation[0].tenantId).toBe('tenant-existing');
  });

  it('leaves the rows that every tenant shares untenanted', async () => {
    await assignTenantToUntenantedRows(mongoose, { tenantId: 'tenant-a', dryRun: false });

    for (const model of ['Role', 'SystemGrant', 'AccessRole']) {
      const rows = await find(model);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.tenantId == null)).toBe(true);
    }
  });

  it('does not report the shared models at all', async () => {
    const result = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: true,
    });

    const names = result.models.map((entry) => entry.model);
    for (const shared of SHARED_UNTENANTED_MODELS) {
      expect(names).not.toContain(shared);
    }
    expect(names).toContain('User');
    expect(names).toContain('Conversation');
  });

  it('is safe to run again', async () => {
    await assignTenantToUntenantedRows(mongoose, { tenantId: 'tenant-a', dryRun: false });
    const again = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: false,
    });

    expect(again.models.every((entry) => entry.untenanted === 0 && entry.updated === 0)).toBe(true);
  });

  it('honors extra models to skip', async () => {
    const result = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: false,
      skipModels: ['Conversation'],
    });

    expect(result.models.map((entry) => entry.model)).not.toContain('Conversation');
    expect(await find('Conversation', { tenantId: 'tenant-a' })).toHaveLength(0);
  });

  it('lists the models alphabetically with their collections', async () => {
    const result = await assignTenantToUntenantedRows(mongoose, {
      tenantId: 'tenant-a',
      dryRun: true,
    });

    const names = result.models.map((entry) => entry.model);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(result.models.find((entry) => entry.model === 'User')?.collection).toBe('users');
  });

  it.each(['__SYSTEM__', '', '-lead', 'a/b', '../x', 'has space'])(
    'refuses the tenant id %p',
    async (tenantId) => {
      await expect(
        assignTenantToUntenantedRows(mongoose, { tenantId, dryRun: false }),
      ).rejects.toThrow();
      expect(await find('User', { tenantId })).toHaveLength(0);
    },
  );

  it('refuses a tenant id that is not a string', async () => {
    await expect(
      assignTenantToUntenantedRows(mongoose, {
        tenantId: { $ne: 'x' } as unknown as string,
        dryRun: false,
      }),
    ).rejects.toThrow();
  });
});
