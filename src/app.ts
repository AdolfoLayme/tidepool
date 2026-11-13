import * as THREE from 'three';
import { G } from './core/globals.ts';
import { PROFILES, detectTier, Governor, stepTier, type QualityProfile, type Tier } from './core/quality.ts';
import { seaLevelFor, PoolLevel, WetLine } from './core/tide.ts';
import { LAYOUT } from './world/layout.ts';
import { SkySystem } from './env/sky.ts';
import { Pipeline, EXPOSURE } from './render/pipeline.ts';
import { CameraRig, HOME_POSE, clonePose, type CameraPose } from './ui/cameraRig.ts';
import { buildWorld, countTriangles, type World } from './world/world.ts';
import { WaterSystem } from './water/water.ts';
import { Life } from './life/life.ts';

export type AppParams = {
  seed: number;
  tier: Tier | null;
  hour: number;
  tide: number;
  /** Advance time only when asked (deterministic captures). */
  manual: boolean;
  debug: Set<string>;
  surf: boolean;
};

export function readParams(search: string): AppParams {
  const p = new URLSearchParams(search);
  const num = (k: string, d: number) => { const v = Number(p.get(k)); return p.has(k) && Number.isFinite(v) ? v : d; };
  const q = p.get('q');
  return {
    seed: Math.floor(num('seed', 7)),
    tier: q === 'low' || q === 'medium' || q === 'high' ? q : null,
    hour: num('hour', 10.2),
    tide: num('tide', 0.42),
    manual: p.has('manual'),
    debug: new Set((p.get('debug') ?? '').split(',').filter(Boolean)),
    surf: p.get('surf') === '1',
  };
}

