import * as THREE from 'three';
import { createSample, sampleTerrain } from './field.ts';
import { gradedAxis, priorityFlood, sampleGrid, type HeightGrid } from './grid.ts';
import { LAYOUT } from './layout.ts';

export type TerrainBuildOptions = {
  /** Vertex spacing in the detail region (m). */
  fine: number;
  /** Largest spacing far away (m). */
  coarse: number;
  /** Horizon directions for the baked sky occlusion. */
  aoDirections: number;
};

export type Occluder = { x: number; y: number; z: number; r: number };

/** Plain arrays, so the build can run in a worker and be transferred. */
export type TerrainArrays = {
  xs: Float64Array;
  zs: Float64Array;
  heights: Float32Array;
  filled: Float32Array;
  positions: Float32Array;
  rock: Float32Array;
  index: Uint32Array;
  spillLevel: number;
  ms: number;
};

export type TerrainData = {
  geometry: THREE.BufferGeometry;
  grid: HeightGrid;
  spillLevel: number;
  filled: Float32Array;
  heightAt: (x: number, z: number) => number;
  stats: { vertices: number; triangles: number; ms: number };
};

/**
 * Samples the shelf on a graded grid and bakes per-vertex data the rock shader needs:
 *  aRock.x  sky occlusion from a horizon search (plus boulder contact),
 *  aRock.y  random id of the basalt column (tint variation),
 *  aRock.z  distance to the nearest joint (m),
 *  aRock.w  puddle water level, or -99 where the rock cannot hold water.
 */
export function computeTerrain(opts: TerrainBuildOptions, occluders: Occluder[] = []): TerrainArrays {
  const t0 = performance.now();
  const E = LAYOUT.extent, D = LAYOUT.detail;
  const xs = gradedAxis(E.minX, E.maxX, D.minX, D.maxX, opts.fine, opts.coarse, 1.11);
  const zs = gradedAxis(E.minZ, E.maxZ, D.minZ, D.maxZ, opts.fine, opts.coarse, 1.11);
  const nx = xs.length, nz = zs.length, n = nx * nz;
  const heights = new Float32Array(n);
  const cell = new Float32Array(n);
  const edge = new Float32Array(n);
  const sample = createSample();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      sampleTerrain(xs[i], zs[j], sample);
      heights[k] = sample.height;
      cell[k] = sample.cell;
      edge[k] = Math.min(sample.edge, 2);
    }
  }
  const grid: HeightGrid = { xs, zs, h: heights };
  const filled = priorityFlood(grid);

  let spillLevel = 0;
  {
    let best = Infinity;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const d = Math.hypot(xs[i] - LAYOUT.pool.cx, zs[j] - LAYOUT.pool.cz);
      if (d < best) { best = d; spillLevel = filled[j * nx + i]; }
    }
  }

  const ao = bakeOcclusion(grid, opts.aoDirections, occluders);
  const positions = new Float32Array(n * 3);
  const rock = new Float32Array(n * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      positions[k * 3] = xs[i];
      positions[k * 3 + 1] = heights[k];
      positions[k * 3 + 2] = zs[j];
      const water = filled[k] - heights[k];
      // Puddles: depressions other than the main pool, whose water the water system draws.
      const mainPool = Math.abs(filled[k] - spillLevel) < 0.004 && Math.hypot((xs[i] - LAYOUT.pool.cx) / LAYOUT.pool.rx, (zs[j] - LAYOUT.pool.cz) / LAYOUT.pool.rz) < 1.6;
      rock[k * 4] = ao[k];
      rock[k * 4 + 1] = cell[k];
      rock[k * 4 + 2] = edge[k];
      rock[k * 4 + 3] = !mainPool && water > 0.002 ? filled[k] : -99;
    }
  }

  // Each quad splits along the diagonal with the smaller height difference.
  const quads = (nx - 1) * (nz - 1);
  const index = new Uint32Array(quads * 6);
  let p = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (Math.abs(heights[a] - heights[d]) < Math.abs(heights[b] - heights[c])) {
        index[p++] = a; index[p++] = c; index[p++] = d;
        index[p++] = a; index[p++] = d; index[p++] = b;
      } else {
        index[p++] = a; index[p++] = c; index[p++] = b;
        index[p++] = b; index[p++] = c; index[p++] = d;
      }
    }
  }
  return { xs, zs, heights, filled, positions, rock, index, spillLevel, ms: performance.now() - t0 };
}

