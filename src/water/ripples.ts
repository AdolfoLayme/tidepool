import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/addons/misc/GPUComputationRenderer.js';
import { POOL_BOUNDS } from '../world/layout.ts';

export const MAX_IMPULSES = 16;

export type Impulse = { x: number; z: number; radius: number; strength: number; foam: number };

/**
 * Pool surface simulation, after the official three.js GPGPU water example: a damped wave
 * equation on a height field, extended with rock walls (the pool mask), many impulses per step and
 * a foam channel that is injected, spreads and decays.
 *
 * Channels: R height now, G height one step ago, B foam, A unused.
 */
export class RippleSim {
  readonly gpu: GPUComputationRenderer;
  readonly variable: Variable;
  readonly size: [number, number];
  /** Simulation steps per second, chosen so ripples travel at about 1 m/s whatever the grid. */
  readonly stepRate: number;
  /** Metres per simulation texel. */
  readonly cellSize: number;
  private accumulator = 0;
  private readonly impulses: Impulse[] = [];
  private readonly impulseUniform: THREE.Vector4[];
  private readonly foamUniform: Float32Array;

  constructor(renderer: THREE.WebGLRenderer, size: [number, number], poolTex: THREE.Texture) {
    this.size = size;
    const [w, h] = size;
    const cell = (POOL_BOUNDS.maxX - POOL_BOUNDS.minX) / w;
    this.cellSize = cell;
    this.stepRate = Math.min(120, Math.max(24, 1.0 / (cell * 0.7071)));
    this.gpu = new GPUComputationRenderer(w, h, renderer);
    this.gpu.setDataType(THREE.HalfFloatType);
    const init = this.gpu.createTexture();
    this.impulseUniform = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4(0, 0, 1, 0));
    this.foamUniform = new Float32Array(MAX_IMPULSES);
    this.variable = this.gpu.addVariable('heightmap', /* glsl */`
      uniform sampler2D uPool;
      uniform vec4 uImpulse[${MAX_IMPULSES}];
      uniform float uImpulseFoam[${MAX_IMPULSES}];
      uniform int uImpulseCount;
      uniform vec2 uWorldMin;
      uniform vec2 uWorldSize;
      uniform float uDamping;
      uniform float uFoamDecay;
      void main() {
        vec2 cellSize = 1.0 / resolution.xy;
        vec2 uv = gl_FragCoord.xy * cellSize;
        vec4 c = texture2D(heightmap, uv);
        vec4 n = texture2D(heightmap, uv + vec2(0.0, cellSize.y));
        vec4 s = texture2D(heightmap, uv - vec2(0.0, cellSize.y));
        vec4 e = texture2D(heightmap, uv + vec2(cellSize.x, 0.0));
        vec4 w = texture2D(heightmap, uv - vec2(cellSize.x, 0.0));
        float wall = 1.0 - smoothstep(0.35, 0.7, texture2D(uPool, uv).y);
        float next = ((n.x + s.x + e.x + w.x) * 0.5 - c.y) * uDamping;
        // Foam spreads a little and is stirred where the surface moves fast.
        float foam = (c.z * 4.0 + n.z + s.z + e.z + w.z) / 8.0;
        foam += abs(c.x - c.y) * 6.0;
        vec2 p = uWorldMin + uv * uWorldSize;
        // Impulses displace the surface without giving it velocity (both time levels move), with a
        // zero-volume Ricker profile: a crater ringed by a rim, as a drop or fingertip makes.
        float imp = 0.0;
        for (int i = 0; i < ${MAX_IMPULSES}; i++) {
          if (i >= uImpulseCount) break;
          vec4 im = uImpulse[i];
          float d2 = dot(p - im.xy, p - im.xy) / (im.z * im.z);
          if (d2 < 4.0) {
            float prof = (1.0 - 2.0 * d2) * exp(-2.0 * d2);
            imp += prof * im.w;
            foam += max(prof, 0.0) * uImpulseFoam[i];
          }
        }
        foam = clamp(foam * uFoamDecay, 0.0, 1.5);
        float keep = 1.0 - wall;
        gl_FragColor = vec4((next - imp) * keep, (c.x - imp) * keep, foam * (1.0 - wall * 0.7), 1.0);
      }`, init);
    this.gpu.setVariableDependencies(this.variable, [this.variable]);
    const u = this.variable.material.uniforms;
    u.uPool = { value: poolTex };
    u.uImpulse = { value: this.impulseUniform };
    u.uImpulseFoam = { value: this.foamUniform };
    u.uImpulseCount = { value: 0 };
    u.uWorldMin = { value: new THREE.Vector2(POOL_BOUNDS.minX, POOL_BOUNDS.minZ) };
    u.uWorldSize = { value: new THREE.Vector2(POOL_BOUNDS.maxX - POOL_BOUNDS.minX, POOL_BOUNDS.maxZ - POOL_BOUNDS.minZ) };
    u.uDamping = { value: 0.992 };
    u.uFoamDecay = { value: 0.994 };
    this.variable.wrapS = THREE.ClampToEdgeWrapping;
    this.variable.wrapT = THREE.ClampToEdgeWrapping;
    // The update samples texel centres, so linear filtering costs nothing there and keeps the
    // surface smooth where the water shader reads between texels.
    this.variable.minFilter = THREE.LinearFilter;
    this.variable.magFilter = THREE.LinearFilter;
    const error = this.gpu.init();
    if (error) throw new Error(`Ripple simulation unavailable: ${error}`);
  }

  get texture(): THREE.Texture {
    return this.gpu.getCurrentRenderTarget(this.variable).texture;
  }

  /** Queue a disturbance: depth of the initial dip (m) and radius (m). */
  push(imp: Impulse): void {
    if (this.impulses.length < MAX_IMPULSES * 4) this.impulses.push(imp);
  }

  update(dt: number): void {
    this.accumulator = Math.min(this.accumulator + dt * this.stepRate, 4);
    const u = this.variable.material.uniforms;
    while (this.accumulator >= 1) {
      this.accumulator -= 1;
      const batch = this.impulses.splice(0, MAX_IMPULSES);
      batch.forEach((im, i) => {
        // Spread the dip over the steps of a frame so fast frames and slow frames feel the same.
        this.impulseUniform[i].set(im.x, im.z, im.radius, im.strength);
        this.foamUniform[i] = im.foam;
      });
      u.uImpulseCount.value = batch.length;
      this.gpu.compute();
    }
    u.uImpulseCount.value = 0;
  }

  dispose(): void { this.gpu.dispose(); }
}
