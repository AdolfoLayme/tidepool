/**
 * Three automatic quality tiers. A tier is chosen from the GPU string and the device class, then
 * a frame-time governor can step it down (and once, up) at run time.
 *
 * Budgets are triangle counts per subsystem, so the cost of every part of the scene is explicit.
 */
export type Tier = 'low' | 'medium' | 'high';
export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];

export type QualityProfile = {
  tier: Tier;
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number;
  /** MSAA samples on the main scene target. */
  msaa: number;
  shadowMapSize: number;
  /** Vertex spacing of the rock shelf in the detail region (m). */
  terrainFine: number;
  terrainCoarse: number;
  aoDirections: number;
  /** Icosahedron subdivision of boulders. */
  boulderDetail: number;
  /** 0 = basic rock shading, 1 = full, 2 = full with extra micro-detail layers. */
  shaderDetail: number;
  /** Planar reflection resolution scale (0 = environment map only). */
  reflectionScale: number;
  /** Ripple simulation texels across the pool. */
  rippleSize: [number, number];
  causticSize: [number, number];
  envSize: number;
  bloom: boolean;
  /** Depth of field during close-ups. */
  dof: boolean;
  /** Fraction of the full life population. */
  lifeDensity: number;
  /** Ocean grid rings x segments. */
  oceanDetail: [number, number];
  /** Redraw the sun's shadow map every N frames (sooner if the light moves). */
  shadowEvery: number;
  /**
   * Triangles per subsystem in one copy of the scene (shadow and reflection passes draw parts of
   * it again). `scripts/perf.mjs` reports each against its budget. Medium is sized for an
   * integrated GPU such as the Radeon 780M; high carries the finer boulders, cobbles and water
   * grid tuned for discrete GPUs.
   */
  budgets: Record<string, number>;
};

export const PROFILES: Record<Tier, QualityProfile> = {
  low: {
    tier: 'low', maxPixelRatio: 1, msaa: 0, shadowMapSize: 1024,
    terrainFine: 0.07, terrainCoarse: 1.6, aoDirections: 8, boulderDetail: 9,
    shaderDetail: 0, reflectionScale: 0, rippleSize: [128, 96], causticSize: [256, 192], envSize: 64,
    bloom: false, dof: false, lifeDensity: 0.4, oceanDetail: [48, 96], shadowEvery: 6,
    budgets: { terrain: 110_000, boulders: 32_000, gravel: 32_000, life: 220_000, water: 50_000 },
  },
  medium: {
    tier: 'medium', maxPixelRatio: 1.25, msaa: 4, shadowMapSize: 2048,
    terrainFine: 0.045, terrainCoarse: 1.2, aoDirections: 12, boulderDetail: 16,
    shaderDetail: 1, reflectionScale: 0.4, rippleSize: [192, 144], causticSize: [384, 288], envSize: 128,
    bloom: true, dof: true, lifeDensity: 0.7, oceanDetail: [80, 160], shadowEvery: 3,
    budgets: { terrain: 260_000, boulders: 110_000, gravel: 80_000, life: 520_000, water: 110_000 },
  },
  high: {
    tier: 'high', maxPixelRatio: 2, msaa: 4, shadowMapSize: 4096,
    terrainFine: 0.03, terrainCoarse: 0.9, aoDirections: 16, boulderDetail: 26,
    shaderDetail: 2, reflectionScale: 0.6, rippleSize: [256, 192], causticSize: [512, 384], envSize: 256,
    bloom: true, dof: true, lifeDensity: 1, oceanDetail: [110, 220], shadowEvery: 2,
    budgets: { terrain: 560_000, boulders: 340_000, gravel: 350_000, life: 1_050_000, water: 190_000 },
  },
};

export type DeviceHints = {
  renderer: string;
  userAgent: string;
  /** Device pixels across the larger screen side. */
  screenPixels: number;
  coarsePointer: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
};

/** Pure tier choice from what the browser tells us. */
export function detectTier(h: DeviceHints): { tier: Tier; reason: string } {
  const r = h.renderer.toLowerCase();
  const ua = h.userAgent.toLowerCase();
  const mobile = /android|iphone|ipad|ipod|mobile/.test(ua) || (h.coarsePointer && h.screenPixels < 2200);
  if (/swiftshader|llvmpipe|software|basic render|softpipe/.test(r)) return { tier: 'low', reason: 'software renderer' };
  if (mobile) {
    if (/apple gpu|apple m\d/.test(r) && (h.deviceMemory ?? 4) >= 6) return { tier: 'medium', reason: 'high-end mobile' };
    if (/adreno \(tm\) (7[3-9]\d|8\d\d)|mali-g7[1-9]|mali-g[7-9]\d\d|immortalis/.test(r)) return { tier: 'medium', reason: 'high-end mobile' };
    return { tier: 'low', reason: 'mobile' };
  }
  if (/rtx|gtx 1[06-9]\d0|gtx 16\d0|rx [5-9]\d{3}|radeon pro|apple m\d (pro|max|ultra)|arc a[57]\d0|titan|quadro rtx/.test(r)) {
    return { tier: 'high', reason: 'discrete GPU' };
  }
  if ((h.deviceMemory !== undefined && h.deviceMemory <= 2) || (h.hardwareConcurrency !== undefined && h.hardwareConcurrency <= 2)) {
    return { tier: 'low', reason: 'low-memory device' };
  }
  // Integrated GPUs, including the Radeon 780M ("AMD Radeon(TM) Graphics"), Iris Xe and base Apple M chips.
  return { tier: 'medium', reason: 'integrated or unknown GPU' };
}

export function stepTier(tier: Tier, delta: -1 | 1): Tier {
  const i = Math.max(0, Math.min(TIERS.length - 1, TIERS.indexOf(tier) + delta));
  return TIERS[i];
}

/**
 * Frame-time governor. Feed it frame durations; it answers whether to step down or try a step up.
 * It first trades resolution inside a tier (dynamic resolution), then changes tier.
 */
export class Governor {
  private samples: number[] = [];
  private since = 0;
  private triedUp = false;
  resolutionScale = 1;

  private readonly targetMs: number;
  private readonly windowMs: number;

  constructor(targetMs = 1000 / 55, windowMs = 2500) {
    this.targetMs = targetMs;
    this.windowMs = windowMs;
  }

  reset(): void { this.samples.length = 0; this.since = 0; }

  /** Returns 'down', 'up' or null. */
  push(frameMs: number, tier: Tier, allowUp: boolean): 'down' | 'up' | null {
    if (frameMs > 250) return null; // tab switch or debugger pause
    this.samples.push(frameMs);
    this.since += frameMs;
    if (this.since < this.windowMs) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    this.reset();
    if (median > this.targetMs * 1.18 || p90 > this.targetMs * 1.9) {
      if (this.resolutionScale > 0.76) { this.resolutionScale = Math.max(0.75, this.resolutionScale - 0.125); return null; }
      if (tier !== 'low') { this.resolutionScale = 1; return 'down'; }
      return null;
    }
    if (median < this.targetMs * 0.75 && this.resolutionScale < 1) { this.resolutionScale = Math.min(1, this.resolutionScale + 0.125); return null; }
    if (allowUp && !this.triedUp && median < this.targetMs * 0.52 && tier !== 'high') { this.triedUp = true; return 'up'; }
    return null;
  }
}
