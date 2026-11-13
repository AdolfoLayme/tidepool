import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader2.js';

/**
 * Exposure is applied when the opaque scene is composited (and by the water shader), so bloom and
 * depth of field work on exposed values; tone mapping then runs with exposure 1.
 */
export const EXPOSURE = { value: 1 };

/** Render layers: opaque world first, then surfaces that read the opaque colour and depth. */
export const LAYER_WORLD = 0;
export const LAYER_WATER = 1;
/** Seen directly but not in reflections (stars: too fine for the reflection's resolution). */
export const LAYER_DIRECT = 3;
/** Small things (barnacles, mussels, turf, cobbles): seen directly, cast shadows, not reflected. */
export const LAYER_DETAIL = 2;

export type SceneTargets = {
  color: THREE.Texture;
  depth: THREE.DepthTexture;
  size: THREE.Vector2;
};

/**
 * Renders the opaque scene into a multisampled target that keeps its depth, then draws a copy
 * plus the water layer (which samples that colour and depth for refraction, absorption and foam).
 */
class SceneWaterPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly copy: FullScreenQuad;
  private readonly copyMat: THREE.ShaderMaterial;
  beforeWater: ((renderer: THREE.WebGLRenderer) => void) | null = null;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, samples: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(2, 2, THREE.UnsignedIntType),
    });
    this.target.texture.name = 'tp.sceneColor';
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: this.target.texture }, uExposure: EXPOSURE },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tColor; uniform float uExposure; varying vec2 vUv; void main(){ vec3 c = texture2D(tColor, vUv).rgb * uExposure; c = any(isnan(c)) ? vec3(0.0) : min(c, vec3(400.0)); gl_FragColor = vec4(c, 1.0); }',
      depthTest: false, depthWrite: false,
    });
    this.copy = new FullScreenQuad(this.copyMat);
  }

  setSamples(samples: number): void { this.target.samples = samples; this.target.dispose(); }

  override setSize(width: number, height: number): void { this.target.setSize(width, height); }

  override render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    cam.layers.set(LAYER_WORLD);
    cam.layers.enable(LAYER_DIRECT);
    cam.layers.enable(LAYER_DETAIL);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, true);
    renderer.render(this.scene, cam);
    this.beforeWater?.(renderer);
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    renderer.clear(true, true, true);
    this.copy.render(renderer);
    cam.layers.set(LAYER_WATER);
    renderer.render(this.scene, cam);
    cam.layers.set(LAYER_WORLD);
    renderer.autoClear = autoClear;
  }

  override dispose(): void { this.target.dispose(); this.copyMat.dispose(); this.copy.dispose(); }
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      // Slight lateral colour fringe toward the corners, like a real lens.
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.0035;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // Optical vignette (cos^4 falloff, gentle).
      float v = 1.0 - uVignette * smoothstep(0.08, 0.62, r2 * (uResolution.x / uResolution.y) * 0.85);
      col *= v;
      // Luminance-weighted film grain, stronger in the shadows.
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(l), 0.12 * (1.0 - smoothstep(0.08, 0.38, l)));
      float g = hash(gl_FragCoord.xy + fract(uTime * 17.0) * 113.0) - 0.5;
      col += g * uGrain * (1.0 - l) * (0.35 + 0.65 * sqrt(max(l, 0.0)));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export type PipelineOptions = { msaa: number; bloom: boolean; dof: boolean };

export class Pipeline {
  readonly composer: EffectComposer;
  readonly scenePass: SceneWaterPass;
  readonly bloom: UnrealBloomPass;
  readonly dof: ShaderPass;
  readonly output: OutputPass;
  readonly grade: ShaderPass;
  /** 0..1 depth-of-field strength (macro shots). */
  dofAmount = 0;
  focusDistance = 5;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PipelineOptions) {
    this.renderer = renderer;
    this.camera = camera;
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, rt);
    this.scenePass = new SceneWaterPass(scene, camera, opts.msaa);
    this.composer.addPass(this.scenePass);

    this.dof = new ShaderPass(BokehShader, 'tColor');
    this.dof.material.defines = { RINGS: 3, SAMPLES: 4 };
    const du = this.dof.uniforms;
    du.tDepth.value = this.scenePass.target.depthTexture;
    du.shaderFocus.value = 0;
    du.manualdof.value = 0;
    du.vignetting.value = 0;
    du.noise.value = 1;
    du.fringe.value = 0.4;
    du.maxblur.value = 1.4;
    du.threshold.value = 0.9;
    du.gain.value = 0.6;
    du.bias.value = 0.3;
    du.znear.value = camera.near;
    du.zfar.value = camera.far;
    this.dof.enabled = false;
    this.composer.addPass(this.dof);

    // Exposed linear values: only real highlights (sun glints on water, the sun itself) bloom. The
    // threshold sits above a bright sunset sky, which otherwise veils the whole frame in glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.14, 0.3, 2.5);
    // Feed the bloom a soft-clipped image: the sun disc is thousands of times brighter than rock and
    // would otherwise flood the frame. Glints and the sun still glow, the sky does not.
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );', 'vec4 texel = texture2D( tDiffuse, vUv ); texel.rgb = texel.rgb / (1.0 + max(max(texel.r, texel.g), texel.b) / 6.0);');
    hp.needsUpdate = true;
    this.bloom.enabled = opts.bloom;
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.setDofAvailable(opts.dof);
  }

  private dofAvailable = true;
  setDofAvailable(on: boolean): void { this.dofAvailable = on; }
  setBloom(on: boolean): void { this.bloom.enabled = on; }
  setSamples(samples: number): void { this.scenePass.setSamples(samples); }
  get sceneTargets(): SceneTargets {
    return { color: this.scenePass.target.texture, depth: this.scenePass.target.depthTexture as THREE.DepthTexture, size: new THREE.Vector2(this.scenePass.target.width, this.scenePass.target.height) };
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    const w = Math.round(width * pixelRatio), h = Math.round(height * pixelRatio);
    this.dof.uniforms.textureWidth.value = w;
    this.dof.uniforms.textureHeight.value = h;
    this.grade.uniforms.uResolution.value.set(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  render(time: number, dt: number): void {
    this.grade.uniforms.uTime.value = time;
    const on = this.dofAvailable && this.dofAmount > 0.01;
    this.dof.enabled = on;
    if (on) {
      const du = this.dof.uniforms;
      du.focalDepth.value = this.focusDistance;
      du.focalLength.value = 35 + 55 * this.dofAmount;
      du.fstop.value = THREE.MathUtils.lerp(16, 2.2, this.dofAmount);
      du.znear.value = this.camera.near;
      du.zfar.value = this.camera.far;
    }
    this.composer.render(dt);
  }
}