export function terrainFromArrays(a: TerrainArrays): TerrainData {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  geometry.setAttribute('aRock', new THREE.BufferAttribute(a.rock, 4));
  geometry.setIndex(new THREE.BufferAttribute(a.index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const grid: HeightGrid = { xs: a.xs, zs: a.zs, h: a.heights };
  return {
    geometry, grid, spillLevel: a.spillLevel, filled: a.filled,
    heightAt: (x, z) => sampleGrid(grid, x, z),
    stats: { vertices: a.xs.length * a.zs.length, triangles: a.index.length / 3, ms: a.ms },
  };
}

/** Regular raster for O(1) bilinear height lookups. */
type Raster = { x0: number; z0: number; step: number; w: number; h: number; data: Float32Array };

function rasterize(grid: HeightGrid, x0: number, z0: number, x1: number, z1: number, step: number): Raster {
  const w = Math.ceil((x1 - x0) / step) + 1, h = Math.ceil((z1 - z0) / step) + 1;
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = sampleGrid(grid, x0 + i * step, z0 + j * step);
  return { x0, z0, step, w, h, data };
}

function rasterAt(r: Raster, x: number, z: number): number {
  let u = (x - r.x0) / r.step, v = (z - r.z0) / r.step;
  u = Math.min(Math.max(u, 0), r.w - 1.001);
  v = Math.min(Math.max(v, 0), r.h - 1.001);
  const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
  const k = j * r.w + i;
  const a = r.data[k], b = r.data[k + 1], c = r.data[k + r.w], d = r.data[k + r.w + 1];
  return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
}

/**
 * Horizon-based sky occlusion. For each vertex, march outward in N directions and keep the
 * steepest elevation angle; occlusion is the mean sine of those angles. Boulders standing on the
 * shelf add their solid angle so the rock darkens where they touch it.
 */
function bakeOcclusion(grid: HeightGrid, directions: number, occluders: Occluder[]): Float32Array {
  const nx = grid.xs.length, nz = grid.zs.length;
  const D = LAYOUT.detail, E = LAYOUT.extent;
  const fine = rasterize(grid, D.minX - 3.5, D.minZ - 3.5, D.maxX + 3.5, D.maxZ + 3.5, 0.04);
  const coarse = rasterize(grid, E.minX, E.minZ, E.maxX, E.maxZ, 0.3);
  const inFine = (x: number, z: number) => x > fine.x0 && z > fine.z0 && x < fine.x0 + (fine.w - 1) * fine.step && z < fine.z0 + (fine.h - 1) * fine.step;
  const out = new Float32Array(nx * nz);
  const steps = [0.04, 0.09, 0.17, 0.3, 0.55, 1.0, 1.8, 3.2];
  const dirs: [number, number][] = [];
  for (let k = 0; k < directions; k++) {
    const a = (k + 0.5) / directions * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  // Only boulders near a vertex matter; bucket them on a coarse grid.
  const near = (x: number, z: number) => occluders.filter(o => Math.abs(o.x - x) < o.r * 6 + 1.5 && Math.abs(o.z - z) < o.r * 6 + 1.5);
  let cacheKey = '', cache: Occluder[] = [];
  for (let j = 0; j < nz; j++) {
    const z = grid.zs[j];
    for (let i = 0; i < nx; i++) {
      const x = grid.xs[i];
      const k = j * nx + i;
      const h0 = grid.h[k] + 0.01;
      let occ = 0;
      for (const [dx, dz] of dirs) {
        let maxSlope = 0;
        for (const s of steps) {
          const px = x + dx * s, pz = z + dz * s;
          const hh = inFine(px, pz) ? rasterAt(fine, px, pz) : rasterAt(coarse, px, pz);
          const slope = (hh - h0) / s;
          if (slope > maxSlope) maxSlope = slope;
        }
        occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope);
      }
      let visible = 1 - occ / dirs.length;
      const key = `${Math.floor(x)}:${Math.floor(z)}`;
      if (key !== cacheKey) { cacheKey = key; cache = near(x, z); }
      for (const o of cache) {
        const ox = o.x - x, oy = o.y - h0, oz = o.z - z;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist > o.r * 6) continue;
        const sinA = Math.min(1, o.r / Math.max(dist, 1e-3));
        const cosTerm = Math.max(0, oy / Math.max(dist, 1e-3) + 0.35);
        visible -= sinA * sinA * Math.min(1, cosTerm) * 0.85;
      }
      out[k] = Math.max(0.05, Math.min(1, visible));
    }
  }
  return out;
}
