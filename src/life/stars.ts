import * as THREE from 'three';
import { animate } from 'animejs';
import { rng, type Rng } from '../core/rng.ts';
import { POOL_REGION, NEAR_REGION, scatter, band, type Habitat, type Site } from './habitat.ts';
import { dropDegenerate, lifeMaterial } from './shared.ts';

/**
 * Ochre sea stars (Pisaster ochraceus), purple and orange morphs. Each star is built in place and
 * draped over the rock under it, as a real star moulds itself to the surface. The aboral surface
 * carries white spines in a reticulated net, drawn in the shader.
 */

const STAR_HEAD = /* glsl */`
uniform float uCurl;
uniform float uStarSize;
attribute vec3 aLocal; // x, z in the star's own frame (unit arm length), y: radial fraction
varying vec3 vLocal;
`;

const STAR_TRANSFORM = /* glsl */`
vLocal = aLocal;
{
  // Touched: arm tips lift and curl inward a little.
  float rad = length(aLocal.xz);
  float lift = uCurl * smoothstep(0.45, 1.0, rad) * pow(rad, 2.0) * 0.35 * uStarSize;
  transformed.y += lift;
}
`;

const STAR_FRAG_HEAD = /* glsl */`
uniform vec3 uStarColor;
uniform float uStarSize;
varying vec3 vLocal;
float tpStarBumpH;
`;

const STAR_SURFACE = /* glsl */`
{
  vec2 q = vLocal.xz;
  float rad = length(q);
  // Reticulated net of spines: spines sit on the borders of larger cells.
  vec2 net = tpWorley(q * 7.5 + 3.0);
  float onNet = 1.0 - smoothstep(0.03, 0.12, net.y - net.x);
  vec3 sp = tpWorleyId(q * 46.0);
  float spine = (1.0 - smoothstep(0.08, 0.32, sp.x)) * (0.35 + 0.65 * onNet) * smoothstep(0.2, 0.3, sp.z);
  float papulae = (1.0 - smoothstep(0.1, 0.4, tpWorley(q * 90.0 + 7.0).x)) * (1.0 - onNet) * 0.5;
  vec3 body = uStarColor * (0.85 + 0.3 * tpVNoise(q * 6.0)) * (1.0 - 0.25 * smoothstep(0.7, 1.0, rad));
  vec3 spineCol = mix(vec3(0.62, 0.56, 0.6), uStarColor * 2.4 + 0.1, 0.25);
  diffuseColor.rgb = mix(body, spineCol, spine * 0.9);
  diffuseColor.rgb *= 1.0 - papulae * 0.25;
  roughnessFactor = mix(0.62, 0.45, spine);
  // Bump from the same features (screen-space derivatives).
  float hgt = (spine * 0.0025 + papulae * 0.0006 + onNet * 0.0008) * uStarSize * 6.0;
  vec3 dpx = dFdx(vTpWorld), dpy = dFdy(vTpWorld);
  vec3 nW = normalize(vTpNormal);
  vec3 r1 = cross(dpy, nW), r2 = cross(nW, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
  vec3 nb = normalize(abs(det) * nW - grad);
  normal = normalize((viewMatrix * vec4(nb, 0.0)).xyz);
}
`;

/** Star outline radius at angle a (unit arm length), with per-arm length and sideways bend. */
function outline(a: number, arms: number[], disc: number): number {
  const n = arms.length;
  let best = disc;
  for (let i = 0; i < n; i++) {
    const center = (i / n) * Math.PI * 2;
    const d = Math.atan2(Math.sin(a - center), Math.cos(a - center));
    // Stout arms: wide at the base, tapering to a blunt tip.
    const halfWidth = (Math.PI * 2) / n * 0.5;
    const along = Math.max(0, 1 - Math.abs(d) / halfWidth);
    best = Math.max(best, disc + (arms[i] - disc) * Math.pow(along, 2.6));
  }
  return best;
}

