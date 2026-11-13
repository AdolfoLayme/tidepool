import * as THREE from 'three';
import { POOL_BOUNDS, SHORE_BOUNDS, type Bounds2 } from './layout.ts';
import { priorityFlood } from './grid.ts';

/** Plain arrays (worker friendly). */
export type ShoreArrays = {
  /** Fine map over the pool: R height, G pool mask, B filled level, A 1. */
  poolData: Float32Array;
  poolSize: [number, number];
  /** Coarse map over the shore: R height, G pool mask, B shelter from swell, A distance to open water. */
  shoreData: Float32Array;
  shoreSize: [number, number];
  spillLevel: number;
};

export type ShoreMaps = ShoreArrays & {
  pool: THREE.DataTexture;
  shore: THREE.DataTexture;
  /** Pool mask lookup on the CPU (bilinear, 0..1). */
  poolMaskAt: (x: number, z: number) => number;
  /** Shore map lookup: [height, poolMask, shelter, distance to open water]. */
  shoreAt: (x: number, z: number) => [number, number, number, number];
};

/** Half floats filter linearly on every WebGL2 device; 32-bit floats do not. */
function toHalf(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = THREE.DataUtils.toHalfFloat(data[i]);
  return out;
}

function rectUniform(b: Bounds2): THREE.Vector4 {
  return new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ));
}

export const POOL_RECT = rectUniform(POOL_BOUNDS);
export const SHORE_RECT = rectUniform(SHORE_BOUNDS);

function bilinear(data: Float32Array, w: number, h: number, channel: number, u: number, v: number): number {
  u = Math.min(Math.max(u, 0), w - 1.001);
  v = Math.min(Math.max(v, 0), h - 1.001);
  const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
  const k = (j * w + i) * 4 + channel;
  const a = data[k], b = data[k + 4], c = data[k + w * 4], d = data[k + w * 4 + 4];
  return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
}

/**
 * Height and mask maps used by the water, foam, caustics and rock shaders. Heights come from the
 * rendered mesh (not the analytic field) so the waterline matches what is on screen.
 * The pool mask comes from a flood fill: every texel connected to the pool centre that lies
 * below the spill level, softened outward a few centimetres so the water meets the rock under it.
 */
