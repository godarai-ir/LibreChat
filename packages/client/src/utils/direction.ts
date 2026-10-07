/** Whether the document reads right to left. */
export const isDocumentRTL = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

/**
 * Floating UI mirrors `start`/`end` alignment under RTL but keeps `left`/`right` sides
 * physical. Callers write `left`/`right` for "toward the start/end edge", so swap them
 * when the document reads right to left.
 */
export function mirrorPlacement<T extends string>(placement: T, rtl: boolean = isDocumentRTL()): T {
  if (!rtl) {
    return placement;
  }
  const [side, align] = placement.split('-');
  const mirrored = side === 'left' ? 'right' : side === 'right' ? 'left' : side;
  return (align ? `${mirrored}-${align}` : mirrored) as T;
}
