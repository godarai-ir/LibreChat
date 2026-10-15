import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, filterModels, getDisplayValue, shortModelName } from '../utils';
import { buildFqnIndex } from '~/utils/fqn';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });
});

describe('model selector trigger label', () => {
  const localize = ((key: string) => key) as ReturnType<typeof useLocalize>;
  const openAI: Endpoint = { value: 'openAI', label: 'OpenAI', hasModels: true, icon: null };

  it('keeps the model name from a namespaced gateway id', () => {
    expect(shortModelName('openai:openai-nimble-breeze:gpt-6-luna')).toBe('gpt-6-luna');
    expect(shortModelName('meta-llama/Llama-3-70b')).toBe('Llama-3-70b');
    expect(shortModelName('gpt-4o')).toBe('gpt-4o');
  });

  it('labels a raw model selection by its short name', () => {
    const label = getDisplayValue({
      localize,
      modelSpecs: [],
      mappedEndpoints: [openAI],
      selectedValues: {
        endpoint: 'openAI',
        model: 'openai:openai-nimble-breeze:gpt-6-luna',
        modelSpec: '',
      },
    });
    expect(label).toBe('gpt-6-luna');
  });
});

describe('fqn model display', () => {
  const localize = ((key: string) => key) as ReturnType<typeof useLocalize>;
  const ids = [
    'openai:acme-main:gpt-4o',
    'openai:acme-backup:gpt-4o',
    'anthropic:team-b:claude-sonnet-4',
  ];
  const gateway: Endpoint = {
    value: 'Gateway',
    label: 'Gateway',
    hasModels: true,
    icon: null,
    models: ids.map((name) => ({ name })),
    fqnIndex: buildFqnIndex(ids),
  };

  it('finds a model by its display name or by its raw id', () => {
    expect(filterModels(gateway, ids, 'gpt-4o (acme-main)', undefined, undefined)).toEqual([
      'openai:acme-main:gpt-4o',
    ]);
    expect(filterModels(gateway, ids, 'anthropic:team-b', undefined, undefined)).toEqual([
      'anthropic:team-b:claude-sonnet-4',
    ]);
    expect(filterModels(gateway, ids, 'SONNET', undefined, undefined)).toEqual([
      'anthropic:team-b:claude-sonnet-4',
    ]);
  });

  it('matches the endpoint in the top-level search through a model display name', () => {
    expect(filterItems([gateway], 'gpt-4o (acme-backup)', undefined, undefined)).toEqual([gateway]);
    expect(filterItems([gateway], 'no-such-model', undefined, undefined)).toEqual([]);
  });

  it('shows the display name of the selected FQN in the trigger', () => {
    const label = (model: string) =>
      getDisplayValue({
        localize,
        modelSpecs: [],
        mappedEndpoints: [gateway],
        selectedValues: { endpoint: 'Gateway', model, modelSpec: '' },
      });
    expect(label('openai:acme-backup:gpt-4o')).toBe('gpt-4o (acme-backup)');
    expect(label('anthropic:team-b:claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('keeps the existing short name for a stored FQN that is no longer listed', () => {
    const label = getDisplayValue({
      localize,
      modelSpecs: [],
      mappedEndpoints: [gateway],
      selectedValues: { endpoint: 'Gateway', model: 'openai:retired:gpt-3', modelSpec: '' },
    });
    expect(label).toBe('gpt-3');
  });

  it('is inert for an endpoint without an fqn index', () => {
    const plain: Endpoint = { ...gateway, fqnIndex: undefined };
    expect(filterModels(plain, ids, 'gpt-4o (acme-main)', undefined, undefined)).toEqual([]);
  });
});
