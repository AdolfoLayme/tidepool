import * as THREE from 'three';
import { G } from '../core/globals.ts';
import type { QualityProfile } from '../core/quality.ts';
import { rng } from '../core/rng.ts';
import { patchMaterial, type RockKind } from '../render/patch.ts';
import { LAYER_DETAIL } from '../render/pipeline.ts';
import { terrainFromArrays, type TerrainData } from './terrainMesh.ts';
import { BOULDER_VARIANTS, COBBLE_VARIANTS, boulderGeometry, buildInstanced, cobbleGeometry, stackGeometry, type RockLayout } from './rocks.ts';
import { shoreMapsFromArrays, POOL_RECT, SHORE_RECT, type ShoreMaps } from './shoreMaps.ts';
import { runWorldJob, type WorldJob, type WorldResult } from './worldWorker.ts';
import WorldWorker from './worldWorker.ts?worker&inline';
import rockAlbedoUrl from '../assets/textures/seaside_rock_diff_2k.jpg';
import rockNormalUrl from '../assets/textures/seaside_rock_nor_gl_2k.jpg';

export type World = {
  group: THREE.Group;
  terrain: TerrainData;
  maps: ShoreMaps;
  layout: RockLayout;
  rockMaterial: THREE.MeshPhysicalMaterial;
  stats: Record<string, number>;
  /** Resolves when textures are decoded and uploaded. */
  ready: Promise<void>;
};

export function makeRockMaterial(kind: RockKind, detail: number, tint = new THREE.Color(1, 1, 1)): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1 });
  m.userData.rockTint = { value: tint };
  return patchMaterial(m, { key: `rock-${kind}`, rock: kind, detail });
}

function loadTexture(url: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = anisotropy;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      resolve(tex);
    }, undefined, reject);
  });
}

export function countTriangles(obj: THREE.Object3D): number {
  let tris = 0;
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry;
    const per = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    tris += per * inst;
  });
  return Math.round(tris);
}

function generate(job: WorldJob): Promise<WorldResult & { worker: boolean }> {
  return new Promise(resolve => {
    let worker: Worker | null = null;
    const fallback = () => { worker?.terminate(); resolve({ ...runWorldJob(job), worker: false }); };
    try {
      worker = new WorldWorker();
      worker.onmessage = (e: MessageEvent<WorldResult>) => { worker?.terminate(); resolve({ ...e.data, worker: true }); };
      worker.onerror = fallback;
      worker.postMessage(job);
    } catch {
      fallback();
    }
  });
}

/** Boulders whose edge is within this distance (m) of the pool centre get the fine mesh. */
const BOULDER_NEAR = 5;
/** Cobbles at least this large (radius, m) get the fine mesh; most are smaller. */
const COBBLE_BIG = 0.06;

