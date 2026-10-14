import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createUserModel } from '~/models/user';
import { createUserMethods } from './user';

jest.mock('~/crypto', () => ({
  signPayload: jest.fn().mockResolvedValue('mocked-token'),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createUserMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createUserModel(mongoose);
  methods = createUserMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await mongoose.models.User.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.User.deleteMany({});
  process.env.TENANT_ISOLATION_STRICT = 'true';
  _resetStrictCache();
});

afterEach(() => {
  delete process.env.TENANT_ISOLATION_STRICT;
  _resetStrictCache();
});

const newUser = (email: string, extra: Record<string, unknown> = {}) => ({
  email,
  name: 'Test User',
  username: email.split('@')[0],
  provider: 'openid',
  openidId: `sub-${email}`,
  emailVerified: true,
  ...extra,
});

const createIn = (tenantId: string, email: string, extra: Record<string, unknown> = {}) =>
  tenantStorage.run({ tenantId }, async () =>
    methods.createUserIfAbsent(newUser(email, extra) as never),
  );

describe('users created at sign-in are bound to the tenant of the request', () => {
  it('stamps the tenant of the current context on a new user', async () => {
    const result = await createIn('tenant-a', 'ann@example.com');

    expect(result.ok).toBe(true);
    const stored = await mongoose.models.User.collection.findOne({ email: 'ann@example.com' });
    expect(stored?.tenantId).toBe('tenant-a');
  });

  it('does not let the caller choose another tenant for the new user', async () => {
    const outcome = await createIn('tenant-a', 'mallory@example.com', {
      tenantId: 'tenant-evil',
    }).catch((error: unknown) => error);

    const stored = await mongoose.models.User.collection.findOne({ email: 'mallory@example.com' });
    expect(stored?.tenantId).not.toBe('tenant-evil');
    if (outcome instanceof Error) {
      expect(stored).toBeNull();
    } else {
      expect(stored?.tenantId).toBe('tenant-a');
    }
  });

  it('refuses to create a user when there is no tenant context in strict mode', async () => {
    await expect(
      methods.createUserIfAbsent(newUser('nobody@example.com') as never),
    ).rejects.toThrow();
    expect(
      await mongoose.models.User.collection.findOne({ email: 'nobody@example.com' }),
    ).toBeNull();
  });
});

describe('a user is invisible from another tenant', () => {
  it('finds the user in their own tenant only', async () => {
    await createIn('tenant-a', 'ann@example.com');

    const inA = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.findUser({ email: 'ann@example.com' }),
    );
    const inB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      methods.findUser({ email: 'ann@example.com' }),
    );

    expect(inA?.email).toBe('ann@example.com');
    expect(inB).toBeNull();
  });

  it('does not return a user of another tenant by id, which is how refresh resolves the account', async () => {
    const created = await createIn('tenant-a', 'ann@example.com');
    const id = created.ok ? created.value._id.toString() : '';

    const inB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      methods.getUserById(id, ''),
    );
    const inA = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.getUserById(id, ''),
    );

    expect(inB).toBeNull();
    expect(inA?._id.toString()).toBe(id);
  });

  it('lets the same email exist in two tenants without clashing', async () => {
    const first = await createIn('tenant-a', 'shared@example.com');
    const second = await createIn('tenant-b', 'shared@example.com');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      await mongoose.models.User.collection.countDocuments({ email: 'shared@example.com' }),
    ).toBe(2);
  });

  it('still rejects a duplicate email inside one tenant', async () => {
    await createIn('tenant-a', 'dup@example.com');
    const again = await createIn('tenant-a', 'dup@example.com', { openidId: 'another-sub' });

    expect(again).toEqual({ ok: false, error: { code: 'user_exists' } });
  });

  it('only a deliberate system context reads across tenants', async () => {
    await createIn('tenant-a', 'ann@example.com');
    await createIn('tenant-b', 'bob@example.com');

    const all = await runAsSystem(() => methods.findUsers({}, 'email'));

    expect(all.map((user) => user.email).sort()).toEqual(['ann@example.com', 'bob@example.com']);
  });
});
