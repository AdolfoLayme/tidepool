import { createVoronoiResult, fbm, lerp, smax, smin, smoothstep, vnoise, voronoi } from '../core/noise.ts';
import { LAYOUT } from './layout.ts';

/**
 * Analytic height of the basalt shelf. This is the ground truth: the mesh, the height textures and
 * every placement query (barnacles, crabs, fish avoidance) read from it.
 *
 * Shape, from large to small:
 *  1. coastal profile: a shelf that steps down steeply into the sea toward -z;
 *  2. columnar jointing: Voronoi columns with their own height and tilt, so neighbouring columns
 *     meet in small vertical steps; weathered (rounded) edges; joint cracks of varying depth;
 *  3. the pool: columns whose centre falls inside the pool outline have been plucked out by the
 *     sea, so the walls follow the joints; a smooth bowl rounds the bottom;
 *  4. a rim that holds water, cut by one gully whose floor sets the spill level;
 *  5. small basins that keep puddles, secondary fractures and fine roughness.
 */

export const JOINT_SEED = 101;
export const JOINT_JITTER = 0.84;
export const FRACTURE_SEED = 211;

export type TerrainSample = {
  height: number;
  /** Random id of the basalt column under the point. */
  cell: number;
  /** Distance to the nearest primary joint in metres. */
  edge: number;
  /** Normalised radius from the pool centre (1 = pool wall). */
  poolR: number;
  /** 0..1 how much the point lies in the drainage gully. */
  gully: number;
  /** 1 when the column under the point was plucked to form the pool. */
  plucked: number;
};

const vor = createVoronoiResult();
const vor2 = createVoronoiResult();

export function shoreZ(x: number): number {
  return -7.4 + 1.5 * Math.sin(x * 0.13 + 0.6) + 0.8 * Math.sin(x * 0.31 - 1.2) + 1.3 * (fbm(x * 0.07, 3.3, 3, 1) - 0.5);
}

/** Coastal profile before jointing. */
export function baseProfile(x: number, z: number): number {
  const d = z - shoreZ(x);
  if (d >= 0) {
    const inland = smoothstep(8.5, 20, d);
    return 0.08 + 0.022 * d + 0.0014 * d * d + inland * (d - 8.5) * 0.085;
  }
  return 0.08 - 4.3 * (1 - Math.exp(d / 5.2));
}

export function poolRadius(x: number, z: number): number {
  const p = LAYOUT.pool;
  const wx = x - p.cx + 0.4 * (fbm(x * 0.42 + 5.1, z * 0.42 - 2.7, 3, 41) - 0.5);
  const wz = z - p.cz + 0.4 * (fbm(x * 0.42 - 8.3, z * 0.42 + 6.2, 3, 43) - 0.5);
  const u = wx / p.rx, v = wz / p.rz;
  const th = Math.atan2(v, u);
  return Math.hypot(u, v) * (1 + 0.085 * Math.sin(3 * th + 1.3) + 0.055 * Math.sin(5 * th - 0.4) + 0.035 * Math.sin(8 * th + 2.1));
}

/** Distance along and across the drainage gully. */
export function gullyFrame(x: number, z: number): { along: number; across: number } {
  const s = LAYOUT.spill;
  const len = Math.hypot(s.dirX, s.dirZ);
  const dx = s.dirX / len, dz = s.dirZ / len;
  const rx = x - s.x, rz = z - s.z;
  const along = rx * dx + rz * dz;
  const meander = 0.26 * Math.sin(along * 0.83 + 0.7) + 0.1 * Math.sin(along * 2.1 + 0.3) + 0.05 * Math.sin(along * 4.7);
  const across = rx * -dz + rz * dx - meander;
  return { along, across };
}

/** Joint relief: gentle on the pool floor, pronounced seaward and inland. */
function jointAmplitude(d: number, poolR: number): number {
  const inPool = 1 - smoothstep(0.55, 0.95, poolR);
  const seaward = 1 - smoothstep(-1, 4, d);
  const inland = smoothstep(7, 16, d);
  return lerp(1, 0.35, inPool) + 0.5 * seaward + 1.4 * inland;
}

/** Exposed column seams alternate with unbroken lava-flow surfaces. */
export function jointExpression(x: number, z: number, poolR: number): number {
  const flow = vnoise(x * 0.21 + 19.3, z * 0.21 - 8.7, 89);
  return smoothstep(0.6, 0.82, flow) * smoothstep(0.48, 0.94, poolR);
}

