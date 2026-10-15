import { renderHook } from '@testing-library/react';
import useModelLabel from '../useModelLabel';

let mockEndpoints: Record<string, { modelDisplay?: string }> | undefined;
let mockModels: Record<string, string[]> | undefined;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: mockModels }),
}));

const ids = ['openai:acme-main:gpt-4o', 'openai:acme-backup:gpt-4o', 'anthropic:t:claude-4'];

describe('useModelLabel', () => {
  beforeEach(() => {
    mockEndpoints = { Godar: { modelDisplay: 'fqn' }, Other: {} };
    mockModels = { Godar: ids, Other: ['openai:acme-main:gpt-4o'] };
  });

  it('labels a model of an fqn endpoint the way the picker does', () => {
    const { result } = renderHook(() => useModelLabel());
    expect(result.current('openai:acme-main:gpt-4o')).toBe('gpt-4o (acme-main)');
    expect(result.current('anthropic:t:claude-4')).toBe('claude-4');
  });

  it('returns an unknown or non-fqn id unchanged', () => {
    const { result } = renderHook(() => useModelLabel());
    expect(result.current('gpt-4o')).toBe('gpt-4o');
    expect(result.current('openai:retired:gpt-3')).toBe('openai:retired:gpt-3');
  });

  it('is the identity when no endpoint opted in or nothing has loaded', () => {
    mockEndpoints = { Other: {} };
    const { result } = renderHook(() => useModelLabel());
    expect(result.current('openai:acme-main:gpt-4o')).toBe('openai:acme-main:gpt-4o');

    mockEndpoints = { Godar: { modelDisplay: 'fqn' } };
    mockModels = undefined;
    const { result: unloaded } = renderHook(() => useModelLabel());
    expect(unloaded.current('openai:acme-main:gpt-4o')).toBe('openai:acme-main:gpt-4o');
    expect(unloaded.current(undefined)).toBeUndefined();
  });
});