function starGeometry(site: Site, size: number, rot: number, r: Rng, heightAt: (x: number, z: number) => number, detail: number): THREE.BufferGeometry {
  const arms = Array.from({ length: 5 }, () => r.range(0.82, 1.08));
  const bends = arms.map(() => r.signed() * 0.25);
  const disc = 0.3;
  const segA = Math.round(200 * detail), segR = Math.round(16 * detail);
  const pos: number[] = [], loc: number[] = [], idx: number[] = [];
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (let j = 0; j <= segR; j++) {
    const t = j / segR;
    for (let i = 0; i < segA; i++) {
      const a = (i / segA) * Math.PI * 2;
      const R = outline(a, arms, disc);
      // Bend the arms a little sideways, more toward the tips.
      const armI = Math.round((a / (Math.PI * 2)) * 5) % 5;
      const aa = a + bends[armI] * Math.pow(t * R, 2) * 0.6;
      const rad = t * R;
      const lx = Math.cos(aa) * rad, lz = Math.sin(aa) * rad;
      const thick = 0.2 * (1 - 0.6 * Math.min(rad, 1)) * Math.pow(Math.max(0, 1 - t * t), 0.4) + 0.012;
      const wx = site.pos.x + (lx * cos - lz * sin) * size;
      const wz = site.pos.z + (lx * sin + lz * cos) * size;
      const ground = heightAt(wx, wz);
      pos.push(wx, ground + thick * size + 0.004, wz);
      loc.push(lx, t, lz);
    }
  }
  for (let j = 0; j < segR; j++) {
    for (let i = 0; i < segA; i++) {
      const i1 = (i + 1) % segA;
      const a = j * segA + i, b = j * segA + i1, c = (j + 1) * segA + i, d = (j + 1) * segA + i1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLocal', new THREE.Float32BufferAttribute(loc, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return dropDegenerate(g);
}

export type StarInstance = { mesh: THREE.Mesh; site: Site; size: number; curl: { value: number }; center: THREE.Vector3 };

export function buildStars(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high') {
  const group = new THREE.Group();
  group.name = 'stars';
  const r = rng(seed, 'life:stars');
  const list: StarInstance[] = [];
  const detail = tier === 'high' ? 1 : tier === 'medium' ? 0.75 : 0.5;
  const purple = new THREE.Color(0.13, 0.025, 0.11);
  const orange = new THREE.Color(0.48, 0.13, 0.025);
  const sites = [
    // In the pool, near the walls, half in and half out of the light.
    ...scatter(h, r, Math.round(8 * Math.max(0.75, density)), POOL_REGION, s => (s.pool > 0.6 && s.poolDepth > 0.04 && s.poolDepth < 0.35 && s.normal.y > 0.7 ? 1 : 0), () => 0.29, 5000),
    // Among the mussels on the wave-beaten rock: their prey.
    ...scatter(h, r, Math.round(3 * Math.max(0.67, density)), NEAR_REGION, s => (s.poolDepth < 0 && s.exposure < 3 && s.normal.y > 0.75 ? band(s.y, -0.6, -0.45, 0.0, 0.2) : 0), () => 0.4, 5000),
  ];
  for (const { site } of sites) {
    const size = r.range(0.09, 0.15);
    const curl = { value: 0 };
    const color = r.chance(0.7) ? purple.clone().multiplyScalar(r.range(0.85, 1.2)) : orange.clone().multiplyScalar(r.range(0.85, 1.15));
    const uniforms = { uCurl: curl, uStarColor: { value: color }, uStarSize: { value: size } };
    const mat = lifeMaterial({
      key: 'pisaster', roughness: 0.6, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.5, 0.4, 0.5),
      patch: { uniforms, vertexHead: STAR_HEAD, vertexTransform: STAR_TRANSFORM, fragmentHead: STAR_FRAG_HEAD, fragmentSurface: STAR_SURFACE },
    });
    (mat as unknown as { uniforms: object }).uniforms = uniforms;
    const geo = starGeometry(site, size, r.range(0, 6.28), r, h.heightAt, detail);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'sea-star';
    group.add(mesh);
    list.push({ mesh, site, size, curl, center: site.pos.clone().add(new THREE.Vector3(0, 0.02, 0)) });
  }
  const touch = (s: StarInstance) => {
    animate(s.curl, { value: [{ to: 0.55, duration: 1400, ease: 'out(2)' }, { to: 0.55, duration: 1500 }, { to: 0, duration: 4000, ease: 'inOut(2)' }] });
  };
  return { group, list, touch, stats: { stars: list.length } };
}
