import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { G } from '../core/globals.ts';
import { nightSkyMaterial, nightSkyMesh } from './night.ts';
import { LAYER_DIRECT } from '../render/pipeline.ts';
import { lum, moonDirection, skyIrradiance, skyParamsFor, skyRadiance, sunDirection, transmittance, type SkyParams, type Vec3 } from './sun.ts';

/** Sun plus sky irradiance on the shelf at noon (exposure units); light above this is full daylight. */
const DAYLIGHT = 42;

export type SkyState = {
  hour: number;
  sun: Vec3;
  moon: Vec3;
  /** 0 by day, 1 in full night. */
  night: number;
  /** 0..1 warm low-sun light. */
  golden: number;
  params: SkyParams;
};

/**
 * Daylight: three.js' Preetham sky (with its cloud layer) for the dome, a CPU port of the same model
 * for sun colour and fog, and a prefiltered environment map rebuilt when the light changes.
 */
export class SkySystem {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly state: SkyState;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: Sky;
  private readonly envGround: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  readonly nightMaterial = nightSkyMaterial();
  private readonly reflectedNight: THREE.ShaderMaterial;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvHour = -999;
  private lastEnvTime = -1e9;
  private mist = 0.15;
  exposure = 1;
  /** Irradiance from the sky dome on a horizontal surface (Sky shader units). */
  readonly skyIrr = new THREE.Vector3(1, 1, 1);

