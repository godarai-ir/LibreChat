import { reservedSlugsFromEnv } from './config';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = ['active', 'suspended', 'deleting'] as const;

type Status = (typeof STATUSES)[number];

interface CliTenant {
  tenantId: string;
  slug: string;
  status: Status;
  oidc: { issuer?: string; clientId: string; clientSecret: string; scopes?: string[] };
}

type CliResult =
  | { ok: true; value: CliTenant }
  | { ok: false; error: { code: string; message?: string } };

export interface TenantCliDeps {
  methods: {
    getTenantById(tenantId: string): Promise<CliTenant | null>;
    getTenantBySlug(slug: string): Promise<CliTenant | null>;
    listTenants(filter?: { status?: Status }): Promise<CliTenant[]>;
    createTenant(input: {
      tenantId: string;
      slug: string;
      status?: Status;
      oidc: CliTenant['oidc'];
    }): Promise<CliResult>;
    updateTenant(
      tenantId: string,
      update: { slug?: string; status?: Status; oidc?: Partial<CliTenant['oidc']> },
    ): Promise<CliResult>;
  };
  /** Encrypts a client secret for storage (`encryptV3`). */
  encryptSecret(plain: string): string;
  /** Reads the client secret from the environment or stdin; it is never accepted as an argument. */
  readSecret(): Promise<string | undefined>;
  env: Readonly<Record<string, string | undefined>>;
  print(line: string): void;
  printError(line: string): void;
}

export const TENANT_CLI_USAGE = [
  'Usage: node config/tenant.js <command> [options]',
  '',
  'Commands:',
  '  create         --tenant-id <id> --slug <slug> --client-id <id> [--issuer <https url>] [--scopes "a b"]',
  '  rotate-secret  --tenant-id <id>',
  '  set-status     --tenant-id <id> --status active|suspended|deleting',
  '  rename         --tenant-id <id> --slug <new slug>',
  '  list           [--status active|suspended|deleting]',
  '',
  'The OIDC client secret is read from TENANT_OIDC_CLIENT_SECRET or, if unset, from stdin.',
  'It is never accepted as an argument and never printed.',
].join('\n');

function parseFlags(args: string[]): Map<string, string> | string {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) {
      return `Expected "--flag value", received "${name.slice(0, 40)}"`;
    }
    if (flags.has(name.slice(2))) {
      return `Duplicate option ${name}`;
    }
    flags.set(name.slice(2), value);
  }
  return flags;
}

const describe = (tenant: CliTenant): string =>
  [
    `tenantId=${tenant.tenantId}`,
    `slug=${tenant.slug}`,
    `status=${tenant.status}`,
    `clientId=${tenant.oidc.clientId}`,
    `issuer=${tenant.oidc.issuer ?? '(template)'}`,
  ].join('  ');

/**
 * Runs one registry command and returns the process exit code. Pure with respect to its
 * dependencies, so everything it does is testable without a database or a terminal.
 */
export async function runTenantCommand(args: string[], deps: TenantCliDeps): Promise<number> {
  const [command, ...rest] = args;
  const fail = (message: string): number => {
    deps.printError(message);
    return 1;
  };

  if (!command || command === '--help' || command === '-h') {
    deps.print(TENANT_CLI_USAGE);
    return command ? 0 : 1;
  }

  const parsed = parseFlags(rest);
  if (typeof parsed === 'string') {
    return fail(parsed);
  }
  const flags = parsed;
  const tenantId = flags.get('tenant-id');

  const checkSlug = (slug: string | undefined): string | null => {
    if (!slug || !SLUG_PATTERN.test(slug.toLowerCase())) {
      return '--slug must be a lowercase DNS label (letters, digits, hyphens; max 63)';
    }
    if (reservedSlugsFromEnv(deps.env).has(slug.toLowerCase())) {
      return `--slug "${slug.toLowerCase()}" is reserved and cannot be a tenant`;
    }
    return null;
  };
  const checkTenantId = (): string | null =>
    tenantId && TENANT_ID_PATTERN.test(tenantId)
      ? null
      : '--tenant-id is required (letters, digits, ".", "_", "-"; must start with a letter or digit)';

  if (command === 'list') {
    const status = flags.get('status') as Status | undefined;
    if (status && !STATUSES.includes(status)) {
      return fail(`--status must be one of ${STATUSES.join(', ')}`);
    }
    const tenants = await deps.methods.listTenants(status ? { status } : {});
    tenants.forEach((tenant) => deps.print(describe(tenant)));
    deps.print(`${tenants.length} tenant(s)`);
    return 0;
  }

  const idProblem = checkTenantId();
  if (idProblem) {
    return fail(idProblem);
  }

  const report = (result: CliResult, verb: string): number => {
    if (!result.ok) {
      return fail(`${verb} failed: ${result.error.code}`);
    }
    deps.print(`${verb}: ${describe(result.value)}`);
    return 0;
  };

  if (command === 'create') {
    const slug = flags.get('slug');
    const clientId = flags.get('client-id');
    const issuer = flags.get('issuer');
    const slugProblem = checkSlug(slug);
    if (slugProblem) {
      return fail(slugProblem);
    }
    if (!clientId) {
      return fail('--client-id is required');
    }
    if (issuer && !issuer.startsWith('https://')) {
      return fail('--issuer must be an https URL');
    }
    const secret = await deps.readSecret();
    if (!secret) {
      return fail('No client secret: set TENANT_OIDC_CLIENT_SECRET or pipe it on stdin');
    }
    const scopes = flags.get('scopes')?.split(/\s+/).filter(Boolean);
    return report(
      await deps.methods.createTenant({
        tenantId: tenantId as string,
        slug: (slug as string).toLowerCase(),
        oidc: {
          clientId,
          clientSecret: deps.encryptSecret(secret),
          ...(issuer && { issuer }),
          ...(scopes?.length && { scopes }),
        },
      }),
      'created',
    );
  }

  if (command === 'rotate-secret') {
    const secret = await deps.readSecret();
    if (!secret) {
      return fail('No client secret: set TENANT_OIDC_CLIENT_SECRET or pipe it on stdin');
    }
    return report(
      await deps.methods.updateTenant(tenantId as string, {
        oidc: { clientSecret: deps.encryptSecret(secret) },
      }),
      'secret rotated',
    );
  }

  if (command === 'set-status') {
    const status = flags.get('status') as Status | undefined;
    if (!status || !STATUSES.includes(status)) {
      return fail(`--status must be one of ${STATUSES.join(', ')}`);
    }
    return report(await deps.methods.updateTenant(tenantId as string, { status }), 'status set');
  }

  if (command === 'rename') {
    const slug = flags.get('slug');
    const slugProblem = checkSlug(slug);
    if (slugProblem) {
      return fail(slugProblem);
    }
    return report(
      await deps.methods.updateTenant(tenantId as string, { slug: (slug as string).toLowerCase() }),
      'renamed',
    );
  }

  deps.printError(TENANT_CLI_USAGE);
  return fail(`Unknown command "${command.slice(0, 40)}"`);
}
