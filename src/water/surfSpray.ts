import * as THREE from 'three';
import { LAYER_WATER } from '../render/pipeline.ts';
import { rng } from '../core/rng.ts';
import type { SurfSim } from './surfSim.ts';

const COUNT = 26000;
const PERIOD = 1.15;

/**
 * Droplets thrown where the flow actually strikes rock. Each point owns a fixed spot and a looping
 * life; the impact memory in the foam texture decides whether it is thrown, and how hard.
 */
export class SurfSpray {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, surf: SurfSim) {
    const random = rng(53, 'water:surf-spray');
    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      seeds[i * 4] = random.next();
      seeds[i * 4 + 1] = random.next();
      seeds[i * 4 + 2] = random.next();
      seeds[i * 4 + 3] = random.next();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null }, uFoam: { value: null }, uBed: { value: surf.bed },
        uRect: { value: surf.rect }, uTime: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute vec4 aSeed;
        uniform sampler2D uState;
        uniform sampler2D uFoam;
        uniform sampler2D uBed;
        uniform vec4 uRect;
        uniform float uTime;
        varying float vAlpha;
        void main() {
          float life = fract(uTime / ${PERIOD.toFixed(2)} + aSeed.z);
          float age = life * ${PERIOD.toFixed(2)};
          float burst = texture2D(uFoam, aSeed.xy).b;
          float depth = texture2D(uState, aSeed.xy).r;
          float base = texture2D(uBed, aSeed.xy).r + depth;
          float power = smoothstep(0.08, 0.5, burst) * (1.0 - smoothstep(0.3, 0.75, depth));
          float speed = (0.6 + 1.9 * aSeed.w * aSeed.w) * (0.45 + 0.55 * power);
          float angle = aSeed.w * 39.0 + aSeed.z * 17.0;
          vec2 side = vec2(cos(angle), sin(angle)) * (0.25 + 0.9 * aSeed.z);
          vec2 xz = vec2(aSeed.x / uRect.z, aSeed.y / uRect.w) + uRect.xy + side * age;
          float y = base + speed * age - 4.9 * age * age;
          vAlpha = power * smoothstep(0.0, 0.12, life) * (1.0 - life) * step(base, y + 0.02);
          vec4 mv = modelViewMatrix * vec4(xz.x, y, xz.y, 1.0);
          gl_PointSize = clamp((26.0 + 60.0 * aSeed.w) / max(-mv.z, 0.5), 1.2, 5.5) * step(0.004, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(0.9, 0.95, 0.96, (1.0 - smoothstep(0.35, 1.0, d)) * vAlpha * 0.6);
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'surf-spray';
    this.points.layers.set(LAYER_WATER);
    this.points.renderOrder = 12;
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(time: number, surf: SurfSim): void {
    const u = this.material.uniforms;
    u.uState.value = surf.stateTexture;
    u.uFoam.value = surf.foamTexture;
    u.uTime.value = time;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
