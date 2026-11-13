import * as THREE from 'three';
import { animate } from 'animejs';
import { rng, type Rng } from '../core/rng.ts';
import { G } from '../core/globals.ts';
import { band, NEAR_REGION, placeOnSite, POOL_REGION, scatter, type Habitat, type Site } from './habitat.ts';
import { dropDegenerate, lifeMaterial } from './shared.ts';

/**
 * Sea anemones of the pool:
 *  - giant green anemone (Anthopleura xanthogrammica): a broad green oral disc ringed by short
 *    stubby tentacles, alone on the pool floor and lower walls;
 *  - aggregating anemone (Anthopleura elegantissima): small clonal polyps with pink-tipped
 *    tentacles, packed in colonies near the waterline.
 * Both close into a gravel-studded dome when touched or when the falling tide leaves them in air.
 */

type Kind = { label: string; species: string; tentacles: number; rings: number; disc: [number, number, number]; tentacle: [number, number, number]; tip: [number, number, number]; column: [number, number, number] };

const GIANT: Kind = {
  label: 'Giant green anemone', species: 'Anthopleura xanthogrammica', tentacles: 132, rings: 5,
  disc: [0.03, 0.12, 0.05], tentacle: [0.028, 0.16, 0.065], tip: [0.06, 0.23, 0.12], column: [0.07, 0.075, 0.035],
};
const AGGREGATING: Kind = {
  label: 'Aggregating anemone', species: 'Anthopleura elegantissima', tentacles: 60, rings: 3,
  disc: [0.09, 0.12, 0.07], tentacle: [0.11, 0.16, 0.1], tip: [0.42, 0.17, 0.27], column: [0.13, 0.13, 0.1],
};

