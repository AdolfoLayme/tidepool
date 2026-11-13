import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, type Rng } from '../core/rng.ts';
import { POOL_REGION, scatter, type Habitat } from './habitat.ts';
import { lifeMaterial } from './shared.ts';

/**
 * Fish of the pool:
 *  - a shoal of juvenile shiner perch (Cymatogaster aggregata): small, silvery with faint
 *    vertical bars, moving together (boids: separation, alignment, cohesion, avoidance);
 *  - tidepool sculpins (Oligocottus maculosus): mottled, big-headed bottom dwellers that rest on
 *    the rock and dart a short way when disturbed.
 * Bodies undulate in the vertex shader; the CPU only moves and orients them.
 */

type Profile = { length: number; height: (t: number) => number; width: (t: number) => number };

/** Lofted fish body along +x (head at +x), plus tail and fins. Unit length. aBody.x = 0 at tail, 1 at snout. */
function fishGeometry(p: Profile, seg: number, fins: 'perch' | 'sculpin'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const ring = 12;
  const pos: number[] = [], body: number[] = [], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg; // 0 tail .. 1 snout
    const x = t - 0.5;
    const hgt = p.height(t), wid = p.width(t);
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      pos.push(x, Math.sin(a) * hgt, Math.cos(a) * wid);
      body.push(t, Math.sin(a), Math.cos(a), 0);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < ring; j++) {
    const j1 = (j + 1) % ring;
    const a = i * ring + j, b = i * ring + j1, c = (i + 1) * ring + j, d = (i + 1) * ring + j1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  parts.push(g.toNonIndexed());
  const fin = (verts: number[], t: number[], kind: number) => {
    const f = new THREE.BufferGeometry();
    f.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const b: number[] = [];
    for (let i = 0; i < t.length; i++) b.push(t[i], 0, 0, kind);
    f.setAttribute('aBody', new THREE.Float32BufferAttribute(b, 4));
    f.computeVertexNormals();
    parts.push(f);
  };
  // Tail: forked for the perch, rounded fan for the sculpin.
  if (fins === 'perch') {
    fin([-0.5, 0, 0, -0.68, 0.16, 0, -0.62, 0, 0, -0.5, 0, 0, -0.62, 0, 0, -0.68, -0.16, 0], [0, -0.3, -0.2, 0, -0.2, -0.3], 1);
    fin([-0.1, p.height(0.4), 0, 0.12, p.height(0.62) + 0.07, 0, 0.18, p.height(0.68), 0], [0.4, 0.62, 0.68], 1);
    for (const s of [-1, 1]) fin([0.12, -0.015, s * 0.038, -0.08, -0.1, s * 0.12, 0.04, -0.045, s * 0.06], [0.62, 0.42, 0.54], 2);
  } else {
    fin([-0.5, 0, 0, -0.66, 0.1, 0, -0.66, -0.1, 0, -0.5, 0, 0, -0.68, 0.0, 0, -0.66, 0.1, 0], [0, -0.3, -0.3, 0, -0.32, -0.3], 1);
    // Big fan-shaped pectorals, spread on the bottom.
    for (const s of [-1, 1]) fin([0.15, -0.02, s * 0.06, 0.05, -0.05, s * 0.2, 0.22, -0.04, s * 0.16], [0.65, 0.55, 0.72], 2);
    fin([-0.3, p.height(0.2) * 0.9, 0, 0.1, p.height(0.6) + 0.06, 0, 0.25, p.height(0.75), 0], [0.2, 0.6, 0.75], 1);
  }
  const out = mergeGeometries(parts.map(q => q.index ? q.toNonIndexed() : q))!;
  return out;
}

const SWIM_HEAD = /* glsl */`
attribute vec4 aBody;      // t (0 tail .. 1 snout), vertical, lateral, part
attribute vec4 aFish;      // phase, beat rate, amplitude, pattern seed
varying vec4 vBody;
varying vec4 vFish;
`;

