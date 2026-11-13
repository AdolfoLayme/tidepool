import * as THREE from 'three';
import { G } from '../core/globals.ts';
import type { QualityProfile } from '../core/quality.ts';
import { rng, type Rng } from '../core/rng.ts';
import { LAYER_WORLD, type Pipeline } from '../render/pipeline.ts';
import { LAYOUT } from '../world/layout.ts';
import type { ShoreMaps } from '../world/shoreMaps.ts';
import type { RockLayout } from '../world/rocks.ts';
import { Caustics } from './caustics.ts';
import { PlanarReflection } from './reflection.ts';
import { RippleSim } from './ripples.ts';
import { surfGeometry, waterGeometry, waterMaterial, waterMesh, type WaterUniforms } from './surface.ts';
import { breakingWaveHeight, waveFactor } from './waves.ts';
import { ShoreSpray } from './spray.ts';
import { SURF_BOUNDS, SurfSim } from './surfSim.ts';
import { SurfSpray } from './surfSpray.ts';

export type WaterEvent = { kind: 'overtop' | 'tap' | 'drip'; x: number; z: number; strength: number };

/**
 * Owns the water: one surface for pool and sea, the pool ripple simulation, caustics, the planar
 * reflection, and the CPU side of the sea (overtopping waves that pour into the pool).
 */
