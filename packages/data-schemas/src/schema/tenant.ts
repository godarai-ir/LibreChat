import { Schema } from 'mongoose';
import type { ITenant } from '~/types';

/** Lowercase DNS label: what a `<slug>.<base domain>` host can carry. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Path-safe and never the system sentinel: it first appears in file keys and cache keys, so it
 * starts with an alphanumeric character (which also excludes `__SYSTEM__`).
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ENCRYPTED_V3_PREFIX = 'v3:';

const tenantSchema: Schema<ITenant> = new Schema<ITenant>(
  {
    tenantId: {
      type: String,
      required: true,
      immutable: true,
      match: TENANT_ID_PATTERN,
    },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: SLUG_PATTERN,
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'deleting'],
      default: 'active',
      required: true,
    },
    oidc: {
      issuer: {
        type: String,
        validate: {
          validator: (value?: string) => value == null || value.startsWith('https://'),
          message: 'oidc.issuer must be an https URL',
        },
      },
      clientId: { type: String, required: true, trim: true },
      clientSecret: {
        type: String,
        required: true,
        validate: {
          validator: (value: string) => value.startsWith(ENCRYPTED_V3_PREFIX),
          message: 'oidc.clientSecret must be stored encrypted (v3), never as plaintext',
        },
      },
      scopes: { type: [String], default: undefined },
    },
  },
  { timestamps: true },
);

tenantSchema.index({ tenantId: 1 }, { unique: true });
tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ status: 1 });

export default tenantSchema;
