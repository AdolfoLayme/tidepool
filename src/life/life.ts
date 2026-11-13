import * as THREE from 'three';
import type { QualityProfile } from '../core/quality.ts';
import type { World } from '../world/world.ts';
import { sampleGrid } from '../world/grid.ts';
import type { Habitat } from './habitat.ts';
import { buildEncrusting } from './encrusting.ts';
import { buildAnemones } from './anemones.ts';
import { buildStars } from './stars.ts';
import { buildUrchins } from './urchins.ts';
import { buildAlgae } from './algae.ts';
import { buildCrabs } from './crab.ts';
import { buildFish } from './fish.ts';
import { LAYER_DETAIL } from '../render/pipeline.ts';

export type Clickable = {
  object: THREE.Object3D;
  label: string;
  /** Latin name shown in the macro view. */
  species: string;
  /** World position to frame and the distance to frame it from. */
  focus: () => THREE.Vector3;
  frameDistance: number;
  touch: (time: number) => void;
};

/**
 * Everything alive in and around the pool. Each group is deterministic from the seed and scaled by
 * the quality tier's life density.
 */
export class Life {
  readonly group = new THREE.Group();
  readonly clickables: Clickable[] = [];
  readonly stats: Record<string, number> = {};
  readonly habitat: Habitat;
  private readonly anemones: ReturnType<typeof buildAnemones>;
  private readonly stars: ReturnType<typeof buildStars>;
  private readonly algae: ReturnType<typeof buildAlgae>;
  private readonly crabs: ReturnType<typeof buildCrabs>;
  private readonly fish: ReturnType<typeof buildFish>;
  private readonly proxies: { mesh: THREE.Mesh; follow: () => THREE.Vector3 }[] = [];
  private time = 0;
  private shoalProxy: THREE.Object3D | null = null;
  /** Extra flow from water pouring into the pool (0..1), set by the app. */
  surge = 0;
  /** Still water level at a point (pool or sea), supplied by the water system. */
  levelAt: (x: number, z: number) => number = () => -10;