export function sampleTerrain(x: number, z: number, out?: TerrainSample): number {
  const L = LAYOUT;
  const d = z - shoreZ(x);
  // 1. Coastal profile and the broad swell of the lava flow surface.
  let h = baseProfile(x, z) + 0.26 * (fbm(x * 0.12 + 3.1, z * 0.12 - 1.7, 3, 3) - 0.5);

  // 2. Columnar jointing on warped, slightly stretched coordinates (flow banding runs along x).
  // A broad warp bends the rows of columns; a finer one makes every joint wander a few
  // centimetres, so no edge is a ruled line. rock.glsl repeats this to paint the same joints.
  const qx = x * 0.9 + 0.95 * (fbm(x * 0.17 + 7.7, z * 0.17 + 1.3, 3, 5) - 0.5)
    + 0.09 * (vnoise(x * 2.6 + 1.9, z * 2.6 - 3.3, 111) - 0.5) + 0.028 * (vnoise(x * 7.9 + 0.4, z * 7.9 + 5.1, 113) - 0.5);
  const qz = z * 1.06 + 0.95 * (fbm(x * 0.17 - 4.2, z * 0.17 + 9.1, 3, 7) - 0.5)
    + 0.09 * (vnoise(x * 2.6 - 6.2, z * 2.6 + 2.8, 115) - 0.5) + 0.028 * (vnoise(x * 7.9 - 3.7, z * 7.9 - 1.6, 117) - 0.5);
  voronoi(qx / L.cell, qz / L.cell, JOINT_SEED, JOINT_JITTER, vor);
  const edge = vor.edge * L.cell;
  const pr = poolRadius(x, z);
  // Column tops, each with its own height and tilt. Columns whose centre falls in the pool outline
  // were plucked out by the sea and sit at the pool floor.
  const ccx = (vor.cx * L.cell) / 0.9, ccz = (vor.cy * L.cell) / 1.06;
  const ncx = (vor.ncx * L.cell) / 0.9, ncz = (vor.ncy * L.cell) / 1.06;
  // Broad patches of massive flow rock interrupt the otherwise even column relief.
  const joints = jointExpression(x, z, pr);
  const amp = jointAmplitude(d, pr) * (0.58 + 0.8 * vnoise(ccx * 0.19 + 4.1, ccz * 0.19 - 2.7, 83)) * joints;
  // Rough, potholed column tops rather than flat paving.
  const lump = 0.19 * (fbm(x * 1.9 + 1.3, z * 1.9 - 4.4, 4, 9) - 0.5) + 0.045 * (vnoise(x * 6.3, z * 6.3, 11) - 0.5);
  voronoi(x / 0.34 + 3.7, z / 0.34 - 8.1, 307, 0.9, vor2);
  const potMask = smoothstep(0.6, 0.8, vnoise(x * 0.8 + 2.9, z * 0.8 - 6.6, 13));
  const pothole = potMask * Math.pow(Math.max(0, 1 - vor2.f1 / 0.42), 2) * (0.05 + 0.05 * vor2.id);
  const columnTop = (id: number, id2: number, cx: number, cz: number): { top: number; plucked: boolean } => {
    const tiltX = (id2 - 0.5) * 0.16, tiltZ = (((id * 7.31) % 1) - 0.5) * 0.16;
    if (poolRadius(cx, cz) < 0.97) {
      const deep = 1 - Math.min(poolRadius(cx, cz), 1);
      return { top: L.pool.floor + 0.24 * (1 - deep) + 0.12 * id + tiltX * 0.3 * (x - cx), plucked: true };
    }
    // Weathered tops are not flat: some are dished where water stands, some domed.
    const curv = ((((id2 * 5.17) % 1) - 0.4) * 0.085) * Math.min(((x - cx) ** 2 + (z - cz) ** 2) / 0.21, 1.6);
    // A few columns have broken off or been undercut and sit well below their neighbours; a few
    // stand proud with a steeper, broken top. Kept off the pool rim so the pool keeps its shape.
    const fate = (id * 13.17 + id2 * 3.71) % 1;
    const away = smoothstep(1.1, 1.5, poolRadius(cx, cz));
    let extra = 0, tilt = 1;
    if (fate < 0.12) extra = -(0.1 + 0.2 * ((id * 29.3) % 1)) * away;
    else if (fate > 0.9) { extra = (0.06 + 0.1 * ((id * 41.9) % 1)) * away; tilt = 1 + 1.6 * away; }
    return { top: (id * 0.25 + (tiltX * (x - cx) + tiltZ * (z - cz)) * tilt - 0.125 - curv) * amp + extra * Math.min(amp, 1.6), plucked: false };
  };
  const self = columnTop(vor.id, vor.id2, ccx, ccz);
  const nb = columnTop(vor.nid, vor.nid2, ncx, ncz);
  const plucked = self.plucked ? 1 : 0;
  const lift = plucked ? 0 : 1;
  // The step between columns belongs to the lower one, so the higher column keeps a crisp rim.
  const stepW = self.plucked !== nb.plucked ? 0.045 : (0.016 + 0.045 * (1 - smoothstep(-2, 6, d))) * (0.55 + 0.8 * vnoise(x * 3.1, z * 3.1, 93));
  let top = self.top;
  if (self.top < nb.top) top = lerp(self.top, nb.top, 1 - smoothstep(0, stepW, edge));
  const flowRelief = (fbm(x * 0.62 - 3.4, z * 0.62 + 8.2, 3, 97) - 0.5) * 0.23
    + (vnoise(x * 1.55, z * 1.55, 99) - 0.5) * 0.045;
  h += top + (lump - pothole + flowRelief * (1 - joints)) * lift;
  // Weathered convex edges on the higher side; sharpness differs from column to column.
  // Here and there a rim has spalled: a wider, deeper bevel bitten out of the edge.
  const chip = smoothstep(0.6, 0.82, vnoise(x * 4.3 + 2.2, z * 4.3 - 7.5, 119));
  const weather = lerp(0.004, 0.027, 1 - smoothstep(-2, 6, d)) * (0.35 + 1.1 * vor.id2 * vor.id2) + chip * 0.075;
  const round = 1 - Math.pow(1 - smoothstep(0, weather, edge), 2);
  if (self.top >= nb.top) h -= (0.015 + 0.04 * vor.id + chip * 0.035) * (1 - round) * Math.min(amp, 1.4);
  // Joint crack: most joints are tight hairlines, a few have opened up.
  const openness = Math.pow(vnoise(x * 1.3 + 4.2, z * 1.3 - 1.1, 31), 2.2);
  const crack = 1 - smoothstep(0, 0.008 + 0.04 * openness, edge);
  h -= crack * crack * (0.012 + 0.09 * openness) * Math.min(amp, 1.5) * joints;

  // Secondary fractures inside some columns.
  voronoi(x / 0.43 + 17.3, z / 0.43 - 5.9, FRACTURE_SEED, 0.9, vor2);
  const fracMask = smoothstep(0.45, 0.75, vnoise(x * 0.55 + 9.1, z * 0.55 + 2.3, 37));
  const frac = 1 - smoothstep(0, 0.018, vor2.edge * 0.43);
  h -= frac * frac * 0.03 * fracMask * Math.min(amp, 1.3) * lift;

  // 3. The pool: a smooth bowl rounds the plucked floor.
  const floor = L.pool.floor + 0.1 * Math.min(pr * pr, 1) + 0.07 * (fbm(x * 0.9 + 2.2, z * 0.9 - 7.1, 3, 61) - 0.5);
  const bowl = floor + 2.4 * Math.pow(Math.max(0, pr - 0.72), 1.5);
  h = smin(h, bowl, 0.1);

  // 4. A rim that holds water, except where the gully cuts through.
  const ring = (1 - plucked) * smoothstep(0.8, 0.98, pr) * (1 - smoothstep(1.55, 2.0, pr));
  h = lerp(h, smax(h, 0.085, 0.03), ring);
  const g = gullyFrame(x, z);
  let gully = 0;
  const s = L.spill;
  if (g.along > -1.4 && g.along < s.length + 1) {
    const fall = smoothstep(0, s.length, g.along);
    const width = s.width * (0.8 + 0.7 * fall + 0.35 * vnoise(g.along * 1.3, 2.7, 39));
    const floorY = -s.drop * fall * fall + 0.012 * Math.sin(g.along * 5.3);
    const prof = floorY + 0.5 * Math.pow(Math.abs(g.across) / width, 1.6);
    const start = smoothstep(-1.4, -0.35, g.along);
    h = Math.min(h, lerp(h + 1, prof, start));
    gully = (1 - smoothstep(width * 0.6, width * 1.6, Math.abs(g.across))) * start;
  }

  // 5. Small basins that keep rain and splash water.
  for (const pd of L.puddles) {
    const dx = x - pd.x, dz = z - pd.z;
    const warp = 1 + 0.22 * (vnoise(x * 2.1, z * 2.1, 91) - 0.5);
    const q = Math.hypot(dx, dz) / (pd.r * warp);
    if (q < 1) h -= pd.depth * Math.pow(1 - q * q, 1.4);
  }

  // 6. Fine roughness that the mesh can still resolve.
  h += 0.018 * (fbm(x * 2.7, z * 2.7, 3, 71) - 0.5) + 0.007 * (vnoise(x * 8.3, z * 8.3, 73) - 0.5);

  if (out) {
    out.height = h;
    out.cell = vor.id;
    out.edge = edge;
    out.poolR = pr;
    out.gully = gully;
    out.plucked = plucked;
  }
  return h;
}

export function createSample(): TerrainSample {
  return { height: 0, cell: 0, edge: 1, poolR: 2, gully: 0, plucked: 0 };
}

/** Surface normal by central differences of the analytic field. */
export function terrainNormal(x: number, z: number, eps = 0.03): [number, number, number] {
  const hx = sampleTerrain(x + eps, z) - sampleTerrain(x - eps, z);
  const hz = sampleTerrain(x, z + eps) - sampleTerrain(x, z - eps);
  const nx = -hx, ny = 2 * eps, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}
