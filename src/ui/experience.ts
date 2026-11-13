import * as THREE from 'three';
import { animate } from 'animejs';
import type { App } from '../app.ts';
import type { Clickable } from '../life/life.ts';
import { ShoreAudio } from '../audio/shore.ts';
import { G } from '../core/globals.ts';
import { hourFor, lightName, phaseForTide, sliderForHour, tideAtPhase, tideName } from '../core/tide.ts';
import { clonePose, type CameraPose } from './cameraRig.ts';
import { shoreZ } from '../world/field.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Everything the visitor does: look around, touch the water, touch an animal for a close look,
 * change the light and the tide, turn the sound on. No menus; one small control.
 */
export class Experience {
  private readonly app: App;
  readonly audio = new ShoreAudio();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private pointers = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private pinch0 = 0;
  private dragged = false;
  private macro: { target: Clickable; home: CameraPose; settled: boolean } | null = null;
  private interactions = 0;
  private lastText = '';
  /** Tide cycle phase (0 low, pi high) and whether it runs on its own. */
  tidePhase: number;
  tideRuns = true;
  /** Real minutes per tidal cycle (accelerated). */
  tidePeriod = 360;
  private tideDragging = false;
  private crestPrev = new Map<number, number>();
  private crestRise = new Map<number, boolean>();

  constructor(app: App) {
    this.app = app;
    this.tidePhase = phaseForTide(app.tide, false);
    // Animals live on several render layers; touches must reach all of them.
    this.raycaster.layers.enableAll();
    this.bindPointer();
    this.bindKeys();
    this.bindHud();
  }

  // --- Input --------------------------------------------------------------------------------

