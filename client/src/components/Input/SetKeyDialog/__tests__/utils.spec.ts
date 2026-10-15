import { hasCurrentKey } from '../utils';

describe('hasCurrentKey', () => {
  it('is false while nothing has been answered', () => {
    expect(hasCurrentKey(undefined, undefined)).toBe(false);
  });

  it('does not announce a key when the server reports none, although getExpiry says never', () => {
    expect(hasCurrentKey('never', false)).toBe(false);
    expect(hasCurrentKey('never', undefined)).toBe(false);
  });

  it('announces a stored key that never expires', () => {
    expect(hasCurrentKey('never', true)).toBe(true);
  });

  it('keeps announcing a dated key, including one that has already expired', () => {
    expect(hasCurrentKey('2026-10-01T00:00:00.000Z', true)).toBe(true);
    expect(hasCurrentKey('2020-01-01T00:00:00.000Z', false)).toBe(true);
  });
});
