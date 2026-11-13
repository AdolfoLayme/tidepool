import { describe, expect, it } from 'vitest';
import { createRng, rng } from '../core/rng.ts';
import { createVoronoiResult, fbm, hash2u, vnoise, voronoi } from '../core/noise.ts';
import { detectTier, Governor, PROFILES, stepTier } from '../core/quality.ts';
import { hourFor, lightName, phaseForTide, PoolLevel, sliderForHour, tideAtPhase, WetLine } from '../core/tide.ts';
import { sunDirection } from '../env/sun.ts';

describe('random streams', () => {
  it('repeat for the same seed and stream', () => {
    const a = rng(7, 'life:barnacles'), b = rng(7, 'life:barnacles');
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
  it('are independent across streams and seeds', () => {
    expect(rng(7, 'a').next()).not.toBe(rng(7, 'b').next());
    expect(rng(7, 'a').next()).not.toBe(rng(8, 'a').next());
  });
  it('stay in range', () => {
    const r = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.range(-2, 3);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThan(3);
      const k = r.int(1, 4);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(k).toBeLessThanOrEqual(4);
    }
  });
});

describe('integer-hash noise (mirrored in GLSL)', () => {
  it('keeps its exact values, so CPU placement and GPU patterns agree', () => {
    expect(hash2u(0, 0, 0)).toBe(1885762141);
    expect(hash2u(-5, 7, 101)).toBe(2972643455);
    expect(hash2u(123, -456, 503)).toBe(2327218436);
    expect(vnoise(1.3, 2.7, 5)).toBeCloseTo(0.304355, 5);
  });
  it('value noise and fbm stay in [0, 1)', () => {
    for (let i = 0; i < 2000; i++) {
      const x = (i * 0.137) % 50 - 25, y = (i * 0.311) % 40 - 20;
      const v = vnoise(x, y), f = fbm(x, y, 4, 3);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1);
      expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1);
    }
  });
  it('voronoi border distance is never negative and never exceeds the feature distance', () => {
    const out = createVoronoiResult();
    for (let i = 0; i < 2000; i++) {
      voronoi((i * 0.173) % 30, (i * 0.419) % 30, 101, 0.84, out);
      expect(out.edge).toBeGreaterThanOrEqual(-1e-9);
      expect(out.edge).toBeLessThanOrEqual(out.f1 + 1e-6 + 2);
    }
  });
});

