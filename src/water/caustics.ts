import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { G } from '../core/globals.ts';
import { POOL_BOUNDS } from '../world/layout.ts';
import noiseGlsl from '../glsl/noise.glsl?raw';
import wavesGlsl from '../glsl/waves.glsl?raw';
import { seaWavesGlsl } from './waves.ts';

/**
 * Caustics over the pool, computed where the light enters the surface. Each texel refracts the sun
 * through the local surface (simulated ripples plus wind waves), follows the ray to the rock at the
 * local depth, and measures how much the landing area shrinks or grows (inverse Jacobian
 * determinant): light focused into a smaller area is brighter. Rock shaders read the result back
 * along the refracted sun direction.
 */
export class Caustics {
  readonly target: THREE.WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  readonly material: THREE.ShaderMaterial;

  constructor(size: [number, number], rippleTex: () => THREE.Texture, rippleTexel: THREE.Vector2) {
    this.target = new THREE.WebGLRenderTarget(size[0], size[1], { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.name = 'tp.caustics';
    this.target.texture.generateMipmaps = false;
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uRipple: { value: null as THREE.Texture | null },
        uRippleTexel: { value: rippleTexel },
        uPool: G.uPoolTex,
        uSunDir: G.uSunDir,
        uTime: G.uTime,
        uPoolLevel: G.uPoolLevel,
        uSeaLevel: G.uSeaLevel,
        uWind: { value: 1 },
        uOctaves: { value: 5 },
        uMin: { value: new THREE.Vector2(POOL_BOUNDS.minX, POOL_BOUNDS.minZ) },
        uSize: { value: new THREE.Vector2(POOL_BOUNDS.maxX - POOL_BOUNDS.minX, POOL_BOUNDS.maxZ - POOL_BOUNDS.minZ) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        precision highp float;
        ${seaWavesGlsl()}
        ${noiseGlsl}
        uniform sampler2D uRipple;
        uniform vec2 uRippleTexel;
        uniform sampler2D uPool;
        uniform vec3 uSunDir;
        uniform float uTime;
        uniform float uPoolLevel;
        uniform float uSeaLevel;
        uniform float uWind;
        uniform int uOctaves;
        uniform vec2 uMin;
        uniform vec2 uSize;
        varying vec2 vUv;
        ${wavesGlsl}

        vec2 slopeAt(vec2 uv) {
          vec2 p = uMin + uv * uSize;
          float hx = texture2D(uRipple, uv + vec2(uRippleTexel.x, 0.0)).x - texture2D(uRipple, uv - vec2(uRippleTexel.x, 0.0)).x;
          float hz = texture2D(uRipple, uv + vec2(0.0, uRippleTexel.y)).x - texture2D(uRipple, uv - vec2(0.0, uRippleTexel.y)).x;
          vec2 g = vec2(hx / (2.0 * uRippleTexel.x * uSize.x), hz / (2.0 * uRippleTexel.y * uSize.y));
          // Short ripples focus light most; keep octaves the texture can resolve (>= 2.5 texels).
          return g + tpWindWavesN(p, uTime, uWind * 1.6, uOctaves, 0.6).yz;
        }

        vec2 landing(vec2 uv, float depth, vec3 sun) {
          vec2 g = slopeAt(uv);
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 t = refract(-sun, n, 1.0 / 1.333);
          return uMin + uv * uSize + t.xz / max(-t.y, 0.15) * depth;
        }

        void main() {
          vec4 pool = texture2D(uPool, vUv);
          float level = mix(uSeaLevel, max(uPoolLevel, uSeaLevel), pool.y);
          float depth = level - pool.x;
          if (depth <= 0.002 || uSunDir.y < 0.02) { gl_FragColor = vec4(1.0); return; }
          vec3 sun = normalize(uSunDir);
          vec2 e = vec2(0.006) / uSize;
          vec2 lx = landing(vUv + vec2(e.x, 0.0), depth, sun) - landing(vUv - vec2(e.x, 0.0), depth, sun);
          vec2 lz = landing(vUv + vec2(0.0, e.y), depth, sun) - landing(vUv - vec2(0.0, e.y), depth, sun);
          float area = abs(lx.x * lz.y - lx.y * lz.x) / (4.0 * 0.006 * 0.006);
          float intensity = 1.0 / (area + 0.14);
          // Very shallow water barely focuses; fade in over the first centimetres.
          intensity = mix(1.0, intensity, smoothstep(0.0, 0.05, depth));
          gl_FragColor = vec4(intensity, depth, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    // Wind-wave octaves start at ~0.9 m and shrink by 2.13 each.
    const texel = (POOL_BOUNDS.maxX - POOL_BOUNDS.minX) / size[0];
    let octaves = 0, len = 1 / 1.1;
    while (octaves < 8 && len > texel * 2.5) { octaves++; len /= 2.13; }
    this.material.uniforms.uOctaves.value = octaves;
    this.quad = new FullScreenQuad(this.material);
    this.rippleTex = rippleTex;
  }

  private readonly rippleTex: () => THREE.Texture;

  render(renderer: THREE.WebGLRenderer, wind: number): void {
    this.material.uniforms.uRipple.value = this.rippleTex();
    this.material.uniforms.uWind.value = wind;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  dispose(): void { this.target.dispose(); this.material.dispose(); this.quad.dispose(); }
}
