import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, type Rng } from '../core/rng.ts';
import { POOL_REGION, placeOnSite, scatter, type Habitat } from './habitat.ts';
import { instanced, lifeMaterial } from './shared.ts';

/**
 * Purple sea urchins (Strongylocentrotus purpuratus): a flattened test bristling with stout spines,
 * sitting in shallow pits they have ground into the pool floor. Spines sway slowly.
 */
function urchinGeometry(r: Rng, spines: number, coarse: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // The test hides under its spines; on the low tier a coarser shell is enough.
  const test = coarse ? new THREE.SphereGeometry(0.42, 12, 7) : new THREE.SphereGeometry(0.42, 16, 10);
  test.scale(1, 0.62, 1);
  test.translate(0, 0.22, 0);
  test.deleteAttribute('uv');
  const tc = new Float32Array(test.getAttribute('position').count * 4);
  for (let i = 0; i < tc.length; i += 4) { tc[i] = 0.06; tc[i + 1] = 0.015; tc[i + 2] = 0.06; tc[i + 3] = 0; }
  test.setAttribute('aSpine', new THREE.BufferAttribute(tc, 4));
  parts.push(test);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < spines; i++) {
    // Fibonacci sphere, upper part denser; spines lie flatter toward the ambitus.
    const y = 1 - (i / (spines - 1)) * 1.25;
    if (y < -0.25) continue;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    const dir = new THREE.Vector3(Math.cos(a) * rr, y * 0.75 + 0.1, Math.sin(a) * rr).normalize();
    const len = r.range(0.42, 0.62) * (0.8 + 0.2 * Math.max(0, y));
    const cone = new THREE.ConeGeometry(0.028, len, 4, 1, true);
    cone.translate(0, len / 2, 0);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    const base = new THREE.Vector3(dir.x * 0.4, 0.22 + dir.y * 0.26, dir.z * 0.4);
    cone.translate(base.x, base.y, base.z);
    cone.deleteAttribute('uv');
    const n = cone.getAttribute('position').count;
    const sp = new Float32Array(n * 4);
    const ph = r.range(0, 6.28);
    for (let k = 0; k < n; k++) {
      // x,y,z of the spine base and a phase for the sway
      sp[k * 4] = base.x; sp[k * 4 + 1] = base.y; sp[k * 4 + 2] = base.z; sp[k * 4 + 3] = ph;
    }
    cone.setAttribute('aSpine', new THREE.BufferAttribute(sp, 4));
    parts.push(cone);
  }
  const g = mergeGeometries(parts)!;
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const sp = g.getAttribute('aSpine');
  for (let i = 0; i < pos.count; i++) {
    const tip = Math.hypot(pos.getX(i) - sp.getX(i), pos.getY(i) - sp.getY(i), pos.getZ(i) - sp.getZ(i));
    const k = Math.min(1, tip / 0.5);
    // Deep violet, a little paler toward the spine tips; not the magenta of a dyed toy.
    col[i * 3] = 0.045 + 0.05 * k; col[i * 3 + 1] = 0.012 + 0.016 * k; col[i * 3 + 2] = 0.065 + 0.055 * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** `avoid`: animals already on the floor (x, z, radius); an urchin never grows through one. */
export function buildUrchins(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high', avoid: { x: number; z: number; r: number }[] = []) {
  const r = rng(seed, 'life:urchins');
  const sites = scatter(h, r, Math.round(40 * Math.max(0.5, density)), POOL_REGION, s => {
    if (s.pool < 0.7 || s.poolDepth < 0.1) return 0;
    if (avoid.some(a => Math.hypot(s.pos.x - a.x, s.pos.z - a.z) < a.r + 0.07)) return 0;
    // Clustered in a few low patches of the floor.
    const patch = Math.sin(s.pos.x * 2.1 + 1.0) * Math.cos(s.pos.z * 2.7 - 0.4);
    return patch > 0.25 ? 1 : 0.05;
  }, rr => rr.range(0.045, 0.06), 8000);
  const geo = urchinGeometry(r, tier === 'low' ? 90 : tier === 'medium' ? 150 : 220, tier === 'low');
  const mat = lifeMaterial({
    key: 'urchin', vertexColors: true, roughness: 0.45,
    patch: {
      vertexHead: 'attribute vec4 aSpine;',
      vertexTransform: `{
        vec3 rel = transformed - aSpine.xyz;
        float l = length(rel);
        float w = sin(uTime * 0.7 + aSpine.w) * 0.12 * min(l * 2.0, 1.0);
        transformed.x += w * l * 0.6;
        transformed.z += cos(uTime * 0.6 + aSpine.w * 1.3) * 0.1 * l * 0.6;
      }`,
    },
  });
  const ms = sites.map(({ site, radius }) => placeOnSite(site, radius * 1.9, r.range(0, 6.28), -radius * 0.25, 0.1, r));
  // Each urchin a shade of its own: older ones duller, some with a faint green cast.
  const tints = sites.map(() => new THREE.Color(r.range(0.8, 1.1), r.range(0.85, 1.25), r.range(0.8, 1.1)));
  const mesh = instanced(geo, mat, ms, tints, 'urchins');
  return { mesh, stats: { urchins: ms.length } };
}