const SWIM_TRANSFORM = /* glsl */`
vBody = aBody;
vFish = aFish;
{
  // Travelling wave from snout to tail, stronger toward the tail.
  float t = aBody.x;
  float w = pow(1.0 - t, 1.7);
  float ph = uTime * aFish.y + aFish.x - t * 5.0;
  transformed.z += sin(ph) * aFish.z * w;
  if (aBody.w > 1.5) transformed.y += sin(uTime * 3.0 + aFish.x) * 0.01;
}
`;

const FISH_FRAG_HEAD = /* glsl */`
varying vec4 vBody;
varying vec4 vFish;
uniform float uSpecies;
`;

const FISH_SURFACE = /* glsl */`
{
  float t = vBody.x;
  float side = vBody.y;
  vec3 col;
  if (uSpecies < 0.5) {
    // Shiner perch: silver flanks, darker back, faint yellowish vertical bars.
    float back = smoothstep(0.1, 0.7, side);
    float bars = smoothstep(0.55, 0.9, sin(t * 26.0 + vFish.w) * 0.5 + 0.5) * (1.0 - back) * 0.6;
    col = mix(vec3(0.78, 0.79, 0.68), vec3(0.09, 0.12, 0.12), back);
    col = mix(col, vec3(0.42, 0.36, 0.16), bars * 0.5);
    col *= mix(1.0, 0.7, smoothstep(-0.2, -0.9, side)) ;
    metalnessFactor = mix(0.52, 0.08, back);
    roughnessFactor = 0.22;
  } else {
    // Tidepool sculpin: mottled olive with darker saddles and pale flecks.
    float saddle = smoothstep(0.45, 0.6, sin(t * 17.0 + vFish.w) * 0.5 + 0.5) * smoothstep(-0.2, 0.6, side);
    float mott = tpVNoise(vec2(t * 30.0, side * 6.0) + vFish.w);
    col = mix(vec3(0.07, 0.075, 0.04), vec3(0.14, 0.12, 0.07), mott);
    col = mix(col, vec3(0.025, 0.025, 0.018), saddle * 0.8);
    col += vec3(0.12, 0.1, 0.08) * step(0.86, tpVNoise(vec2(t * 70.0, side * 14.0) + vFish.w * 2.0));
    col = mix(col, vec3(0.2, 0.17, 0.12), smoothstep(-0.3, -0.9, side) * 0.7);
    roughnessFactor = 0.5;
  }
  if (vBody.w > 0.5) { col *= 0.85; }
  // Eye on both flanks, with a narrow pale rim visible in a close look.
  float eyeDist = length(vec2((t - 0.84) / 0.045, (abs(vBody.z) - 0.89) / 0.15));
  float eyeSide = (1.0 - step(0.5, vBody.w)) * (1.0 - smoothstep(0.25, 0.6, abs(side)));
  col = mix(col, vec3(0.42, 0.44, 0.37), (1.0 - smoothstep(0.9, 1.1, eyeDist)) * eyeSide);
  col = mix(col, vec3(0.008, 0.009, 0.008), (1.0 - smoothstep(0.55, 0.75, eyeDist)) * eyeSide);
  diffuseColor.rgb = col;
}
`;

type Fish = { pos: THREE.Vector3; vel: THREE.Vector3; size: number; rest: number; dart: number; heading: number };

