import { fireEvent, render, screen } from '@testing-library/react';
import type { Endpoint } from '~/common';
import { EndpointItem } from '../EndpointItem';

const mockHandleSelectEndpoint = jest.fn();
const mockHandleOpenKeyDialog = jest.fn();
let mockHasKey: boolean | undefined;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useUserKey: () => ({ hasKey: mockHasKey }),
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
    selectedValues: { endpoint: '', model: '', modelSpec: '' },
    endpointSearchValues: {},
    handleOpenKeyDialog: mockHandleOpenKeyDialog,
    handleSelectEndpoint: mockHandleSelectEndpoint,
    handleSelectModel: jest.fn(),
    setEndpointSearchValue: jest.fn(),
    endpointRequiresUserKey: () => true,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenu: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'submenu' }, label, children),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
    CustomMenuGroup: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { role: 'group' }, children),
  };
});

const godar = (overrides: Partial<Endpoint> = {}): Endpoint => ({
  value: 'Godar',
  label: 'Godar',
  hasModels: false,
  icon: null,
  requireUserKey: true,
  ...overrides,
});

describe('EndpointItem for an endpoint that requires the user key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasKey = false;
  });

  it('shows a row that asks for the key and has no model list', () => {
    render(<EndpointItem endpoint={godar()} endpointIndex={0} />);

    expect(screen.getByText('com_endpoint_key_required')).toBeInTheDocument();
    expect(screen.queryByTestId('submenu')).toBeNull();
    expect(screen.getByRole('button', { name: /com_endpoint_config_key Godar/ })).toBeVisible();
  });

  it('never selects the endpoint; clicking the row opens the key dialog instead', () => {
    render(<EndpointItem endpoint={godar()} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('menuitem'));

    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
    expect(mockHandleOpenKeyDialog).toHaveBeenCalledTimes(1);
    expect(mockHandleOpenKeyDialog.mock.calls[0][0]).toBe('Godar');
  });

  it('opens the key dialog from the key button without selecting', () => {
    render(<EndpointItem endpoint={godar()} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: /com_endpoint_config_key/ }));

    expect(mockHandleOpenKeyDialog).toHaveBeenCalledTimes(1);
    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
  });

  it('says the key lists nothing once a key exists but no model comes back', () => {
    mockHasKey = true;
    render(<EndpointItem endpoint={godar()} endpointIndex={0} />);

    expect(screen.getByText('com_endpoint_key_no_models')).toBeInTheDocument();
    expect(screen.queryByText('com_endpoint_key_required')).toBeNull();
  });

  it('becomes the normal model menu once models arrive', () => {
    render(
      <EndpointItem
        endpoint={godar({ hasModels: true, models: [{ name: 'openai:acme:gpt-4o' }] })}
        endpointIndex={0}
      />,
    );

    expect(screen.getByTestId('submenu')).toBeInTheDocument();
    expect(screen.queryByText('com_endpoint_key_required')).toBeNull();
  });

  it('leaves a user-key endpoint without the option as a selectable leaf', () => {
    render(<EndpointItem endpoint={godar({ requireUserKey: undefined })} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('menuitem'));
    expect(mockHandleSelectEndpoint).toHaveBeenCalledTimes(1);
  });
});
