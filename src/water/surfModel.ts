/** CPU reference for the four-face shallow-water flux used by the shore shader. */
export type SurfGrid = {
  width: number;
  height: number;
  cell: number;
  bed: Float64Array;
  depth: Float64Array;
  /** Outgoing flux per face in E, W, N, S order, metres squared per second. */
  flux: Float64Array;
};

export function makeSurfGrid(width: number, height: number, cell: number): SurfGrid {
  return { width, height, cell, bed: new Float64Array(width * height), depth: new Float64Array(width * height), flux: new Float64Array(width * height * 4) };
}

export function totalWater(g: SurfGrid): number {
  let sum = 0;
  for (const d of g.depth) sum += d;
  return sum * g.cell * g.cell;
}

export function decayFoam(amount: number, dt: number): number {
  return amount * Math.exp(-dt / 2.4);
}

export function stepSurfGrid(g: SurfGrid, dt: number): void {
  const { width: w, height: h, cell, bed, depth } = g;
  const nextFlux = new Float64Array(g.flux.length);
  const delta = new Float64Array(depth.length);
  const neighbors = [1, -1, w, -w];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    const surface = bed[k] + depth[k];
    let out = 0;
    for (let d = 0; d < 4; d++) {
      if ((d === 0 && x === w - 1) || (d === 1 && x === 0) || (d === 2 && y === h - 1) || (d === 3 && y === 0)) continue;
      const n = k + neighbors[d];
      const head = surface - (bed[n] + depth[n]);
      if (surface <= bed[n]) continue;
      const wet = Math.min(depth[k], Math.max(surface - bed[n], 0), 1);
      const q = Math.max(0, g.flux[k * 4 + d] * 0.98 + 9.81 * dt * head * wet / cell);
      nextFlux[k * 4 + d] = q;
      out += q;
    }
    const scale = Math.min(1, depth[k] * cell / Math.max(out * dt, 1e-12));
    for (let d = 0; d < 4; d++) {
      const q = nextFlux[k * 4 + d] * scale;
      nextFlux[k * 4 + d] = q;
      const amount = q * dt / cell;
      delta[k] -= amount;
      if (q > 0) delta[k + neighbors[d]] += amount;
    }
  }
  for (let k = 0; k < depth.length; k++) depth[k] = Math.max(0, depth[k] + delta[k]);
  g.flux = nextFlux;
}
