import { useMemo } from 'react';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { FqnIndex } from '~/utils/fqn';
import { useGetEndpointsQuery } from '~/data-provider';
import { getFqnIndex } from '~/utils/fqn';

const asIs = (model?: string | null) => model ?? undefined;

/**
 * Display name for a raw model id, for places that show a stored message's model (header hover,
 * screen-reader text). Ids of endpoints that opted into `modelDisplay: fqn` get the same label the
 * model picker shows; anything else is returned unchanged.
 */
export default function useModelLabel(): (model?: string | null) => string | undefined {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: models } = useGetModelsQuery();

  return useMemo(() => {
    const indexes: FqnIndex[] = [];
    for (const [name, config] of Object.entries(endpointsConfig ?? {})) {
      const ids = models?.[name];
      if (config?.modelDisplay === 'fqn' && ids) {
        indexes.push(getFqnIndex(ids));
      }
    }
    if (indexes.length === 0) {
      return asIs;
    }
    return (model?: string | null) => {
      for (const index of indexes) {
        const label = model ? index.labels.get(model) : undefined;
        if (label) {
          return label;
        }
      }
      return asIs(model);
    };
  }, [endpointsConfig, models]);
}
