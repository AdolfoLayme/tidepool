import * as THREE from 'three';
import { LAYER_WATER } from '../render/pipeline.ts';
import { rng } from '../core/rng.ts';
import { shoreZ } from '../world/field.ts';

type Drop = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number };

/** Small airborne droplets over crests that reach the basalt edge. */
export class ShoreSpray {
  readonly points: THREE.Points;
  private readonly drops: Drop[] = [];
  private readonly positions = new Float32Array(240 * 3);
  private readonly opacity = new Float32Array(240);
  private readonly random = rng(47, 'water:spray');
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  get count(): number { return this.drops.length; }

  constructor(scene: THREE.Scene) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacity, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aOpacity;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(45.0 / max(-mv.z, 0.5), 1.0, 3.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vOpacity;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.3, 1.0, d)) * vOpacity;
          gl_FragColor = vec4(0.78, 0.88, 0.86, a);
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'shore-spray';
    this.points.layers.set(LAYER_WATER);
    this.points.renderOrder = 11;
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(
    dt: number, time: number, seaLevel: number,
    surfaceAt: (x: number, z: number, time: number) => number,
    rockAt: (x: number, z: number) => number,
  ): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      if (d.age >= d.life) { this.drops.splice(i, 1); continue; }
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.vy -= 1.2 * dt;
      if (d.y < seaLevel - 0.1) this.drops.splice(i, 1);
    }
    for (let i = 0; i < 18 && this.drops.length < 240; i++) {
      const x = -15 + i * (30 / 17);
      const z = shoreZ(x) - 1.1;
      const crest = surfaceAt(x, z, time) - seaLevel;
      // A crest can strike the vertical face while its surface is below the top of the shelf.
      if (crest < 0.12 || seaLevel + crest < rockAt(x, z) - 0.35 || this.random.next() > dt * 10) continue;
      const count = 1 + this.random.int(0, 1);
      for (let j = 0; j < count && this.drops.length < 240; j++) {
        this.drops.push({
          x: x + this.random.signed() * 0.5, y: seaLevel + crest * 0.5,
          z: z + this.random.signed() * 0.6,
          vx: this.random.signed() * 0.24, vy: this.random.range(0.2, 0.65),
          vz: this.random.range(0.12, 0.5), age: 0, life: this.random.range(0.35, 0.9),
        });
      }
    }
    this.drops.forEach((d, i) => {
      this.positions[i * 3] = d.x; this.positions[i * 3 + 1] = d.y; this.positions[i * 3 + 2] = d.z;
      this.opacity[i] = Math.min(1, d.age * 12) * (1 - d.age / d.life) * 0.35;
    });
    this.geometry.setDrawRange(0, this.drops.length);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aOpacity').needsUpdate = true;
  }

  dispose(): void { this.points.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
