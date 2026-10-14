import type { AssignTenantCliDeps } from './assign';
import { runAssignTenantCommand } from './assign';

const setup = (overrides: Partial<AssignTenantCliDeps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const assign = jest.fn(async ({ tenantId, dryRun }: { tenantId: string; dryRun: boolean }) => ({
    tenantId,
    dryRun,
    models: [
      { model: 'User', collection: 'users', untenanted: 3, updated: dryRun ? 0 : 3 },
      { model: 'Message', collection: 'messages', untenanted: 0, updated: 0 },
    ],
  }));
  const getTenantById = jest.fn(async (tenantId: string) =>
    tenantId === 'tenant-a' ? { tenantId, slug: 'acme' } : null,
  );
  const deps: AssignTenantCliDeps = {
    assign,
    getTenantById,
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    ...overrides,
  };
  return { deps, assign, getTenantById, out, err };
};

describe('runAssignTenantCommand', () => {
  it('is a dry run unless --apply is given', async () => {
    const { deps, assign, out } = setup();

    expect(await runAssignTenantCommand(['--tenant-id', 'tenant-a'], deps)).toBe(0);

    expect(assign).toHaveBeenCalledWith({ tenantId: 'tenant-a', dryRun: true, skipModels: [] });
    expect(out.join('\n')).toContain('DRY RUN (nothing written)');
    expect(out.join('\n')).toContain('Run again with --apply');
  });

  it('writes only with --apply', async () => {
    const { deps, assign, out } = setup();

    expect(await runAssignTenantCommand(['--tenant-id', 'tenant-a', '--apply'], deps)).toBe(0);

    expect(assign).toHaveBeenCalledWith({ tenantId: 'tenant-a', dryRun: false, skipModels: [] });
    expect(out.join('\n')).toContain('APPLIED');
    expect(out.join('\n')).not.toContain('Run again with --apply');
  });

  it('refuses a tenant that is not in the registry, without touching any data', async () => {
    const { deps, assign, err } = setup();

    expect(await runAssignTenantCommand(['--tenant-id', 'ghost', '--apply'], deps)).toBe(1);

    expect(assign).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('not in the registry');
  });

  it('requires a tenant id', async () => {
    const { deps, assign, err } = setup();

    expect(await runAssignTenantCommand(['--apply'], deps)).toBe(1);

    expect(assign).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('--tenant-id is required');
  });

  it('passes models to skip', async () => {
    const { deps, assign } = setup();

    await runAssignTenantCommand(
      ['--tenant-id', 'tenant-a', '--skip-models', 'Banner, Preset'],
      deps,
    );

    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ skipModels: ['Banner', 'Preset'] }),
    );
  });

  it.each([
    [['--tenant-id']],
    [['--tenant-id', '--apply']],
    [['--unknown']],
    [['tenant-a']],
    [['--tenant-id', 'tenant-a', '--force']],
  ])('rejects the arguments %p', async (args) => {
    const { deps, assign } = setup();

    expect(await runAssignTenantCommand(args, deps)).toBe(1);

    expect(assign).not.toHaveBeenCalled();
  });

  it('lists only the models that have rows to assign', async () => {
    const { deps, out } = setup();

    await runAssignTenantCommand(['--tenant-id', 'tenant-a'], deps);

    const text = out.join('\n');
    expect(text).toContain('User');
    expect(text).not.toContain('Message');
    expect(text).toContain('3 untenanted row(s) in total.');
  });

  it('says so when there is nothing to assign', async () => {
    const { deps, out } = setup({
      assign: async ({ tenantId, dryRun }) => ({ tenantId, dryRun, models: [] }),
    });

    await runAssignTenantCommand(['--tenant-id', 'tenant-a'], deps);

    expect(out.join('\n')).toContain('Nothing to assign.');
  });

  it('prints usage for --help and writes nothing', async () => {
    const { deps, assign, out } = setup();

    expect(await runAssignTenantCommand(['--help'], deps)).toBe(0);

    expect(out.join('\n')).toContain('Usage:');
    expect(assign).not.toHaveBeenCalled();
  });
});
