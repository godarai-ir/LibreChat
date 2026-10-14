/** Shapes shared by every writer of the tenant registry (CLI and provisioning API). */
export const SLUG_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const TENANT_ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TENANT_STATUSES: readonly ['active', 'suspended', 'deleting'] = [
  'active',
  'suspended',
  'deleting',
];
