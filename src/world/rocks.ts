import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, type Rng } from '../core/rng.ts';
import { fbm3, smoothstep, vnoise3 } from '../core/noise.ts';
import { poolRadius, sampleTerrain, shoreZ, terrainNormal } from './field.ts';
import { LAYOUT } from './layout.ts';
import type { Occluder } from './terrainMesh.ts';

export type RockPlacement = {
  variant: number;
  x: number; y: number; z: number;
  /** Uniform scale (variant shapes already carry their own proportions). */
  s: number;
  rotY: number;
  tilt: [number, number];
  id: number;
};

export type RockLayout = { boulders: RockPlacement[]; cobbles: RockPlacement[]; stacks: RockPlacement[] };

export const BOULDER_VARIANTS = 10;
export const COBBLE_VARIANTS = 9;

/**
 * Fractured block: a sphere clipped by random planes with a smooth minimum, so faces are flat
 * like joint surfaces and edges are rounded by the sea. Proportions are baked in.
 */
export function boulderGeometry(r: Rng, detail: number, roundness: number, squash: number): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const planes: [number, number, number, number][] = [];
  const count = r.int(10, 16);
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(r.normal(), r.normal() * 0.8, r.normal()).normalize();
    planes.push([v.x, v.y, v.z, r.range(0.48, 0.88)]);
  }
  planes.push([0, -1, 0, r.range(0.35, 0.55)]); // bedding face underneath
  const sx = r.range(0.85, 1.25), sz = r.range(0.75, 1.15);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const ao = new Float32Array(pos.count);
  const seed = r.int(0, 1e6);
  const k = roundness;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let sum = 0;
    for (const [nx, ny, nz, d] of planes) {
      const c = Math.max(x * nx + y * ny + z * nz, 0.04);
      sum += Math.exp(-(d / c) / k);
    }
    let rad = Math.min(-k * Math.log(sum), 1.2);
    rad *= 1 + 0.19 * (fbm3(x * 1.9 + 3, y * 1.9, z * 1.9, 4, seed) - 0.5) + 0.04 * (vnoise3(x * 9, y * 9, z * 9, seed + 7) - 0.5);
    pos.setXYZ(i, x * rad * sx, y * rad * squash, z * rad * sz);
    ao[i] = 0.42 + 0.58 * smoothstep(-0.55, 0.35, y);
  }
  geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Sea-worn cobble: a smooth, slightly flattened pebble shape. */
export function cobbleGeometry(r: Rng, detail: number): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const ao = new Float32Array(pos.count);
  const sx = r.range(0.76, 1.36), sy = r.range(0.68, 1.08), sz = r.range(0.68, 1.24);
  const seed = r.int(0, 1e6);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const rad = 1 + 0.26 * (fbm3(x * 1.7 + 2, y * 1.7, z * 1.7 - 1, 3, seed) - 0.5)
      + 0.075 * Math.sin(3 * Math.atan2(z, x) + seed) * (1 - y * y);
    pos.setXYZ(i, (x * rad + y * 0.09) * sx, (y * rad + 0.06 * x * z) * sy, (z * rad - y * 0.07) * sz);
    ao[i] = 0.5 + 0.5 * smoothstep(-0.7, 0.2, y);
  }
  geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Eroded sea stack with a narrow summit and steep fractured sides. */
