import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GodarSeat } from '~/data-provider/Godar/queries';
import Error from '../Error';

const mockMutate = jest.fn();
let mockSeat: GodarSeat | null = null;

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, unknown>): string => {
      const template =
        (jest.requireActual('~/locales/en/translation.json') as Record<string, string>)[key] ?? key;
      if (!values) {
        return template;
      }
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        values[name] != null ? String(values[name]) : match,
      );
    },
  useHasAccess: () => false,
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
  useGetStartupConfig: jest.fn(() => ({ data: {} })),
}));

jest.mock('~/data-provider/Godar/queries', () => ({
  useGodarSeatQuery: () => ({ data: mockSeat }),
  useRequestGodarSeatMutation: () => ({
    mutate: mockMutate,
    isLoading: false,
    isSuccess: false,
    isError: false,
  }),
}));

function seat(overrides: Partial<GodarSeat> = {}): GodarSeat {
  return {
    enabled: true,
    enforced: true,
    type: 'free',
    monthly_credits: '500.00',
    remaining_credits: '0.00',
    lifetime: true,
    pool_access: false,
    pool_limit_credits: null,
    pool_used_credits: '0.00',
    upgrade_requestable: true,
    pending_request: '',
    ...overrides,
  };
}

/**
 * A gateway 402 as the agents backend persists it: the provider's text is withheld and only a
 * code listed in `endpoints.agents.providerErrorCodes` is named beside the upstream error type.
 */
function gatewayRefusal(code: string) {
  return `The model provider could not complete this request.\n${JSON.stringify({
    type: 'upstream_model_error',
    code,
    status: 402,
  })}`;
}

describe('SeatError', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockSeat = null;
  });

  it('explains a used-up free seat and asks for an upgrade with the block reason', () => {
    mockSeat = seat();
    render(<Error text={gatewayRefusal('seat_credits_exhausted')} />);

    expect(screen.getByText('Your free seat credits are used up.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Request a Pro seat' }));
    expect(mockMutate).toHaveBeenCalledWith({
      seat: 'pro',
      block_reason: 'seat_credits_exhausted',
    });
    expect(screen.getByRole('button', { name: 'Request a Max seat' })).toBeInTheDocument();
  });

  it('shows a request that is already waiting instead of the buttons', () => {
    mockSeat = seat({ type: 'pro', pending_request: 'max', upgrade_requestable: false });
    render(<Error text={gatewayRefusal('personal_limit_reached')} />);

    expect(
      screen.getByText('You reached your personal usage limit for this month.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You asked for a Max seat.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('sends the member to an administrator when the organization is out of credits', () => {
    render(<Error text={gatewayRefusal('pool_exhausted')} />);

    expect(screen.getByText('Your organization has no credits left.')).toBeInTheDocument();
    expect(screen.getByText("Contact your organization's administrator.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('leaves a 402 without a listed code to the generic model error', () => {
    render(
      <Error
        text={`The model provider could not complete this request.\n${JSON.stringify({
          type: 'upstream_model_error',
          status: 402,
        })}`}
      />,
    );

    expect(
      screen.queryByText("Contact your organization's administrator."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /seat/i })).not.toBeInTheDocument();
  });
});
