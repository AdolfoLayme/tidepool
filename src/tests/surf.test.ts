import { describe, expect, it } from 'vitest';
import { makeSurfGrid, stepSurfGrid, totalWater, decayFoam } from '../water/surfModel.ts';
import { buildSurfBed } from '../water/surfBed.ts';
import { readParams } from '../app.ts';

describe('shore flow reference', () => {
  it('keeps the analytic surf selectable as a rollback path', () => {
    expect(readParams('?surf=0').surf).toBe(false);
    expect(readParams('?surf=1').surf).toBe(true);
  });
  it('includes separate boulders while leaving a channel open', () => {
    const bed = buildSurfBed({ minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, [40, 40], () => -0.5, [
      { x: -0.8, z: 0, y: -0.2, s: 0.55 },
      { x: 0.9, z: 0, y: -0.2, s: 0.8 },
    ]);
    const at = (x: number, z: number) => bed[(Math.floor((z + 2) * 10)) * 40 + Math.floor((x + 2) * 10)];
    expect(at(-0.8, 0)).toBeGreaterThan(0);
    expect(at(0.9, 0)).toBeGreaterThan(at(-0.8, 0));
    expect(at(0, 0)).toBeCloseTo(-0.5, 1);
  });
  it('conserves water in a closed basin and never makes depth negative', () => {
    const g = makeSurfGrid(12, 8, 0.25);
    g.depth[3 * 12 + 4] = 0.7;
    const before = totalWater(g);
    for (let i = 0; i < 120; i++) stepSurfGrid(g, 0.018);
    expect(totalWater(g)).toBeCloseTo(before, 5);
    expect(Math.min(...g.depth)).toBeGreaterThanOrEqual(0);
  });

  it('stops and reflects a wave at a high wall', () => {
    const g = makeSurfGrid(18, 5, 0.2);
    for (let y = 0; y < 5; y++) {
      g.bed[y * 18 + 9] = 3;
      for (let x = 1; x < 6; x++) g.depth[y * 18 + x] = 0.55;
    }
    for (let i = 0; i < 180; i++) stepSurfGrid(g, 0.012);
    const left = g.depth[2 * 18 + 7];
    const right = g.depth[2 * 18 + 11];
    expect(left).toBeGreaterThan(0.05);
    expect(right).toBeLessThan(0.001);
  });

  it('leaves a lower wave behind a block and routes water around it', () => {
    const g = makeSurfGrid(22, 11, 0.2);
    for (let y = 4; y <= 6; y++) for (let x = 9; x <= 11; x++) g.bed[y * 22 + x] = 2;
    for (let y = 0; y < 11; y++) for (let x = 0; x < 6; x++) g.depth[y * 22 + x] = 0.6;
    for (let i = 0; i < 150; i++) stepSurfGrid(g, 0.012);
    expect(g.depth[5 * 22 + 8]).toBeGreaterThan(g.depth[5 * 22 + 13]);
    expect(g.depth[2 * 22 + 13]).toBeGreaterThan(g.depth[5 * 22 + 13]);
  });

  it('wets a dry shelf then drains when the source recedes', () => {
    const g = makeSurfGrid(14, 3, 0.2);
    for (let y = 0; y < 3; y++) for (let x = 5; x < 14; x++) g.bed[y * 14 + x] = 0.08;
    for (let y = 0; y < 3; y++) g.depth[y * 14 + 2] = 0.7;
    for (let i = 0; i < 70; i++) stepSurfGrid(g, 0.012);
    const wet = g.depth[1 * 14 + 6];
    expect(wet).toBeGreaterThan(0.005);
    for (let y = 0; y < 3; y++) g.bed[y * 14 + 6] = 0.25;
    for (let i = 0; i < 150; i++) stepSurfGrid(g, 0.012);
    expect(g.depth[1 * 14 + 6]).toBeLessThan(wet);
  });

  it('foam fades away without a source', () => {
    expect(decayFoam(1, 1.5)).toBeGreaterThan(0);
    expect(decayFoam(1, 1.5)).toBeLessThan(1);
    expect(decayFoam(0.5, 3)).toBeLessThan(decayFoam(0.5, 1));
  });
});
