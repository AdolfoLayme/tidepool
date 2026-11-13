/**
 * Fixed layout of the shore, in metres. +y is up, the sea lies toward -z (west), so the sun sets
 * over the water in front of the default camera. North is +x.
 */
export const LAYOUT = {
  /** The main rock pool: centre and half-extents of its warped ellipse. */
  pool: { cx: 0.0, cz: -0.2, rx: 2.35, rz: 1.6, floor: -0.46 },
  /** Gully that drains the pool toward the sea. Its floor sets the spill level. */
  spill: { x: 0.85, z: -1.55, dirX: 0.18, dirZ: -1.0, length: 6.2, width: 0.2, drop: 0.55 },
  /** Small basins above the pool that hold rain and splash water. */
  puddles: [
    { x: 3.75, z: 1.45, r: 0.48, depth: 0.08 },
    { x: -3.55, z: 1.95, r: 0.62, depth: 0.11 },
    { x: -3.1, z: -2.85, r: 0.38, depth: 0.07 },
    { x: 4.35, z: -2.25, r: 0.52, depth: 0.09 },
    { x: 1.75, z: 3.05, r: 0.32, depth: 0.06 },
    { x: -1.35, z: 3.35, r: 0.42, depth: 0.07 },
  ],
  /** Tide extremes for the sea surface. */
  tide: { low: -1.1, high: 0.34 },
  /** Size of the generated rock shelf. */
  extent: { minX: -34, maxX: 34, minZ: -30, maxZ: 22 },
  /** Region carved at full resolution. */
  detail: { minX: -5.5, maxX: 5.5, minZ: -5.5, maxZ: 4.5 },
  /** Basalt column size. */
  cell: 0.92,
} as const;

export type Bounds2 = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Region covered by the water simulation, caustics and the terrain height texture near the pool. */
export const POOL_BOUNDS: Bounds2 = { minX: -3.4, maxX: 3.4, minZ: -2.6, maxZ: 2.2 };

/** Region covered by the shore height texture used by water and foam. */
export const SHORE_BOUNDS: Bounds2 = { minX: -34, maxX: 34, minZ: -30, maxZ: 22 };
