/**
 * Sea state shared by the GPU (surface, foam, caustics) and the CPU (overtopping, sound, camera).
 * Gerstner swell arriving from the west (-z), shoaling over the shelf, plus a short wind sea.
 * The GLSL constants are generated from these tables so both sides stay identical.
 */

export type Wave = { dirX: number; dirZ: number; length: number; amp: number; steep: number; phase: number; speed: number };

const G = 9.81;
/** Reference depth for the phase speed of long waves near the coast. */
const SHALLOW_REF = 3.5;

function swell(angleDeg: number, length: number, amp: number, steep: number, phase: number): Wave {
  const a = (angleDeg * Math.PI) / 180;
  return { dirX: Math.sin(a), dirZ: Math.cos(a), length, amp, steep, phase, speed: Math.sqrt(G * SHALLOW_REF) * 0.92 };
}

function wind(angleDeg: number, length: number, amp: number, steep: number, phase: number): Wave {
  const a = (angleDeg * Math.PI) / 180;
  return { dirX: Math.sin(a), dirZ: Math.cos(a), length, amp, steep, phase, speed: Math.sqrt((G * length) / (2 * Math.PI)) };
}

/**
 * Two close swell trains beat into sets of larger waves every minute or so; a third crosses at an
 * angle. The wind sea adds chop. Direction 0 deg = travelling toward +z (onto the shore).
 */
export const SEA_WAVES: Wave[] = [
  swell(4, 62, 0.2, 0.55, 0.0),
  swell(-3, 69, 0.17, 0.5, 1.7),
  swell(18, 47, 0.08, 0.45, 4.1),
  wind(-35, 9.5, 0.035, 0.6, 0.6),
  wind(28, 6.3, 0.026, 0.6, 2.9),
  wind(-8, 4.1, 0.017, 0.55, 5.2),
  wind(55, 2.9, 0.011, 0.5, 1.1),
];

export const SEA_WAVE_COUNT = SEA_WAVES.length;

/** Shoaling and sheltering factor for wave height at a point. */
export function waveFactor(depth: number, shelter: number): number {
  // Green's law growth over the shelf edge, gone a few metres into the rock.
  const grow = Math.min(1.7, Math.pow(4 / Math.max(depth, 0.6), 0.25));
  const reach = 1 - smoothstep(0.15, 1, shelter);
  return grow * reach;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Vertical displacement of the sea at (x, z) and time t, before shoaling. */
export function swellHeight(x: number, z: number, t: number): number {
  let h = 0;
  for (const w of SEA_WAVES) {
    const k = (2 * Math.PI) / w.length;
    h += w.amp * Math.sin(k * (w.dirX * x + w.dirZ * z) - k * w.speed * t + w.phase);
  }
  return h;
}

/** The steep front lifts into a short lip only as the swell shoals against the shelf. */
export function breakingWaveHeight(x: number, z: number, t: number, factor: number): number {
  let h = 0;
  const shoal = smoothstep(1.15, 1.65, factor);
  for (const w of SEA_WAVES) {
    const k = (2 * Math.PI) / w.length;
    const th = k * (w.dirX * x + w.dirZ * z) - k * w.speed * t + w.phase;
    const s = Math.sin(th), c = Math.cos(th);
    const lip = w.length > 20 ? 0.32 * shoal * Math.pow(Math.max(s, 0), 4) * smoothstep(0, 0.7, -c) : 0;
    h += w.amp * factor * (s + lip);
  }
  return h;
}

/** GLSL constants matching SEA_WAVES: vec4(dirX, dirZ, k, omega) and vec4(amp, steep, phase, 0). */
export function seaWavesGlsl(): string {
  const a = SEA_WAVES.map(w => {
    const k = (2 * Math.PI) / w.length;
    return `vec4(${f(w.dirX)}, ${f(w.dirZ)}, ${f(k)}, ${f(k * w.speed)})`;
  });
  const b = SEA_WAVES.map(w => `vec4(${f(w.amp)}, ${f(w.steep)}, ${f(w.phase)}, 0.0)`);
  return `#define TP_SEA_WAVES ${SEA_WAVES.length}
const vec4 tpWaveA[${SEA_WAVES.length}] = vec4[](${a.join(', ')});
const vec4 tpWaveB[${SEA_WAVES.length}] = vec4[](${b.join(', ')});
`;
}

function f(v: number): string {
  const s = v.toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
}
