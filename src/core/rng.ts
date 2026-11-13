/**
 * Deterministic random numbers.
 *
 * Every subsystem draws from its own named stream (`rng(seed, 'life:barnacles')`), so adding
 * or removing draws in one subsystem never reshuffles another. Same seed, same pool.
 */

/** FNV-1a over UTF-16 code units, folded to 32 bits. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32-bit integer mixer (lowbias32). */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export type Rng = {
  /** Uniform in [0, 1). */
  next: () => number;
  /** Uniform in [min, max). */
  range: (min: number, max: number) => number;
  /** Integer in [min, max]. */
  int: (min: number, max: number) => number;
  /** True with probability p. */
  chance: (p: number) => boolean;
  /** Standard normal (Box-Muller). */
  normal: () => number;
  /** Uniform element. */
  pick: <T>(items: readonly T[]) => T;
  /** Signed value in [-1, 1). */
  signed: () => number;
};

/** mulberry32: small, fast, good enough statistical quality for placement work. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: p => next() < p,
    signed: () => next() * 2 - 1,
    normal: () => {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u <= 1e-12) u = next();
      v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    pick: items => items[Math.floor(next() * items.length)],
  };
}

/** Named, independent stream derived from the world seed. */
export function rng(seed: number, stream: string): Rng {
  return createRng(mix32(hashString(stream) ^ mix32(seed)));
}