/** Builds the rock shelf, boulders, cobbles and distant stacks for one quality profile. */
export async function buildWorld(seed: number, q: QualityProfile, maxAnisotropy: number): Promise<World> {
  const group = new THREE.Group();
  group.name = 'world';
  const t0 = performance.now();
  const result = await generate({
    seed, density: q.lifeDensity,
    terrain: { fine: q.terrainFine, coarse: q.terrainCoarse, aoDirections: q.aoDirections },
    poolRes: q.tier === 'low' ? [384, 272] : [512, 362], shoreRes: [384, 294],
  });
  const tGen = performance.now() - t0;
  const layout = result.layout;
  const terrain = terrainFromArrays(result.terrain);
  const maps = shoreMapsFromArrays(result.shore);
  // The pool must never sit above the lowest rim either representation allows.
  maps.spillLevel = Math.min(maps.spillLevel, terrain.spillLevel) - 0.001;
  G.uShoreTex.value = maps.shore;
  G.uShoreRect.value.copy(SHORE_RECT);
  G.uPoolTex.value = maps.pool;
  G.uPoolRect.value.copy(POOL_RECT);
  G.uPoolLevel.value = maps.spillLevel;

  const rockMaterial = makeRockMaterial('terrain', q.shaderDetail);
  const shelf = new THREE.Mesh(terrain.geometry, rockMaterial);
  shelf.name = 'shelf';
  shelf.receiveShadow = true;
  shelf.castShadow = true;
  group.add(shelf);

  const boulderMat = makeRockMaterial('boulder', Math.min(q.shaderDetail, 1));
  // Two levels of detail per shape. A second generator replays the same random stream, so the
  // coarse copy of each boulder or cobble has exactly the shape of the fine one. The camera stays
  // around the pool: boulders far from it, and the many small cobbles, use the coarse copy.
  const r = rng(seed, 'rocks:shapes');
  const rCoarse = rng(seed, 'rocks:shapes');
  const bGeo: THREE.BufferGeometry[] = [], bGeoFar: THREE.BufferGeometry[] = [];
  const farDetail = Math.max(5, Math.round(q.boulderDetail * 0.5));
  for (let i = 0; i < BOULDER_VARIANTS; i++) {
    bGeo.push(boulderGeometry(r, q.boulderDetail, 0.012 + 0.012 * (i % 3), r.range(0.58, 0.92)));
    bGeoFar.push(boulderGeometry(rCoarse, farDetail, 0.012 + 0.012 * (i % 3), rCoarse.range(0.58, 0.92)));
  }
  const nearPool = (p: { x: number; z: number; s: number }) => Math.hypot(p.x, p.z + 0.3) - p.s < BOULDER_NEAR;
  for (const m of buildInstanced(layout.boulders.filter(nearPool), bGeo, boulderMat, 'boulder')) group.add(m);
  for (const m of buildInstanced(layout.boulders.filter(p => !nearPool(p)), bGeoFar, boulderMat, 'boulder-far')) group.add(m);

  const cobbleMat = makeRockMaterial('cobble', 0, new THREE.Color(0.95, 1.0, 0.97));
  const cobbleDetail = Math.max(3, Math.round(q.boulderDetail / 4));
  const cGeo: THREE.BufferGeometry[] = [], cGeoSmall: THREE.BufferGeometry[] = [];
  for (let i = 0; i < COBBLE_VARIANTS; i++) {
    cGeo.push(cobbleGeometry(r, cobbleDetail));
    cGeoSmall.push(cobbleGeometry(rCoarse, Math.max(1, cobbleDetail - 2)));
  }
  const big = (p: { s: number }) => p.s >= COBBLE_BIG;
  const cobbleMeshes = [
    ...buildInstanced(layout.cobbles.filter(big), cGeo, cobbleMat, 'cobble'),
    ...buildInstanced(layout.cobbles.filter(p => !big(p)), cGeoSmall, cobbleMat, 'cobble-small'),
  ];
  for (const m of cobbleMeshes) { m.castShadow = q.tier !== 'low'; m.layers.set(LAYER_DETAIL); group.add(m); }

  const stackMat = makeRockMaterial('boulder', 0, new THREE.Color(0.9, 0.92, 0.95));
  const sGeo = Array.from({ length: BOULDER_VARIANTS }, () => stackGeometry(r));
  for (const m of buildInstanced(layout.stacks, sGeo, stackMat, 'stack')) { m.castShadow = false; m.receiveShadow = false; group.add(m); }

  const ready = Promise.all([loadTexture(rockAlbedoUrl, true, maxAnisotropy), loadTexture(rockNormalUrl, false, maxAnisotropy)]).then(([a, n]) => {
    G.uRockAlbedo.value = a;
    G.uRockNormal.value = n;
  });

  const stats = {
    terrainTris: terrain.stats.triangles,
    terrainMs: Math.round(terrain.stats.ms),
    generateMs: Math.round(tGen),
    inWorker: result.worker ? 1 : 0,
    buildMs: Math.round(performance.now() - t0),
    boulders: layout.boulders.length,
    cobbles: layout.cobbles.length,
    rockTris: countTriangles(group) - terrain.stats.triangles,
  };
  return { group, terrain, maps, layout, rockMaterial, stats, ready };
}
