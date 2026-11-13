import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, type Rng } from '../core/rng.ts';
import { vnoise } from '../core/noise.ts';
import { band, NEAR_REGION, POOL_REGION, scatter, type Habitat, type Site } from './habitat.ts';
import { lifeMaterial } from './shared.ts';

/**
 * Seaweeds and seagrass:
 *  - surfgrass (Phyllospadix scouleri): long bright-green blades streaming with the current under
 *    water, lying limp across the rock once the tide has left them;
 *  - coralline turf (Corallina vancouveriensis): stiff, jointed pink tufts lining the pool;
 *  - rockweed (Fucus distichus): olive-brown branching fronds with swollen tips on the mid shore.
 */

/** Water and current shared by blade shaders (vertex side). */
const BLADE_HEAD = /* glsl */`
attribute vec4 aBlade; // length, width, phase, stiffness
uniform vec4 uCurrent; // dir x, dir z, strength, surge
vec3 tpBladeC, tpBladeT, tpBladeW;
void tpBlade(vec3 root, float s) {
  float poolM;
  float level = tpWaterLevel(root.xz, poolM);
  float depth = level - root.y;
  float under = smoothstep(0.0, 0.05, depth);
  float len = aBlade.x;
  // Under water the blade rises and streams with the flow; out of it the blade collapses.
  vec2 flow = uCurrent.xy * (uCurrent.z + uCurrent.w) + vec2(sin(uTime * 0.31 + aBlade.z), cos(uTime * 0.27 + aBlade.z * 1.3)) * 0.25;
  float fl = length(flow);
  vec3 D = fl > 1e-4 ? vec3(flow.x, 0.0, flow.y) / fl : vec3(cos(aBlade.z), 0.0, sin(aBlade.z));
  // Exposed blades fall toward their own random side.
  vec3 Dd = vec3(cos(aBlade.z * 2.3), 0.0, sin(aBlade.z * 2.3));
  D = normalize(mix(Dd, D, under) + vec3(1e-4));
  float th0 = mix(1.45, 0.25 + fl * 0.4 / aBlade.w, under);
  // A blade much longer than the water is deep does not stand up and then fold at the surface:
  // the flow lays it over from the root, so it meets the surface at a shallow angle.
  float shallow = smoothstep(1.2, 4.5, len / max(depth, 0.01)) * under;
  th0 = mix(th0, 1.2, shallow);
  float k = mix(0.15, (0.7 + fl * 1.6) / aBlade.w, under) * (1.0 - 0.3 * shallow);
  // Walk the blade from its root to s: the bend (curvature plus a travelling sway), the side to
  // side lie and the water surface are all applied step by step, so neighbouring vertices lie on
  // one smooth curve. Rising toward the surface, the vertical part of each step is turned
  // sideways along that step's own heading: the floating part of the blade snakes on the surface
  // instead of shooting off straight.
  float cap = max(depth - 0.015, 0.01);
  float bw = min(0.05, cap * 0.8);
  vec3 side = vec3(-D.z, 0.0, D.x);
  vec3 P = vec3(0.0), Ds = D;
  float th = th0, floating = 0.0;
  // Buoyant blades in water bend over to lie along the flow but do not hook back down.
  float thMax = mix(1.75, 1.45, under);
  // A fixed step along the blade, the same for every vertex (the last one partial), so all the
  // vertices of a blade sample one and the same path.
  const int STEPS = 16;
  const float STEP = 1.0 / float(STEPS);
  for (int i = 0; i < STEPS; i++) {
    float s0 = float(i) * STEP;
    if (s0 >= s) break;
    float ds = min(STEP, s - s0);
    float sm = s0 + 0.5 * ds;
    float sway = (sin(uTime * 1.6 + aBlade.z + sm * 4.0) * 0.12 + sin(uTime * 0.7 + aBlade.z * 2.0) * 0.1) * under;
    float kk = k + sway / aBlade.w;
    float thm = min(th + kk * len * ds * 0.5, thMax);
    // On the surface a blade snakes more freely than when it stands in the flow.
    float wander = sin(sm * 7.0 * aBlade.w + aBlade.z * 3.1 + uTime * 0.9) * 0.6 * sm * (1.0 + 0.5 * max(shallow, floating))
      + sin(sm * 4.5 + aBlade.z * 5.7 - uTime * 0.4) * 0.3 * sm * max(shallow, floating);
    Ds = normalize(D + side * wander);
    float dy = cos(thm) * len * ds * mix(0.25, 1.0, under);
    // Out of the water the blade collapses onto the rock; under it, the surface stops it.
    floating = under > 0.5 ? smoothstep(cap - bw, cap, P.y) : 0.0;
    float up = dy * (1.0 - floating);
    P += Ds * (sin(thm) * len * ds + max(dy - up, 0.0) * 0.95) + vec3(0.0, up, 0.0);
    th = min(th + kk * len * ds, thMax);
  }
  tpBladeC = P;
  tpBladeT = normalize(Ds * (sin(th) + floating * cos(th)) + vec3(0.0, cos(th) * (1.0 - floating), 0.0));
  vec3 W0 = normalize(cross(vec3(0.0, 1.0, 0.0), Ds));
  float twist = sin(s * 5.0 + aBlade.z) * 0.6;
  tpBladeW = normalize(W0 * cos(twist) + vec3(0.0, sin(twist), 0.0));
}
`;