export class WaterSystem {
  readonly mesh: THREE.Mesh;
  readonly surfMesh: THREE.Mesh | null;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: WaterUniforms;
  readonly ripples: RippleSim;
  readonly caustics: Caustics;
  readonly reflection: PlanarReflection;
  readonly spray: ShoreSpray;
  readonly surf: SurfSim | null;
  readonly surfSpray: SurfSpray | null;
  /** Recent pouring into the pool (0..~0.03), for currents; decays. */
  surge = 0;
  private inflow = 0;
  swell = 1;
  wind = 1;
  /** Things that happened this frame (for sound and animals); cleared by the owner each frame. */
  readonly events: WaterEvent[] = [];
  private readonly rand: Rng;
  private readonly maps: ShoreMaps;
  private readonly layers = new THREE.Layers();
  private lastOvertop = -10;
  private profile: QualityProfile;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, profile: QualityProfile, maps: ShoreMaps, layout: RockLayout, seed: number, surfOn = false) {
    this.maps = maps;
    this.profile = profile;
    this.rand = rng(seed, 'water:ambient');
    this.ripples = new RippleSim(renderer, profile.rippleSize, maps.pool);
    this.surf = surfOn && profile.tier !== 'low' ? new SurfSim(renderer, maps, layout, profile.tier === 'high' ? [320, 220] : [256, 176]) : null;
    const texel = new THREE.Vector2(1 / profile.rippleSize[0], 1 / profile.rippleSize[1]);
    this.caustics = new Caustics(profile.causticSize, () => this.ripples.texture, texel);
    G.uCausticTex.value = this.caustics.target.texture;
    G.uFeatures.value.y = 1;
    this.reflection = new PlanarReflection(profile.reflectionScale || 0.4);
    const { material, uniforms } = waterMaterial();
    this.material = material;
    this.uniforms = uniforms;
    uniforms.uSurfOn.value = this.surf ? 1 : 0;
    if (this.surf) {
      uniforms.uSurfRect.value.copy(this.surf.rect);
      uniforms.uSurfTexel.value.copy(this.surf.texel);
      uniforms.uSurfBed.value = this.surf.bed;
    }
    uniforms.uRippleTexel.value.copy(texel);
    const seg = profile.tier === 'high' ? 256 : profile.tier === 'medium' ? 192 : 128;
    const fine = profile.tier === 'high' ? 0.03 : profile.tier === 'medium' ? 0.045 : 0.07;
    this.mesh = waterMesh(waterGeometry(seg, fine), material);
    scene.add(this.mesh);
    if (this.surf) {
      // Same shader and uniforms; only the layer flag differs, so the two meshes split the water.
      const fine = material.clone();
      fine.uniforms = { ...material.uniforms, uSurfLayer: { value: 1 } };
      const cells: [number, number] = profile.tier === 'high' ? [640, 440] : [448, 308];
      this.surfMesh = waterMesh(surfGeometry(SURF_BOUNDS, cells[0], cells[1]), fine);
      this.surfMesh.name = 'water-shore';
      scene.add(this.surfMesh);
    } else this.surfMesh = null;
    this.spray = new ShoreSpray(scene);
    this.surfSpray = this.surf ? new SurfSpray(scene, this.surf) : null;
    this.layers.set(LAYER_WORLD);
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.reflection.scale = profile.reflectionScale || 0.4;
  }

  setSize(width: number, height: number): void {
    this.reflection.setSize(width, height);
  }

  /** A touch, drip or animal at (x, z). Strength 1 is a fingertip. */
  disturb(x: number, z: number, strength = 1, radius = 0.075, foam = 0.15): void {
    if (this.maps.poolMaskAt(x, z) < 0.3) return;
    // The grid resolves waves of ~10 cm and up; a fingertip's few-millimetre rings are carried by a
    // slightly larger, deeper dip so they read at viewing distance.
    const cell = this.ripples.cellSize;
    this.ripples.push({ x, z, radius: Math.max(radius, cell * 1.6), strength: 0.02 * strength, foam });
  }

  /** Still level of the sea or pool at a point (no waves). */
  levelAt(x: number, z: number): number {
    const m = this.maps.poolMaskAt(x, z);
    const sea = G.uSeaLevel.value;
    return sea + (Math.max(G.uPoolLevel.value, sea) - sea) * m;
  }

  /** Sea surface with swell (CPU mirror of the shader, without the small chop). */
  seaSurfaceAt(x: number, z: number, t: number): number {
    const [h, , shelter] = this.maps.shoreAt(x, z);
    const sea = G.uSeaLevel.value;
    return sea + breakingWaveHeight(x, z, t, waveFactor(sea - h, shelter) * this.swell);
  }

  update(dt: number, time: number, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, pipeline: Pipeline, env: THREE.Texture | null, skyIrr: THREE.Vector3): void {
    const u = this.uniforms;
    // Light air moving over the pool: a few faint touches per second keep the surface alive.
    const breeze = this.wind;
    let n = this.rand.next() < dt * 9 * breeze ? 1 : 0;
    while (n-- > 0) {
      const x = this.rand.range(-2.6, 2.6), z = this.rand.range(-1.9, 1.5);
      this.disturb(x, z, this.rand.range(0.02, 0.07), this.rand.range(0.05, 0.14), 0);
    }
    this.overtopping(time);
    this.spray.update(dt, time, G.uSeaLevel.value, (x, z, t) => this.seaSurfaceAt(x, z, t), (x, z) => this.maps.shoreAt(x, z)[0]);
    // Rock stays wet for a while after a breaker has drained back into the sea.
    G.uSpray.value = Math.max(0.05, Math.min(1, this.spray.count / 200), G.uSpray.value * Math.exp(-dt / 22));
    this.surge *= Math.exp(-dt / 7);

    this.ripples.update(dt);
    this.surf?.update(dt, this.swell);
    if (this.surf) this.surfSpray?.update(time, this.surf);
    this.caustics.render(renderer, this.wind);

    const targets = pipeline.sceneTargets;
    u.uSceneColor.value = targets.color;
    u.uSceneDepth.value = targets.depth;
    u.uResolution.value.copy(targets.size);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uProjScale.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    u.uRippleTex.value = this.ripples.texture;
    if (this.surf) {
      u.uSurfState.value = this.surf.stateTexture;
      u.uSurfFoam.value = this.surf.foamTexture;
    }
    u.uSkyIrr.value.copy(skyIrr);
    u.uWind.value = this.wind;
    u.uSwell.value = this.swell;
    if (env) {
      const mips = (env as THREE.Texture & { mipmaps?: unknown[] }).mipmaps;
      u.uEnvMaxLod.value = mips && mips.length > 1 ? mips.length - 1 : 8;
      u.envMap.value = env;
      u.uEnvOn.value = 1;
    }
    const reflect = this.profile.reflectionScale > 0;
    u.uReflOn.value = 0;
    if (reflect) {
      this.mesh.visible = false;
      if (this.surfMesh) this.surfMesh.visible = false;
      const ok = this.reflection.render(renderer, scene, camera, G.uPoolLevel.value, this.layers);
      this.mesh.visible = true;
      if (this.surfMesh) this.surfMesh.visible = true;
      if (ok) {
        u.uReflOn.value = 1;
        u.uReflTex.value = this.reflection.target.texture;
        u.uReflMatrix.value.copy(this.reflection.textureMatrix);
      }
    }
  }

  /**
   * When a wave runs up the gully higher than the rim, it pours into the pool: foam and a pulse of
   * ripples at the gully mouth, and a little extra water that drains away again.
   */
  /** Water that poured in since the last call (m of pool level). */
  takeInflow(): number { const v = this.inflow; this.inflow = 0; return v; }

  private overtopping(time: number): void {
    const s = LAYOUT.spill;
    const sea = G.uSeaLevel.value;
    const spill = G.uPoolSpill.value;
    if (sea > G.uPoolLevel.value + 0.01) return; // the sea has already joined the pool
    const len = Math.hypot(s.dirX, s.dirZ);
    const ex = s.x + (s.dirX / len) * s.length, ez = s.z + (s.dirZ / len) * s.length;
    const crest = this.seaSurfaceAt(ex, ez, time);
    // Run-up along the gully adds roughly the local wave amplitude.
    const runup = crest + Math.max(0, crest - sea) * 0.9;
    if (runup > spill + 0.01 && time - this.lastOvertop > 2.5) {
      this.lastOvertop = time;
      const strength = Math.min(1.5, (runup - spill) * 8);
      this.surge = Math.min(0.03, this.surge + 0.004 * strength);
      this.inflow += 0.012 * strength;
      for (let i = 0; i < 6; i++) {
        const a = this.rand.range(-0.25, 0.25);
        this.ripples.push({ x: s.x - (s.dirX / len) * (0.15 + i * 0.1) + a, z: s.z - (s.dirZ / len) * (0.15 + i * 0.1), radius: 0.18, strength: 0.004 * strength, foam: 0.6 * strength });
      }
      this.events.push({ kind: 'overtop', x: s.x, z: s.z, strength });
    }
  }

  dispose(): void {
    this.surfSpray?.dispose();
    this.surf?.dispose();
    this.spray.dispose();
    this.ripples.dispose();
    this.caustics.dispose();
    this.reflection.dispose();
    this.mesh.geometry.dispose();
    this.surfMesh?.geometry.dispose();
    this.material.dispose();
  }
}
