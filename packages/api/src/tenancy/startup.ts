import { logger } from '@librechat/data-schemas';
import type { HostTenancyAppConfig, HostTenancyConfig } from './config';
import {
  enforceHostTenancy,
  resolveHostTenancyConfig,
  validateHostTenancyEnv,
  validateHostTenancyAppConfig,
} from './config';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Startup guard, run before the database connects. Throws when `MULTI_TENANT_MODE=host` is set
 * with an environment that cannot isolate tenants; does nothing when the mode is off.
 */
export function assertHostTenancyEnv(env: Env = process.env): HostTenancyConfig {
  const config = resolveHostTenancyConfig(env);
  enforceHostTenancy(validateHostTenancyEnv(config, env));

  if (config.enabled) {
    logger.info('[tenancy] Host multi-tenancy enabled', {
      baseDomain: config.baseDomain,
      issuerTemplate: config.issuerTemplate ?? '(from tenant registry)',
      reservedSlugs: config.reservedSlugs.size,
    });
  }

  return config;
}

/** Startup guard for settings that live in the loaded base application config. */
export function assertHostTenancyAppConfig(
  appConfig: HostTenancyAppConfig | undefined,
  env: Env = process.env,
): void {
  const config = resolveHostTenancyConfig(env);
  enforceHostTenancy(validateHostTenancyAppConfig(config, appConfig));
}
