import * as THREE from 'three';

/**
 * Uniform objects shared by reference across every patched material, so one write per frame
 * reaches rock, life and water alike.
 */
export const G = {
  uTime: { value: 0 },
  /** Direction toward the dominant light (sun by day, moon by night). */
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
  /** Radiance scale of that light, already including its colour. */
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  /** Mean sea level (tide) without waves. */
  uSeaLevel: { value: -0.4 },
  /** Current level of the main pool. */
  uPoolLevel: { value: 0 },
  /** Level at which the pool spills over its rim (its fullest). */
  uPoolSpill: { value: 0 },
  /** Rock below this height is still wet from the last high water. */
  uWetLevel: { value: 0.1 },
  /** 0..1 spray reaching the seaward rocks (rises with swell and tide). */
  uSpray: { value: 0.5 },
  /** RGBA float: x terrain height, y pool mask, z shelter from swell, w distance to open water. */
  uShoreTex: { value: null as THREE.Texture | null },
  /** RGBA half float over the pool: x height, y pool mask, z filled level. */
  uPoolTex: { value: null as THREE.Texture | null },
  uPoolRect: { value: new THREE.Vector4(-3.4, -2.6, 1 / 6.8, 1 / 4.8) },
  /** minX, minZ, 1/sizeX, 1/sizeZ of the shore texture. */
  uShoreRect: { value: new THREE.Vector4(-34, -30, 1 / 68, 1 / 52) },
  /** Caustic intensity over the pool (R), written each frame by the water system. */
  uCausticTex: { value: null as THREE.Texture | null },
  /** minX, minZ, 1/sizeX, 1/sizeZ of the caustics texture. */
  uCausticRect: { value: new THREE.Vector4(-3.4, -2.6, 1 / 6.8, 1 / 4.8) },
  /** Absorption of sea water per metre (linear RGB). */
  uWaterSigma: { value: new THREE.Vector3(0.25, 0.075, 0.055) },
  uFogColor: { value: new THREE.Color(0.6, 0.66, 0.7) },
  uFogSunColor: { value: new THREE.Color(0.9, 0.8, 0.7) },
  /** x density, y height falloff, z base height, w sun phase power. */
  uFogParams: { value: new THREE.Vector4(0.004, 0.18, 0, 8) },
  /** Overall brightness of the night sky; drives star visibility and moon glints. */
  uNight: { value: 0 },
  uRockAlbedo: { value: null as THREE.Texture | null },
  uRockNormal: { value: null as THREE.Texture | null },
  /**
   * Thin plants (surfgrass) closer to the lens than this (m) dissolve. A hand's breadth in
   * general; during a close look almost up to the animal, so blades in between do not cross it.
   */
  uLensClear: { value: 0.32 },
  /** x: water simulation available, y: caustics strength, z: wet sheen strength. */
  uFeatures: { value: new THREE.Vector4(0, 1, 1, 0) },
};

export type Globals = typeof G;
