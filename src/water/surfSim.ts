import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/addons/misc/GPUComputationRenderer.js';
import { G } from '../core/globals.ts';
import { type Bounds2 } from '../world/layout.ts';
import type { RockLayout } from '../world/rocks.ts';
import type { ShoreMaps } from '../world/shoreMaps.ts';
import { buildSurfBed } from './surfBed.ts';
import { seaWavesGlsl } from './waves.ts';

/** Near-shore domain. The outer metre blends back to analytic Gerstner water. */
export const SURF_BOUNDS: Bounds2 = { minX: -16, maxX: 16, minZ: -14, maxZ: 8 };

/**
 * Stateful four-face flow, following the virtual-pipe flux limiter of Mei, Decaudin and Hu (2007).
 * Every pass reads only the previous step, so the new flux reaches the height pass one step later.
 * Foam uses semi-Lagrangian backtracing and a separate wetness memory.
 */
export class SurfSim {
  readonly gpu: GPUComputationRenderer;
  readonly flux: Variable;
  readonly state: Variable;
  readonly foam: Variable;
  readonly bed: THREE.DataTexture;
  readonly rect = new THREE.Vector4(SURF_BOUNDS.minX, SURF_BOUNDS.minZ, 1 / 32, 1 / 22);
  readonly texel: THREE.Vector2;
  readonly size: [number, number];
  private accumulator = 0;

