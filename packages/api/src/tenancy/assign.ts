interface AssignModelRow {
  model: string;
  collection: string;
  untenanted: number;
  updated: number;
}

interface AssignRunResult {
  tenantId: string;
  dryRun: boolean;
  models: AssignModelRow[];
}

export interface AssignTenantCliDeps {
  /** Gives every untenanted row to the tenant (`assignTenantToUntenantedRows`). */
  assign(options: {
    tenantId: string;
    dryRun: boolean;
    skipModels?: readonly string[];
  }): Promise<AssignRunResult>;
  /** The tenant registry; the tenant must exist before it is given any data. */
  getTenantById(tenantId: string): Promise<{ tenantId: string; slug: string } | null>;
  print(line: string): void;
  printError(line: string): void;
}

export const ASSIGN_TENANT_USAGE: string = [
  'Usage: node config/assign-tenant.js --tenant-id <id> [--apply] [--skip-models "Model,Model"]',
  '',
  'Gives every row that has no tenant to one tenant, to move an existing single-tenant',
  'deployment into host mode. Without --apply nothing is written: it prints the counts.',
  '',
  'Before --apply:  run `npm run migrate:tenant-indexes`, and create the tenant first',
  '(node config/tenant.js create ...). After:  rebuild the search index.',
].join('\n');

interface ParsedArgs {
  tenantId?: string;
  apply: boolean;
  skipModels: string[];
}

function parseArgs(args: string[]): ParsedArgs | string {
  const parsed: ParsedArgs = { apply: false, skipModels: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    const value = args[i + 1];
    if ((arg === '--tenant-id' || arg === '--skip-models') && value && !value.startsWith('--')) {
      if (arg === '--tenant-id') {
        parsed.tenantId = value;
      } else {
        parsed.skipModels = value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
      }
      i += 1;
      continue;
    }
    return `Unexpected argument "${arg.slice(0, 40)}"`;
  }
  return parsed;
}

/** Runs the assign-tenant command and returns the process exit code. */
export async function runAssignTenantCommand(
  args: string[],
  deps: AssignTenantCliDeps,
): Promise<number> {
  const fail = (message: string): number => {
    deps.printError(message);
    return 1;
  };

  if (args.includes('--help') || args.includes('-h')) {
    deps.print(ASSIGN_TENANT_USAGE);
    return 0;
  }

  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    deps.printError(ASSIGN_TENANT_USAGE);
    return fail(parsed);
  }
  if (!parsed.tenantId) {
    deps.printError(ASSIGN_TENANT_USAGE);
    return fail('--tenant-id is required');
  }

  const tenant = await deps.getTenantById(parsed.tenantId);
  if (!tenant) {
    return fail(
      `Tenant "${parsed.tenantId.slice(0, 64)}" is not in the registry; create it first with config/tenant.js`,
    );
  }

  const result = await deps.assign({
    tenantId: tenant.tenantId,
    dryRun: !parsed.apply,
    skipModels: parsed.skipModels,
  });

  deps.print(
    `${result.dryRun ? 'DRY RUN (nothing written)' : 'APPLIED'} for tenant ${tenant.slug} (${tenant.tenantId})`,
  );
  let total = 0;
  for (const row of result.models) {
    if (row.untenanted === 0) {
      continue;
    }
    total += row.untenanted;
    deps.print(
      `  ${row.model.padEnd(28)} untenanted=${String(row.untenanted).padStart(8)}  updated=${String(row.updated).padStart(8)}`,
    );
  }
  deps.print(total === 0 ? 'Nothing to assign.' : `${total} untenanted row(s) in total.`);
  if (result.dryRun && total > 0) {
    deps.print('Run again with --apply to write these changes.');
  }
  return 0;
}