export const CAMERA_PRESETS: Record<string, CameraPose> = {
  home: HOME_POSE,
  low: { target: new THREE.Vector3(0.2, -0.05, -0.6), azimuth: 0.35, elevation: 0.3, distance: 3.6, fov: 42 },
  top: { target: new THREE.Vector3(0, -0.2, -0.3), azimuth: 0.0, elevation: 1.3, distance: 6.5, fov: 40 },
  wide: { target: new THREE.Vector3(0, 0, -2.5), azimuth: -0.25, elevation: 0.42, distance: 9.5, fov: 45 },
  macro: { target: new THREE.Vector3(-1.2, -0.25, -0.5), azimuth: 0.6, elevation: 0.75, distance: 1.1, fov: 34 },
};

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 4000);
  readonly params: AppParams;
  profile: QualityProfile;
  tierReason: string;
  sky!: SkySystem;
  pipeline!: Pipeline;
  rig!: CameraRig;
  world!: World;
  ready = false;
  time = 0;
  hour: number;
  tide: number;
  readonly wet: WetLine;
  pool!: PoolLevel;
  readonly governor = new Governor();
  private resolutionScale = 1;
  private lastFrame = performance.now();
  private frameTimes: number[] = [];
  water!: WaterSystem;
  life!: Life;
  dragging = false;
  private shadowFrame = 0;
  private readonly lastShadowDir = new THREE.Vector3();
  onFrame: ((dt: number) => void)[] = [];

  private readonly host: HTMLElement;

  constructor(host: HTMLElement, params: AppParams) {
    this.host = host;
    this.params = params;
    this.hour = params.hour;
    this.tide = params.tide;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const tm = new URLSearchParams(location.search).get('tm');
    this.renderer.toneMapping = tm === 'aces' ? THREE.ACESFilmicToneMapping : tm === 'neutral' ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The rock never moves; the shadow map is redrawn when the light moves and every few frames
    // for the animals.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    host.appendChild(this.renderer.domElement);
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const nav = navigator as Navigator & { deviceMemory?: number };
    const detected = detectTier({
      renderer: gpu, userAgent: navigator.userAgent,
      screenPixels: Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1),
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      deviceMemory: nav.deviceMemory, hardwareConcurrency: navigator.hardwareConcurrency,
    });
    this.profile = PROFILES[params.tier ?? detected.tier];
    this.tierReason = params.tier ? 'requested' : detected.reason;
    this.gpu = gpu;
    this.wet = new WetLine(0.15);
  }

  readonly gpu: string;

  async init(): Promise<void> {
    const q = this.profile;
    this.sky = new SkySystem(this.renderer, this.scene, q.shadowMapSize);
    this.world = await buildWorld(this.params.seed, q, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.world.group);
    if (this.params.debug.has('norocks')) this.world.group.children.forEach(c => { if (c.name !== 'shelf') c.visible = false; });

    this.water = new WaterSystem(this.renderer, this.scene, q, this.world.maps, this.world.layout, this.params.seed, this.params.surf);
    if (this.params.debug.has('nowater')) this.water.mesh.visible = false;
    if (this.params.debug.has('caustics')) G.uFeatures.value.w = 1;
    if (this.params.debug.has('zones')) G.uFeatures.value.w = 2;
    this.life = new Life(this.world, q, this.params.seed);
    this.life.levelAt = (x, z) => this.water.levelAt(x, z);
    if (!this.params.debug.has('nolife')) this.scene.add(this.life.group);

    this.pipeline = new Pipeline(this.renderer, this.scene, this.camera, { msaa: q.msaa, bloom: q.bloom && !this.params.debug.has('nobloom'), dof: q.dof });
    this.rig = new CameraRig(this.camera, HOME_POSE);
    this.rig.groundAt = (x, z) => Math.max(this.world.terrain.heightAt(x, z) + 0.08, this.water.levelAt(x, z) + 0.12);
    const preset = new URLSearchParams(location.search).get('cam');
    if (preset && CAMERA_PRESETS[preset]) this.rig.snapTo(clonePose(CAMERA_PRESETS[preset]));

    this.resize();
    addEventListener('resize', () => this.resize());
    await this.world.ready;
    this.updateEnvironment(0, true);
    this.renderer.compile(this.scene, this.camera);
    this.ready = true;
    if (!this.params.manual) this.renderer.setAnimationLoop(() => this.tick());
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    // Portrait screens see less across: step back so the whole pool stays in frame.
    if (this.rig && this.camera.aspect !== w / h && !this.params.manual) this.rig.setAspect(w / h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio || 1, this.profile.maxPixelRatio) * this.resolutionScale;
    this.pipeline.setSize(w, h, pr);
    this.water?.setSize(w * pr, h * pr);
  }

  setTier(tier: Tier): void {
    if (tier === this.profile.tier) return;
    this.profile = PROFILES[tier];
    const q = this.profile;
    this.sky.setShadowSize(q.shadowMapSize);
    this.pipeline.setSamples(q.msaa);
    this.pipeline.setBloom(q.bloom);
    this.pipeline.setDofAvailable(q.dof);
    this.water.setProfile(q);
    this.resize();
  }

  private updateEnvironment(dt: number, force = false): void {
    const sea = seaLevelFor(this.tide);
    G.uSeaLevel.value = sea;
    if (!this.pool) {
      this.pool = new PoolLevel(this.world.maps.spillLevel);
      // Start where a pool at this point of the tide would sit.
      for (let i = 0; i < 400; i++) this.pool.update(1, sea, 0, LAYOUT.tide.low);
    }
    const inflow = this.water ? this.water.takeInflow() : 0;
    const pool = this.pool.update(dt, sea, inflow, LAYOUT.tide.low);
    G.uPoolLevel.value = pool;
    G.uPoolSpill.value = this.world.maps.spillLevel;
    G.uWetLevel.value = force ? Math.max(sea, 0.12) : this.wet.update(dt, Math.max(sea, -0.2), 0.12);
    if (force) this.wet.level = G.uWetLevel.value;
    this.sky.update(this.hour, this.time, force);
    EXPOSURE.value = this.sky.exposure;
    this.renderer.toneMappingExposure = 1;
  }

  /** One frame. In manual mode the caller supplies dt. */
  tick(fixedDt?: number): void {
    const now = performance.now();
    const realDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = fixedDt ?? Math.min(realDt, 0.05);
    this.time += dt;
    G.uTime.value = this.time;
    this.updateEnvironment(dt);
    this.rig.update(dt, this.dragging);
    this.renderer.info.reset();
    this.shadowFrame++;
    const sd = G.uSunDir.value;
    const moved = sd.distanceToSquared(this.lastShadowDir) > 1e-6;
    if (moved || this.shadowFrame % this.profile.shadowEvery === 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this.lastShadowDir.copy(sd);
    }
    this.water.events.length = 0;
    for (const f of this.onFrame) f(dt);
    this.life.surge = Math.min(1, (this.water?.surge ?? 0) * 60);
    this.life.update(dt, this.time);
    this.camera.updateMatrixWorld();
    this.water.update(dt, this.time, this.renderer, this.scene, this.camera, this.pipeline, this.sky.environment, this.sky.skyIrr);
    this.pipeline.render(this.time, dt);
    if (fixedDt === undefined) this.govern(realDt * 1000);
  }

  private govern(ms: number): void {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    if (this.params.tier || this.time < 3) return;
    const decision = this.governor.push(ms, this.profile.tier, !matchMedia('(pointer: coarse)').matches);
    if (this.governor.resolutionScale !== this.resolutionScale) { this.resolutionScale = this.governor.resolutionScale; this.resize(); }
    if (decision === 'down') this.setTier(stepTier(this.profile.tier, -1));
    else if (decision === 'up') this.setTier(stepTier(this.profile.tier, 1));
  }

  fps(): number {
    if (!this.frameTimes.length) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return 1000 / sorted[Math.floor(sorted.length / 2)];
  }

  /** Triangles by subsystem, against the tier's budget. */
  budgets(): Record<string, { triangles: number; budget: number }> {
    const shelf = this.world.group.children.find(c => c.name === 'shelf')!;
    const rocks = this.world.group.children.filter(c => c.name.startsWith('boulder') || c.name.startsWith('stack'));
    const cobbles = this.world.group.children.filter(c => c.name.startsWith('cobble'));
    const sum = (list: THREE.Object3D[]) => list.reduce((a, o) => a + countTriangles(o), 0);
    const b = this.profile.budgets;
    return {
      terrain: { triangles: countTriangles(shelf), budget: b.terrain },
      boulders: { triangles: sum(rocks), budget: b.boulders },
      gravel: { triangles: sum(cobbles), budget: b.gravel },
      life: { triangles: countTriangles(this.life.group), budget: b.life },
      water: { triangles: countTriangles(this.water.mesh), budget: b.water },
    };
  }

  stats(): Record<string, unknown> {
    const info = this.renderer.info;
    return {
      tier: this.profile.tier, reason: this.tierReason, gpu: this.gpu, fps: Math.round(this.fps()),
      callsPerFrame: info.render.calls, trianglesPerFrame: info.render.triangles, sceneTriangles: countTriangles(this.scene),
      budgets: this.budgets(),
      ...this.world.stats,
      ...this.life.stats,
      sprayDrops: this.water.spray.count,
      surf: this.water.surf ? this.water.surf.diagnostics(this.renderer) : null,
      sprayWetness: +G.uSpray.value.toFixed(3),
      exposure: +EXPOSURE.value.toFixed(3), sunI: +this.sky.sun.intensity.toFixed(3),
      sunDir: G.uSunDir.value.toArray().map(v => +v.toFixed(2)), fog: G.uFogColor.value.toArray().map(v => +v.toFixed(4)),
    };
  }
}