  private readonly scene: THREE.Scene;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, shadowSize: number) {
    this.scene = scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(9000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    const u = this.sky.material.uniforms;
    u.cloudCoverage.value = 0.32;
    u.cloudDensity.value = 0.45;
    u.cloudScale.value = 0.00022;
    u.cloudElevation.value = 0.55;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.setShadowSize(shadowSize);
    const cam = this.sun.shadow.camera;
    cam.left = -9; cam.right = 9; cam.top = 9; cam.bottom = -9; cam.near = 1; cam.far = 80;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3.5;
    // Small things on their own layer still cast shadows.
    this.sun.shadow.camera.layers.enableAll();
    this.sun.target.position.set(0, 0, -0.6);
    scene.add(this.sun, this.sun.target);

    this.envSky = new Sky();
    this.envSky.scale.setScalar(900);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.envSky);
    // Lower hemisphere: the sea and wet rock seen from the pool, darker than the sky it reflects.
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(400, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b1416 }));
    this.envGround.position.y = -1.5;
    this.envScene.add(this.envGround);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // Stars only in the direct view; reflections and the environment get the moon and sky glow.
    this.nightMaterial.uniforms.uGlow.value = 0;
    const direct = nightSkyMesh(this.nightMaterial, 3000);
    direct.layers.set(LAYER_DIRECT);
    scene.add(direct);
    this.reflectedNight = this.nightMaterial.clone();
    this.reflectedNight.uniforms.uStars.value = 0;
    this.reflectedNight.uniforms.uGlow.value = 1;
    scene.add(nightSkyMesh(this.reflectedNight, 2900));
    this.envScene.add(nightSkyMesh(this.reflectedNight, 600));

    this.state = { hour: 12, sun: [0, 1, 0], moon: [0, -1, 0], night: 0, golden: 0, params: skyParamsFor(1, 0) };
  }

  setShadowSize(size: number): void {
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
  }

  setMist(m: number): void { this.mist = m; }

  /** Updates sky, sun, fog and (when the light moved enough) the environment map. */
  update(hour: number, time: number, force = false): void {
    const sun = sunDirection(hour);
    const moon = moonDirection(hour);
    const elev = sun[1];
    const night = 1 - THREE.MathUtils.smoothstep(elev, -0.16, 0.02);
    const golden = Math.exp(-Math.pow((elev - 0.08) / 0.12, 2));
    // Sea mist lingers around sunrise and burns off as the sun climbs; once the sun is up it
    // thins enough for the low light to cast shadows.
    const mist = this.mist + 0.3 * Math.exp(-Math.pow((hour - 5.6) / 0.8, 2));
    const params = skyParamsFor(elev, mist);
    Object.assign(this.state, { hour, sun, moon, night, golden, params });

    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.sunPosition.value.set(sun[0], sun[1], sun[2]);
      u.turbidity.value = params.turbidity;
      u.rayleigh.value = params.rayleigh;
      u.mieCoefficient.value = params.mieCoefficient;
      u.mieDirectionalG.value = params.mieDirectionalG;
      u.time.value = time;
      u.cloudCoverage.value = 0.3 + mist * 0.25;
    }

    // Key light: the sun, fading into moonlight after dusk.
    const tSun = transmittance(sun, sun, params);
    const sunUp = THREE.MathUtils.smoothstep(elev, -0.02, 0.06);
    // Calibrated against the sky model: at midday direct sun gives ~7x the sky's irradiance.
    const sunI = 40 * (lum(tSun) / 0.86) * sunUp;
    const eSkyRgb = skyIrradiance(sun, params);
    // Moonlight is far brighter here than in nature (a photographer's long exposure), so the
    // night reads as moonlit rather than black.
    const moonI = 0.55 * night * THREE.MathUtils.smoothstep(moon[1], 0.02, 0.25);
    const twilight = THREE.MathUtils.smoothstep(sun[1], -0.21, -0.03) * (1 - THREE.MathUtils.smoothstep(sun[1], -0.03, 0.09));
    const nu = this.nightMaterial.uniforms;
    nu.uSunDir.value.set(sun[0], sun[1], sun[2]);
    nu.uMoonDir.value.set(moon[0], moon[1], moon[2]);
    nu.uNight.value = night;
    nu.uTwilight.value = twilight;
    nu.uTime.value = time;
    for (const k of ['uSunDir', 'uMoonDir'] as const) this.reflectedNight.uniforms[k].value.copy(nu[k].value);
    for (const k of ['uNight', 'uTwilight', 'uTime'] as const) this.reflectedNight.uniforms[k].value = nu[k].value;
    // Twilight glow, airglow and the moon's own sky (matches the night dome's level).
    this.skyIrr.set(
      eSkyRgb[0] + twilight * 0.09 + night * 0.012 + moonI * 0.03,
      eSkyRgb[1] + twilight * 0.11 + night * 0.016 + moonI * 0.04,
      eSkyRgb[2] + twilight * 0.2 + night * 0.03 + moonI * 0.07,
    );
    const useMoon = sunUp < 0.02;
    const key = useMoon ? moon : sun;
    this.sun.position.set(key[0] * 40, key[1] * 40, key[2] * 40).add(this.sun.target.position);
    if (useMoon) {
      this.sun.color.setRGB(0.62, 0.74, 1.0);
      this.sun.intensity = moonI;
    } else {
      this.sun.color.setRGB(tSun[0], tSun[1], tSun[2]);
      const m = Math.max(this.sun.color.r, this.sun.color.g, this.sun.color.b);
      this.sun.color.multiplyScalar(1 / m);
      this.sun.intensity = sunI * m;
    }
    G.uSunDir.value.set(key[0], key[1], key[2]).normalize();
    G.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    G.uNight.value = night;

    // Fog colours from the sky at the horizon: away from and toward the sun.
    const hz = 0.035;
    const flat = Math.hypot(sun[0], sun[2]) || 1;
    const toward: Vec3 = [sun[0] / flat, hz, sun[2] / flat];
    const away: Vec3 = [-sun[0] / flat, hz, -sun[2] / flat];
    const side: Vec3 = [-sun[2] / flat, hz, sun[0] / flat];
    const a = skyRadiance(away, sun, params), s = skyRadiance(side, sun, params), t = skyRadiance(toward, sun, params);
    const nightFloor = 0.0018;
    G.uFogColor.value.setRGB((a[0] + s[0]) / 2 + nightFloor * 0.6, (a[1] + s[1]) / 2 + nightFloor * 0.8, (a[2] + s[2]) / 2 + nightFloor * 1.2);
    // Toward the sun the haze glows, but the horizon sample right under the sun is far too hot for
    // mist a few metres thick: cap it relative to the ambient haze.
    const fc = G.uFogColor.value;
    const cap = (v: number, c: number) => Math.min(v, c * 3.5 + 0.02);
    G.uFogSunColor.value.setRGB(cap(t[0], fc.r) + nightFloor * 0.6, cap(t[1], fc.g) + nightFloor * 0.8, cap(t[2], fc.b) + nightFloor * 1.2);
    // Aerial perspective over the sea: about half the light of a stack 300 m out is haze.
    G.uFogParams.value.set(0.0022 + 0.012 * mist, 0.035, 0, 6 + 10 * golden);

    // Exposure follows the light like a photographer metering dark rock would; at night it is held
    // back so moonlight still reads as night.
    // With the sun low, rock faces turned toward it take far more light than the level ground; a
    // photographer exposes for those lit faces, so the meter counts them too.
    const sunFacing = Math.max(sun[1], 0.3 * THREE.MathUtils.smoothstep(sun[1], -0.02, 0.05));
    const eTotal = sunI * sunFacing + lum([this.skyIrr.x, this.skyIrr.y, this.skyIrr.z]) + moonI * Math.max(moon[1], 0) * night;
    const meter = THREE.MathUtils.lerp(3.1, 1.5, night);
    // Eyes and cameras only partly follow falling light: a frame with a bright sunset sky in it is
    // not metered as if the rock were all there is. Below full daylight the exposure therefore
    // rises with a power of the light lost (about 2 of every 3 stops), so low sun keeps dark
    // basalt dark under a glowing sky. Full day is unchanged; by night the meter is used as is.
    const adapt = THREE.MathUtils.lerp(0.68, 1, night);
    const eMeter = Math.pow(DAYLIGHT, 1 - adapt) * Math.pow(Math.max(Math.min(eTotal, DAYLIGHT), 1e-4), adapt) * Math.max(eTotal / DAYLIGHT, 1);
    this.exposure = THREE.MathUtils.clamp(meter / eMeter, 0.05, 30);

    this.envGround.material = this.envGround.material as THREE.MeshBasicMaterial;
    (this.envGround.material as THREE.MeshBasicMaterial).color.setRGB(a[0] * 0.18 + 0.002, a[1] * 0.2 + 0.003, a[2] * 0.2 + 0.004);

    const now = performance.now();
    if (force || (Math.abs(hour - this.lastEnvHour) > 0.04 && now - this.lastEnvTime > 220)) {
      this.rebuildEnvironment();
      this.lastEnvHour = hour;
      this.lastEnvTime = now;
    }
  }

  private rebuildEnvironment(): void {
    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.5, 2000);
    this.scene.environment = this.envTarget.texture;
    prev?.dispose();
  }

  get environment(): THREE.Texture | null { return this.envTarget?.texture ?? null; }
}
