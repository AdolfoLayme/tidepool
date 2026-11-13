/// <reference lib="webworker" />
import { computeTerrain, type TerrainBuildOptions } from './terrainMesh.ts';
import { computeShoreMaps } from './shoreMaps.ts';
import { layoutRocks, occludersFrom } from './rocks.ts';
import { sampleGrid } from './grid.ts';

export type WorldJob = { seed: number; terrain: TerrainBuildOptions; density: number; poolRes: [number, number]; shoreRes: [number, number] };

/** Builds the analytic shore off the main thread so the page stays responsive while it loads. */
export function runWorldJob(job: WorldJob) {
  const layout = layoutRocks(job.seed, job.density);
  const terrain = computeTerrain(job.terrain, occludersFrom(layout));
  const grid = { xs: terrain.xs, zs: terrain.zs, h: terrain.heights };
  const shore = computeShoreMaps(job.poolRes, job.shoreRes, (x, z) => sampleGrid(grid, x, z));
  return { layout, terrain, shore };
}

export type WorldResult = ReturnType<typeof runWorldJob>;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
if (typeof scope.postMessage === 'function' && typeof (globalThis as { document?: unknown }).document === 'undefined') {
  scope.onmessage = (e: MessageEvent<WorldJob>) => {
    const r = runWorldJob(e.data);
    const t = r.terrain, s = r.shore;
    scope.postMessage(r, [t.xs.buffer, t.zs.buffer, t.heights.buffer, t.filled.buffer, t.positions.buffer, t.rock.buffer, t.index.buffer, s.poolData.buffer, s.shoreData.buffer]);
  };
}
