import { App, readParams, CAMERA_PRESETS } from './app.ts';
import { clonePose } from './ui/cameraRig.ts';
import type { Tier } from './core/quality.ts';
import { Experience } from './ui/experience.ts';
import { G } from './core/globals.ts';
import './style.css';

declare global {
  interface Window {
    __tidepool?: {
      ready: boolean;
      app: App;
      step: (frames: number, dt?: number) => void;
      shot: (frames?: number, dt?: number) => string;
      setHour: (h: number) => void;
      setTide: (t: number) => void;
      setTier: (t: Tier) => void;
      tap: (x: number, z: number, strength?: number) => void;
      look: (which: number | string, azimuth?: number, elevation?: number) => string;
      camera: (name: string) => void;
      stats: () => Record<string, unknown>;
      globals: typeof G;
      error?: string;
    };
  }
}

function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  const host = document.getElementById('scene')!;
  if (!webgl2Available()) {
    document.getElementById('fallback')!.hidden = false;
    return;
  }
  const app = new App(host, readParams(location.search));
  const api = {
    ready: false,
    app,
    step(frames: number, dt = 1 / 60) { for (let i = 0; i < frames; i++) app.tick(dt); },
    shot(frames = 1, dt = 1 / 60) { api.step(frames, dt); return app.renderer.domElement.toDataURL('image/png'); },
    setHour(h: number) { app.hour = h; },
    setTide(t: number) { app.tide = t; },
    setTier(t: Tier) { app.setTier(t); },
    tap(x: number, z: number, strength = 1) { app.water.disturb(x, z, strength); },
    look(which: number | string, azimuth = 0.3, elevation = 0.85) {
      const list = app.life.clickables;
      const c = typeof which === 'number' ? list[which % list.length] : (list.find(k => k.label.toLowerCase().includes(which.toLowerCase())) ?? list[0]);
      app.rig.snapTo({ target: c.focus(), azimuth, elevation, distance: c.frameDistance, fov: 32 });
      G.uLensClear.value = Math.max(0.32, c.frameDistance * 0.9);
      return c.label;
    },
    camera(name: string) { const p = CAMERA_PRESETS[name]; if (p) app.rig.snapTo(clonePose(p)); G.uLensClear.value = 0.32; },
    stats: () => app.stats(),
    globals: G,
  };
  window.__tidepool = api;
  await app.init();
  const experience = new Experience(app);
  // Captures and tests drive time themselves; the tide only runs on its own for visitors.
  experience.tideRuns = !app.params.manual;
  app.onFrame.push(dt => experience.update(dt));
  (api as unknown as { experience: Experience }).experience = experience;
  api.ready = true;
  document.body.classList.add('is-ready');
  window.setTimeout(() => document.body.classList.add('is-settled'), 9000);
}

start().catch(err => {
  console.error(err);
  if (window.__tidepool) window.__tidepool.error = String(err);
  const fb = document.getElementById('fallback');
  if (fb) {
    fb.hidden = false;
    fb.querySelector('p')!.textContent = 'Something went wrong while building the scene. Try reloading, or a browser with hardware graphics acceleration.';
  }
});
