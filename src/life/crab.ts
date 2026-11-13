import * as THREE from 'three';
import { animate, createTimeline } from 'animejs';
import { rng, type Rng } from '../core/rng.ts';
import { POOL_REGION, scatter, type Habitat } from './habitat.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lifeMaterial } from './shared.ts';

/**
 * Hairy hermit crab (Pagurus hirsutiusculus) living in a black turban snail shell
 * (Tegula funebralis), as is typical on this coast. It walks the pool floor with an alternating
 * gait, stops to pick at the rock with its claws, and pulls back into the shell when touched.
 */

/** Turban shell: a tube winding down a low spire, growing by a constant ratio each whorl. */
export function turbanShellGeometry(detail: number): THREE.BufferGeometry {
  const whorls = 3.6;
  const segT = Math.round(110 * detail), segC = Math.round(18 * detail);
  const k = Math.log(2.3) / (Math.PI * 2);
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const thMax = whorls * Math.PI * 2;
  for (let i = 0; i <= segT; i++) {
    const th = (i / segT) * thMax;
    const g = Math.exp(k * (th - thMax));
    const R = 0.4 * g, a = 0.4 * g, H = 0.62 * g;
    const cx = Math.cos(th) * R, cz = Math.sin(th) * R, cy = -H + 0.5;
    for (let j = 0; j <= segC; j++) {
      const phi = (j / segC) * Math.PI * 2;
      // Cross-section: slightly flattened, with spiral cords.
      // Spiral cords and growth lines, a little irregular.
      const cord = 1 + 0.035 * Math.pow(Math.abs(Math.sin(phi * 7 + th * 0.2)), 3) + 0.012 * Math.sin(th * 23 + phi);
      const rr = a * cord;
      const ox = Math.cos(phi) * rr, oy = Math.sin(phi) * rr * 0.85;
      pos.push(cx + Math.cos(th) * ox, cy + oy, cz + Math.sin(th) * ox);
      // Black-purple, worn to pearly white and orange-tan at the apex.
      const apex = 1 - i / segT;
      const worn = Math.pow(apex, 2.5);
      const lip = i > segT - 2 ? 1 : 0;
      col.push(0.025 + 0.42 * worn + 0.25 * lip, 0.02 + 0.26 * worn + 0.22 * lip, 0.03 + 0.14 * worn + 0.2 * lip);
    }
  }
  for (let i = 0; i < segT; i++) {
    for (let j = 0; j < segC; j++) {
      const a = i * (segC + 1) + j, b = a + 1, c = a + segC + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Close the aperture: the crab's body fills it, dark and soft.
  const last = segT * (segC + 1);
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j <= segC; j++) { cx += pos[(last + j) * 3]; cy += pos[(last + j) * 3 + 1]; cz += pos[(last + j) * 3 + 2]; }
  const n = segC + 1;
  const capPos = [cx / n, cy / n, cz / n];
  const capCol = [0.022, 0.016, 0.011];
  const cap = new THREE.BufferGeometry();
  const cp: number[] = [], cc: number[] = [], ci: number[] = [];
  cp.push(...capPos); cc.push(...capCol);
  for (let j = 0; j <= segC; j++) { cp.push(pos[(last + j) * 3], pos[(last + j) * 3 + 1], pos[(last + j) * 3 + 2]); cc.push(...capCol); }
  for (let j = 0; j < segC; j++) ci.push(0, j + 1, j + 2, 0, j + 2, j + 1);
  cap.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cap.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
  cap.setIndex(ci);
  cap.computeVertexNormals();
  const merged = mergeGeometries([g.toNonIndexed(), cap.toNonIndexed()])!;
  merged.computeVertexNormals();
  merged.translate(-0.1, 0, 0);
  return merged;
}

/** Chela: a swollen, granular palm with a fixed and a movable finger, pointing along +x. */
function chelaGeometry(side: number): THREE.BufferGeometry {
  const palm = new THREE.SphereGeometry(0.1, 12, 9);
  palm.scale(1.5, 0.75, 1);
  const pos = palm.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const g = 1 + 0.06 * Math.sin(x * 120) * Math.sin(z * 110) * Math.sin(y * 90);
    pos.setXYZ(i, x * g, y * g, z * g);
  }
  const fixed = new THREE.ConeGeometry(0.04, 0.17, 7);
  fixed.rotateZ(-Math.PI / 2);
  fixed.translate(0.22, -0.02, 0);
  const mov = new THREE.ConeGeometry(0.035, 0.16, 7);
  mov.rotateZ(-Math.PI / 2 - 0.25);
  mov.translate(0.21, 0.04, 0);
  const parts = [palm, fixed, mov].map(g => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; });
  const g = mergeGeometries(parts)!;
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const tip = Math.max(0, (p.getX(i) - 0.22) / 0.08);
    const band = 0.72 + 0.28 * Math.pow(Math.sin(p.getX(i) * 75 + p.getZ(i) * 18), 2);
    col[i * 3] = (0.16 + 0.4 * tip) * band; col[i * 3 + 1] = (0.1 + 0.36 * tip) * band; col[i * 3 + 2] = (0.05 + 0.3 * tip) * band;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  if (side < 0) g.scale(1, 1, -1);
  return g;
}

