import { mirrorPlacement } from './direction';

describe('mirrorPlacement', () => {
  it('keeps every placement under LTR', () => {
    expect(mirrorPlacement('right-start', false)).toBe('right-start');
    expect(mirrorPlacement('left', false)).toBe('left');
  });

  it('swaps left and right sides under RTL and keeps the alignment', () => {
    expect(mirrorPlacement('right', true)).toBe('left');
    expect(mirrorPlacement('left', true)).toBe('right');
    expect(mirrorPlacement('right-start', true)).toBe('left-start');
    expect(mirrorPlacement('left-end', true)).toBe('right-end');
  });

  it('leaves top and bottom placements to Floating UI', () => {
    expect(mirrorPlacement('top-start', true)).toBe('top-start');
    expect(mirrorPlacement('bottom', true)).toBe('bottom');
  });
});
