import React from 'react';
import { TStartupConfig } from 'librechat-data-provider';
import type { FqnIndex } from '~/utils/fqn';

export interface Endpoint {
  value: string;
  label: string;
  hasModels: boolean;
  models?: Array<{ name: string; isGlobal?: boolean }>;
  icon: React.ReactNode;
  agentNames?: Record<string, string>;
  assistantNames?: Record<string, string>;
  modelIcons?: Record<string, string | undefined>;
  showMarketplace?: boolean;
  searchAliases?: string[];
  /** Present only when the endpoint opts into `modelDisplay: fqn`; display data only. */
  fqnIndex?: FqnIndex;
  /** Lists nothing until the user stores a key; see `endpointSchema.requireUserKey`. */
  requireUserKey?: boolean;
}

export interface SelectedValues {
  endpoint: string | null;
  model: string | null;
  modelSpec: string | null;
}

export interface ModelSelectorProps {
  startupConfig: TStartupConfig | undefined;
}
