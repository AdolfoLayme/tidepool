import * as THREE from 'three';

/**
 * Planar mirror for the pool surface, following the math of three.js' Reflector addon: the camera
 * is reflected about the water plane and the projection gets an oblique near plane, so nothing
 * below the water leaks into the reflection.
 */
export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  readonly camera = new THREE.PerspectiveCamera();
  scale: number;
  private readonly plane = new THREE.Plane();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly mirrorPos = new THREE.Vector3();
  private readonly cameraPos = new THREE.Vector3();
  private readonly rotation = new THREE.Matrix4();
  private readonly lookAt = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();

  constructor(scale: number) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    this.target.texture.name = 'tp.reflection';
    this.target.texture.generateMipmaps = false;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }

  /** Renders the mirrored view. Returns false when the camera is below the plane. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, planeY: number, layers: THREE.Layers): boolean {
    this.mirrorPos.set(camera.position.x, planeY, camera.position.z);
    this.cameraPos.setFromMatrixPosition(camera.matrixWorld);
    this.rotation.extractRotation(camera.matrixWorld);
    this.view.subVectors(this.mirrorPos, this.cameraPos);
    if (this.view.dot(this.normal) > 0) return false;
    this.view.reflect(this.normal).negate().add(this.mirrorPos);

    this.lookAt.set(0, 0, -1).applyMatrix4(this.rotation).add(this.cameraPos);
    this.target3.subVectors(this.mirrorPos, this.lookAt).reflect(this.normal).negate().add(this.mirrorPos);

    const vc = this.camera;
    vc.position.copy(this.view);
    vc.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(this.normal);
    vc.lookAt(this.target3);
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.layers.mask = layers.mask;

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // Oblique near plane (Lengyel) so geometry under the water is clipped.
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.mirrorPos).applyMatrix4(vc.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = vc.projectionMatrix;
    this.q.x = (Math.sign(this.clip.x) + p.elements[8]) / p.elements[0];
    this.q.y = (Math.sign(this.clip.y) + p.elements[9]) / p.elements[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + p.elements[10]) / p.elements[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(this.q));
    p.elements[2] = this.clip.x;
    p.elements[6] = this.clip.y;
    p.elements[10] = this.clip.z + 1.0 - 0.003;
    p.elements[14] = this.clip.w;

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  dispose(): void { this.target.dispose(); }
}
