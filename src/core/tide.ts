import { LAYOUT } from '../world/layout.ts';

/**
 * Tide and water levels. The tide moves the sea; the pool keeps its water at the spill level of its
 * rim until the sea rises past it, and then the two are one body of water.
 */
export function seaLevelFor(tide: number): number {
  const t = Math.min(1, Math.max(0, tide));
  return LAYOUT.tide.low + (LAYOUT.tide.high - LAYOUT.tide.low) * t;
}

export function tideFor(seaLevel: number): number {
  return (seaLevel - LAYOUT.tide.low) / (LAYOUT.tide.high - LAYOUT.tide.low);
}

/** Pool level: held at the spill level, joined to the sea once the sea (with surge) overtops it. */
export function poolLevelFor(sea: number, spill: number, surge: number): number {
  const top = sea + surge;
  if (top <= spill) return spill;
  // Above the rim the pool follows the sea; a soft knee avoids a visible kink.
  const k = 0.03;
  const x = top - spill;
  return spill + (x < k ? (x * x) / (2 * k) : x - k / 2);
}

/**
 * The pool's own level. While the sea is below the rim, water seeps out through joints and the
 * level falls slowly (deeper at the bottom of the tide); waves that overtop pour back in, and
 * once the sea reaches the rim the pool rises with it.
 */
export class PoolLevel {
  level: number;
  private readonly spill: number;
  /** Lowest the pool can drain (m below the spill level). */
  readonly maxDrain: number;
  constructor(spill: number, maxDrain = 0.16) { this.spill = spill; this.level = spill; this.maxDrain = maxDrain; }
  update(dt: number, sea: number, inflow: number, low: number): number {
    if (sea >= this.spill - 0.005) {
      // The sea has reached the rim: the pool and the sea are one body of water.
      this.level += (sea - this.level) * Math.min(1, dt * 2.5);
      return this.level;
    }
    const exposure = Math.min(1, Math.max(0, (this.spill - sea) / Math.max(this.spill - low, 1e-3)));
    const floor = this.spill - this.maxDrain * exposure;
    // Seepage: a few millimetres a second, slowing as the head drops.
    if (this.level > floor) this.level = Math.max(floor, this.level - dt * 0.0011 * (0.3 + 0.7 * exposure));
    // Waves pouring in over the rim.
    this.level = Math.min(Math.max(this.spill, sea), this.level + inflow);
    return this.level;
  }
}

/**
 * Wet line memory: rock is wet up to the highest recent water, and dries from the top down at a
 * steady rate (accelerated, minutes rather than hours).
 */
export class WetLine {
  level: number;
  private readonly dryRate: number;
  constructor(start: number, dryRate = 0.035) { this.level = start; this.dryRate = dryRate; }
  update(dt: number, water: number, splash: number): number {
    const reach = water + splash;
    if (reach > this.level) this.level += (reach - this.level) * Math.min(1, dt * 6);
    else this.level = Math.max(reach, this.level - this.dryRate * dt);
    return this.level;
  }
}

/**
 * Light slider mapping (0..1 to local solar hour). Piecewise linear so the evenly spaced labels
 * land on deep night, sunrise glow, noon, sunset glow and night again, and the slider spends more
 * of its travel where the light changes fastest.
 */
const LIGHT_ANCHORS: [number, number][] = [[0, 2.6], [0.25, 5.35], [0.5, 12.9], [0.75, 18.95], [1, 23.4]];

export function hourFor(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  for (let i = 1; i < LIGHT_ANCHORS.length; i++) {
    const [u0, h0] = LIGHT_ANCHORS[i - 1], [u1, h1] = LIGHT_ANCHORS[i];
    if (v <= u1) return h0 + (h1 - h0) * ((v - u0) / (u1 - u0));
  }
  return LIGHT_ANCHORS[LIGHT_ANCHORS.length - 1][1];
}

export function sliderForHour(hour: number): number {
  for (let i = 1; i < LIGHT_ANCHORS.length; i++) {
    const [u0, h0] = LIGHT_ANCHORS[i - 1], [u1, h1] = LIGHT_ANCHORS[i];
    if (hour <= h1) return Math.max(0, u0 + (u1 - u0) * ((hour - h0) / (h1 - h0)));
  }
  return 1;
}

export function lightName(hour: number): string {
  if (hour < 4.15 || hour >= 20.7) return 'Night';
  if (hour < 4.75) return 'Before dawn';
  if (hour < 6.6) return 'Dawn';
  if (hour < 10.5) return 'Morning';
  if (hour < 14.5) return 'Midday';
  if (hour < 18.0) return 'Afternoon';
  if (hour < 19.45) return 'Sunset';
  return 'Dusk';
}

/** Tide as a slow cycle: phase 0 = low water, pi = high water. */
export function tideAtPhase(phase: number): number {
  return 0.5 - 0.5 * Math.cos(phase);
}

/** Phase for a tide level, keeping the current direction (rising or falling). */
export function phaseForTide(tide: number, rising: boolean): number {
  const p = Math.acos(Math.min(1, Math.max(-1, 1 - 2 * tide)));
  return rising ? p : Math.PI * 2 - p;
}

export function tideName(tide: number, rising: boolean): string {
  const state = tide < 0.18 ? 'Low tide' : tide > 0.82 ? 'High tide' : rising ? 'Rising tide' : 'Falling tide';
  return state;
}
