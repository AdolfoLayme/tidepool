import * as THREE from 'three';
import { G } from '../core/globals.ts';
import { EXPOSURE, LAYER_WATER } from '../render/pipeline.ts';
import { LAYOUT } from '../world/layout.ts';
import noiseGlsl from '../glsl/noise.glsl?raw';
import commonGlsl from '../glsl/common.glsl?raw';
import wavesGlsl from '../glsl/waves.glsl?raw';
import waterGlsl from '../glsl/water.glsl?raw';
import { seaWavesGlsl } from './waves.ts';

/**
 * Polar grid centred on the pool: square-ish cells everywhere, centimetres in the pool and tens of
 * metres at the horizon, so one mesh carries ripples, run-up on the rock and the open sea.
 */
/** Fine regular grid over the near-shore domain, so the simulated water has no visible facets. */
export function surfGeometry(rect: { minX: number; maxX: number; minZ: number; maxZ: number }, nx: number, nz: number): THREE.BufferGeometry {
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const k = (j * (nx + 1) + i) * 3;
    pos[k] = rect.minX + (rect.maxX - rect.minX) * i / nx;
    pos[k + 2] = rect.minZ + (rect.maxZ - rect.minZ) * j / nz;
  }
  const idx = new Uint32Array(nx * nz * 6);
  let n = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function waterGeometry(segments: number, fine: number, radius = 3200): THREE.BufferGeometry {
  const rings: number[] = [0];
  let r = 0;
  const growth = (2 * Math.PI) / segments;
  while (r < radius) {
    r += Math.max(fine, r * growth);
    rings.push(Math.min(r, radius));
  }
  const cx = LAYOUT.pool.cx, cz = LAYOUT.pool.cz;
  const verts = 1 + (rings.length - 1) * segments;
  const pos = new Float32Array(verts * 3);
  pos[0] = cx; pos[2] = cz;
  let v = 1;
  for (let i = 1; i < rings.length; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos[v * 3] = cx + Math.cos(a) * rings[i];
      pos[v * 3 + 2] = cz + Math.sin(a) * rings[i];
      v++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 1; i < rings.length - 1; i++) {
    const a0 = 1 + (i - 1) * segments, b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export type WaterUniforms = {
  uSceneColor: THREE.IUniform<THREE.Texture | null>;
  uSceneDepth: THREE.IUniform<THREE.Texture | null>;
  uRippleTex: THREE.IUniform<THREE.Texture | null>;
  uRippleTexel: THREE.IUniform<THREE.Vector2>;
  uSurfState: THREE.IUniform<THREE.Texture | null>;
  uSurfFoam: THREE.IUniform<THREE.Texture | null>;
  uSurfBed: THREE.IUniform<THREE.Texture | null>;
  uSurfRect: THREE.IUniform<THREE.Vector4>;
  uSurfTexel: THREE.IUniform<THREE.Vector2>;
  uSurfOn: THREE.IUniform<number>;
  uSurfLayer: THREE.IUniform<number>;
  uReflTex: THREE.IUniform<THREE.Texture | null>;
  uReflMatrix: THREE.IUniform<THREE.Matrix4>;
  uReflOn: THREE.IUniform<number>;
  uResolution: THREE.IUniform<THREE.Vector2>;
  uProjScale: THREE.IUniform<THREE.Vector2>;
  uNear: THREE.IUniform<number>;
  uFar: THREE.IUniform<number>;
  uSkyIrr: THREE.IUniform<THREE.Vector3>;
  uWind: THREE.IUniform<number>;
  uSwell: THREE.IUniform<number>;
  envMap: THREE.IUniform<THREE.Texture | null>;
  uEnvOn: THREE.IUniform<number>;
  uEnvMaxLod: THREE.IUniform<number>;
};

export function waterMaterial(): { material: THREE.ShaderMaterial; uniforms: WaterUniforms } {
  const uniforms: WaterUniforms = {
    uSceneColor: { value: null },
    uSceneDepth: { value: null },
    uRippleTex: { value: null },
    uRippleTexel: { value: new THREE.Vector2(1 / 256, 1 / 181) },
    uSurfState: { value: null },
    uSurfFoam: { value: null },
    uSurfBed: { value: null },
    uSurfRect: { value: new THREE.Vector4(-16, -14, 1 / 32, 1 / 22) },
    uSurfTexel: { value: new THREE.Vector2(1 / 144, 1 / 100) },
    uSurfOn: { value: 0 },
    uSurfLayer: { value: 0 },
    uReflTex: { value: null },
    uReflMatrix: { value: new THREE.Matrix4() },
    uReflOn: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uProjScale: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.05 },
    uFar: { value: 4000 },
    uSkyIrr: { value: new THREE.Vector3(1, 1, 1) },
    uWind: { value: 1 },
    uSwell: { value: 1 },
    envMap: { value: null },
    uEnvOn: { value: 0 },
    uEnvMaxLod: { value: 8 },
  };
  const shared = Object.fromEntries(Object.entries(G).map(([k, v]) => [k, v]));
  const material = new THREE.ShaderMaterial({
    name: 'tp.water',
    uniforms: { ...shared, ...uniforms, uExposure: EXPOSURE },
    vertexShader: /* glsl */`
      ${seaWavesGlsl()}
      ${noiseGlsl}
      ${commonGlsl}
      ${wavesGlsl}
      uniform sampler2D uRippleTex;
      uniform sampler2D uSurfState;
      uniform sampler2D uSurfBed;
      uniform vec4 uSurfRect;
      uniform vec2 uSurfTexel;
      uniform float uSurfOn;
      uniform float uSwell;
      varying vec3 vWorld;
      varying vec2 vSlope;
      varying float vCrest;
      varying float vFactor;
      varying float vMask;
      varying float vViewZ;
      varying float vSeaDepth;
      varying vec2 vXZ;
      varying vec2 vSurfUV;
      varying float vSurfMix;
      varying float vSurfDepth;
      void main() {
        vec2 p = position.xz;
        vec4 shore = tpShore(p);
        float mask = shore.y;
        float level = mix(uSeaLevel, max(uPoolLevel, uSeaLevel), mask);
        float seaDepth = uSeaLevel - shore.x;
        // Swell reaches the pool only once the sea has joined it, and then only weakly.
        float joined = smoothstep(uPoolLevel - 0.02, uPoolLevel + 0.08, uSeaLevel);
        float factor = tpWaveFactor(seaDepth, shore.z) * uSwell * mix(1.0, joined * 0.3, mask);
        float dist = length(p - cameraPosition.xz);
        vec2 slope;
        float crest;
        vec3 d = tpGerstner(p, uTime, factor, slope, crest);
        // Far out the grid is coarse: keep only the long swell so nothing aliases.
        d *= 1.0 - 0.6 * smoothstep(300.0, 1500.0, dist);
        vec2 ruv = (p - uPoolRect.xy) * uPoolRect.zw;
        float ripple = 0.0;
        if (ruv.x > 0.0 && ruv.y > 0.0 && ruv.x < 1.0 && ruv.y < 1.0) ripple = texture(uRippleTex, ruv).x * mask;
        vec2 suv = (p - uSurfRect.xy) * uSurfRect.zw;
        float edge = smoothstep(0.0, 0.045, suv.x) * smoothstep(0.0, 0.045, suv.y)
                   * smoothstep(0.0, 0.045, 1.0 - suv.x) * smoothstep(0.0, 0.045, 1.0 - suv.y);
        float surfMix = uSurfOn * edge * (1.0 - smoothstep(0.08, 0.5, mask) * (1.0 - step(0.5, joined)));
        vec2 sampleUV = clamp(suv, uSurfTexel * 0.5, vec2(1.0) - uSurfTexel * 0.5);
        vec4 flow = texture(uSurfState, sampleUV);
        float bed = texture(uSurfBed, sampleUV).r;
        // Averaging the wet neighbours keeps a step in the rock from tearing the surface into spikes.
        float hSum = (bed + flow.r) * 2.0, wSum = 2.0;
        for (int k = 0; k < 4; k++) {
          vec2 o = vec2(k < 2 ? (k == 0 ? 1.5 : -1.5) : 0.0, k < 2 ? 0.0 : (k == 2 ? 1.5 : -1.5)) * uSurfTexel;
          float dn = texture(uSurfState, sampleUV + o).r;
          float wn = smoothstep(0.005, 0.04, dn);
          hSum += wn * (texture(uSurfBed, sampleUV + o).r + dn);
          wSum += wn;
        }
        float flowHeight = mix(level + d.y, hSum / wSum, smoothstep(0.005, 0.04, flow.r));
        vec3 world = vec3(p.x + d.x * (1.0 - surfMix), mix(level + d.y + ripple, flowHeight, surfMix), p.y + d.z * (1.0 - surfMix));
        slope = mix(slope, clamp(-flow.gb * 0.12, vec2(-0.5), vec2(0.5)), surfMix);
        vSurfUV = sampleUV;
        vSurfMix = surfMix;
        vSurfDepth = flow.r;
        vWorld = world;
        vXZ = p;
        vSlope = slope;
        vCrest = crest;
        vFactor = factor;
        vMask = mask;
        vSeaDepth = seaDepth;
        vec4 mv = viewMatrix * vec4(world, 1.0);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${seaWavesGlsl()}
      #include <common>
      ${noiseGlsl}
      ${commonGlsl}
      ${wavesGlsl}
      ${waterGlsl}
      void main() {
        vec3 col = tpWaterShade();
        col = tpFog(col, vWorld);
        col = any(isnan(col)) ? vec3(0.0) : min(col * uExposure, vec3(400.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  return { material, uniforms };
}

export function waterMesh(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_WATER);
  mesh.renderOrder = 10;
  return mesh;
}
