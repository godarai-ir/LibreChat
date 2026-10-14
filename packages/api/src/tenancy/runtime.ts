import type { RequestHandler } from 'express';
import type { StoredTenant, TenantRegistry } from './registry';
import type { HostTenancyConfig } from './config';
import { createHostTenantMiddleware } from './host';
import { createTenantRegistry } from './registry';

export interface HostTenancyRuntimeDeps {
  config: HostTenancyConfig;
  findBySlug(slug: string): Promise<StoredTenant | null>;
  decryptSecret(encrypted: string): string;
}

export interface HostTenancyRuntime {
  registry: TenantRegistry;
  middleware: RequestHandler;
}

/**
 * Builds the host-mode pieces the server mounts. Returns `null` when the mode is off, so the
 * caller's wiring is a single `if` and single-tenant deployments are untouched.
 */
export function createHostTenancyRuntime({
  config,
  findBySlug,
  decryptSecret,
}: HostTenancyRuntimeDeps): HostTenancyRuntime | null {
  if (!config.enabled) {
    return null;
  }

  const registry = createTenantRegistry(
    { findBySlug, decryptSecret },
    { issuerTemplate: config.issuerTemplate },
  );

  return { registry, middleware: createHostTenantMiddleware({ config, registry }) };
}
