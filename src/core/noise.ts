/**
 * Integer-hash noise that is bit-identical to `src/glsl/noise.glsl`.
 *
 * The rock geometry is carved on the CPU and the fine joint lines are drawn on the GPU; both must
 * agree on where every basalt joint is, so the hash uses only 32-bit integer operations that
 * JavaScript (Math.imul, >>>) and GLSL ES 3.0 (uint wrap-around) evaluate the same way.
 */

const OFFSET = 32768;

export function hash2u(cx: number, cy: number, seed: number): number {
  const ux = (cx + OFFSET) >>> 0;
  const uy = (cy + OFFSET) >>> 0;
  let h = (Math.imul(ux, 0x27d4eb2d) ^ Math.imul((uy + seed) >>> 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae3d) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1) with 24 bits. */
export function hash2f(cx: number, cy: number, seed: number): number {
  return (hash2u(cx, cy, seed) >>> 8) / 16777216;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0, 1). */
export function vnoise(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const a = hash2f(ix, iy, seed), b = hash2f(ix + 1, iy, seed);
  const c = hash2f(ix, iy + 1, seed), d = hash2f(ix + 1, iy + 1, seed);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Fractal value noise, normalised to roughly [0, 1). Rotates each octave to hide the lattice. */
export function fbm(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0, amp = 0.5, norm = 0;
  let px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(px, py, seed + i * 17);
    norm += amp;
    const nx = 0.8 * px - 0.6 * py, ny = 0.6 * px + 0.8 * py;
    px = nx * 2.03 + 1.7;
    py = ny * 2.03 - 3.1;
    amp *= 0.5;
  }
  return sum / norm;
}

export type VoronoiResult = {
  /** Distance to the nearest feature point (cell units). */
  f1: number;
  /** Distance to the nearest cell border (cell units). */
  edge: number;
  /** Stable random id of the nearest cell in [0, 1). */
  id: number;
  /** Second id for independent per-cell properties. */
  id2: number;
  /** Feature point of the nearest cell (cell units, absolute). */
  cx: number;
  cy: number;
  /** The neighbour across the nearest border: ids and feature point. */
  nid: number;
  nid2: number;
  ncx: number;
  ncy: number;
};

export function createVoronoiResult(): VoronoiResult {
  return { f1: 0, edge: 0, id: 0, id2: 0, cx: 0, cy: 0, nid: 0, nid2: 0, ncx: 0, ncy: 0 };
}

function pointX(h: number, jitter: number): number { return 0.5 + jitter * ((h & 0xffff) / 65536 - 0.5); }
function pointY(h: number, jitter: number): number { return 0.5 + jitter * ((h >>> 16) / 65536 - 0.5); }

/**
 * Jittered-grid Voronoi with exact border distance (two-pass method).
 * Jitter <= 0.9 keeps the 3x3 / 5x5 neighbourhoods sufficient.
 */
export function voronoi(x: number, y: number, seed: number, jitter: number, out: VoronoiResult): VoronoiResult {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let md = 8, mrx = 0, mry = 0, mgx = 0, mgy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = hash2u(ix + i, iy + j, seed);
      const rx = i + pointX(h, jitter) - fx;
      const ry = j + pointY(h, jitter) - fy;
      const d = rx * rx + ry * ry;
      if (d < md) { md = d; mrx = rx; mry = ry; mgx = i; mgy = j; }
    }
  }
  let edge = 8, ngx = 0, ngy = 0, nrx = 0, nry = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const gx = mgx + i, gy = mgy + j;
      const h = hash2u(ix + gx, iy + gy, seed);
      const rx = gx + pointX(h, jitter) - fx;
      const ry = gy + pointY(h, jitter) - fy;
      const dx = rx - mrx, dy = ry - mry;
      const len2 = dx * dx + dy * dy;
      if (len2 > 1e-5) {
        const len = Math.sqrt(len2);
        const e = (0.5 * (mrx + rx) * dx + 0.5 * (mry + ry) * dy) / len;
        if (e < edge) { edge = e; ngx = gx; ngy = gy; nrx = rx; nry = ry; }
      }
    }
  }
  out.nid = hash2f(ix + ngx, iy + ngy, seed + 7);
  out.nid2 = hash2f(ix + ngx, iy + ngy, seed + 13);
  out.ncx = x + nrx;
  out.ncy = y + nry;
  out.f1 = Math.sqrt(md);
  out.edge = edge;
  out.id = hash2f(ix + mgx, iy + mgy, seed + 7);
  out.id2 = hash2f(ix + mgx, iy + mgy, seed + 13);
  out.cx = x + mrx;
  out.cy = y + mry;
  return out;
}

/** 3D value noise in [0, 1) (CPU only, for shaping meshes). */
export function vnoise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const h = (i: number, j: number, k: number): number => hash2f(ix + i, iy + j + Math.imul(iz + k, 7919), seed);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * u;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * u;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * u;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

export function fbm3(x: number, y: number, z: number, octaves = 4, seed = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise3(x * f + i * 3.1, y * f - i * 1.7, z * f + i * 5.3, seed + i * 13);
    norm += amp; amp *= 0.5; f *= 2.07;
  }
  return sum / norm;
}

export const smoothstep =(e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Polynomial smooth minimum (k = blend width). */
export function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Polynomial smooth maximum. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}
