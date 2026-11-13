import * as THREE from 'three';
import { patchMaterial, type PatchOptions } from '../render/patch.ts';

/**
 * GLSL for anything alive on the rock: darker and glossier while wet (below the wet line, under
 * spray, or under water), drying to a matte surface above it.
 */
export const WET_SURFACE = /* glsl */`
{
  float tpPool;
  float tpStill = tpWaterLevel(vTpWorld.xz, tpPool);
  float tpUnder = 1.0 - smoothstep(tpStill - 0.004, tpStill + 0.004, vTpWorld.y);
  float tpWet = max(1.0 - smoothstep(uWetLevel - 0.04, uWetLevel + 0.04, vTpWorld.y), tpUnder);
  diffuseColor.rgb *= mix(1.0, 0.72, tpWet);
  roughnessFactor = mix(roughnessFactor, mix(0.32, 0.6, tpUnder), tpWet * (1.0 - tpUnder * 0.5));
}
`;

export type LifeMaterialOptions = THREE.MeshPhysicalMaterialParameters & {
  key: string;
  patch?: Partial<PatchOptions>;
};

/** Physical material with the shared lighting model (fog, underwater light, wetness). */
export function lifeMaterial(o: LifeMaterialOptions): THREE.MeshPhysicalMaterial {
  const { key, patch, ...params } = o;
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.7, metalness: 0, ...params });
  return patchMaterial(m, {
    key,
    ...patch,
    fragmentSurface: `${patch?.fragmentSurface ?? ''}\n${WET_SURFACE}`,
  });
}

/**
 * Removes zero-area triangles from an indexed geometry: those where two corners share a
 * position, as at the apex of a cone or the pole of a shell. They draw nothing but still cost
 * vertex work, and thousands of instances multiply them.
 */
export function dropDegenerate(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.index;
  if (!index) return g;
  const pos = g.getAttribute('position');
  if (!g.boundingSphere) g.computeBoundingSphere();
  const eps = Math.max(1e-9, (g.boundingSphere?.radius ?? 1) * 1e-6);
  const same = (a: number, b: number) =>
    Math.abs(pos.getX(a) - pos.getX(b)) + Math.abs(pos.getY(a) - pos.getY(b)) + Math.abs(pos.getZ(a) - pos.getZ(b)) < eps;
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (same(a, b) || same(b, c) || same(a, c)) continue;
    kept.push(a, b, c);
  }
  if (kept.length !== index.count) g.setIndex(kept);
  return g;
}

/** Builds a mesh from a parametric surface f(u, v) -> position, u around, v along. */
export function paramSurface(
  segU: number, segV: number, f: (u: number, v: number, out: THREE.Vector3) => void, closedU = true,
): THREE.BufferGeometry {
  const cols = closedU ? segU : segU + 1;
  const pos = new Float32Array(cols * (segV + 1) * 3);
  const uv = new Float32Array(cols * (segV + 1) * 2);
  const p = new THREE.Vector3();
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / segU, v = j / segV;
      f(u, v, p);
      const k = j * cols + i;
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const i1 = closedU ? (i + 1) % segU : i + 1;
      const a = j * cols + i, b = j * cols + i1, c = (j + 1) * cols + i, d = (j + 1) * cols + i1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return dropDegenerate(g);
}

/** Adds a per-vertex colour attribute from a function of position. */
export function colorize(g: THREE.BufferGeometry, f: (p: THREE.Vector3, c: THREE.Color) => void): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    f(p, c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], colors?: THREE.Color[], name = 'life'): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, matrices.length));
  matrices.forEach((mm, i) => m.setMatrixAt(i, mm));
  if (colors) colors.forEach((c, i) => m.setColorAt(i, c));
  m.count = matrices.length;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere();
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = name;
  return m;
}