export function stackGeometry(r: Rng): THREE.BufferGeometry {
  const sides = 18, levels = 9;
  const positions: number[] = [], ao: number[] = [], indices: number[] = [];
  const phase = r.range(0, Math.PI * 2);
  const lobes = Array.from({ length: 5 }, () => r.range(-0.07, 0.07));
  for (let j = 0; j <= levels; j++) {
    const t = j / levels;
    const y = -0.5 + t * 1.7;
    const shoulder = t > 0.72 ? 1 - 0.38 * smoothstep(0.72, 1, t) : 1;
    const radius = (0.64 - 0.13 * t) * shoulder;
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2;
      const fracture = lobes[i % lobes.length] + 0.065 * Math.sin(a * 5 + phase + t * 2.4);
      const lean = 0.1 * t;
      positions.push(Math.cos(a) * (radius + fracture) + lean, y + 0.035 * Math.sin(a * 4 + phase) * t, Math.sin(a) * (radius + fracture) - lean * 0.3);
      ao.push(0.43 + 0.5 * t);
    }
  }
  for (let j = 0; j < levels; j++) for (let i = 0; i < sides; i++) {
    const a = j * sides + i, b = j * sides + (i + 1) % sides, c = (j + 1) * sides + i, d = (j + 1) * sides + (i + 1) % sides;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Deterministic placement of boulders, pool cobbles and distant sea stacks. */
export function layoutRocks(seed: number, density: number): RockLayout {
  const boulders: RockPlacement[] = [];
  const cobbles: RockPlacement[] = [];
  const stacks: RockPlacement[] = [];
  const r = rng(seed, 'rocks:boulders');
  const place = (x: number, z: number, s: number, embed: number, list: RockPlacement[], variants: number, rr: Rng) => {
    const h = sampleTerrain(x, z);
    const n = terrainNormal(x, z, 0.12);
    list.push({
      variant: rr.int(0, variants - 1), x, y: h - s * embed, z, s,
      rotY: rr.range(0, Math.PI * 2), tilt: [n[2] * 0.6 + rr.signed() * 0.12, -n[0] * 0.6 + rr.signed() * 0.12], id: rr.next(),
    });
  };
  // Inside the pool: blocks that fell in and were rounded by the surge.
  const inPool: [number, number, number][] = [[-1.25, -0.55, 0.36], [1.35, 0.5, 0.3], [0.55, -0.95, 0.22], [-0.35, 0.75, 0.18], [1.75, -0.45, 0.26]];
  for (const [x, z, s] of inPool) place(x, z, s, 0.35, boulders, BOULDER_VARIANTS, r);
  // On the shelf, thicker toward the seaward edge where storms leave them.
  let tries = 0;
  const target = Math.round(46 * Math.max(0.5, density));
  while (boulders.length < target && tries++ < 4000) {
    const x = r.range(-14, 14), z = r.range(-11, 6);
    const d = z - shoreZ(x);
    if (poolRadius(x, z) < 1.15) continue;
    if (Math.abs(x) < 1.6 && z > 1.6 && z < 5.5) continue; // keep the viewer's foreground readable
    const pSea = Math.exp(-Math.pow((d - 0.8) / 3.2, 2));
    const pNear = 0.18 * Math.exp(-Math.hypot(x, z) / 5);
    if (!r.chance(pSea * 0.7 + pNear + 0.04)) continue;
    const s = d < 2 ? r.range(0.45, 1.5) : r.range(0.18, 0.75);
    if (boulders.some(b => Math.hypot(b.x - x, b.z - z) < (b.s + s) * 0.9)) continue;
    place(x, z, s, d < 0 ? 0.4 : 0.31, boulders, BOULDER_VARIANTS, r);
  }

  // Cobbles on the pool floor: many small, few large, never stacked through each other.
  const c = rng(seed, 'rocks:cobbles');
  const nCobbles = Math.round(420 * density);
  tries = 0;
  while (cobbles.length < nCobbles && tries++ < nCobbles * 30) {
    const x = c.range(-2.6, 2.6), z = c.range(-1.9, 1.5);
    const pr = poolRadius(x, z);
    if (pr > 0.93) continue;
    const s = 0.018 + Math.pow(c.next(), 2.6) * 0.13;
    // Cobbles gather in hollows: prefer points lower than their surroundings.
    const h = sampleTerrain(x, z);
    const around = (sampleTerrain(x + 0.25, z) + sampleTerrain(x - 0.25, z) + sampleTerrain(x, z + 0.25) + sampleTerrain(x, z - 0.25)) / 4;
    if (!c.chance(0.35 + smoothstep(-0.02, 0.06, around - h) * 0.65)) continue;
    if (cobbles.some(b => Math.hypot(b.x - x, b.z - z) < (b.s + s) * 1.05)) continue;
    if (boulders.some(b => Math.hypot(b.x - x, b.z - z) < b.s * 0.95)) continue;
    place(x, z, s, 0.25, cobbles, COBBLE_VARIANTS, c);
  }

  // Sea stacks fading into the mist.
  const st = rng(seed, 'rocks:stacks');
  const stackSpots: [number, number, number][] = [[-46, -140, 9], [34, -210, 12], [95, -330, 16], [-150, -360, 18], [-22, -62, 3.2], [16, -55, 2.2], [40, -90, 4.5], [-70, -105, 5.5]];
  for (const [x, z, s] of stackSpots) {
    stacks.push({ variant: st.int(0, BOULDER_VARIANTS - 1), x, y: -s * 0.35 - 1.2, z, s, rotY: st.range(0, 6.28), tilt: [st.signed() * 0.04, st.signed() * 0.04], id: st.next() });
  }
  void LAYOUT;
  return { boulders, cobbles, stacks };
}

export function occludersFrom(layout: RockLayout): Occluder[] {
  return layout.boulders.map(b => ({ x: b.x, y: b.y + b.s * 0.45, z: b.z, r: b.s * 0.85 }));
}

/** Instanced meshes, one per variant, sharing a material. */
export function buildInstanced(
  placements: RockPlacement[], variants: THREE.BufferGeometry[], material: THREE.Material, name: string,
  heightScale: (p: RockPlacement) => number = () => 1,
): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3();
  variants.forEach((geo, v) => {
    const list = placements.filter(p => p.variant === v);
    if (list.length === 0) return;
    const g = geo.clone();
    const inst = new Float32Array(list.length * 2);
    const mesh = new THREE.InstancedMesh(g, material, list.length);
    list.forEach((p, i) => {
      e.set(p.tilt[0], p.rotY, p.tilt[1], 'YXZ');
      q.setFromEuler(e);
      s.set(p.s, p.s * heightScale(p), p.s);
      t.set(p.x, p.y, p.z);
      m.compose(t, q, s);
      mesh.setMatrixAt(i, m);
      inst[i * 2] = p.id; inst[i * 2 + 1] = p.s;
    });
    g.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 2));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `${name}-${v}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  });
  return meshes;
}
