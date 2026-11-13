/**
 * Solar position and a CPU port of the Preetham daylight model used by three.js' Sky shader,
 * so lights, fog and the sky agree. Coordinates: +x north, +z east, -z west (the sea), +y up.
 */

export type Vec3 = [number, number, number];

export const LATITUDE = 44.6; // central Oregon coast
export const DECLINATION = 18; // early summer

const DEG = Math.PI / 180;

/** Direction toward the sun for a local solar hour (12 = solar noon). */
export function sunDirection(hour: number, latitude = LATITUDE, declination = DECLINATION): Vec3 {
  const lat = latitude * DEG, dec = declination * DEG;
  const H = (hour - 12) * 15 * DEG;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
  const c = Math.cos(el);
  return [Math.cos(az) * c, Math.sin(el), Math.sin(az) * c];
}

/** Moon roughly opposite the sun, a little higher, so night has a key light. */
export function moonDirection(hour: number): Vec3 {
  const s = sunDirection(hour + 11.2, LATITUDE, -6);
  return s;
}

export type SkyParams = { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number };

const totalRayleigh: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MieConst: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const cutoffAngle = 1.6110731556870734;
const steepness = 1.5;
const EE = 1000;

function sunIntensity(zenithAngleCos: number): number {
  const z = Math.max(-1, Math.min(1, zenithAngleCos));
  return EE * Math.max(0, 1 - Math.exp(-((cutoffAngle - Math.acos(z)) / steepness)));
}

function scattering(sun: Vec3, p: SkyParams) {
  // The shader receives a unit sun vector, so this fade is ~1; kept for parity with Sky.js.
  const sunfade = 1 - Math.max(0, Math.min(1, 1 - Math.exp(sun[1] / 450000)));
  const rayleighCoefficient = p.rayleigh - (1 - sunfade);
  const betaR = totalRayleigh.map(v => v * rayleighCoefficient) as Vec3;
  const c = 0.2 * p.turbidity * 10e-18;
  const betaM = MieConst.map(v => 0.434 * c * v * p.mieCoefficient) as Vec3;
  return { betaR, betaM, sunE: sunIntensity(sun[1]) };
}

function opticalLengths(dirY: number): [number, number] {
  const zenith = Math.acos(Math.max(0, dirY));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
  return [8.4e3 * inv, 1.25e3 * inv];
}

/** Atmospheric transmittance along a direction (what sunlight keeps after crossing the air). */
export function transmittance(dir: Vec3, sun: Vec3, p: SkyParams): Vec3 {
  const { betaR, betaM } = scattering(sun, p);
  const [sR, sM] = opticalLengths(dir[1]);
  return [0, 1, 2].map(i => Math.exp(-(betaR[i] * sR + betaM[i] * sM))) as Vec3;
}

/** Sky radiance in the same linear units the Sky shader writes (before tone mapping), no clouds. */
export function skyRadiance(dir: Vec3, sun: Vec3, p: SkyParams): Vec3 {
  const { betaR, betaM, sunE } = scattering(sun, p);
  const [sR, sM] = opticalLengths(dir[1]);
  const Fex = [0, 1, 2].map(i => Math.exp(-(betaR[i] * sR + betaM[i] * sM)));
  const cosTheta = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const rPhase = (3 / (16 * Math.PI)) * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = p.mieDirectionalG, g2 = g * g;
  const mPhase = (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
  const k = Math.max(0, Math.min(1, Math.pow(1 - sun[1], 5)));
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    let Lin = Math.pow(sunE * ratio * (1 - Fex[i]), 1.5);
    Lin *= 1 + (Math.pow(sunE * ratio * Fex[i], 0.5) - 1) * k;
    const L0 = 0.1 * Fex[i];
    out[i] = (Lin + L0) * 0.04 + [0, 0.0003, 0.00075][i];
  }
  return out;
}

/** Sky look across the day: hazier and redder near the horizon hours. */
export function skyParamsFor(sunElevation: number, mist: number): SkyParams {
  const low = 1 - Math.min(1, Math.max(0, sunElevation / 0.5));
  return {
    turbidity: 2.6 + 3.4 * low + 4 * mist,
    rayleigh: 1.1 + 1.6 * low,
    mieCoefficient: 0.0045 + 0.004 * low + 0.006 * mist,
    mieDirectionalG: 0.8 + 0.06 * low,
  };
}

/** Irradiance on a horizontal surface from the sky dome (cosine-weighted), in Sky shader units. */
export function skyIrradiance(sun: Vec3, p: SkyParams): Vec3 {
  const out: Vec3 = [0, 0, 0];
  const nEl = 8, nAz = 16;
  let wsum = 0;
  for (let i = 0; i < nEl; i++) {
    const el = ((i + 0.5) / nEl) * (Math.PI / 2);
    const cosT = Math.sin(el); // cosine to the zenith
    const ring = Math.cos(el); // solid-angle weight of the ring
    for (let j = 0; j < nAz; j++) {
      const az = ((j + 0.5) / nAz) * Math.PI * 2;
      const d: Vec3 = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
      const L = skyRadiance(d, sun, p);
      const w = cosT * ring;
      out[0] += L[0] * w; out[1] += L[1] * w; out[2] += L[2] * w;
      wsum += ring;
    }
  }
  // Mean of L*cos over the hemisphere times its solid angle (2*pi).
  const k = (2 * Math.PI) / wsum;
  return [out[0] * k, out[1] * k, out[2] * k];
}

export const lum = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