/** Ribbon along +y, x across. Unit length and width. */
function ribbon(seg: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, seg);
  g.translate(0, 0.5, 0);
  return g;
}

/** Jointed coralline tuft: upright axes of short calcified segments with paired, feather-like
 * branchlets, pink-lilac with pale tips. About 1 unit tall, a few hundred triangles. */
function corallineTuft(r: Rng, sparse: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const seg = (p: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, tone: number, tip: boolean) => {
    const g = new THREE.CylinderGeometry(rad * 0.8, rad, len * 0.92, 3, 1, true);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate(p.x, p.y, p.z);
    g.deleteAttribute('uv');
    const c = new Float32Array(g.getAttribute('position').count * 3);
    for (let k = 0; k < c.length; k += 3) {
      c[k] = (tip ? 0.5 : 0.36) * tone; c[k + 1] = (tip ? 0.4 : 0.14) * tone; c[k + 2] = (tip ? 0.44 : 0.19) * tone;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g.toNonIndexed());
    return p.clone().addScaledVector(dir, len);
  };
  const axes = sparse ? r.int(3, 5) : r.int(5, 7);
  for (let i = 0; i < axes; i++) {
    const a = r.range(0, 6.28);
    let p = new THREE.Vector3(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06);
    let dir = new THREE.Vector3(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
    const n = r.int(6, 8);
    const tone = 0.85 + r.next() * 0.3;
    for (let k = 0; k < n; k++) {
      const len = 0.085 * (1 - k / (n * 1.6));
      const last = k === n - 1;
      const next = seg(p, dir, len, 0.014, tone, last);
      // Paired branchlets on every other segment, in alternating planes.
      if (k > 0 && k < n - 1 && k % 2 === 1) {
        const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().applyAxisAngle(dir, (k % 4) * Math.PI / 4);
        for (const sgn of [-1, 1]) {
          const bdir = dir.clone().multiplyScalar(0.7).addScaledVector(side, sgn).normalize();
          seg(next, bdir, len * (1.1 - k / n * 0.5), 0.009, tone, true);
        }
      }
      p = next;
      dir = dir.add(new THREE.Vector3(r.signed() * 0.12, 0, r.signed() * 0.12)).normalize();
    }
  }
  return mergeGeometries(parts)!;
}

/** Rockweed clump: forked, flattened fronds lying over the rock, swollen receptacles at the tips. */
function rockweedClump(r: Rng, coarse: boolean): THREE.BufferGeometry {
  // Many forked fronds from one holdfast, piled into a low mound: the inner parts lie on top of
  // each other, the tips droop onto the rock. Each frond its own shade of olive-brown.
  const parts: THREE.BufferGeometry[] = [];
  const reach = 0.6;
  const dome = (d: number) => 0.075 * Math.max(0, 1 - Math.pow(d / reach, 2));
  const frond = (start: THREE.Vector3, dir: THREE.Vector3, width: number, depth: number, tone: number) => {
    const len = 0.2 + r.next() * 0.1;
    // Two strips across (one when coarse), so the midrib stands a little proud of the wings.
    const g = new THREE.PlaneGeometry(width, len, coarse ? 1 : 2, coarse ? 3 : 4);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -len / 2);
    const pos = g.getAttribute('position');
    const along = Float32Array.from({ length: pos.count }, (_, i) => -pos.getZ(i) / len);
    const across = Float32Array.from({ length: pos.count }, (_, i) => pos.getX(i) / (width / 2));
    // Each frond bends sideways and twists a little along its length.
    const bend = r.signed() * 0.12, twist = r.signed() * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const t = along[i], w = across[i];
      // Fronds narrow a little toward the forked, rounded tips.
      const taper = 1 - 0.3 * t * t * (depth === 2 ? 1.6 : 1);
      pos.setX(i, pos.getX(i) * Math.cos(twist * t) * taper + bend * t * t * len);
      pos.setY(i, (1 - Math.abs(w)) * width * 0.12 + w * Math.sin(twist * t) * width * 0.5);
    }
    const yaw = Math.atan2(dir.x, -dir.z);
    g.rotateY(-yaw);
    g.translate(start.x, 0, start.z);
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getZ(i));
      // Lie on the mound, with a small arch of each frond's own and higher orders on top.
      pos.setY(i, pos.getY(i) + dome(d) + Math.sin(along[i] * Math.PI) * 0.014 + depth * 0.007 + 0.004);
    }
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    // Dark olive-brown, the midrib a shade darker: wet rockweed is barely lighter than wet basalt.
    const c = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const rib = 1 - 0.18 * (1 - Math.abs(across[i]));
      c[i * 3] = 0.034 * tone * rib; c[i * 3 + 1] = 0.03 * tone * rib; c[i * 3 + 2] = 0.012 * tone * rib;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
    const end = start.clone().addScaledVector(dir, len);
    if (depth < 2) {
      for (const s of [-1, 1]) frond(end, dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), s * r.range(0.18, 0.42)), width * 0.82, depth + 1, tone * r.range(0.9, 1.1));
    } else {
      // Swollen, warty receptacles at the tips, a little yellower.
      const b = coarse ? new THREE.SphereGeometry(0.03, 4, 2) : new THREE.SphereGeometry(0.03, 4, 3);
      b.scale(1, 0.45, 1.6);
      b.rotateY(-yaw);
      b.translate(end.x, dome(Math.hypot(end.x, end.z)) + 0.02, end.z);
      b.deleteAttribute('uv');
      const cc = new Float32Array(b.getAttribute('position').count * 3);
      for (let i = 0; i < cc.length; i += 3) { cc[i] = 0.05 * tone; cc[i + 1] = 0.042 * tone; cc[i + 2] = 0.015 * tone; }
      b.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      parts.push(b);
    }
  };
  const n = coarse ? r.int(6, 8) : r.int(7, 9);
  const turn = r.range(0, 6.28);
  for (let i = 0; i < n; i++) {
    const a = turn + (i / n) * 6.28 + r.signed() * 0.35;
    const lean = r.range(0.0, 0.06);
    frond(new THREE.Vector3(Math.cos(a) * lean, 0, Math.sin(a) * lean), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.08, 0, r.range(0.75, 1.2));
  }
  return mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p))!;
}