describe('quality tiers', () => {
  const hints = (renderer: string, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', extra = {}) => ({ renderer, userAgent: ua, screenPixels: 1920, coarsePointer: false, ...extra });
  it('puts the Radeon 780M (the target machine) on medium', () => {
    expect(detectTier(hints('ANGLE (AMD, AMD Radeon(TM) 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)')).tier).toBe('medium');
    expect(detectTier(hints('ANGLE (AMD, AMD Radeon(TM) Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)')).tier).toBe('medium');
  });
  it('recognises discrete GPUs, software rendering and phones', () => {
    expect(detectTier(hints('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).tier).toBe('high');
    expect(detectTier(hints('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).tier).toBe('low');
    expect(detectTier(hints('Apple GPU', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', { coarsePointer: true, screenPixels: 2532 })).tier).toBe('low');
    expect(detectTier(hints('Adreno (TM) 740', 'Mozilla/5.0 (Linux; Android 14; Pixel)', { coarsePointer: true })).tier).toBe('medium');
  });
  it('scales every cost down from high to low', () => {
    const [l, m, h] = [PROFILES.low, PROFILES.medium, PROFILES.high];
    expect(l.maxPixelRatio).toBeLessThan(h.maxPixelRatio);
    expect(l.shadowMapSize).toBeLessThan(m.shadowMapSize);
    expect(m.shadowMapSize).toBeLessThan(h.shadowMapSize);
    expect(l.terrainFine).toBeGreaterThan(m.terrainFine);
    expect(m.terrainFine).toBeGreaterThan(h.terrainFine);
    expect(l.lifeDensity).toBeLessThan(m.lifeDensity);
    for (const k of Object.keys(h.budgets)) expect(l.budgets[k]).toBeLessThan(h.budgets[k]);
  });
  it('steps tiers within bounds', () => {
    expect(stepTier('low', -1)).toBe('low');
    expect(stepTier('medium', -1)).toBe('low');
    expect(stepTier('high', 1)).toBe('high');
  });
  it('governor first lowers resolution, then the tier, and tries one step up when idle', () => {
    const g = new Governor(1000 / 55, 1000);
    let d: string | null = null;
    for (let i = 0; i < 40; i++) d = g.push(40, 'medium', true) ?? d;
    expect(g.resolutionScale).toBeLessThan(1);
    d = null;
    for (let i = 0; i < 200 && d === null; i++) d = g.push(40, 'medium', true);
    expect(d).toBe('down');
    const g2 = new Governor(1000 / 55, 1000);
    let up: string | null = null;
    for (let i = 0; i < 200 && up === null; i++) up = g2.push(6, 'medium', true);
    expect(up).toBe('up');
  });
});

describe('time and tide', () => {
  it('maps the light slider through its labelled anchors and back', () => {
    expect(hourFor(0.5)).toBeCloseTo(12.9, 5);
    for (const u of [0, 0.1, 0.25, 0.4, 0.5, 0.66, 0.75, 0.9, 1]) expect(sliderForHour(hourFor(u))).toBeCloseTo(u, 6);
    expect(lightName(hourFor(0))).toBe('Night');
    expect(lightName(hourFor(0.25))).toBe('Dawn');
    expect(lightName(hourFor(0.5))).toBe('Midday');
    expect(lightName(hourFor(0.75))).toBe('Sunset');
  });
  it('keeps the tide direction when the visitor sets a level', () => {
    for (const t of [0.1, 0.4, 0.9]) {
      const rising = phaseForTide(t, true), falling = phaseForTide(t, false);
      expect(tideAtPhase(rising)).toBeCloseTo(t, 6);
      expect(tideAtPhase(falling)).toBeCloseTo(t, 6);
      expect(Math.sin(rising)).toBeGreaterThan(0);
      expect(Math.sin(falling)).toBeLessThan(0);
    }
  });
  it('drains the pool while the sea is low and refills it when waves pour in', () => {
    const p = new PoolLevel(0.01, 0.16);
    for (let i = 0; i < 300; i++) p.update(1, -1.1, 0, -1.1);
    expect(p.level).toBeCloseTo(0.01 - 0.16, 3);
    p.update(0.1, -0.1, 0.05, -1.1);
    expect(p.level).toBeGreaterThan(0.01 - 0.16 + 0.04);
    for (let i = 0; i < 200; i++) p.update(0.1, 0.2, 0, -1.1);
    expect(p.level).toBeCloseTo(0.2, 2);
  });
  it('dries rock from the top down after the water leaves', () => {
    const w = new WetLine(0.3, 0.05);
    for (let i = 0; i < 10; i++) w.update(1, -0.5, 0.1);
    expect(w.level).toBeLessThan(0.3);
    expect(w.level).toBeGreaterThan(-0.4);
  });
  it('puts the sun where it belongs on the Oregon coast in early summer', () => {
    const noon = sunDirection(12);
    expect((Math.asin(noon[1]) * 180) / Math.PI).toBeCloseTo(90 - 44.6 + 18, 1);
    expect(noon[0]).toBeLessThan(0); // south is -x
    const rise = sunDirection(4.75), set = sunDirection(19.25);
    expect(Math.abs(rise[1])).toBeLessThan(0.03);
    expect(rise[2]).toBeGreaterThan(0); // east is +z
    expect(set[2]).toBeLessThan(0); // sets over the sea, toward -z
  });
});
