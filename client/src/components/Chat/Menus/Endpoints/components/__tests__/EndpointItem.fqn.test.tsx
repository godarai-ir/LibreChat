import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointItem } from '../EndpointItem';
import { buildFqnIndex } from '~/utils/fqn';

const mockHandleSelectModel = jest.fn();
let mockSelectedValues: SelectedValues;
let mockSearchValue = '';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({
    isFavoriteModel: () => false,
    toggleFavoriteModel: jest.fn(),
    isFavoriteAgent: () => false,
    toggleFavoriteAgent: jest.fn(),
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    agentsMap: undefined,
    assistantsMap: undefined,
    modelSpecs: [],
    selectedValues: mockSelectedValues,
    endpointSearchValues: { Gateway: mockSearchValue },
    handleOpenKeyDialog: jest.fn(),
    handleSelectEndpoint: jest.fn(),
    handleSelectModel: mockHandleSelectModel,
    setEndpointSearchValue: jest.fn(),
    endpointRequiresUserKey: () => false,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenu: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', null, children),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
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

const ids = [
  'openai:acme-main:gpt-4o',
  'openai:acme-backup:gpt-4o',
  'anthropic:team-b:claude-sonnet-4',
];

const gateway = (withIndex: boolean): Endpoint => ({
  value: 'Gateway',
  label: 'Gateway',
  hasModels: true,
  icon: null,
  models: ids.map((name) => ({ name })),
  fqnIndex: withIndex ? buildFqnIndex(ids) : undefined,
});

describe('EndpointItem model rows for an fqn endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchValue = '';
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
  });

  it('groups by provider and selects the full FQN', () => {
    const endpoint = gateway(true);
    render(<EndpointItem endpoint={endpoint} endpointIndex={0} />);

    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => within(group).getByRole('heading').textContent)).toEqual([
      'anthropic',
      'openai',
    ]);

    fireEvent.click(screen.getByText('gpt-4o (acme-backup)'));
    expect(mockHandleSelectModel).toHaveBeenCalledWith(endpoint, 'openai:acme-backup:gpt-4o');
  });

  it('filters by display name or raw FQN and keeps account-qualified labels', () => {
    mockSearchValue = 'acme-main';
    render(<EndpointItem endpoint={gateway(true)} endpointIndex={0} />);

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'gpt-4o (acme-main)',
    ]);
  });

  it('renders no groups when the search matches nothing', () => {
    mockSearchValue = 'zzz';
    render(<EndpointItem endpoint={gateway(true)} endpointIndex={0} />);

    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('keeps the flat raw-id list when the endpoint did not opt in', () => {
    render(<EndpointItem endpoint={gateway(false)} endpointIndex={0} />);

    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(ids);
  });
});
