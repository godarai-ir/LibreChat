const { getTenantId, SYSTEM_TENANT_ID } = require('@librechat/data-schemas');

const seen = {};

jest.mock('@librechat/api', () => {
  const { getTenantId: tenantInEffect } = require('@librechat/data-schemas');
  return {
    checkAgentPermissionsMigration: jest.fn(async () => {
      seen.agent = tenantInEffect();
      return {};
    }),
    checkPromptPermissionsMigration: jest.fn(async () => {
      seen.prompt = tenantInEffect();
      return {};
    }),
    logAgentMigrationWarning: jest.fn(),
    logPromptMigrationWarning: jest.fn(),
  };
});

jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const { checkMigrations } = require('./migration');

describe('checkMigrations', () => {
  it('counts every tenant, so it runs in a system context and not in the caller one', async () => {
    expect(getTenantId()).toBeUndefined();

    await checkMigrations();

    expect(seen.agent).toBe(SYSTEM_TENANT_ID);
    expect(seen.prompt).toBe(SYSTEM_TENANT_ID);
  });
});