/** Body with two shapes (open and closed) sharing topology; the shader blends by uOpen. Unit disc diameter. */
function bodyGeometry(kind: Kind, r: Rng, segU: number, segV: number): THREE.BufferGeometry {
  const open: number[] = [], closed: number[] = [], col: number[] = [], idx: number[] = [];
  const bumps = Array.from({ length: 60 }, () => [r.range(0, 6.283), r.range(0.1, 0.55), r.range(0.02, 0.05)]);
  // Rows along the profile: column, margin (where the disc flares to its widest), disc. Every
  // part keeps rows of its own so the silhouette holds at low detail.
  const nc = Math.max(2, Math.round(segV * 0.4)), nm = Math.max(2, Math.round(segV * 0.2)), nd = Math.max(1, segV - nc - nm);
  const rows: number[] = [];
  for (let j = 0; j < nc; j++) rows.push(0.55 * j / nc);
  for (let j = 0; j < nm; j++) rows.push(0.55 + 0.15 * j / nm);
  for (let j = 0; j <= nd; j++) rows.push(0.7 + 0.3 * j / nd);
  segV = rows.length - 1;
  for (let j = 0; j <= segV; j++) {
    const v = rows[j];
    for (let i = 0; i < segU; i++) {
      const a = (i / segU) * Math.PI * 2;
      let ro: number, yo: number, rc: number, yc: number;
      if (v < 0.55) {
        const t = v / 0.55;
        ro = 0.34 * (1 + 0.1 * Math.sin(t * Math.PI)) ; yo = t * 0.42;
        rc = 0.38 * Math.sqrt(Math.max(0, 1 - Math.pow(t * 0.75, 2))) ; yc = t * 0.3;
      } else if (v < 0.7) {
        const t = (v - 0.55) / 0.15;
        ro = 0.34 + 0.16 * Math.sin(t * Math.PI / 2); yo = 0.42 + 0.06 * Math.sin(t * Math.PI);
        rc = 0.38 * Math.sqrt(Math.max(0, 1 - Math.pow(0.75 + t * 0.2, 2))); yc = 0.3 + t * 0.06;
      } else {
        const t = (v - 0.7) / 0.3;
        ro = 0.5 * (1 - t); yo = 0.46 - 0.035 * Math.sin(t * Math.PI) - 0.02 * t;
        rc = 0.12 * (1 - t); yc = 0.36 + 0.02 * (1 - t);
      }
      // Verrucae: adhesive bumps on the column that hold gravel when closed.
      let bump = 0;
      for (const [ba, bv, bs] of bumps) {
        const d = Math.hypot(Math.atan2(Math.sin(a - ba), Math.cos(a - ba)) * 0.35, (v - bv) * 1.2);
        if (d < bs) bump += (1 - d / bs) * 0.025;
      }
      const wob = 1 + 0.03 * Math.sin(a * 5 + v * 7);
      open.push(Math.cos(a) * (ro + (v < 0.55 ? bump : 0)) * wob, yo, Math.sin(a) * (ro + (v < 0.55 ? bump : 0)) * wob);
      closed.push(Math.cos(a) * (rc + bump * 1.2) * wob, yc, Math.sin(a) * (rc + bump * 1.2) * wob);
      // Colour: column, margin, then the disc with paler radial lines and a pale mouth.
      let c: [number, number, number];
      if (v < 0.62) {
        const grit = bump > 0.012 && r.chance(0.6) ? 1 : 0;
        c = grit ? [0.2, 0.19, 0.17] : [kind.column[0] * (0.8 + 0.4 * v), kind.column[1] * (0.85 + 0.3 * v), kind.column[2]];
      } else {
        const lines = 0.75 + 0.25 * Math.pow(Math.abs(Math.cos(a * 12)), 8);
        // The mouth: a short oval slit with darker lips, the same green, not a black scratch.
        const slit = Math.abs(Math.sin(a)) * (1 - v) < 0.02 && v > 0.93 ? 1 : 0;
        const inner = Math.max(0, (v - 0.85) / 0.15);
        c = slit ? [kind.disc[0] * 0.45, kind.disc[1] * 0.4, kind.disc[2] * 0.45] : [kind.disc[0] * lines * (1 + 0.6 * inner), kind.disc[1] * lines * (1 + 0.25 * inner), kind.disc[2] * lines * (1 + 0.4 * inner)];
      }
      col.push(...c);
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const i1 = (i + 1) % segU;
      const a = j * segU + i, b = j * segU + i1, c = (j + 1) * segU + i, d = (j + 1) * segU + i1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(open, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const gc = new THREE.BufferGeometry();
  gc.setAttribute('position', new THREE.Float32BufferAttribute(closed, 3));
  gc.setIndex(idx);
  gc.computeVertexNormals();
  g.setAttribute('aClosed', gc.getAttribute('position'));
  g.setAttribute('aClosedNormal', gc.getAttribute('normal'));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // Open and closed shapes both close to a point at the mouth, so the open shape decides.
  return dropDegenerate(g);
}

/** Unit tentacle: cone along +y, base radius 1. Colour from base to tip. */
function tentacleGeometry(kind: Kind, fine: boolean): THREE.BufferGeometry {
  // Blunt, finger-like: nearly parallel sides and a rounded tip.
  // Stout, tapering cones with a rounded tip; crowded rows of them hide the outer disc.
  const shape = fine
    ? [[1, 0], [0.88, 0.4], [0.68, 0.72], [0.42, 0.9], [0.16, 0.99], [0.0, 1]]
    : [[1, 0], [0.74, 0.6], [0.3, 0.95], [0.0, 1]];
  const prof = shape.map(([x, y]) => new THREE.Vector2(x, y));
  // Six sides even when coarse: seen from above in a close look, five read as a pentagon.
  const g = dropDegenerate(new THREE.LatheGeometry(prof, 6));
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i);
    const k = Math.pow(t, 2.2);
    col[i * 3] = kind.tentacle[0] + (kind.tip[0] - kind.tentacle[0]) * k;
    col[i * 3 + 1] = kind.tentacle[1] + (kind.tip[1] - kind.tentacle[1]) * k;
    col[i * 3 + 2] = kind.tentacle[2] + (kind.tip[2] - kind.tentacle[2]) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const TENTACLE_HEAD = /* glsl */`
uniform float uOpen;
uniform float uSway;
attribute vec4 aTent;   // angle, ring radius, length, thickness
attribute float aPhase;
varying float vTentTint;
vec3 tpTentO, tpTentU, tpTentQ;
float tpTentTheta, tpTentK, tpTentLen, tpTentR, tpTentY;
void tpTentFrame() {
  float a = aTent.x;
  vTentTint = 0.76 + 0.42 * fract(sin(aPhase * 12.9898) * 43758.5453);
  float open = clamp(uOpen, 0.0, 1.0);
  tpTentO = vec3(cos(a), 0.0, sin(a));
  tpTentU = vec3(0.0, 1.0, 0.0);
  tpTentQ = vec3(-sin(a), 0.0, cos(a));
  float outer = smoothstep(0.3, 0.5, aTent.y);
  float sway = sin(uTime * 1.1 + aPhase) * 0.09 + sin(uTime * 0.47 + aPhase * 1.7) * 0.06;
  // Open, the rows stand as a crowded fringe leaning outward, the outer rows most; not splayed flat
  // like petals.
  tpTentTheta = mix(0.0, mix(0.15, 0.72, outer) + (fract(aPhase * 3.7) - 0.5) * 0.3, open) + sway * uSway * open;
  tpTentK = mix(0.6, 1.8, outer) * open;
  tpTentLen = aTent.z * mix(0.08, 1.0, open);
  tpTentR = aTent.y * mix(0.2, 1.0, open);
  tpTentY = mix(0.37, 0.46, open);
}
`;

const TENTACLE_NORMAL = /* glsl */`
tpTentFrame();
{
  float s = position.y;
  float th = tpTentTheta + tpTentK * s * tpTentLen;
  vec3 P = tpTentO * cos(th) - tpTentU * sin(th);
  objectNormal = normalize(normal.x * P + normal.z * tpTentQ + normal.y * (tpTentO * sin(th) + tpTentU * cos(th)) * 0.3);
}
`;

const TENTACLE_TRANSFORM = /* glsl */`
{
  float s = position.y * tpTentLen;
  float th0 = tpTentTheta, k = tpTentK;
  vec3 c = tpTentO * (sin(th0) * s + 0.5 * k * cos(th0) * s * s) + tpTentU * (cos(th0) * s - 0.5 * k * sin(th0) * s * s);
  float th = th0 + k * s;
  vec3 P = tpTentO * cos(th) - tpTentU * sin(th);
  float thick = aTent.w;
  vec3 base = vec3(cos(aTent.x) * tpTentR, tpTentY, sin(aTent.x) * tpTentR);
  transformed = base + c + (position.x * P + position.z * tpTentQ) * thick;
}
`;

const TENTACLE_SURFACE = /* glsl */`
diffuseColor.rgb *= vTentTint;
`;

const BODY_HEAD = /* glsl */`
uniform float uOpen;
attribute vec3 aClosed;
attribute vec3 aClosedNormal;
`;

/** Back-lit tissue glows a little (thin, translucent): a cheap stand-in for subsurface light. */
const TISSUE_GLOW = /* glsl */`
{
  vec3 vdir = normalize(cameraPosition - vTpWorld);
  float back = pow(max(dot(-vdir, normalize(uSunDir)), 0.0), 3.0);
  float tpP; float tpS = tpWaterLevel(vTpWorld.xz, tpP);
  float atten = vTpWorld.y < tpS ? exp(-uWaterSigma.g * (tpS - vTpWorld.y) * 2.0) : 1.0;
  // Sun shining through from behind, and the sky light that diffuses through the thin tissue.
  // The latter follows the light that actually reaches the animal, so in shade it does not glow.
  outgoingLight += diffuseColor.rgb * uSunColor * back * 0.3 * atten + reflectedLight.indirectDiffuse * 0.35;
}
`;

export type AnemoneInstance = {
  kind: Kind;
  root: THREE.Group;
  site: Site;
  size: number;
  open: { value: number };
  tide: number;
  touch: { value: number };
  proxy: THREE.Mesh;
};

export function buildAnemones(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high') {
  const group = new THREE.Group();
  group.name = 'anemones';
  const list: AnemoneInstance[] = [];
  const r = rng(seed, 'life:anemones');
  const proxyGeo = new THREE.SphereGeometry(0.5, 8, 6);
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });

  const make = (kind: Kind, site: Site, size: number, rr: Rng) => {
    const open = { value: 1 };
    const sway = { value: 1 };
    const uniforms = { uOpen: open, uSway: sway };
    const bodyMat = lifeMaterial({
      key: `anemone-body-${kind.tentacles}`, vertexColors: true, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.2, 0.35, 0.25),
      patch: {
        uniforms,
        vertexHead: BODY_HEAD,
        vertexNormal: 'objectNormal = normalize(mix(aClosedNormal, objectNormal, clamp(uOpen, 0.0, 1.0)));',
        vertexTransform: 'transformed = mix(aClosed, transformed, clamp(uOpen, 0.0, 1.0));',
        fragmentOutput: TISSUE_GLOW,
      },
    });
    (bodyMat as unknown as { uniforms: object }).uniforms = uniforms;
    // A few centimetres across: the aggregating kind needs far fewer facets than the giant.
    const big = kind === GIANT;
    const segU = tier === 'high' ? (big ? 24 : 14) : tier === 'medium' ? (big ? 20 : 12) : (big ? 16 : 10);
    const body = new THREE.Mesh(bodyGeometry(kind, rr, segU, segU / 2), bodyMat);
    body.castShadow = true; body.receiveShadow = true;
    // Fine tentacles only where they can fill the frame: the giant kind on the high tier.
    const tGeo = tentacleGeometry(kind, tier === 'high' && big);
    const share = tier === 'low' ? 0.47 : tier === 'medium' ? 0.65 : 1;
    const n = Math.round(kind.tentacles * share);
    // Fewer tentacles on lower tiers are made stouter, so the crown still closes over the disc.
    const stout = 1 / Math.sqrt(share);
    const tent = new Float32Array(n * 4), phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ring = i % kind.rings;
      const perRing = Math.ceil(n / kind.rings);
      const k = Math.floor(i / kind.rings);
      // Rows reach well in from the margin; only the middle of the disc stays bare.
      const rr0 = 0.5 - ring * (0.24 / kind.rings) - rr.range(0, 0.02);
      tent[i * 4] = ((k + 0.5 * (ring % 2)) / perRing) * Math.PI * 2 + rr.signed() * 0.04;
      tent[i * 4 + 1] = Math.max(0.2, rr0 - 0.03);
      tent[i * 4 + 2] = (0.1 + 0.07 * (kind.rings - ring) / kind.rings) * rr.range(0.8, 1.15) * (kind === GIANT ? 1 : 1.45);
      tent[i * 4 + 3] = (kind === GIANT ? 0.047 : 0.03) * stout * rr.range(0.85, 1.15);
      phase[i] = rr.range(0, 6.28);
    }
    tGeo.setAttribute('aTent', new THREE.InstancedBufferAttribute(tent, 4));
    tGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const tentMat = lifeMaterial({
      key: `anemone-tent-${kind.tentacles}`, vertexColors: true, roughness: 0.45, sheen: 0.35, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.14, 0.3, 0.18),
      patch: { uniforms, vertexHead: TENTACLE_HEAD, vertexNormal: TENTACLE_NORMAL, vertexTransform: TENTACLE_TRANSFORM, fragmentHead: 'varying float vTentTint;', fragmentSurface: TENTACLE_SURFACE, fragmentOutput: TISSUE_GLOW },
    });
    (tentMat as unknown as { uniforms: object }).uniforms = uniforms;
    const tentacles = new THREE.InstancedMesh(tGeo, tentMat, n);
    for (let i = 0; i < n; i++) tentacles.setMatrixAt(i, new THREE.Matrix4());
    tentacles.frustumCulled = false;
    tentacles.castShadow = true; tentacles.receiveShadow = true;
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(placeOnSite(site, size, rr.range(0, 6.28), -size * 0.04, 0.12, rr));
    root.add(body, tentacles);
    const proxy = new THREE.Mesh(proxyGeo, proxyMat);
    proxy.position.set(0, 0.3, 0);
    proxy.scale.set(1.3, 0.9, 1.3);
    root.add(proxy);
    group.add(root);
    const a: AnemoneInstance = { kind, root, site, size, open, tide: 1, touch: { value: 1 }, proxy };
    list.push(a);
    return a;
  };

  // Giant green anemones on the pool floor and lower walls.
  const giants = scatter(h, r, Math.round(14 * Math.max(0.6, density)), POOL_REGION, s => {
    if (s.pool < 0.6 || s.poolDepth < 0.07 || s.poolDepth > 0.5) return 0;
    return Math.max(0, s.normal.y - 0.35) * 1.5;
  }, () => 0.18, 6000);
  for (const { site } of giants) make(GIANT, site, r.range(0.085, 0.16), r);

  // On the seaward rock, below mid-tide: open when the sea covers them, closed when it leaves.
  const seaward = scatter(h, r, Math.round(11 * Math.max(0.6, density)), NEAR_REGION, s => {
    if (s.poolDepth >= 0 || s.puddle) return 0;
    return band(s.y, -1.0, -0.85, -0.35, -0.2) * (s.exposure < 3.5 ? 1 : 0) * Math.max(0, s.normal.y - 0.45) * 2;
  }, () => 0.25, 8000);
  for (const { site } of seaward) make(GIANT, site, r.range(0.08, 0.14), r);

  // Aggregating anemone colonies hugging the waterline.
  const colonies = scatter(h, r, 3, POOL_REGION, s => {
    if (s.pool < 0.3) return 0;
    return band(s.poolDepth, -0.06, 0.0, 0.12, 0.2) * (s.normal.y > 0.25 ? 1 : 0);
  }, () => 0.6, 6000);
  for (const { site } of colonies) {
    const count = Math.round((tier === 'low' ? 6 : tier === 'medium' ? 9 : 14) * Math.max(0.6, density));
    const local = scatter(h, r, count, { minX: site.pos.x - 0.22, maxX: site.pos.x + 0.22, minZ: site.pos.z - 0.22, maxZ: site.pos.z + 0.22 },
      s => (s.pool > 0.2 && s.poolDepth > -0.08 ? 1 : 0), () => 0.022, 800);
    for (const l of local) make(AGGREGATING, l.site, r.range(0.026, 0.045), r);
  }

  const touch = (a: AnemoneInstance) => {
    // A touched anemone snaps shut, holds, then slowly unfurls again.
    animate(a.touch, { value: [{ to: 0.0, duration: 420, ease: 'out(3)' }, { to: 0.0, duration: 3800 }, { to: 1, duration: 5200, ease: 'inOut(2)' }] });
    // Neighbours in a colony feel it too, a little later.
    for (const b of list) {
      if (b === a || b.kind !== a.kind) continue;
      const d = b.site.pos.distanceTo(a.site.pos);
      if (d < 0.14) animate(b.touch, { value: [{ to: 0.15, duration: 600, delay: 150 + d * 3000, ease: 'out(2)' }, { to: 0.15, duration: 2500 }, { to: 1, duration: 4500, ease: 'inOut(2)' }] });
    }
  };

  const update = (dt: number, levelAt: (x: number, z: number) => number) => {
    for (const a of list) {
      // Out of water: close slowly and stay closed until the tide returns.
      const top = a.site.pos.y + a.size * 0.35;
      const under = levelAt(a.site.pos.x, a.site.pos.z) - top;
      const target = under > 0.012 ? 1 : 0;
      const rate = target > a.tide ? 0.12 : 0.5;
      a.tide += (target - a.tide) * Math.min(1, dt * rate * 3);
      a.open.value = Math.min(a.tide, a.touch.value);
    }
  };
  void G;
  return { group, list, touch, update, stats: { anemones: list.length } };
}