  private bindPointer(): void {
    const el = this.app.renderer.domElement;
    const host = el.parentElement!;
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
      if (this.pointers.size === 2) this.pinch0 = this.pinchDistance();
      this.dragged = false;
      this.app.rig.stopInertia();
    });
    el.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { this.hover(e.clientX, e.clientY); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > 6) this.dragged = true;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinch0 > 0 && d > 0) this.app.rig.zoom(this.pinch0 / d);
        this.pinch0 = d;
        return;
      }
      if (this.dragged) {
        this.app.dragging = true;
        host.classList.add('dragging');
        this.app.rig.drag(dx, dy, el.clientHeight);
        this.noteInteraction();
      }
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch0 = 0;
      this.app.dragging = this.pointers.size > 0 && this.dragged;
      host.classList.remove('dragging');
      // Event timestamps, not handling time: a slow frame between down and up is still a tap.
      if (p && !this.dragged && e.type === 'pointerup' && e.timeStamp - p.t0 < 700) this.tap(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.app.rig.zoom(Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016));
      this.noteInteraction();
    }, { passive: false });
    el.addEventListener('dblclick', () => this.exitMacro());
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.app.camera);
    return this.raycaster;
  }

  private hover(x: number, y: number): void {
    const hit = this.app.life.pick(this.rayFrom(x, y));
    this.app.renderer.domElement.parentElement!.classList.toggle('pointing', !!hit);
  }

  /** Where a ray meets the still water of the pool, if it does. */
  private waterHit(ray: THREE.Ray): THREE.Vector3 | null {
    const level = G.uPoolLevel.value;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = (level - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    if (this.app.world.maps.poolMaskAt(p.x, p.z) < 0.5) return null;
    // Rock in front of the water hides it.
    if (this.app.world.terrain.heightAt(p.x, p.z) > level + 0.005) return null;
    return p;
  }

  private tap(x: number, y: number): void {
    this.noteInteraction();
    const ray = this.rayFrom(x, y);
    const animal = this.app.life.pick(ray);
    const water = this.waterHit(ray.ray);
    // The water is clear: an animal under the tap point is what the visitor meant.
    if (animal) {
      animal.touch(this.app.time);
      if (water) this.touchWater(water, 0.6);
      this.enterMacro(animal);
      return;
    }
    if (water) { this.touchWater(water, 1); return; }
    if (this.macro) this.exitMacro();
  }

  private touchWater(p: THREE.Vector3, strength: number): void {
    this.app.water.disturb(p.x, p.z, strength);
    this.app.life.startle(p.x, p.z);
    this.audio.plip(this.panFor(p), strength);
  }

  private panFor(p: THREE.Vector3): number {
    const cam = this.app.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const to = p.clone().sub(cam.position).normalize();
    return to.dot(right);
  }

  private bindKeys(): void {
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const hadPanel = !$('panel').hidden;
        this.closePanel();
        if (hadPanel) $('pill').focus({ preventScroll: true }); else this.exitMacro();
        return;
      }
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const r = this.app.rig;
      if (e.key === 'ArrowLeft') r.drag(-40, 0, 600);
      else if (e.key === 'ArrowRight') r.drag(40, 0, 600);
      else if (e.key === 'ArrowUp') r.drag(0, -30, 600);
      else if (e.key === 'ArrowDown') r.drag(0, 30, 600);
      else if (e.key === '+' || e.key === '=') r.zoom(0.88);
      else if (e.key === '-' || e.key === '_') r.zoom(1.14);
      else return;
      this.noteInteraction();
    });
  }

  private noteInteraction(): void {
    this.interactions++;
    if (this.interactions === 2) $('hint').classList.add('gone');
    document.body.classList.add('is-settled');
  }

  // --- Close look at an animal --------------------------------------------------------------

  private enterMacro(c: Clickable): void {
    const rig = this.app.rig;
    const home = this.macro ? this.macro.home : clonePose(rig.pose);
    const focus = c.focus();
    // Light from behind the viewer, as a photographer would stand, without swinging too far.
    const sun = G.uSunDir.value;
    const sunAz = Math.atan2(sun.x, sun.z);
    const cur = rig.pose.azimuth;
    let delta = Math.atan2(Math.sin(sunAz - cur), Math.cos(sunAz - cur));
    delta = Math.max(-1.1, Math.min(1.1, delta * 0.7));
    const az = sun.y > 0.05 ? cur + delta : cur;
    rig.limits.azMin = -Math.PI * 2; rig.limits.azMax = Math.PI * 2;
    rig.limits.distMin = 0.12;
    // An underwater animal needs an underwater lens; staying above the water leaves
    // the camera much farther away than its framing distance.
    rig.groundAt = (x, z) => this.app.world.terrain.heightAt(x, z) + 0.04;
    this.macro = { target: c, home, settled: false };
    const d = this.reduceMotion ? 1 : 1700;
    animate(G.uLensClear, { value: Math.max(0.32, c.frameDistance * 0.9), duration: d, ease: 'inOut(2)' });
    rig.follow = 12;
    animate(rig.pose.target, { x: focus.x, y: focus.y, z: focus.z, duration: d, ease: 'inOut(3)' });
    animate(rig.pose, {
      distance: c.frameDistance, fov: 30, azimuth: az, elevation: 0.82, duration: d, ease: 'inOut(3)',
      onComplete: () => { if (this.macro) this.macro.settled = true; },
    });
    // At this distance a full-strength bokeh pass blurs the animal itself.
    animate(this.app.pipeline, { dofAmount: 0.25, duration: d * 1.1, ease: 'inOut(2)' });
    document.body.classList.add('is-macro');
    $('caption-name').textContent = c.label;
    $('caption-latin').textContent = c.species;
    const cap = $('caption');
    cap.hidden = false;
    requestAnimationFrame(() => cap.classList.add('shown'));
  }

  exitMacro(): void {
    if (!this.macro) return;
    const rig = this.app.rig;
    const home = this.macro.home;
    this.macro = null;
    const d = this.reduceMotion ? 1 : 1500;
    animate(G.uLensClear, { value: 0.32, duration: d * 0.6, ease: 'out(2)' });
    animate(rig.pose.target, { x: home.target.x, y: home.target.y, z: home.target.z, duration: d, ease: 'inOut(3)' });
    animate(rig.pose, {
      distance: home.distance, fov: home.fov, azimuth: home.azimuth, elevation: home.elevation, duration: d, ease: 'inOut(3)',
      onComplete: () => {
        rig.limits.azMin = -1.75; rig.limits.azMax = 1.75; rig.limits.distMin = 0.35;
        rig.follow = 7;
        rig.groundAt = (x, z) => Math.max(this.app.world.terrain.heightAt(x, z) + 0.08, this.app.water.levelAt(x, z) + 0.12);
      },
    });
    animate(this.app.pipeline, { dofAmount: 0, duration: d * 0.7, ease: 'out(2)' });
    document.body.classList.remove('is-macro');
    const cap = $('caption');
    cap.classList.remove('shown');
    window.setTimeout(() => { if (!this.macro) cap.hidden = true; }, 600);
  }

  // --- Control: light, tide, sound ----------------------------------------------------------

  private bindHud(): void {
    const pill = $<HTMLButtonElement>('pill');
    const panel = $('panel');
    const light = $<HTMLInputElement>('light');
    const tide = $<HTMLInputElement>('tide');
    const sound = $<HTMLButtonElement>('sound');
    pill.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      pill.setAttribute('aria-expanded', String(open));
      if (open) light.focus({ preventScroll: true });
    });
    document.addEventListener('pointerdown', e => {
      if (!panel.hidden && !$('dock').contains(e.target as Node)) this.closePanel();
    });
    light.value = String(Math.round(sliderForHour(this.app.hour) * 1000));
    light.addEventListener('input', () => { this.app.hour = hourFor(Number(light.value) / 1000); this.refreshText(true); });
    tide.value = String(Math.round(this.app.tide * 1000));
    tide.addEventListener('pointerdown', () => { this.tideDragging = true; });
    tide.addEventListener('input', () => {
      const v = Number(tide.value) / 1000;
      const rising = Math.sin(this.tidePhase) > 0;
      this.tidePhase = phaseForTide(v, rising);
      this.app.tide = v;
      this.refreshText(true);
    });
    const release = () => { this.tideDragging = false; };
    tide.addEventListener('pointerup', release);
    tide.addEventListener('change', release);
    if (!this.audio.available) sound.hidden = true;
    sound.addEventListener('click', async () => {
      const on = await this.audio.setEnabled(!this.audio.enabled);
      sound.setAttribute('aria-pressed', String(on));
      sound.setAttribute('aria-label', on ? 'Sound on. Turn off the sound of the shore' : 'Sound off. Turn on the sound of the shore');
    });
    $('caption-back').addEventListener('click', () => this.exitMacro());
    this.refreshText(true);
  }

  private closePanel(): void {
    const panel = $('panel');
    if (panel.hidden) return;
    panel.hidden = true;
    $('pill').setAttribute('aria-expanded', 'false');
  }

  private refreshText(force = false): void {
    const rising = Math.sin(this.tidePhase) > 0;
    const l = lightName(this.app.hour), t = tideName(this.app.tide, rising);
    const text = `${l} · ${t}`;
    if (!force && text === this.lastText) return;
    this.lastText = text;
    $('pill-text').textContent = text;
    $('light-label').textContent = `${l}, ${formatHour(this.app.hour)}`;
    $('tide-label').textContent = t;
    $<HTMLInputElement>('tide').setAttribute('aria-valuetext', `${t}, ${Math.round(this.app.tide * 100)} percent`);
    $<HTMLInputElement>('light').setAttribute('aria-valuetext', `${l}, ${formatHour(this.app.hour)}`);
  }

  // --- Per frame ----------------------------------------------------------------------------

  update(dt: number): void {
    const app = this.app;
    // The tide keeps moving unless the visitor is holding it.
    if (this.tideRuns && !this.tideDragging) {
      this.tidePhase = (this.tidePhase + (dt * Math.PI * 2) / this.tidePeriod) % (Math.PI * 2);
      app.tide = tideAtPhase(this.tidePhase);
      const slider = $<HTMLInputElement>('tide');
      if (document.activeElement !== slider) slider.value = String(Math.round(app.tide * 1000));
    }
    this.refreshText();

    // Moving animals stay framed.
    if (this.macro) {
      const f = this.macro.target.focus();
      if (this.macro.settled) app.rig.pose.target.lerp(f, Math.min(1, dt * 3));
      app.pipeline.focusDistance = app.camera.position.distanceTo(app.rig.current.target);
    }

    // Sound: crashes when crests reach the shelf, pours, drips.
    for (const x of [-7, -2, 3, 8]) {
      const z = shoreZ(x) + 0.6;
      const h = app.water.seaSurfaceAt(x, z, app.time);
      const prev = this.crestPrev.get(x) ?? h;
      const rising = h > prev;
      if (this.crestRise.get(x) && !rising) {
        const amp = h - G.uSeaLevel.value;
        if (amp > 0.12) this.audio.crash(Math.min(1.2, amp * 2.5), this.panFor(new THREE.Vector3(x, h, z)));
      }
      this.crestRise.set(x, rising);
      this.crestPrev.set(x, h);
    }
    for (const e of app.water.events) if (e.kind === 'overtop') this.audio.pour(e.strength, this.panFor(new THREE.Vector3(e.x, 0, e.z)));
    if (this.audio.update(dt, { tide: app.tide, night: G.uNight.value, time: app.time })) {
      // A drop falls from the rim into the pool: you hear it and see its ring.
      const a = Math.random() * Math.PI * 2;
      const p = new THREE.Vector3(Math.cos(a) * 1.85, 0, -0.2 + Math.sin(a) * 1.2);
      app.water.disturb(p.x, p.z, 0.25, 0.03, 0.02);
      this.audio.drip(this.panFor(p));
    }
  }
}

function formatHour(h: number): string {
  const hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
