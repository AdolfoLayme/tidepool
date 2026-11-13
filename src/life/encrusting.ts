import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../core/rng.ts';
import { smoothstep, vnoise } from '../core/noise.ts';
import { band, NEAR_REGION, placeOnSite, scatter, type Habitat, type Site } from './habitat.ts';
import { colorize, instanced, lifeMaterial, paramSurface } from './shared.ts';

/**
 * Sessile animals that crust the rock, by tidal zone and wave exposure:
 *  - acorn barnacles (Balanus glandula), upper and mid shore, in dense clusters;
 *  - California mussels (Mytilus californianus), beds on the wave-beaten seaward rock;
 *  - gooseneck barnacles (Pollicipes polymerus), clumps among the mussels at the very edge;
 *  - owl limpets (Lottia gigantea), scattered grazers on mid-shore rock.
 */

/**
 * Acorn barnacle: six flat wall plates (the real animal has six, so a hexagonal cone is the right
 * shape, not a shortcut) rising to a rim, a lip sloping into the opening, and the dark opercular
 * plates closing it. Flat-shaded so each plate catches light on its own. Unit base diameter,
 * 5 seg x 6 triangles: thousands of them sit on the rock.
 */
export function barnacleGeometry(seg: number): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const ring = (r: number, y: number, i: number) => {
    const a = ((i + 0.5) / seg) * Math.PI * 2;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  const tri = (a: number[], b: number[], c: number[], ca: number[], cb: number[], cc: number[]) => {
    pos.push(...a, ...b, ...c);
    col.push(...ca, ...cb, ...cc);
  };
  const dirty = [0.16, 0.15, 0.125], chalk = [0.34, 0.32, 0.28], lip = [0.19, 0.175, 0.15];
  for (let i = 0; i < seg; i++) {
    const j = i + 1;
    const b0 = ring(0.5, 0, i), b1 = ring(0.5, 0, j);
    const r0 = ring(0.21, 0.38, i), r1 = ring(0.21, 0.38, j);
    const l0 = ring(0.13, 0.33, i), l1 = ring(0.13, 0.33, j);
    // Wall plate: grimy at the base, chalky toward the worn rim.
    tri(b0, r0, b1, dirty, chalk, dirty);
    tri(b1, r0, r1, dirty, chalk, chalk);
    // Lip sloping into the opening.
    tri(r0, l0, r1, chalk, lip, chalk);
    tri(r1, l0, l1, chalk, lip, lip);
    // Opercular plates, alternately lit and shadowed, meeting at the slit.
    const op = i % 2 ? [0.1, 0.09, 0.08] : [0.14, 0.125, 0.11];
    tri(l0, [0, 0.3, 0], l1, op, [0.04, 0.035, 0.03], op);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** California mussel: an elongated, slightly flattened shell with growth lines. Unit length. */
export function musselGeometry(segU: number, segV: number): THREE.BufferGeometry {
  const g = paramSurface(segU, segV, (u, v, p) => {
    // v along the shell (0 umbo, 1 posterior), u around the cross-section
    const a = u * Math.PI * 2;
    const t = v;
    const width = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.85) * 0.24 * (0.55 + 0.45 * t);
    const height = width * 0.78;
    const growth = 1 + 0.035 * Math.sin(t * 46) * t;
    const ridge = 1 + 0.08 * Math.pow(Math.abs(Math.cos(a)), 6);
    p.set(Math.cos(a) * width * growth, Math.sin(a) * height * ridge * growth, (t - 0.5) * 1.0);
    // Ventral edge straighter, dorsal edge arched.
    if (Math.sin(a) < 0) p.y *= 0.75;
  }, true);
  return colorize(g, (p, c) => {
    const t = p.z + 0.5;
    // Blue-black shell, brown periostracum toward the margin, umbo worn to blue-white.
    const worn = Math.max(0, 1 - t / 0.22);
    const brown = Math.max(0, (t - 0.55) / 0.45) * 0.6;
    c.setRGB(0.035 + 0.045 * brown + 0.32 * worn * worn, 0.04 + 0.025 * brown + 0.34 * worn * worn, 0.06 + 0.005 * brown + 0.38 * worn * worn);
  });
}

/** Owl limpet: low oval cone, apex near the front, fine radial ribs. Unit length. */
export function limpetGeometry(seg: number): THREE.BufferGeometry {
  const g = paramSurface(seg, 3, (u, v, p) => {
    const a = u * Math.PI * 2;
    const rib = 1 + 0.025 * Math.cos(a * 24);
    const r = (1 - v) * 0.5 * rib;
    const h = Math.pow(v, 0.7) * 0.28;
    p.set(Math.cos(a) * r * 0.82 + v * 0.12, h, Math.sin(a) * r);
  });
  return colorize(g, (p, c) => {
    const apex = Math.max(0, p.y / 0.28);
    // Brown shell with darker radial streaks, worn paler only at the apex.
    const streak = 0.85 + 0.15 * Math.cos(Math.atan2(p.z, p.x) * 9);
    c.setRGB((0.13 + 0.11 * apex) * streak, (0.1 + 0.085 * apex) * streak, (0.07 + 0.06 * apex) * streak);
  });
}

/** Gooseneck barnacle: leathery stalk and a capitulum of white plates. Unit height. */
export function gooseneckGeometry(seg: number): THREE.BufferGeometry {
  const stalk = paramSurface(seg, 3, (u, v, p) => {
    const a = u * Math.PI * 2;
    const r = 0.11 * (1 - 0.25 * v) * (1 + 0.04 * Math.sin(v * 40));
    p.set(Math.cos(a) * r + Math.sin(v * 2.2) * 0.05, v * 0.55, Math.sin(a) * r);
  });
  const head = paramSurface(seg, 3, (u, v, p) => {
    const a = u * Math.PI * 2;
    const plates = 1 + 0.12 * Math.abs(Math.cos(a * 2.5));
    const r = 0.14 * Math.sin(Math.PI * (0.15 + v * 0.85)) * plates * (1 - v * 0.6);
    p.set(Math.cos(a) * r * 1.2 + 0.05, 0.55 + v * 0.45, Math.sin(a) * r * 0.7);
  });
  const g = mergeGeometries([stalk, head])!;
  return colorize(g, (p, c) => {
    if (p.y < 0.56) c.setRGB(0.09, 0.075, 0.06);
    else c.setRGB(0.6, 0.57, 0.5);
  });
}

export type Encrusting = { group: THREE.Group; stats: Record<string, number> };

export function buildEncrusting(h: Habitat, seed: number, density: number, tier: 'low' | 'medium' | 'high'): Encrusting {
  const group = new THREE.Group();
  group.name = 'encrusting';

  // Barnacles: larvae settle where adults already are, so they live in crowded colonies, shells
  // touching, the ones in the middle grown taller; only a few loners sit between colonies.
  // Colonies are placed first (mostly near the viewer, where shells can be seen one by one), then
  // each is packed shell by shell inside a ragged outline.
  const rb = rng(seed, 'life:barnacles');
  const nB = Math.round(4500 * density);
  const zoneOf = (s: Site) => (s.puddle || s.poolDepth > 0.02 ? 0 : band(s.y, -0.32, -0.1, 0.42, 0.62));
  const colonies = scatter(h, rb, Math.round(160 * density), NEAR_REGION, s => {
    const cluster = smoothstep(0.45, 0.66, vnoise(s.pos.x * 1.6 + 3.1, s.pos.z * 1.6 - 2.2, 501));
    const near = 1 - Math.min(1, Math.hypot(s.pos.x, s.pos.z + 0.6) / 7.5);
    return zoneOf(s) * cluster * (0.15 + 0.85 * near * near);
  }, r => r.range(0.05, 0.13), Math.round(160 * density) * 60);
  const barnacles: { site: Site; radius: number; crowd: number }[] = [];
  const loners = Math.round(nB * 0.08);
  for (const col of colonies) {
    if (barnacles.length >= nB - loners) break;
    const R = col.radius, c = col.site.pos;
    // Fill to about half the area with shells of 0.6 to 1.8 cm.
    const want = Math.min(nB - loners - barnacles.length, Math.round((R * R) / (0.0062 * 0.0062) * 0.6));
    let crowd = 0;
    const packed = scatter(h, rb, want, { minX: c.x - R, maxX: c.x + R, minZ: c.z - R, maxZ: c.z + R }, s => {
      const d = Math.hypot(s.pos.x - c.x, s.pos.z - c.z) / R;
      const rim = 0.7 + 0.45 * vnoise(s.pos.x * 34 + 1.3, s.pos.z * 34 - 6.1, 521);
      crowd = 1 - Math.min(1, d / rim);
      return zoneOf(s) > 0.2 ? smoothstep(0.0, 0.12, crowd) : 0;
    }, r => (0.003 + Math.pow(r.next(), 1.6) * 0.006) * (0.75 + 0.45 * crowd), want * 90);
    for (const b of packed) barnacles.push({ ...b, crowd: 1 - Math.min(1, Math.hypot(b.site.pos.x - c.x, b.site.pos.z - c.z) / R) });
  }
  for (const b of scatter(h, rb, nB - barnacles.length, NEAR_REGION, s => {
    const near = 1 - Math.min(1, Math.hypot(s.pos.x, s.pos.z + 0.6) / 7.5);
    return zoneOf(s) * (0.2 + 0.8 * near);
  }, r => 0.004 + Math.pow(r.next(), 2) * 0.006, (nB - barnacles.length) * 30)) barnacles.push({ ...b, crowd: 0 });
  // Chalky shells, but weathered and dirty, not white. With distance a single shell shrinks below
  // a pixel and only the crust tone painted on the rock should remain, so the shells fade to it
  // instead of sparkling as bright points.
  const bMat = lifeMaterial({
    key: 'barnacle', vertexColors: true, roughness: 0.78,
    patch: { fragmentSurface: 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.165, 0.15), smoothstep(2.2, 6.5, distance(cameraPosition, vTpWorld)));' },
  });
  const bm: THREE.Matrix4[] = [], bc: THREE.Color[] = [];
  for (const { site, radius, crowd } of barnacles) {
    // Crowded shells grow up instead of out: taller and narrower toward the colony centre.
    // Bases a little wider than the spacing, so neighbours touch and press into each other.
    const m = placeOnSite(site, radius * (2.4 + 0.5 * crowd), rb.range(0, 6.28), -radius * 0.08, 0.15 + 0.1 * crowd, rb);
    bm.push(m.multiply(new THREE.Matrix4().makeScale(rb.range(0.85, 1.1), 1 + 0.55 * crowd * crowd, rb.range(0.85, 1.1))));
    const t = rb.next();
    bc.push(new THREE.Color().setRGB(0.78 + 0.2 * t, 0.78 + 0.18 * t, 0.76 + 0.16 * t).multiplyScalar(rb.chance(0.3) ? 0.6 : 1));
  }
  const bMesh = instanced(barnacleGeometry(tier === 'low' ? 5 : 6), bMat, bm, bc, 'barnacles');
  bMesh.castShadow = false;
  group.add(bMesh);

  // Mussel beds: shells packed edge to edge in mats where the waves hit and along the seaward lip
  // of the pool, never strewn one by one. Mats are placed first (mostly near the viewer; further
  // out the painted bed carries the look), then packed shell by shell, standing more upright
  // where they are most crowded.
  const rm = rng(seed, 'life:mussels');
  const nM = Math.round(2600 * density);
  const bedAt = (s: Site) => {
    if (s.puddle || s.poolDepth > 0.05) return 0;
    const zone = band(s.y, -0.62, -0.45, 0.2, 0.34);
    const exposed = 1 - Math.min(1, Math.max(0, (s.exposure - 1.0) / 3.5));
    const bed = vnoise(s.pos.x * 0.75 + 11.7, s.pos.z * 0.75 - 4.4, 503);
    const lip = s.pool > 0.05 && s.pos.z < -0.9 ? 0.8 : 0;
    return zone * Math.max(exposed, lip) * (bed > 0.54 ? 1 : 0);
  };
  const mats = scatter(h, rm, Math.round(40 * density), NEAR_REGION, s => {
    const near = 1 - Math.min(1, Math.hypot(s.pos.x, s.pos.z + 1.2) / 8);
    return bedAt(s) * (0.1 + 0.9 * near * near);
  }, r => r.range(0.2, 0.45), Math.round(40 * density) * 200);
  const mussels: { site: Site; radius: number; crowd: number }[] = [];
  for (const mat of mats) {
    if (mussels.length >= nM) break;
    const R = mat.radius, c = mat.site.pos;
    const want = Math.min(nM - mussels.length, Math.round((R * R) / (0.016 * 0.016) * 0.9));
    let crowd = 0;
    const packed = scatter(h, rm, want, { minX: c.x - R, maxX: c.x + R, minZ: c.z - R, maxZ: c.z + R }, s => {
      const d = Math.hypot(s.pos.x - c.x, s.pos.z - c.z) / R;
      const rim = 0.65 + 0.5 * vnoise(s.pos.x * 9 + 2.4, s.pos.z * 9 - 0.7, 523);
      crowd = 1 - Math.min(1, d / rim);
      return bedAt(s) > 0.2 ? smoothstep(0.0, 0.15, crowd) : 0;
    }, r => (0.012 + r.next() * 0.012) * (0.8 + 0.3 * crowd), want * 60);
    for (const m of packed) mussels.push({ ...m, crowd: 1 - Math.min(1, Math.hypot(m.site.pos.x - c.x, m.site.pos.z - c.z) / R) });
  }
  const mMat = lifeMaterial({ key: 'mussel', vertexColors: true, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.25 });
  // Shells more than a few metres from the pool are a few pixels long: they get a coarser shell.
  const mm: THREE.Matrix4[] = [], mc: THREE.Color[] = [], mmFar: THREE.Matrix4[] = [], mcFar: THREE.Color[] = [];
  for (const { site, radius, crowd } of mussels) {
    const far = Math.hypot(site.pos.x, site.pos.z + 0.3) > 4.5;
    const len = radius * 5.2;
    const m = placeOnSite(site, 1, rm.range(0, 6.28), 0.01, 0.2, rm);
    // Umbo down into the bed. Packed shells prop each other up; at the edge of a mat they lie over.
    const tilt = new THREE.Matrix4().makeRotationX(-(0.25 + 0.55 * crowd) - rm.next() * 0.55);
    const lift = new THREE.Matrix4().makeTranslation(0, len * (0.1 + 0.15 * crowd), 0);
    const sc = new THREE.Matrix4().makeScale(len, len, len);
    (far ? mmFar : mm).push(m.multiply(lift).multiply(tilt).multiply(sc));
    (far ? mcFar : mc).push(new THREE.Color(1, 1, 1).multiplyScalar(0.85 + rm.next() * 0.3));
  }
  group.add(instanced(musselGeometry(tier === 'high' ? 8 : tier === 'medium' ? 7 : 6, tier === 'high' ? 7 : tier === 'medium' ? 6 : 5), mMat, mm, mc, 'mussels'));
  group.add(instanced(musselGeometry(5, 4), mMat, mmFar, mcFar, 'mussels-far'));

  // Gooseneck barnacles: clumps on the most exposed edges.
  const rg = rng(seed, 'life:gooseneck');
  const gm: THREE.Matrix4[] = [], gc: THREE.Color[] = [];
  const clumps = scatter(h, rg, Math.round(40 * density), NEAR_REGION, s => {
    if (s.poolDepth > 0) return 0;
    return band(s.y, -0.55, -0.35, 0.15, 0.3) * (s.exposure < 2.2 ? 1 : 0);
  }, () => 0.15, 4000);
  for (const { site } of clumps) {
    const n = rg.int(8, 22);
    for (let i = 0; i < n; i++) {
      const a = rg.range(0, 6.28), d = Math.sqrt(rg.next()) * 0.07;
      const s2 = { ...site, pos: site.pos.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d)) };
      gm.push(placeOnSite(s2, 0.035 + rg.next() * 0.03, rg.range(0, 6.28), 0, 0.35, rg));
      gc.push(new THREE.Color(1, 1, 1).multiplyScalar(0.8 + rg.next() * 0.35));
    }
  }
  const gMat = lifeMaterial({ key: 'gooseneck', vertexColors: true, roughness: 0.6 });
  const gMesh = instanced(gooseneckGeometry(tier === 'low' ? 5 : 6), gMat, gm, gc, 'goosenecks');
  gMesh.castShadow = false;
  group.add(gMesh);

  // Limpets.
  const rl = rng(seed, 'life:limpets');
  const limpets = scatter(h, rl, Math.round(320 * density), NEAR_REGION, s => {
    if (s.puddle || s.poolDepth > 0.15) return 0;
    return band(s.y, -0.4, -0.15, 0.4, 0.6) * 0.5;
  }, r => 0.008 + r.next() * 0.022, 20000);
  const lm: THREE.Matrix4[] = [], lc: THREE.Color[] = [];
  for (const { site, radius } of limpets) {
    lm.push(placeOnSite(site, radius * 2.2, rl.range(0, 6.28), -0.001, 0.05, rl));
    lc.push(new THREE.Color(1, 1, 1).multiplyScalar(0.7 + rl.next() * 0.6));
  }
  const lMat = lifeMaterial({ key: 'limpet', vertexColors: true, roughness: 0.62 });
  const lMesh = instanced(limpetGeometry(tier === 'high' ? 12 : 9), lMat, lm, lc, 'limpets');
  lMesh.castShadow = false;
  group.add(lMesh);

  return { group, stats: { barnacles: barnacles.length, mussels: mussels.length, goosenecks: gm.length, limpets: limpets.length } };
}