/** Leg segment: a slightly flattened capsule along +y with banding baked into vertex colour. */
function segmentGeometry(): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(0.5, 1, 3, 7);
  g.translate(0, 1, 0);
  g.scale(1, 0.5, 0.85);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i);
    const band = t > 0.75 && t < 0.88 ? 1 : 0;
    col[i * 3] = band ? 0.55 : 0.12;
    col[i * 3 + 1] = band ? 0.52 : 0.085;
    col[i * 3 + 2] = band ? 0.48 : 0.05;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

type Leg = { side: number; index: number; phase: number; base: THREE.Vector3; lengths: number[]; radius: number };

export type Crab = {
  root: THREE.Group;
  body: THREE.Group;
  shell: THREE.Mesh;
  proxy: THREE.Mesh;
  legs: Leg[];
  pos: THREE.Vector3;
  heading: number;
  target: THREE.Vector3;
  speed: number;
  gait: number;
  pause: number;
  /** 1 out and walking, 0 withdrawn into the shell. */
  out: { value: number };
  hiding: boolean;
  size: number;
  rand: Rng;
};

export function buildCrabs(h: Habitat, seed: number, count: number, tier: 'low' | 'medium' | 'high') {
  const group = new THREE.Group();
  group.name = 'crabs';
  const r = rng(seed, 'life:crabs');
  const detail = tier === 'high' ? 1 : tier === 'medium' ? 0.75 : 0.5;
  const shellGeo = turbanShellGeometry(detail);
  const shellMat = lifeMaterial({ key: 'tegula', vertexColors: true, roughness: 0.68 });
  const segGeo = segmentGeometry();
  const segMat = lifeMaterial({ key: 'crab-leg', vertexColors: true, roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0.4, 0.35, 0.25), sheenRoughness: 0.8 });
  const eyeMat = lifeMaterial({ key: 'crab-eye', color: 0x050505, roughness: 0.15, clearcoat: 1 });
  const bodyMat = lifeMaterial({ key: 'crab-body', color: new THREE.Color(0.14, 0.1, 0.06), roughness: 0.6 });
  const clawMat = lifeMaterial({ key: 'crab-claw', vertexColors: true, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color(0.55, 0.5, 0.4), sheenRoughness: 0.7 });
  const floorSites = scatter(h, r, count, POOL_REGION, s => (s.pool > 0.7 && s.poolDepth > 0.1 && s.normal.y > 0.8 ? 1 : 0), () => 0.4, 3000);
  const crabs: Crab[] = [];
  const maxSegs = floorSites.length * 64;
  const segs = new THREE.InstancedMesh(segGeo, segMat, Math.max(1, maxSegs));
  segs.castShadow = true; segs.receiveShadow = true;
  segs.frustumCulled = false;
  segs.name = 'crab-legs';
  group.add(segs);

  for (const { site } of floorSites) {
    const size = r.range(0.026, 0.034);
    const root = new THREE.Group();
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.castShadow = true; shell.receiveShadow = true;
    const body = new THREE.Group();
    // Carapace front, claws (chelae) with fingers, eyes on stalks.
    const cara = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 9), bodyMat);
    cara.scale.set(1.25, 0.65, 1);
    body.add(cara);
    for (const side of [-1, 1]) {
      const big = side > 0 ? 1.4 : 0.85; // right claw larger
      const claw = new THREE.Mesh(chelaGeometry(side), clawMat);
      claw.scale.setScalar(big);
      claw.position.set(0.2, -0.05, side * 0.14);
      claw.rotation.set(0, -side * 0.35, -0.25);
      claw.castShadow = true;
      body.add(claw);
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.16, 6), bodyMat);
      stalk.position.set(0.2, 0.12, side * 0.05);
      stalk.rotation.set(side * 0.25, 0, -0.35);
      body.add(stalk);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), eyeMat);
      eye.position.set(0.23, 0.2, side * 0.07);
      body.add(eye);
    }
    root.add(shell, body);
    const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.y = 0.4;
    root.add(proxy);
    root.scale.setScalar(size);
    group.add(root);
    const legs: Leg[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        legs.push({ side, index: i, phase: (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? Math.PI : 0), base: new THREE.Vector3(0.1 - i * 0.08, -0.03, side * 0.11), lengths: [0.36, 0.32, 0.3], radius: 0.13 });
      }
    }
    crabs.push({
      root, body, shell, proxy, legs, pos: site.pos.clone(), heading: r.range(0, 6.28), target: site.pos.clone(),
      speed: r.range(0.018, 0.03), gait: r.range(0, 6.28), pause: r.range(1, 3), out: { value: 1 }, hiding: false, size, rand: r,
    });
  }

  const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const pickTarget = (c: Crab) => {
    for (let i = 0; i < 20; i++) {
      const x = c.pos.x + c.rand.range(-0.6, 0.6), z = c.pos.z + c.rand.range(-0.5, 0.5);
      if (h.maps.poolMaskAt(x, z) > 0.85 && h.spill - h.heightAt(x, z) > 0.08) { c.target.set(x, 0, z); return; }
    }
    c.target.set(c.pos.x, 0, c.pos.z);
  };

  const update = (dt: number, time: number) => {
    let si = 0;
    for (const c of crabs) {
      const out = c.out.value;
      // Walk toward the target, pausing now and then to feed.
      let moving = 0;
      if (!c.hiding && out > 0.95) {
        if (c.pause > 0) c.pause -= dt;
        else {
          const dx = c.target.x - c.pos.x, dz = c.target.z - c.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.02) { c.pause = c.rand.range(1.5, 5); pickTarget(c); }
          else {
            const want = Math.atan2(dz, dx);
            let turn = Math.atan2(Math.sin(want - c.heading), Math.cos(want - c.heading));
            turn = Math.max(-1.6 * dt, Math.min(1.6 * dt, turn));
            c.heading += turn;
            const step = Math.min(d, c.speed * dt * (Math.abs(turn) < 0.02 ? 1 : 0.6));
            c.pos.x += Math.cos(c.heading) * step;
            c.pos.z += Math.sin(c.heading) * step;
            moving = 1;
            c.gait += dt * (c.speed / c.size) * 1.6;
          }
        }
      }
      const ground = h.heightAt(c.pos.x, c.pos.z);
      c.pos.y = ground;
      // Align to the rock under the crab.
      const eps = 0.02;
      const nx = h.heightAt(c.pos.x - eps, c.pos.z) - h.heightAt(c.pos.x + eps, c.pos.z);
      const nz = h.heightAt(c.pos.x, c.pos.z - eps) - h.heightAt(c.pos.x, c.pos.z + eps);
      const n = v.set(nx, 2 * eps, nz).normalize();
      q.setFromUnitVectors(up, n).multiply(new THREE.Quaternion().setFromAxisAngle(up, -c.heading));
      c.root.position.set(c.pos.x, ground + c.size * 0.02, c.pos.z);
      c.root.quaternion.copy(q);
      // Shell rides above and behind, rocking slightly with each step.
      const bob = Math.sin(c.gait * 2) * 0.015 * moving;
      c.shell.position.set(-0.28 - 0.12 * (1 - out), 0.43 - 0.18 * (1 - out) + bob, 0);
      c.shell.rotation.set(Math.sin(c.gait) * 0.04 * moving, 0, -0.35 + Math.sin(c.gait * 2) * 0.03 * moving);
      // Body tucks into the aperture as the crab withdraws.
      c.body.position.set(0.05 - 0.32 * (1 - out), 0.18 + 0.12 * (1 - out), 0);
      c.body.scale.setScalar(0.4 + 0.6 * out);
      // Feeding: claws pick at the rock while paused.
      const feed = c.pause > 0 && out > 0.95 ? Math.max(0, Math.sin(time * 4 + c.gait)) : 0;
      c.body.rotation.z = -0.15 * feed;
      c.root.updateMatrixWorld();
      // Legs: three segments, planted and lifted in an alternating gait; folded when hiding.
      for (const leg of c.legs) {
        const ph = c.gait + leg.phase;
        const swing = Math.sin(ph) * 0.45 * moving;
        const lift = Math.max(0, Math.cos(ph)) * 0.5 * moving;
        const fold = 1 - out;
        const yaw = leg.side * (1.25 + leg.index * 0.32) + swing;
        // Merus rises outward, carpus and dactyl reach down to the rock; folded when hiding.
        const angles = [0.5 + lift + fold * 0.9, 1.3 - lift * 0.4 + fold * 0.9, 0.55 + fold * 0.6];
        if (leg.index === 2) angles[0] += 0.1;
        const m = new THREE.Matrix4().makeTranslation(leg.base.x + c.body.position.x, leg.base.y + c.body.position.y, leg.base.z);
        m.multiply(tmp.makeRotationY(yaw));
        let acc = 0;
        for (let k = 0; k < 3; k++) {
          acc += k === 0 ? angles[0] : -angles[k];
          const segM = m.clone().multiply(tmp.makeRotationZ(-Math.PI / 2 + acc));
          const len = leg.lengths[k] * (0.55 + 0.45 * out);
          sc.set(leg.radius * (1 - k * 0.2), len, leg.radius * (1 - k * 0.2));
          const segFinal = segM.clone().multiply(tmp.makeScale(sc.x, sc.y, sc.z));
          segs.setMatrixAt(si++, new THREE.Matrix4().multiplyMatrices(c.root.matrixWorld, segFinal));
          // Advance to the end of this segment.
          m.multiply(tmp.makeRotationZ(-Math.PI / 2 + acc)).multiply(tmp.makeTranslation(0, len, 0)).multiply(tmp.makeRotationZ(Math.PI / 2 - acc));
        }
      }
      // Antennae.
      for (const side of [-1, 1]) {
        const m = new THREE.Matrix4().makeTranslation(0.22 + c.body.position.x, 0.12 + c.body.position.y, side * 0.04);
        e.set(side * 0.35 + Math.sin(time * 2.1 + side) * 0.2, 0, -1.2 + Math.sin(time * 1.7 + side * 2) * 0.15);
        m.multiply(tmp.makeRotationFromEuler(e)).multiply(tmp.makeScale(0.012, 0.32 * out, 0.012));
        segs.setMatrixAt(si++, new THREE.Matrix4().multiplyMatrices(c.root.matrixWorld, m));
      }
    }
    segs.count = si;
    segs.instanceMatrix.needsUpdate = true;
  };

  const touch = (c: Crab) => {
    if (c.hiding) return;
    c.hiding = true;
    createTimeline({ onComplete: () => { c.hiding = false; c.pause = 0; pickTarget(c); c.speed *= 1.6; setTimeout(() => { c.speed /= 1.6; }, 6000); } })
      .add(c.out, { value: 0, duration: 260, ease: 'out(3)' })
      .add(c.out, { value: 0, duration: 4200 })
      .add(c.out, { value: [0, 0.35], duration: 900, ease: 'inOut(2)' })
      .add(c.out, { value: 0.35, duration: 700 })
      .add(c.out, { value: 1, duration: 800, ease: 'out(2)' });
  };
  void animate;

  for (const c of crabs) pickTarget(c);
  update(0, 0);
  return { group, crabs, update, touch, stats: { crabs: crabs.length } };
}
