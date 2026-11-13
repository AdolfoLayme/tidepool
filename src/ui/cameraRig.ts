import * as THREE from 'three';

export type CameraPose = { target: THREE.Vector3; azimuth: number; elevation: number; distance: number; fov: number };

export const HOME_POSE: CameraPose = {
  target: new THREE.Vector3(0.1, -0.15, -1.0),
  azimuth: 0.12,
  elevation: 0.43,
  distance: 5.4,
  fov: 42,
};

/**
 * Orbit camera with inertia, held to a viewer standing at the pool: it cannot go under the rock
 * or swing round to look inland. Pose values are plain numbers so anime.js can tween them.
 */
export class CameraRig {
  readonly pose: CameraPose;
  /** Smoothed values actually used for the camera. */
  private readonly cur: CameraPose;
  private vAz = 0;
  private vEl = 0;
  limits = { azMin: -1.75, azMax: 1.75, elMin: 0.12, elMax: 1.35, distMin: 0.35, distMax: 11 };
  /** Optional terrain query to keep the lens above rock and water. */
  groundAt: ((x: number, z: number) => number) | null = null;
  /** Fraction of the remaining offset covered per second (higher = snappier). */
  follow = 7;

  private readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera, pose: CameraPose = HOME_POSE) {
    this.camera = camera;
    this.pose = clonePose(pose);
    this.cur = clonePose(pose);
    this.apply(1);
  }

  /** Drag by screen pixels. */
  drag(dx: number, dy: number, height: number): void {
    const k = 2.4 / Math.max(height, 300);
    this.vAz = -dx * k * 60;
    this.vEl = dy * k * 60 * 0.8;
    this.pose.azimuth = THREE.MathUtils.clamp(this.pose.azimuth - dx * k, this.limits.azMin, this.limits.azMax);
    this.pose.elevation = THREE.MathUtils.clamp(this.pose.elevation + dy * k * 0.8, this.limits.elMin, this.limits.elMax);
  }

  release(): void { /* inertia continues from the last drag velocity */ }

  stopInertia(): void { this.vAz = 0; this.vEl = 0; }

  zoom(factor: number): void {
    this.pose.distance = THREE.MathUtils.clamp(this.pose.distance * factor, this.limits.distMin, this.limits.distMax);
  }

  private aspect = 1.6;

  /** Keeps the pool framed on narrow screens by stepping back and looking a little more down. */
  setAspect(aspect: number): void {
    const k = (a: number) => (a >= 1.3 ? 1 : Math.pow(1.3 / a, 0.75));
    const ratio = k(aspect) / k(this.aspect);
    this.aspect = aspect;
    if (Math.abs(ratio - 1) < 1e-3) return;
    this.pose.distance = THREE.MathUtils.clamp(this.pose.distance * ratio, this.limits.distMin, this.limits.distMax * 1.6);
    this.pose.elevation = THREE.MathUtils.clamp(this.pose.elevation + (ratio - 1) * 0.12, this.limits.elMin, this.limits.elMax);
  }

  snapTo(p: CameraPose): void {
    copyPose(this.pose, p);
    copyPose(this.cur, p);
    this.vAz = this.vEl = 0;
    this.apply(1);
  }

  get current(): Readonly<CameraPose> { return this.cur; }

  update(dt: number, dragging: boolean): void {
    if (!dragging) {
      // Inertia decays quickly; clamped to the same limits.
      const decay = Math.exp(-dt * 5.5);
      this.vAz *= decay; this.vEl *= decay;
      if (Math.abs(this.vAz) > 1e-4) this.pose.azimuth = THREE.MathUtils.clamp(this.pose.azimuth - this.vAz * dt * 0.016 * 60, this.limits.azMin, this.limits.azMax);
      if (Math.abs(this.vEl) > 1e-4) this.pose.elevation = THREE.MathUtils.clamp(this.pose.elevation + this.vEl * dt * 0.016 * 60, this.limits.elMin, this.limits.elMax);
    }
    const a = 1 - Math.exp(-dt * this.follow);
    this.apply(a);
  }

  private apply(a: number): void {
    const c = this.cur, p = this.pose;
    c.target.lerp(p.target, a);
    c.azimuth += (p.azimuth - c.azimuth) * a;
    c.elevation += (p.elevation - c.elevation) * a;
    c.distance += (p.distance - c.distance) * a;
    c.fov += (p.fov - c.fov) * a;
    const ce = Math.cos(c.elevation);
    const pos = new THREE.Vector3(
      c.target.x + Math.sin(c.azimuth) * ce * c.distance,
      c.target.y + Math.sin(c.elevation) * c.distance,
      c.target.z + Math.cos(c.azimuth) * ce * c.distance,
    );
    if (this.groundAt) {
      const floor = this.groundAt(pos.x, pos.z) + 0.12;
      if (pos.y < floor) pos.y = floor;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(c.target);
    if (Math.abs(this.camera.fov - c.fov) > 1e-3) {
      this.camera.fov = c.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

export function clonePose(p: CameraPose): CameraPose {
  return { target: p.target.clone(), azimuth: p.azimuth, elevation: p.elevation, distance: p.distance, fov: p.fov };
}

export function copyPose(dst: CameraPose, src: CameraPose): void {
  dst.target.copy(src.target);
  dst.azimuth = src.azimuth; dst.elevation = src.elevation; dst.distance = src.distance; dst.fov = src.fov;
}
