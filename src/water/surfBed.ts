import type { Bounds2 } from '../world/layout.ts';

export type SurfRock = { x: number; y: number; z: number; s: number };

/** Rasterize the rendered shelf and loose block tops into a conservative flow bed. */
export function buildSurfBed(
  bounds: Bounds2, size: [number, number], terrainAt: (x: number, z: number) => number, rocks: readonly SurfRock[],
): Float32Array {
  const [w, h] = size;
  const bed = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = bounds.minX + (i + 0.5) * (bounds.maxX - bounds.minX) / w;
    const z = bounds.minZ + (j + 0.5) * (bounds.maxZ - bounds.minZ) / h;
    let top = terrainAt(x, z);
    for (const b of rocks) {
      const r = b.s * 0.82;
      const d2 = ((x - b.x) ** 2 + (z - b.z) ** 2) / (r * r);
      if (d2 < 1) top = Math.max(top, b.y + b.s * 0.78 * Math.sqrt(1 - d2));
    }
    bed[j * w + i] = top;
  }
  return bed;
}