  constructor(world: World, profile: QualityProfile, seed: number) {
    this.group.name = 'life';
    const filled = { xs: world.terrain.grid.xs, zs: world.terrain.grid.zs, h: world.terrain.filled };
    this.habitat = {
      maps: world.maps,
      spill: world.maps.spillLevel,
      heightAt: (x, z) => world.terrain.heightAt(x, z),
      puddleLevel: (x, z) => sampleGrid(filled, x, z),
    };
    const t0 = performance.now();
    const enc = buildEncrusting(this.habitat, seed, profile.lifeDensity, profile.tier);
    this.group.add(enc.group);
    enc.group.traverse(o => o.layers.set(LAYER_DETAIL));
    this.anemones = buildAnemones(this.habitat, seed, profile.lifeDensity, profile.tier);
    this.group.add(this.anemones.group);
    this.anemones.group.traverse(o => o.layers.set(LAYER_DETAIL));
    for (const a of this.anemones.list) {
      this.clickables.push({
        object: a.proxy, label: a.kind.label, species: a.kind.species,
        focus: () => new THREE.Vector3(0, 0.45, 0).applyMatrix4(a.root.matrix),
        frameDistance: Math.max(0.22, a.size * 3.4),
        touch: () => this.anemones.touch(a),
      });
    }
    this.stars = buildStars(this.habitat, seed, profile.lifeDensity, profile.tier);
    this.group.add(this.stars.group);
    this.stars.group.traverse(o => o.layers.set(LAYER_DETAIL));
    for (const st of this.stars.list) {
      this.clickables.push({
        object: st.mesh, label: 'Ochre sea star', species: 'Pisaster ochraceus',
        focus: () => st.center.clone(), frameDistance: Math.max(0.35, st.size * 4.2),
        touch: () => this.stars.touch(st),
      });
    }
    const occupied = [
      ...this.anemones.list.map(a => ({ x: a.site.pos.x, z: a.site.pos.z, r: a.size * 0.7 })),
      ...this.stars.list.map(st => ({ x: st.site.pos.x, z: st.site.pos.z, r: st.size * 0.8 })),
    ];
    const urchins = buildUrchins(this.habitat, seed, profile.lifeDensity, profile.tier, occupied);
    this.group.add(urchins.mesh);
    urchins.mesh.layers.set(LAYER_DETAIL);
    this.algae = buildAlgae(this.habitat, seed, profile.lifeDensity, profile.tier);
    this.group.add(this.algae.group);
    this.algae.group.traverse(o => o.layers.set(LAYER_DETAIL));
    this.crabs = buildCrabs(this.habitat, seed, profile.tier === 'low' ? 1 : 2, profile.tier);
    this.group.add(this.crabs.group);
    this.crabs.group.traverse(o => o.layers.set(LAYER_DETAIL));
    for (const c of this.crabs.crabs) {
      this.clickables.push({
        object: c.proxy, label: 'Hairy hermit crab', species: 'Pagurus hirsutiusculus, in a black turban shell',
        focus: () => c.root.position.clone().add(new THREE.Vector3(0, c.size * 0.4, 0)), frameDistance: 0.2,
        touch: () => this.crabs.touch(c),
      });
    }
    this.fish = buildFish(this.habitat, seed, profile.lifeDensity, profile.tier);
    this.group.add(this.fish.group);
    this.fish.group.traverse(o => o.layers.set(LAYER_DETAIL));
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    const shoalProxy = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), proxyMat);
    this.shoalProxy = shoalProxy;
    this.group.add(shoalProxy);
    this.proxies.push({ mesh: shoalProxy, follow: () => this.fish.shoalCenter() });
    this.clickables.push({
      object: shoalProxy, label: 'Shiner perch, juveniles', species: 'Cymatogaster aggregata',
      focus: () => this.fish.shoalCenter(), frameDistance: 0.55,
      touch: () => { const c = this.fish.shoalCenter(); this.fish.startle(c.x + 0.1, c.z, this.time); },
    });
    this.fish.sculpinFish.forEach(f => {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), proxyMat);
      this.group.add(p);
      this.proxies.push({ mesh: p, follow: () => f.pos });
      this.clickables.push({
        object: p, label: 'Tidepool sculpin', species: 'Oligocottus maculosus',
        focus: () => f.pos.clone().add(new THREE.Vector3(0, 0.01, 0)), frameDistance: 0.26,
        touch: () => this.fish.startle(f.pos.x, f.pos.z, this.time),
      });
    });
    Object.assign(this.stats, enc.stats, this.anemones.stats, this.stars.stats, urchins.stats, this.algae.stats, this.crabs.stats, this.fish.stats, { lifeBuildMs: Math.round(performance.now() - t0) });
  }

  /** Something touched the water at (x, z): fish nearby flee. */
  startle(x: number, z: number): void { this.fish.startle(x, z, this.time); }

  update(dt: number, time: number): void {
    this.time = time;
    this.anemones.update(dt, this.levelAt);
    this.crabs.update(dt, time);
    this.fish.update(dt, time, this.levelAt(0, -0.2));
    for (const p of this.proxies) p.mesh.position.copy(p.follow());
    // Pool water sloshes back and forth slowly; surges from overtopping waves push it seaward-in.
    const c = this.algae.current.value;
    const a = Math.sin(time * 0.21) * 0.9 + Math.sin(time * 0.083 + 1.0) * 0.6;
    c.set(Math.cos(a), Math.sin(a), 0.22 + 0.12 * Math.sin(time * 0.37), this.surge);
  }

  /** Finds the creature under a ray, if any. */
  pick(raycaster: THREE.Raycaster): Clickable | null {
    const hits = raycaster.intersectObjects(this.clickables.map(c => c.object), false);
    if (!hits.length) return null;
    const byObject = (o: THREE.Object3D) => this.clickables.find(c => c.object === o) ?? null;
    // A loose shoal should not swallow a tap aimed at an animal just behind it.
    const first = byObject(hits[0].object);
    if (first && first.object === this.shoalProxy) {
      const next = hits.slice(1).find(h => h.distance - hits[0].distance < 0.45 && h.object !== this.shoalProxy);
      if (next) return byObject(next.object);
    }
    return first;
  }
}
