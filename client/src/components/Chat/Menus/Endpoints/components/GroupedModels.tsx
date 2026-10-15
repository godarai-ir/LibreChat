import type { FqnGroup } from '~/utils/fqn';
import type { Endpoint } from '~/common';
import { EndpointModelItem, VIRTUALIZE_THRESHOLD } from './EndpointModelItem';
import VirtualizedModelList from './VirtualizedModelList';
import { CustomMenuGroup } from '../CustomMenu';
import { useLocalize } from '~/hooks';

/** True when any provider group is long enough to be windowed. */
export const hasVirtualizedGroup = (groups: FqnGroup[]): boolean =>
  groups.some((group) => group.models.length > VIRTUALIZE_THRESHOLD);

interface GroupedModelsProps {
  endpoint: Endpoint;
  groups: FqnGroup[];
  isFavorite: (modelId: string) => boolean;
  onToggleFavorite: (modelId: string) => void;
  globalByName: Map<string, boolean>;
  searchValue: string;
  endpointIndex?: number;
  /** Count of options rendered ahead of these groups in the same listbox. */
  precedingOptionCount: number;
  /**
   * Total options in the surrounding listbox. When set, every row declares its position so
   * windowed groups and plain groups agree; leave it unset when nothing is windowed.
   */
  listboxSetSize?: number;
}

/**
 * Model rows of one endpoint under a heading per provider. Each group is windowed on its own,
 * so a provider with a very long list costs the same as it does in a flat list.
 */
export default function GroupedModels({
  endpoint,
  groups,
  isFavorite,
  onToggleFavorite,
  globalByName,
  searchValue,
  endpointIndex,
  precedingOptionCount,
  listboxSetSize,
}: GroupedModelsProps) {
  const localize = useLocalize();
  const indexSuffix = endpointIndex != null ? `-${endpointIndex}` : '';
  let offset = precedingOptionCount;

  return (
    <>
      {groups.map((group) => {
        const groupOffset = offset;
        offset += group.models.length;
        const groupKey = group.provider ?? '\u0000other';
        return (
          <CustomMenuGroup
            key={groupKey}
            label={
              /** Provider names are identifiers; keep them left-to-right in an RTL interface. */
              <span dir={group.provider != null ? 'ltr' : undefined}>
                {group.provider ?? localize('com_ui_models_other')}
              </span>
            }
          >
            {group.models.length > VIRTUALIZE_THRESHOLD ? (
              <VirtualizedModelList
                key={searchValue}
                endpoint={endpoint}
                modelIds={group.models}
                globalByName={globalByName}
                isFavorite={isFavorite}
                onToggleFavorite={onToggleFavorite}
                endpointIndex={endpointIndex}
                precedingOptionCount={groupOffset}
                listboxSetSize={listboxSetSize}
              />
            ) : (
              group.models.map((modelId, index) => (
                <EndpointModelItem
                  key={`${endpoint.value}${indexSuffix}-${modelId}`}
                  modelId={modelId}
                  endpoint={endpoint}
                  isGlobal={globalByName.get(modelId) ?? false}
                  isFavorite={isFavorite(modelId)}
                  onToggleFavorite={onToggleFavorite}
                  posInSet={listboxSetSize != null ? groupOffset + index + 1 : undefined}
                  setSize={listboxSetSize}
                />
              ))
            )}
          </CustomMenuGroup>
        );
      })}
    </>
  );
}