export function computeShoreMaps(poolRes: [number, number], shoreRes: [number, number], heightAt: (x: number, z: number) => number): ShoreArrays {
  const [pw, ph] = poolRes;
  const B = POOL_BOUNDS;
  const xs = Float64Array.from({ length: pw }, (_, i) => B.minX + (B.maxX - B.minX) * (i + 0.5) / pw);
  const zs = Float64Array.from({ length: ph }, (_, j) => B.minZ + (B.maxZ - B.minZ) * (j + 0.5) / ph);
  const heights = new Float32Array(pw * ph);
  for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) heights[j * pw + i] = heightAt(xs[i], zs[j]);
  const filled = priorityFlood({ xs, zs, h: heights });
  const ci = Math.floor(pw * (0 - B.minX) / (B.maxX - B.minX));
  const cj = Math.floor(ph * (-0.2 - B.minZ) / (B.maxZ - B.minZ));
  const spillLevel = filled[cj * pw + ci];

  const mask = new Float32Array(pw * ph);
  const stack = [cj * pw + ci];
  mask[cj * pw + ci] = 1;
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % pw, j = (k - i) / pw;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= pw || jj >= ph) continue;
      const kk = jj * pw + ii;
      // Only water that the pool actually holds: cells filled to the spill level, not the gully
      // beyond it, which drains to the sea.
      if (mask[kk] || heights[kk] > spillLevel + 0.003 || Math.abs(filled[kk] - spillLevel) > 0.002) continue;
      mask[kk] = 1;
      stack.push(kk);
    }
  }
  const texel = (B.maxX - B.minX) / pw;
  const grow = Math.max(1, Math.round(0.04 / texel));
  const soft = Float32Array.from(mask);
  for (let pass = 0; pass < grow; pass++) {
    const prev = Float32Array.from(soft);
    for (let j = 1; j < ph - 1; j++) for (let i = 1; i < pw - 1; i++) {
      const k = j * pw + i;
      const m = Math.max(prev[k - 1], prev[k + 1], prev[k - pw], prev[k + pw]);
      soft[k] = Math.max(prev[k], m * 0.82);
    }
  }
  const poolData = new Float32Array(pw * ph * 4);
  for (let k = 0; k < pw * ph; k++) {
    poolData[k * 4] = heights[k];
    poolData[k * 4 + 1] = soft[k];
    poolData[k * 4 + 2] = filled[k];
    poolData[k * 4 + 3] = 1;
  }
  const poolMask = (x: number, z: number) => {
    const u = (x - B.minX) / (B.maxX - B.minX) * pw - 0.5, v = (z - B.minZ) / (B.maxZ - B.minZ) * ph - 0.5;
    if (u < 0 || v < 0 || u >= pw - 1 || v >= ph - 1) return 0;
    return bilinear(poolData, pw, ph, 1, u, v);
  };

  const [sw, sh] = shoreRes;
  const S = SHORE_BOUNDS;
  const shoreData = new Float32Array(sw * sh * 4);
  const open = new Float32Array(sw * sh);
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const x = S.minX + (S.maxX - S.minX) * (i + 0.5) / sw, z = S.minZ + (S.maxZ - S.minZ) * (j + 0.5) / sh;
    const h = heightAt(x, z);
    const k = j * sw + i;
    shoreData[k * 4] = h;
    shoreData[k * 4 + 1] = poolMask(x, z);
    open[k] = h < -0.75 ? 0 : 1e9;
  }
  // Distance to open water (chamfer distance transform, metres).
  const dx = (S.maxX - S.minX) / sw, dz = (S.maxZ - S.minZ) / sh, dd = Math.hypot(dx, dz);
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const k = j * sw + i;
    if (i > 0) open[k] = Math.min(open[k], open[k - 1] + dx);
    if (j > 0) open[k] = Math.min(open[k], open[k - sw] + dz);
    if (i > 0 && j > 0) open[k] = Math.min(open[k], open[k - sw - 1] + dd);
    if (i < sw - 1 && j > 0) open[k] = Math.min(open[k], open[k - sw + 1] + dd);
  }
  for (let j = sh - 1; j >= 0; j--) for (let i = sw - 1; i >= 0; i--) {
    const k = j * sw + i;
    if (i < sw - 1) open[k] = Math.min(open[k], open[k + 1] + dx);
    if (j < sh - 1) open[k] = Math.min(open[k], open[k + sw] + dz);
    if (i < sw - 1 && j < sh - 1) open[k] = Math.min(open[k], open[k + sw + 1] + dd);
    if (i > 0 && j < sh - 1) open[k] = Math.min(open[k], open[k + sw - 1] + dd);
  }
  for (let k = 0; k < sw * sh; k++) {
    const distOpen = Math.min(open[k], 60);
    shoreData[k * 4 + 2] = Math.max(shoreData[k * 4 + 1], Math.min(1, distOpen / 7));
    shoreData[k * 4 + 3] = distOpen;
  }
  return { poolData, poolSize: [pw, ph], shoreData, shoreSize: [sw, sh], spillLevel };
}

export function shoreMapsFromArrays(a: ShoreArrays): ShoreMaps {
  const [pw, ph] = a.poolSize, [sw, sh] = a.shoreSize;
  const tex = (data: Float32Array, w: number, h: number) => {
    const t = new THREE.DataTexture(toHalf(data), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  const B = POOL_BOUNDS, S = SHORE_BOUNDS;
  const poolMaskAt = (x: number, z: number): number => {
    const u = (x - B.minX) / (B.maxX - B.minX) * pw - 0.5, v = (z - B.minZ) / (B.maxZ - B.minZ) * ph - 0.5;
    if (u < 0 || v < 0 || u >= pw - 1 || v >= ph - 1) return 0;
    return bilinear(a.poolData, pw, ph, 1, u, v);
  };
  const shoreAt = (x: number, z: number): [number, number, number, number] => {
    const u = (x - S.minX) / (S.maxX - S.minX) * sw - 0.5, v = (z - S.minZ) / (S.maxZ - S.minZ) * sh - 0.5;
    return [0, 1, 2, 3].map(c => bilinear(a.shoreData, sw, sh, c, u, v)) as [number, number, number, number];
  };
  return { ...a, pool: tex(a.poolData, pw, ph), shore: tex(a.shoreData, sw, sh), poolMaskAt, shoreAt };
}
