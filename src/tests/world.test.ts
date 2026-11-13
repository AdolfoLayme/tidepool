import { describe, expect, it } from 'vitest';
import { poolRadius, sampleTerrain, gullyFrame, jointExpression } from '../world/field.ts';
import { gradedAxis, priorityFlood, sampleGrid } from '../world/grid.ts';
import { computeTerrain } from '../world/terrainMesh.ts';
import { computeShoreMaps } from '../world/shoreMaps.ts';
import { LAYOUT } from '../world/layout.ts';
import { PROFILES } from '../core/quality.ts';
import { swellHeight, breakingWaveHeight, waveFactor } from '../water/waves.ts';

describe('the shore', () => {
  it('interrupts the column joints with massive flow and leaves the pool floor unjointed', () => {
    const floor = jointExpression(0, 0, 0.2);
    expect(floor).toBeLessThan(0.08);
    const shelf = Array.from({ length: 121 }, (_, i) => jointExpression(-8 + (i % 11) * 1.6, 3 + Math.floor(i / 11) * 1.2, 2));
    expect(Math.min(...shelf)).toBeLessThan(0.2);
    expect(Math.max(...shelf)).toBeGreaterThan(0.8);
    expect(shelf.filter(value => value > 0.5).length / shelf.length).toBeLessThan(0.3);
  });
  it('holds a pool deeper than 30 cm below its spill level', () => {
    expect(sampleTerrain(LAYOUT.pool.cx, LAYOUT.pool.cz)).toBeLessThan(-0.3);
    expect(poolRadius(LAYOUT.pool.cx, LAYOUT.pool.cz)).toBeLessThan(0.2);
  });
  it('steps down into the sea toward -z', () => {
    expect(sampleTerrain(0, -15)).toBeLessThan(LAYOUT.tide.low);
    expect(sampleTerrain(0, 3)).toBeGreaterThan(0);
  });
  it('drains the pool through a gully that falls toward the sea', () => {
    const s = LAYOUT.spill;
    const len = Math.hypot(s.dirX, s.dirZ);
    const at = (d: number) => sampleTerrain(s.x + (s.dirX / len) * d, s.z + (s.dirZ / len) * d);
    expect(at(s.length)).toBeLessThan(at(1));
    expect(Math.abs(gullyFrame(s.x, s.z).along)).toBeLessThan(1e-9);
  });
  it('is finite everywhere it is generated', () => {
    const E = LAYOUT.extent;
    for (let i = 0; i < 400; i++) {
      const x = E.minX + ((i * 0.618) % 1) * (E.maxX - E.minX), z = E.minZ + ((i * 0.414) % 1) * (E.maxZ - E.minZ);
      expect(Number.isFinite(sampleTerrain(x, z))).toBe(true);
    }
  });
});

describe('grids and flood fill', () => {
  it('graded axes cover the extent and only grow outward', () => {
    const a = gradedAxis(-10, 10, -2, 2, 0.05, 0.8);
    expect(a[0]).toBeCloseTo(-10);
    expect(a[a.length - 1]).toBeCloseTo(10);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThan(a[i - 1]);
  });
  it('fills a bowl exactly to its rim and samples bilinearly', () => {
    const xs = Float64Array.from({ length: 21 }, (_, i) => i), zs = Float64Array.from({ length: 21 }, (_, i) => i);
    const h = new Float32Array(441);
    for (let j = 0; j < 21; j++) for (let i = 0; i < 21; i++) h[j * 21 + i] = Math.hypot(i - 10, j - 10) < 6 ? -1 : 0.5;
    h[10 * 21 + 16] = 0.2; h[10 * 21 + 17] = 0.2; h[10 * 21 + 18] = 0.2; h[10 * 21 + 19] = 0.2; h[10 * 21 + 20] = 0.2;
    const f = priorityFlood({ xs, zs, h });
    expect(f[10 * 21 + 10]).toBeCloseTo(0.2, 6);
    expect(sampleGrid({ xs, zs, h }, 2.5, 2.5)).toBeCloseTo(0.5, 6);
  });
});

describe('terrain build', () => {
  it('stays within each tier\'s triangle budget and spills near datum', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const q = PROFILES[tier];
      const t = computeTerrain({ fine: q.terrainFine, coarse: q.terrainCoarse, aoDirections: 4 });
      expect(t.index.length / 3).toBeLessThanOrEqual(q.budgets.terrain);
      expect(t.spillLevel).toBeGreaterThan(-0.03);
      expect(t.spillLevel).toBeLessThan(0.06);
      for (let i = 0; i < t.rock.length; i += 4) {
        expect(t.rock[i]).toBeGreaterThanOrEqual(0);
        expect(t.rock[i]).toBeLessThanOrEqual(1);
      }
    }
  }, 120000);
  it('masks the water the pool holds, not the gully that drains it', () => {
    const maps = computeShoreMaps([256, 181], [96, 74], (x, z) => sampleTerrain(x, z));
    const P = maps.poolSize[0];
    const at = (x: number, z: number) => {
      const i = Math.floor(((x + 3.4) / 6.8) * P), j = Math.floor(((z + 2.6) / 4.8) * maps.poolSize[1]);
      return maps.poolData[(j * P + i) * 4 + 1];
    };
    expect(at(LAYOUT.pool.cx, LAYOUT.pool.cz)).toBeCloseTo(1, 3);
    const s = LAYOUT.spill;
    expect(at(s.x + s.dirX * 0.9, s.z + s.dirZ * 0.9)).toBeLessThan(0.5);
  }, 60000);
});

describe('sea', () => {
  it('lifts the leading lip of a shoaling crest without changing deep-water swell', () => {
    const samples = Array.from({ length: 120 }, (_, i) => i * 0.17);
    expect(samples.every(t => Math.abs(breakingWaveHeight(0, -8, t, 1) - swellHeight(0, -8, t)) < 1e-8)).toBe(true);
    expect(samples.some(t => breakingWaveHeight(0, -8, t, 1.7) > swellHeight(0, -8, t) * 1.7 + 0.02)).toBe(true);
  });
  it('is deterministic in time and space', () => {
    expect(swellHeight(3, -9, 12.5)).toBe(swellHeight(3, -9, 12.5));
    expect(swellHeight(3, -9, 12.5)).not.toBe(swellHeight(3, -9, 13.5));
  });
  it('dies out a few metres into the rock and grows over the shelf edge', () => {
    expect(waveFactor(-0.5, 1)).toBe(0);
    expect(waveFactor(1, 0)).toBeGreaterThan(waveFactor(8, 0));
  });
});
