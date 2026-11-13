import * as THREE from 'three';
import type { ShoreMaps } from '../world/shoreMaps.ts';
import type { Rng } from '../core/rng.ts';
import { LAYOUT } from '../world/layout.ts';

/** A point on rock where something can live. */
export type Site = {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  /** Height relative to the tidal datum (m). */
  y: number;
  /** 1 inside the pool basin. */
  pool: number;
  /** Depth below the pool surface (m, negative above it). */
  poolDepth: number;
  /** Distance to open water (m): small on the wave-beaten edge. */
  exposure: number;
  /** Standing water from a puddle above the rock. */
  puddle: boolean;
};

export type Habitat = {
  maps: ShoreMaps;
  spill: number;
  /** Height of the rendered rock surface (the mesh), so animals sit exactly on it. */
  heightAt: (x: number, z: number) => number;
  /** Filled water level per terrain vertex (for puddles), looked up via the analytic grid. */
  puddleLevel: (x: number, z: number) => number;
};

const tmpN = new THREE.Vector3();

/** Builds a site on the shelf at (x, z) from the rendered surface. */
export function siteAt(h: Habitat, x: number, z: number): Site {
  const y = h.heightAt(x, z);
  const e = 0.025;
  const nx = h.heightAt(x - e, z) - h.heightAt(x + e, z), nz = h.heightAt(x, z - e) - h.heightAt(x, z + e), ny = 2 * e;
  const [, , , dist] = h.maps.shoreAt(x, z);
  const pool = h.maps.poolMaskAt(x, z);
  const level = h.puddleLevel(x, z);
  return {
    pos: new THREE.Vector3(x, y, z),
    normal: tmpN.set(nx, ny, nz).normalize().clone(),
    y,
    pool,
    poolDepth: pool > 0.5 ? h.spill - y : -1,
    exposure: dist,
    puddle: level > y + 0.004,
  };
}

/**
 * Rejection sampling over a region with a per-species suitability (0..1) and a minimum spacing.
 * A coarse spatial hash keeps the spacing test fast for thousands of sites.
 */
export function scatter(
  h: Habitat, r: Rng, count: number, region: { minX: number; maxX: number; minZ: number; maxZ: number },
  suitability: (s: Site) => number, spacing: (r: Rng) => number, maxTries = count * 40,
): { site: Site; radius: number }[] {
  const out: { site: Site; radius: number }[] = [];
  const cell = 0.1;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  let tries = 0;
  while (out.length < count && tries++ < maxTries) {
    const x = r.range(region.minX, region.maxX), z = r.range(region.minZ, region.maxZ);
    const site = siteAt(h, x, z);
    const p = suitability(site);
    if (p <= 0 || r.next() > p) continue;
    const rad = spacing(r);
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    const reach = Math.ceil((rad * 2) / cell);
    let ok = true;
    for (let i = ci - reach; i <= ci + reach && ok; i++) {
      for (let j = cj - reach; j <= cj + reach && ok; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (const k of list) {
          const o = out[k];
          if (Math.hypot(o.site.pos.x - x, o.site.pos.z - z) < (o.radius + rad) * 0.9) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    const k = out.length;
    out.push({ site, radius: rad });
    const g = key(ci, cj);
    const list = grid.get(g);
    if (list) list.push(k); else grid.set(g, [k]);
  }
  return out;
}

/** Smooth band: 0 outside [a, d], ramps over [a, b] and [c, d]. */
export function band(v: number, a: number, b: number, c: number, d: number): number {
  const s = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  return s(a, b, v) * (1 - s(c, d, v));
}

/** Matrix placing an object on a site, its +y along the surface normal, spun about it. */
export function placeOnSite(site: Site, scale: number, spin: number, lift = 0, tilt = 0, r?: Rng): THREE.Matrix4 {
  const up = site.normal.clone();
  if (tilt && r) up.add(new THREE.Vector3(r.signed(), 0, r.signed()).multiplyScalar(tilt)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));
  const pos = site.pos.clone().addScaledVector(site.normal, lift);
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(scale, scale, scale));
}

export const NEAR_REGION = { minX: -7.5, maxX: 7.5, minZ: -8.5, maxZ: 4.5 };
export const POOL_REGION = { minX: LAYOUT.pool.cx - 2.7, maxX: LAYOUT.pool.cx + 2.7, minZ: LAYOUT.pool.cz - 1.9, maxZ: LAYOUT.pool.cz + 1.8 };
