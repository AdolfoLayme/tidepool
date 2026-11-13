/**
 * Graded tensor grids: fine spacing where the camera looks closely, growing geometrically outward.
 */
export function gradedAxis(min: number, max: number, fineMin: number, fineMax: number, fine: number, coarse: number, growth = 1.09): Float64Array {
  const core: number[] = [];
  const n = Math.max(1, Math.round((fineMax - fineMin) / fine));
  for (let i = 0; i <= n; i++) core.push(fineMin + (fineMax - fineMin) * (i / n));
  const up: number[] = [];
  let step = fine, x = fineMax;
  while (x < max - 1e-6) {
    step = Math.min(coarse, step * growth);
    x = Math.min(max, x + step);
    if (max - x < step * 0.35) x = max;
    up.push(x);
  }
  const down: number[] = [];
  step = fine; x = fineMin;
  while (x > min + 1e-6) {
    step = Math.min(coarse, step * growth);
    x = Math.max(min, x - step);
    if (x - min < step * 0.35) x = min;
    down.push(x);
  }
  down.reverse();
  return Float64Array.from([...down, ...core, ...up]);
}

/** Index of the cell containing v (axis[i] <= v < axis[i+1]), clamped. */
export function axisCell(axis: Float64Array, v: number): number {
  let lo = 0, hi = axis.length - 1;
  if (v <= axis[0]) return 0;
  if (v >= axis[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

export type HeightGrid = {
  xs: Float64Array;
  zs: Float64Array;
  /** Row-major: index = iz * xs.length + ix. */
  h: Float32Array;
};

export function sampleGrid(grid: HeightGrid, x: number, z: number): number {
  const nx = grid.xs.length;
  const ix = axisCell(grid.xs, x), iz = axisCell(grid.zs, z);
  const x0 = grid.xs[ix], x1 = grid.xs[ix + 1], z0 = grid.zs[iz], z1 = grid.zs[iz + 1];
  const tx = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  const tz = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  const a = grid.h[iz * nx + ix], b = grid.h[iz * nx + ix + 1];
  const c = grid.h[(iz + 1) * nx + ix], d = grid.h[(iz + 1) * nx + ix + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/**
 * Priority-flood depression filling (Barnes, Lehman & Mulla 2014) on a grid with 8-connectivity.
 * Returns the water level each cell would hold if every depression filled to its spill point.
 */
export function priorityFlood(grid: HeightGrid): Float32Array {
  const nx = grid.xs.length, nz = grid.zs.length, n = nx * nz;
  const filled = Float32Array.from(grid.h);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  for (let i = 0; i < nx; i++) {
    for (const j of [0, nz - 1]) { const k = j * nx + i; if (!done[k]) { done[k] = 1; heap.push(k, filled[k]); } }
  }
  for (let j = 0; j < nz; j++) {
    for (const i of [0, nx - 1]) { const k = j * nx + i; if (!done[k]) { done[k] = 1; heap.push(k, filled[k]); } }
  }
  while (heap.size > 0) {
    const k = heap.pop();
    const level = filled[k];
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx || (di === 0 && dj === 0)) continue;
        const kk = jj * nx + ii;
        if (done[kk]) continue;
        done[kk] = 1;
        if (filled[kk] < level) filled[kk] = level;
        heap.push(kk, filled[kk]);
      }
    }
  }
  return filled;
}

class MinHeap {
  private keys: Int32Array;
  private vals: Float32Array;
  size = 0;
  constructor(capacity: number) {
    this.keys = new Int32Array(capacity);
    this.vals = new Float32Array(capacity);
  }
  push(key: number, value: number): void {
    let i = this.size++;
    this.keys[i] = key; this.vals[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]; this.vals[0] = this.vals[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.vals[l] < this.vals[m]) m = l;
        if (r < this.size && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
  }
}