export function buildFish(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high') {
  const group = new THREE.Group();
  group.name = 'fish';
  const r: Rng = rng(seed, 'life:fish');
  const seg = tier === 'low' ? 10 : 18;

  const perchGeo = fishGeometry({ length: 1, height: t => 0.13 * Math.sin(Math.PI * Math.pow(t, 0.8)) + 0.012, width: t => 0.09 * Math.sin(Math.PI * Math.pow(t, 0.9)) + 0.006 }, seg, 'perch');
  const sculpinGeo = fishGeometry({ length: 1, height: t => 0.085 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.6)), 0.8) + 0.01, width: t => 0.1 * Math.pow(t, 1.4) * Math.sin(Math.PI * Math.pow(t, 0.55)) + 0.01 }, seg, 'sculpin');

  const make = (geo: THREE.BufferGeometry, n: number, species: number, key: string) => {
    const attr = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { attr[i * 4] = r.range(0, 6.28); attr[i * 4 + 1] = species ? 6 : 14; attr[i * 4 + 2] = species ? 0.035 : 0.06; attr[i * 4 + 3] = r.range(0, 10); }
    geo.setAttribute('aFish', new THREE.InstancedBufferAttribute(attr, 4));
    const mat = lifeMaterial({
      key, roughness: 0.3, side: THREE.DoubleSide, clearcoat: species ? 0.2 : 0.6, clearcoatRoughness: 0.2,
      patch: { uniforms: { uSpecies: { value: species } }, vertexHead: SWIM_HEAD, vertexTransform: SWIM_TRANSFORM, fragmentHead: FISH_FRAG_HEAD, fragmentSurface: FISH_SURFACE },
    });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    mesh.frustumCulled = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = key;
    group.add(mesh);
    return { mesh, attr };
  };

  // Shoal.
  const nShoal = Math.round(36 * Math.max(0.6, density));
  const shoal = make(perchGeo, nShoal, 0, 'shiner-perch');
  const shoalFish: Fish[] = [];
  const c0 = new THREE.Vector3(0.3, h.spill - 0.15, -0.3);
  for (let i = 0; i < nShoal; i++) {
    shoalFish.push({ pos: c0.clone().add(new THREE.Vector3(r.signed() * 0.4, r.signed() * 0.045, r.signed() * 0.3)), vel: new THREE.Vector3(r.signed(), 0, r.signed()).multiplyScalar(0.07), size: r.range(0.062, 0.088), rest: 0, dart: 0, heading: 0 });
  }

  // Sculpins.
  const sSites = scatter(h, r, Math.round(6 * Math.max(0.6, density)), POOL_REGION, s => (s.pool > 0.8 && s.poolDepth > 0.08 && s.normal.y > 0.8 ? 1 : 0), () => 0.25, 3000);
  const sculpins = make(sculpinGeo, sSites.length, 1, 'sculpin');
  const sculpinFish: Fish[] = sSites.map(({ site }) => ({ pos: site.pos.clone(), vel: new THREE.Vector3(), size: r.range(0.05, 0.075), rest: r.range(1, 6), dart: 0, heading: r.range(0, 6.28) }));

  const inside = (x: number, z: number) => h.maps.poolMaskAt(x, z);
  const floorAt = (x: number, z: number) => h.heightAt(x, z);
  const threats: { x: number; z: number; t: number }[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), dir = new THREE.Vector3();
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  const steerShoal = (dt: number, time: number, level: number) => {
    const n = shoalFish.length;
    // A slowly wandering goal keeps the shoal exploring the pool.
    const goal = tmpC.set(Math.sin(time * 0.05) * 1.3, level - 0.14, Math.cos(time * 0.037) * 0.8 - 0.25);
    for (let i = 0; i < n; i++) {
      const f = shoalFish[i];
      const sep = tmpA.set(0, 0, 0), ali = tmpB.set(0, 0, 0);
      const coh = new THREE.Vector3();
      let cnt = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const o = shoalFish[j];
        const d = f.pos.distanceTo(o.pos);
        if (d < 0.085) sep.addScaledVector(dir.subVectors(f.pos, o.pos), (0.085 - d) / Math.max(d, 1e-3));
        if (d < 0.42) { ali.add(o.vel); coh.add(o.pos); cnt++; }
      }
      const acc = new THREE.Vector3();
      acc.addScaledVector(sep, 1.6);
      if (cnt) {
        acc.addScaledVector(ali.divideScalar(cnt).sub(f.vel), 0.9);
        acc.addScaledVector(coh.divideScalar(cnt).sub(f.pos), 0.6);
      }
      acc.addScaledVector(dir.subVectors(goal, f.pos), 0.08);
      // Stay in the pool: away from walls, below the surface, above the rock.
      const ahead = tmpA.copy(f.pos).addScaledVector(f.vel, 0.6);
      if (inside(ahead.x, ahead.z) < 0.9 || level - floorAt(ahead.x, ahead.z) < 0.08) acc.addScaledVector(dir.set(-f.pos.x * 0.6, 0, -0.25 - f.pos.z).normalize(), 0.8);
      const floor = floorAt(f.pos.x, f.pos.z);
      if (f.pos.y > level - 0.04) acc.y -= 1.2;
      if (f.pos.y < floor + 0.05) acc.y += 1.2;
      for (const th of threats) {
        const d = Math.hypot(f.pos.x - th.x, f.pos.z - th.z);
        const age = time - th.t;
        if (d < 0.6 && age < 2.5) acc.addScaledVector(dir.set(f.pos.x - th.x, -0.2, f.pos.z - th.z).normalize(), 3.5 * (1 - d / 0.6) * (1 - age / 2.5));
      }
      f.vel.addScaledVector(acc, dt);
      f.vel.y *= 0.96;
      const sp = f.vel.length();
      const maxS = 0.22, minS = 0.045;
      if (sp > maxS) f.vel.multiplyScalar(maxS / sp);
      if (sp < minS) f.vel.multiplyScalar(minS / Math.max(sp, 1e-4));
      f.pos.addScaledVector(f.vel, dt);
      f.pos.y = Math.min(Math.max(f.pos.y, floor + 0.03), level - 0.025);
    }
  };

  const update = (dt: number, time: number, level: number) => {
    dt = Math.min(dt, 0.05);
    steerShoal(dt, time, level);
    shoalFish.forEach((f, i) => {
      dir.copy(f.vel).normalize();
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      s.setScalar(f.size);
      m.compose(f.pos, q, s);
      shoal.mesh.setMatrixAt(i, m);
      // Beat faster when swimming fast.
      shoal.attr[i * 4 + 1] = 10 + f.vel.length() * 60;
    });
    shoal.mesh.instanceMatrix.needsUpdate = true;
    (shoal.mesh.geometry.getAttribute('aFish') as THREE.InstancedBufferAttribute).needsUpdate = true;

    sculpinFish.forEach((f, i) => {
      // Startled by a nearby touch.
      for (const th of threats) if (time - th.t < 0.2 && Math.hypot(f.pos.x - th.x, f.pos.z - th.z) < 0.4 && f.dart <= 0) f.rest = 0;
      if (f.dart > 0) {
        f.dart -= dt;
        f.pos.addScaledVector(f.vel, dt);
        f.vel.multiplyScalar(Math.exp(-dt * 4));
        if (inside(f.pos.x, f.pos.z) < 0.85) { f.vel.negate(); f.pos.addScaledVector(f.vel, dt * 2); }
      } else {
        f.rest -= dt;
        if (f.rest <= 0) {
          // Dart a short way, then settle.
          f.heading += r.signed() * 1.6;
          f.vel.set(Math.cos(f.heading), 0, Math.sin(f.heading)).multiplyScalar(r.range(0.35, 0.7));
          f.dart = r.range(0.25, 0.5);
          f.rest = r.range(3, 12);
        }
      }
      const floor = floorAt(f.pos.x, f.pos.z);
      f.pos.y = floor + f.size * 0.06 + (f.dart > 0 ? 0.02 : 0);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -f.heading);
      s.setScalar(f.size);
      m.compose(f.pos, q, s);
      sculpins.mesh.setMatrixAt(i, m);
      sculpins.attr[i * 4 + 1] = f.dart > 0 ? 22 : 1.5;
      sculpins.attr[i * 4 + 2] = f.dart > 0 ? 0.07 : 0.008;
    });
    sculpins.mesh.instanceMatrix.needsUpdate = true;
    (sculpins.mesh.geometry.getAttribute('aFish') as THREE.InstancedBufferAttribute).needsUpdate = true;
    while (threats.length && time - threats[0].t > 3) threats.shift();
  };

  const startle = (x: number, z: number, time: number) => { threats.push({ x, z, t: time }); };
  const shoalCenter = () => shoalFish.reduce((a, f) => a.add(f.pos), new THREE.Vector3()).divideScalar(Math.max(1, shoalFish.length));
  return { group, update, startle, shoalCenter, shoal: shoal.mesh, sculpins: sculpins.mesh, sculpinFish, stats: { shoal: nShoal, sculpins: sSites.length } };
}
