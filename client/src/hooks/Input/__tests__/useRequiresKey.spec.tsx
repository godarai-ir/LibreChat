import { renderHook } from '@testing-library/react';
import useRequiresKey from '../useRequiresKey';

let mockEndpointConfig: Record<string, unknown> | undefined;
let mockHasKey: boolean | undefined;
let mockExpiry: string | undefined;

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: () => ({ conversation: { endpoint: 'Godar' } }),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: { Godar: mockEndpointConfig } }),
}));

jest.mock('../useUserKey', () => ({
  __esModule: true,
  default: () => ({ getExpiry: () => mockExpiry, hasKey: mockHasKey }),
}));

describe('useRequiresKey', () => {
  beforeEach(() => {
    mockEndpointConfig = { userProvide: true, requireUserKey: true };
    mockHasKey = undefined;
    mockExpiry = 'never';
  });

  it('locks the composer when a requireUserKey endpoint has no key', () => {
    mockHasKey = false;
    const { result } = renderHook(() => useRequiresKey());
    expect(result.current.requiresKey).toBe(true);
  });

  it('does not lock it while the answer is still loading', () => {
    mockHasKey = undefined;
    const { result } = renderHook(() => useRequiresKey());
    expect(result.current.requiresKey).toBe(false);
  });

  it('unlocks it once a key is stored', () => {
    mockHasKey = true;
    const { result } = renderHook(() => useRequiresKey());
    expect(result.current.requiresKey).toBe(false);
  });

  it('keeps the existing rule for a user-key endpoint without the option', () => {
    mockEndpointConfig = { userProvide: true };
    mockHasKey = false;
    mockExpiry = 'never';
    const { result } = renderHook(() => useRequiresKey());
    expect(result.current.requiresKey).toBe(false);

    mockExpiry = undefined;
    const { result: unanswered } = renderHook(() => useRequiresKey());
    expect(unanswered.current.requiresKey).toBe(true);
  });
});
