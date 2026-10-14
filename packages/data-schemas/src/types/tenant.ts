import type { Document, Types } from 'mongoose';

export type TenantStatus = 'active' | 'suspended' | 'deleting';

export type TenantOidc = {
  /** Overrides the deployment issuer template for this tenant. */
  issuer?: string;
  clientId: string;
  /** Encrypted with `encryptV3` before it reaches the database; never plaintext. */
  clientSecret: string;
  scopes?: string[];
};

/**
 * One row of the host-mode tenant registry. `tenantId` is the immutable identity stamped on every
 * document and file path; `slug` is the mutable host alias (`<slug>.<base domain>`).
 */
export type Tenant = {
  tenantId: string;
  slug: string;
  status: TenantStatus;
  oidc: TenantOidc;
};

export type ITenant = Tenant &
  Document & {
    _id: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
  };
