import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { buildFqnIndex, groupFqnModels } from '~/utils/fqn';
import { SearchResults } from '../SearchResults';
import GroupedModels from '../GroupedModels';

const mockHandleSelectModel = jest.fn();
const mockVirtualizedModelList = jest.fn();
let mockSelectedValues: SelectedValues;

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    selectedValues: mockSelectedValues,
    handleSelectSpec: jest.fn(),
    handleSelectModel: mockHandleSelectModel,
    handleSelectEndpoint: jest.fn(),
    endpointsConfig: {},
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', tabIndex: 0, ...rest }, children);
    }),
    CustomMenuGroup: ({
      label,
      children,
    }: {
      label?: React.ReactNode;
      children?: React.ReactNode;
    }) =>
      React.createElement(
        'div',
        { role: 'group' },
        React.createElement('h3', null, label),
        children,
      ),
  };
});

jest.mock('~/hooks', () => ({
  useFavorites: () => ({
    isFavoriteModel: () => false,
    toggleFavoriteModel: jest.fn(),
    isFavoriteAgent: () => false,
    toggleFavoriteAgent: jest.fn(),
  }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

jest.mock('../VirtualizedModelList', () => ({
  __esModule: true,
  default: (props: {
    modelIds: string[];
    precedingOptionCount: number;
    listboxSetSize?: number;
  }) => {
    mockVirtualizedModelList(props);
    return <div data-testid="virtualized-group">{props.modelIds.length}</div>;
  },
}));

const ids = [
  'openai:acme-main:gpt-4o',
  'openai:acme-backup:gpt-4o',
  'openai:acme-main:gpt-4o-mini',
  'anthropic:team-b:claude-sonnet-4',
  'legacy-model',
];

const makeEndpoint = (modelIds: string[]): Endpoint => ({
  value: 'Gateway',
  label: 'Gateway',
  hasModels: true,
  icon: null,
  models: modelIds.map((name) => ({ name })),
  fqnIndex: buildFqnIndex(modelIds),
});

const renderGroups = (
  endpoint: Endpoint,
  props: Partial<React.ComponentProps<typeof GroupedModels>> = {},
) =>
  render(
    <GroupedModels
      endpoint={endpoint}
      groups={endpoint.fqnIndex?.groups ?? []}
      isFavorite={() => false}
      onToggleFavorite={jest.fn()}
      globalByName={new Map()}
      searchValue=""
      precedingOptionCount={0}
      {...props}
    />,
  );

const itemTexts = (container: HTMLElement) =>
  within(container)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

describe('GroupedModels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: 'Gateway', model: '', modelSpec: '' };
  });

  it('renders a heading per provider with display names, other group last', () => {
    renderGroups(makeEndpoint(ids));

    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => within(group).getByRole('heading').textContent)).toEqual([
      'anthropic',
      'openai',
      'com_ui_models_other',
    ]);
    expect(itemTexts(groups[0])).toEqual(['claude-sonnet-4']);
    expect(itemTexts(groups[1])).toEqual([
      'gpt-4o (acme-backup)',
      'gpt-4o (acme-main)',
      'gpt-4o-mini',
    ]);
    expect(itemTexts(groups[2])).toEqual(['legacy-model']);
  });

  it('selects with the full FQN, never the display name', () => {
    const endpoint = makeEndpoint(ids);
    renderGroups(endpoint);

    fireEvent.click(screen.getByText('gpt-4o (acme-backup)'));
    expect(mockHandleSelectModel).toHaveBeenLastCalledWith(endpoint, 'openai:acme-backup:gpt-4o');

    fireEvent.click(screen.getByText('legacy-model'));
    expect(mockHandleSelectModel).toHaveBeenLastCalledWith(endpoint, 'legacy-model');
  });

  it('marks only the stored FQN as selected, not its same-named sibling', () => {
    mockSelectedValues = {
      endpoint: 'Gateway',
      model: 'openai:acme-main:gpt-4o',
      modelSpec: '',
    };
    renderGroups(makeEndpoint(ids));

    const selected = screen
      .getAllByRole('menuitem')
      .filter((item) => item.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('gpt-4o (acme-main)');
  });

  it('keeps provider and model names left-to-right', () => {
    renderGroups(makeEndpoint(ids));
    expect(screen.getByText('openai')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('gpt-4o-mini')).toHaveAttribute('dir', 'ltr');
  });

  it('omits positions unless the listbox size is declared', () => {
    renderGroups(makeEndpoint(ids));
    expect(screen.getAllByRole('menuitem')[0]).not.toHaveAttribute('aria-posinset');
  });

  it('numbers rows continuously across groups when the listbox size is declared', () => {
    renderGroups(makeEndpoint(ids), { precedingOptionCount: 2, listboxSetSize: 7 });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('aria-posinset'))).toEqual([
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
    expect(items.every((item) => item.getAttribute('aria-setsize') === '7')).toBe(true);
  });

  it('windows only the provider group that exceeds the threshold, at its own offset', () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `openai:acct:model-${String(i).padStart(3, '0')}`,
    );
    const endpoint = makeEndpoint([...many, 'anthropic:team-b:claude-sonnet-4']);
    renderGroups(endpoint, { listboxSetSize: 102 });

    expect(screen.getAllByTestId('virtualized-group')).toHaveLength(1);
    expect(mockVirtualizedModelList).toHaveBeenCalledWith(
      expect.objectContaining({ precedingOptionCount: 1, listboxSetSize: 102 }),
    );
    expect(screen.getByText('claude-sonnet-4').closest('[role="menuitem"]')).toHaveAttribute(
      'aria-posinset',
      '1',
    );
  });

  it('keeps labels qualified when a filtered view leaves a single account', () => {
    const endpoint = makeEndpoint(ids);
    renderGroups(endpoint, {
      groups: groupFqnModels(endpoint.fqnIndex!, ['openai:acme-main:gpt-4o']),
    });
    expect(screen.getByRole('menuitem').textContent).toBe('gpt-4o (acme-main)');
  });
});

describe('fqn search results', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
  });

  const renderSearch = (endpoint: Endpoint, query: string) =>
    render(
      <SearchResults
        results={[endpoint]}
        localize={((key: string) => key) as never}
        searchValue={query}
      />,
    );

  it('matches the display name and groups the matches', () => {
    renderSearch(makeEndpoint(ids), 'gpt-4o (acme');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'gpt-4o (acme-backup)',
      'gpt-4o (acme-main)',
    ]);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toContain(
      'openai',
    );
  });

  it('matches the raw FQN', () => {
    renderSearch(makeEndpoint(ids), 'anthropic:team-b');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'claude-sonnet-4',
    ]);
  });

  it('selects the full FQN from a search result', () => {
    const endpoint = makeEndpoint(ids);
    renderSearch(endpoint, 'acme-main');
    fireEvent.click(screen.getByText('gpt-4o-mini'));
    expect(mockHandleSelectModel).toHaveBeenCalledWith(endpoint, 'openai:acme-main:gpt-4o-mini');
  });

  it('leaves an endpoint without an fqn index as a flat list', () => {
    const plain = { ...makeEndpoint(ids), fqnIndex: undefined };
    renderSearch(plain, 'claude');
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('menuitem').textContent).toBe('anthropic:team-b:claude-sonnet-4');
  });
});