  constructor(renderer: THREE.WebGLRenderer, maps: ShoreMaps, layout: RockLayout, size: [number, number]) {
    this.size = size;
    const [w, h] = size;
    this.texel = new THREE.Vector2(1 / w, 1 / h);
    const bed = buildSurfBed(SURF_BOUNDS, size, (x, z) => maps.shoreAt(x, z)[0], layout.boulders);
    const bedPixels = new Uint16Array(w * h * 4);
    const statePixels = new Float32Array(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const x = SURF_BOUNDS.minX + (i + 0.5) * 32 / w;
      const z = SURF_BOUNDS.minZ + (j + 0.5) * 22 / h;
      const mask = maps.poolMaskAt(x, z);
      bedPixels[k * 4] = THREE.DataUtils.toHalfFloat(bed[k]);
      bedPixels[k * 4 + 1] = THREE.DataUtils.toHalfFloat(mask);
      bedPixels[k * 4 + 2] = 0;
      bedPixels[k * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
      statePixels[k * 4] = mask > 0.4 ? 0 : Math.max(0, G.uSeaLevel.value - bed[k]);
    }
    this.bed = new THREE.DataTexture(bedPixels, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    this.bed.minFilter = this.bed.magFilter = THREE.NearestFilter;
    this.bed.wrapS = this.bed.wrapT = THREE.ClampToEdgeWrapping;
    this.bed.needsUpdate = true;
    this.gpu = new GPUComputationRenderer(w, h, renderer);
    this.gpu.setDataType(THREE.HalfFloatType);
    const fluxInit = this.gpu.createTexture();
    const stateInit = this.gpu.createTexture();
    (stateInit.image.data as Float32Array).set(statePixels);
    const foamInit = this.gpu.createTexture();
    const shared = /* glsl */`
      uniform sampler2D uBed;
      uniform vec2 uTexel;
      uniform vec2 uCell;
      uniform float uStep;
      uniform float uSeaLevel;
      uniform float uPoolLevel;
      uniform float uTime;
      uniform float uSwell;
      float bedAt(vec2 uv) { return texture2D(uBed, uv).r; }
      // The pool is a wall only while the rim holds; once the sea covers it they are one body of water.
      float joined() { return step(0.5, smoothstep(uPoolLevel - 0.02, uPoolLevel + 0.08, uSeaLevel)); }
      float blocked(vec2 uv) { return step(0.45, texture2D(uBed, uv).g) * (1.0 - joined()); }
    `;
    const flowRules = /* glsl */`
      float flow(vec2 uv, vec2 offset, float old, float cell, float depth, float surface) {
        vec2 nUV = uv + offset;
        vec4 n = texture2D(surfState, nUV);
        float nBed = bedAt(nUV);
        float head = surface - (nBed + n.r);
        // Capping the depth that drives the flow caps wave speed, which keeps the deep seaward edge stable.
        float wet = min(min(depth, max(surface - nBed, 0.0)), 1.0);
        return max(0.0, old * 0.98 + 9.81 * uStep * head * wet / cell) * (1.0 - blocked(nUV));
      }
      vec4 proposedFlux(vec2 uv) {
        vec4 c = texture2D(surfState, uv);
        vec4 old = texture2D(surfFlux, uv);
        float surface = bedAt(uv) + c.r;
        vec4 q = vec4(0.0);
        if (c.r > 0.0001 && blocked(uv) < 0.5) {
          if (uv.x < 1.0 - uTexel.x) q.r = flow(uv, vec2(uTexel.x, 0.0), old.r, uCell.x, c.r, surface);
          if (uv.x > uTexel.x) q.g = flow(uv, vec2(-uTexel.x, 0.0), old.g, uCell.x, c.r, surface);
          if (uv.y < 1.0 - uTexel.y) q.b = flow(uv, vec2(0.0, uTexel.y), old.b, uCell.y, c.r, surface);
          if (uv.y > uTexel.y) q.a = flow(uv, vec2(0.0, -uTexel.y), old.a, uCell.y, c.r, surface);
          float outDepth = uStep * ((q.r + q.g) / uCell.x + (q.b + q.a) / uCell.y);
          q *= min(1.0, c.r / max(outDepth, 0.000001));
        }
        return q;
      }
    `;
    this.flux = this.gpu.addVariable('surfFlux', /* glsl */`
      ${shared}
      ${flowRules}
      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        gl_FragColor = proposedFlux(uv);
      }`, fluxInit);
    this.state = this.gpu.addVariable('surfState', /* glsl */`
      ${shared}
      ${flowRules}
      ${seaWavesGlsl()}
      float boundaryWave(vec2 p) {
        float h = 0.0;
        for (int i = 0; i < TP_SEA_WAVES; i++) {
          vec4 a = tpWaveA[i], b = tpWaveB[i];
          h += b.x * sin(a.z * dot(a.xy, p) - a.w * uTime + b.z);
        }
        // Sets of steep bores: long swell alone is too gentle to break on a shelf this short.
        float group = 0.55 + 0.45 * sin(uTime * 0.11) * sin(uTime * 0.07 + 1.0);
        float bore = pow(0.5 + 0.5 * sin(uTime * 0.72 - p.x * 0.035), 6.0);
        return (h + 1.15 * group * bore) * uSwell;
      }
      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 c = texture2D(surfState, uv);
        vec4 q = proposedFlux(uv);
        vec4 west = proposedFlux(uv - vec2(uTexel.x, 0.0));
        vec4 east = proposedFlux(uv + vec2(uTexel.x, 0.0));
        vec4 south = proposedFlux(uv - vec2(0.0, uTexel.y));
        vec4 north = proposedFlux(uv + vec2(0.0, uTexel.y));
        float inX = west.r * step(uTexel.x, uv.x) + east.g * step(uv.x, 1.0 - uTexel.x);
        float inZ = south.b * step(uTexel.y, uv.y) + north.a * step(uv.y, 1.0 - uTexel.y);
        float d = max(0.0, c.r + uStep * ((inX - q.r - q.g) / uCell.x + (inZ - q.b - q.a) / uCell.y));
        float bed = bedAt(uv);
        if (uv.y < 2.5 * uTexel.y) {
          vec2 p = vec2(-16.0, -14.0) + uv * vec2(32.0, 22.0);
          d = max(0.0, uSeaLevel + boundaryWave(p) - bed);
        }
        // A held pool keeps its water, so the sea meets a full basin when the rim goes under.
        if (blocked(uv) > 0.5) d = max(0.0, uPoolLevel - bed);
        vec2 vel = clamp(vec2(q.r - q.g, q.b - q.a) / max(d, 0.06), vec2(-3.0), vec2(3.0));
        float surface = bed + d;
        float hit = 0.0;
        hit += max(0.0, inX + inZ - q.r - q.g - q.b - q.a) * 0.08;
        // Water driven up a rising face: the slope of the bed against the flow is the impact.
        vec2 rise = vec2(bedAt(uv + vec2(uTexel.x, 0.0)) - bedAt(uv - vec2(uTexel.x, 0.0)),
                         bedAt(uv + vec2(0.0, uTexel.y)) - bedAt(uv - vec2(0.0, uTexel.y))) / (2.0 * uCell);
        hit += max(0.0, dot(vel, rise)) * 0.55 * smoothstep(0.01, 0.08, d) * (1.0 - smoothstep(0.35, 0.9, d));
        gl_FragColor = vec4(d, vel, clamp(hit * 3.0, 0.0, 1.0));
      }`, stateInit);
    this.foam = this.gpu.addVariable('surfFoam', /* glsl */`
      ${shared}
      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 s = texture2D(surfState, uv);
        vec2 from = clamp(uv - s.gb * uStep / vec2(32.0, 22.0), uTexel * 0.5, vec2(1.0) - uTexel * 0.5);
        vec4 prior = texture2D(surfFoam, from);
        vec2 dx = vec2(uTexel.x, 0.0), dz = vec2(0.0, uTexel.y);
        float convergence = max(0.0,
          texture2D(surfState, uv - dx).g - texture2D(surfState, uv + dx).g
          + texture2D(surfState, uv - dz).b - texture2D(surfState, uv + dz).b);
        float churn = smoothstep(0.7, 2.2, length(s.gb)) * smoothstep(0.015, 0.08, s.r) * (1.0 - smoothstep(0.22, 0.7, s.r));
        float strike = (s.a + texture2D(surfState, uv + dx).a + texture2D(surfState, uv - dx).a
                     + texture2D(surfState, uv + dz).a + texture2D(surfState, uv - dz).a) * 0.2;
        float source = strike * 6.0 + convergence * 0.22 * smoothstep(0.02, 0.2, s.r) * (1.0 - smoothstep(0.3, 0.8, s.r)) + churn * 0.9;
        float foam = clamp(prior.r * exp(-uStep / mix(2.6, 1.5, smoothstep(0.02, 0.2, s.r))) + source * uStep, 0.0, 1.0);
        float wet = max(max(prior.g * exp(-uStep / 8.0), smoothstep(0.004, 0.04, s.r)), s.a * 0.7);
        // Recent impact stays in place for the spray to read; it does not ride the current.
        float last = texture2D(surfFoam, uv).b;
        float burst = max(last * exp(-uStep / 0.8), mix(last, strike, 0.08));
        gl_FragColor = vec4(foam, wet, burst, 1.0);
      }`, foamInit);
    this.gpu.setVariableDependencies(this.flux, [this.flux, this.state]);
    this.gpu.setVariableDependencies(this.state, [this.state, this.flux]);
    this.gpu.setVariableDependencies(this.foam, [this.foam, this.state]);
    for (const v of [this.flux, this.state, this.foam]) {
      v.wrapS = v.wrapT = THREE.ClampToEdgeWrapping;
      v.minFilter = v.magFilter = v === this.flux ? THREE.NearestFilter : THREE.LinearFilter;
      const u = v.material.uniforms;
      u.uBed = { value: this.bed };
      u.uTexel = { value: this.texel };
      u.uCell = { value: new THREE.Vector2(32 / w, 22 / h) };
      u.uStep = { value: 1 / 60 };
      u.uSeaLevel = G.uSeaLevel;
      u.uPoolLevel = G.uPoolLevel;
      u.uTime = G.uTime;
      u.uSwell = { value: 1 };
    }
    const error = this.gpu.init();
    if (error) throw new Error(`Surf simulation unavailable: ${error}`);
  }

  get stateTexture(): THREE.Texture { return this.gpu.getCurrentRenderTarget(this.state).texture; }
  get foamTexture(): THREE.Texture { return this.gpu.getCurrentRenderTarget(this.foam).texture; }

  update(dt: number, swell: number): void {
    this.accumulator = Math.min(this.accumulator + dt * 60, 3);
    for (const v of [this.flux, this.state, this.foam]) v.material.uniforms.uSwell.value = swell;
    while (this.accumulator >= 1) { this.gpu.compute(); this.accumulator--; }
  }

  diagnostics(renderer: THREE.WebGLRenderer): Record<string, number | number[]> {
    const [w, h] = this.size;
    const pixels = new Uint16Array(w * h * 4);
    const foamPixels = new Uint16Array(w * h * 4);
    renderer.readRenderTargetPixels(this.gpu.getCurrentRenderTarget(this.state), 0, 0, w, h, pixels);
    renderer.readRenderTargetPixels(this.gpu.getCurrentRenderTarget(this.foam), 0, 0, w, h, foamPixels);
    let maxDepth = 0, maxCell = 0, maxImpact = 0, maxFoam = 0, foamCells = 0, wetCells = 0, impactCells = 0, badCells = 0;
    for (let k = 0; k < w * h; k++) {
      const d = THREE.DataUtils.fromHalfFloat(pixels[k * 4]);
      const impact = THREE.DataUtils.fromHalfFloat(pixels[k * 4 + 3]);
      const foam = THREE.DataUtils.fromHalfFloat(foamPixels[k * 4]);
      if (!Number.isFinite(d) || !Number.isFinite(impact)) badCells++;
      if (d > maxDepth) { maxDepth = d; maxCell = k; }
      if (d > 0.02) wetCells++;
      if (impact > 0.05) impactCells++;
      maxImpact = Math.max(maxImpact, impact);
      maxFoam = Math.max(maxFoam, foam);
      if (foam > 0.15) foamCells++;
    }
    const maxX = maxCell % w;
    const transect = Array.from({ length: 12 }, (_, j) => +THREE.DataUtils.fromHalfFloat(pixels[(j * w + maxX) * 4]).toFixed(2));
    const maxBed = THREE.DataUtils.fromHalfFloat((this.bed.image.data as Uint16Array)[maxCell * 4]);
    return { maxDepth: +maxDepth.toFixed(2), maxBed: +maxBed.toFixed(2), maxX: +(SURF_BOUNDS.minX + (maxX + 0.5) * 32 / w).toFixed(1), maxZ: +(SURF_BOUNDS.minZ + (Math.floor(maxCell / w) + 0.5) * 22 / h).toFixed(1), transect, maxImpact: +maxImpact.toFixed(3), maxFoam: +maxFoam.toFixed(4), foamCells, wetCells, impactCells, badCells };
  }

  dispose(): void { this.gpu.dispose(); this.bed.dispose(); }
}