export function buildAlgae(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high') {
  const group = new THREE.Group();
  group.name = 'algae';
  const current = { value: new THREE.Vector4(0.8, 0.6, 0.3, 0) };

  // --- Surfgrass clumps: lower shore at the sea edge, and the seaward end of the pool by the gully.
  const rs = rng(seed, 'life:surfgrass');
  const clumps: Site[] = [
    ...scatter(h, rs, Math.round(9 * density + 3), POOL_REGION, s => (s.pool > 0.6 && s.poolDepth > 0.12 && s.pos.z < -0.5 ? 1 : 0.0), () => 0.25, 3000).map(c => c.site),
    ...scatter(h, rs, Math.round(26 * density + 6), NEAR_REGION, s => (s.poolDepth < 0 && s.exposure < 2.5 ? band(s.y, -1.2, -0.95, -0.3, -0.15) : 0), () => 0.3, 6000).map(c => c.site),
  ];
  const blades: { root: THREE.Vector3; len: number; width: number; phase: number; stiff: number }[] = [];
  const perClump = tier === 'high' ? 70 : tier === 'medium' ? 48 : 26;
  for (const c of clumps) {
    const n = Math.round(perClump * rs.range(0.6, 1.3));
    for (let i = 0; i < n; i++) {
      const a = rs.range(0, 6.28), d = Math.sqrt(rs.next()) * 0.09;
      const x = c.pos.x + Math.cos(a) * d, z = c.pos.z + Math.sin(a) * d;
      blades.push({ root: new THREE.Vector3(x, h.heightAt(x, z) - 0.005, z), len: rs.range(0.25, 0.7), width: rs.range(0.004, 0.0065), phase: rs.range(0, 6.28) + c.pos.x * 3.0, stiff: rs.range(0.8, 1.3) });
    }
  }
  const bGeo = ribbon(tier === 'low' ? 6 : 10);
  const bAttr = new Float32Array(blades.length * 4);
  blades.forEach((b, i) => { bAttr[i * 4] = b.len; bAttr[i * 4 + 1] = b.width; bAttr[i * 4 + 2] = b.phase; bAttr[i * 4 + 3] = b.stiff; });
  bGeo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(bAttr, 4));
  const bMat = lifeMaterial({
    key: 'surfgrass', color: new THREE.Color(0.035, 0.2, 0.03), roughness: 0.4, side: THREE.DoubleSide, sheen: 0.5, sheenColor: new THREE.Color(0.2, 0.5, 0.1),
    patch: {
      vertexCommon: true,
      uniforms: { uCurrent: current },
      vertexHead: BLADE_HEAD,
      vertexNormal: `{
        vec3 rootW = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        tpBlade(rootW, position.y);
        objectNormal = normalize(cross(tpBladeT, tpBladeW));
      }`,
      vertexTransform: 'transformed = tpBladeC + tpBladeW * position.x * aBlade.y;',
      // A blade right in front of the lens would be a flat stripe across the frame: blades closer
      // than uLensClear dissolve (dithered, so no sorting is needed).
      fragmentSurface: `{
        float camD = distance(cameraPosition, vTpWorld);
        float dither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (dither > smoothstep(uLensClear * 0.75, uLensClear, camD)) discard;
      }`,
      fragmentOutput: `{
        vec3 vdir = normalize(cameraPosition - vTpWorld);
        float back = pow(max(dot(-vdir, normalize(uSunDir)), 0.0), 2.0);
        outgoingLight += diffuseColor.rgb * uSunColor * back * 0.5;
      }`,
    },
  });
  const surf = new THREE.InstancedMesh(bGeo, bMat, Math.max(1, blades.length));
  blades.forEach((b, i) => surf.setMatrixAt(i, new THREE.Matrix4().makeTranslation(b.root.x, b.root.y, b.root.z)));
  surf.count = blades.length;
  surf.instanceMatrix.needsUpdate = true;
  surf.frustumCulled = false;
  surf.castShadow = true; surf.receiveShadow = true;
  surf.name = 'surfgrass';
  group.add(surf);

  // --- Coralline turf on the pool rim and walls just below the waterline.
  const rc = rng(seed, 'life:coralline');
  const tufts = scatter(h, rc, Math.round(200 * density), POOL_REGION, s => {
    if (s.pool < 0.3) return 0;
    const turf = vnoise(s.pos.x * 2.2 + 1.7, s.pos.z * 2.2 + 0.3, 511);
    return band(s.poolDepth, -0.02, 0.02, 0.2, 0.35) * (turf > 0.45 ? 1 : 0.1);
  }, r => r.range(0.02, 0.035), 12000);
  const tGeos = Array.from({ length: 4 }, () => corallineTuft(rc, tier === 'low'));
  const tMat = lifeMaterial({ key: 'coralline', vertexColors: true, roughness: 0.8 });
  for (let v = 0; v < tGeos.length; v++) {
    const list = tufts.filter((_, i) => i % tGeos.length === v);
    const m = new THREE.InstancedMesh(tGeos[v], tMat, Math.max(1, list.length));
    list.forEach(({ site, radius }, i) => {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), site.normal.clone().lerp(new THREE.Vector3(0, 1, 0), 0.4).normalize());
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rc.range(0, 6.28)));
      m.setMatrixAt(i, new THREE.Matrix4().compose(site.pos, q, new THREE.Vector3(radius, radius * rc.range(1.0, 1.6), radius).multiplyScalar(1.4)));
    });
    m.count = list.length;
    m.castShadow = false; m.receiveShadow = true;
    m.computeBoundingSphere();
    m.name = 'coralline-turf';
    group.add(m);
  }

  // --- Rockweed on the mid shore, draped over the rock.
  const rw = rng(seed, 'life:rockweed');
  const weeds = scatter(h, rw, Math.round(70 * density), NEAR_REGION, s => {
    if (s.poolDepth > 0 || s.puddle) return 0;
    const patch = vnoise(s.pos.x * 0.9 + 21.3, s.pos.z * 0.9 - 8.8, 513);
    return band(s.y, -0.05, 0.08, 0.32, 0.45) * (patch > 0.55 ? 1 : 0) * (s.normal.y > 0.7 ? 1 : 0);
  }, r => r.range(0.12, 0.2), 8000);
  const wGeos = Array.from({ length: 3 }, () => rockweedClump(rw, tier === 'low'));
  // Slick, but not mirror-like: at a low angle a glossy frond would turn into a white twig.
  const wMat = lifeMaterial({ key: 'rockweed', vertexColors: true, roughness: 0.56, specularIntensity: 0.45, side: THREE.DoubleSide });
  for (let v = 0; v < wGeos.length; v++) {
    const list = weeds.filter((_, i) => i % wGeos.length === v);
    const m = new THREE.InstancedMesh(wGeos[v], wMat, Math.max(1, list.length));
    list.forEach(({ site, radius }, i) => {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), site.normal);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rw.range(0, 6.28)));
      m.setMatrixAt(i, new THREE.Matrix4().compose(site.pos, q, new THREE.Vector3(1, 1, 1).multiplyScalar(radius * 2.4)));
    });
    m.count = list.length;
    m.castShadow = true; m.receiveShadow = true;
    m.computeBoundingSphere();
    m.name = 'rockweed';
    group.add(m);
  }

  return { group, current, stats: { surfgrassBlades: blades.length, corallineTufts: tufts.length, rockweed: weeds.length } };
}
