/**
 * Presentation of gateway model ids shaped `<provider>:<account>:<model>`.
 *
 * Everything here is display-only. The id a user picks, and the one stored on a conversation or
 * sent as `model`, is always the original string: it is only ever a lookup key into the index.
 */

export interface FqnParts {
  provider: string;
  account: string;
  model: string;
}

export interface FqnGroup {
  /** `null` collects ids that are not a well-formed FQN. */
  provider: string | null;
  /** Full ids, in display order. */
  models: string[];
}

export interface FqnIndex {
  /** Full id → name shown for it. Covers every id the index was built from. */
  labels: Map<string, string>;
  /** Providers alphabetically, then the unparsed ids last. */
  groups: FqnGroup[];
}

const SEPARATOR = ':';
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const compare = (a: string, b: string): number => {
  const result = collator.compare(a, b);
  if (result !== 0) {
    return result;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** Exactly three non-blank parts split on `:`; anything else is not an FQN. */
export function parseFqn(id: string): FqnParts | null {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part.trim() === '')) {
    return null;
  }
  const [provider, account, model] = parts;
  return { provider, account, model };
}

/**
 * Parses, groups and labels `ids` once. Labels depend on the whole list (a model is only
 * qualified with its account when a sibling account in the same provider serves it too), so the
 * index must be built from the unfiltered list and reused for any subset.
 */
export function buildFqnIndex(ids: readonly string[]): FqnIndex {
  const parsed = new Map<string, FqnParts>();
  const unparsed: string[] = [];
  /** provider → model name → accounts serving it. Duplicates are not counted by design. */
  const accounts = new Map<string, Map<string, Set<string>>>();

  for (const id of new Set(ids)) {
    const parts = parseFqn(id);
    if (!parts) {
      unparsed.push(id);
      continue;
    }
    parsed.set(id, parts);
    let byModel = accounts.get(parts.provider);
    if (!byModel) {
      byModel = new Map();
      accounts.set(parts.provider, byModel);
    }
    const serving = byModel.get(parts.model);
    if (serving) {
      serving.add(parts.account);
    } else {
      byModel.set(parts.model, new Set([parts.account]));
    }
  }

  const labels = new Map<string, string>();
  const byProvider = new Map<string, Array<[string, FqnParts]>>();
  for (const [id, parts] of parsed) {
    const shared = (accounts.get(parts.provider)?.get(parts.model)?.size ?? 0) > 1;
    labels.set(id, shared ? `${parts.model} (${parts.account})` : parts.model);
    const entries = byProvider.get(parts.provider);
    if (entries) {
      entries.push([id, parts]);
    } else {
      byProvider.set(parts.provider, [[id, parts]]);
    }
  }

  const groups: FqnGroup[] = [...byProvider.keys()].sort(compare).map((provider) => ({
    provider,
    models: (byProvider.get(provider) ?? [])
      .sort(
        ([idA, a], [idB, b]) =>
          compare(a.model, b.model) || compare(a.account, b.account) || compare(idA, idB),
      )
      .map(([id]) => id),
  }));

  if (unparsed.length > 0) {
    unparsed.sort(compare);
    for (const id of unparsed) {
      labels.set(id, id);
    }
    groups.push({ provider: null, models: unparsed });
  }

  return { labels, groups };
}

/** Restricts the index's groups to `ids` (e.g. search matches), keeping order and dropping empties. */
export function groupFqnModels(index: FqnIndex, ids: readonly string[]): FqnGroup[] {
  const wanted = new Set(ids);
  const result: FqnGroup[] = [];
  for (const group of index.groups) {
    const models = group.models.filter((id) => wanted.has(id));
    if (models.length > 0) {
      result.push({ provider: group.provider, models });
    }
  }
  return result;
}

const indexes = new WeakMap<readonly string[], FqnIndex>();

/** `buildFqnIndex` memoized by list identity, for readers that rerun on every render. */
export function getFqnIndex(ids: readonly string[]): FqnIndex {
  let index = indexes.get(ids);
  if (!index) {
    index = buildFqnIndex(ids);
    indexes.set(ids, index);
  }
  return index;
}
