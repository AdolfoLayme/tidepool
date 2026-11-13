import waveClipUrl from './assets/wave-crash.ogg?url&inline';
import dropClipUrl from './assets/water-drop.ogg?url&inline';

/**
 * The sound of the shore, synthesised with Web Audio (no recordings, nothing to license).
 *
 *  - a low surf bed and a fizz of spray, louder as the tide rises;
 *  - crashes timed to the swell crests that actually reach the shelf in the scene;
 *  - pool lapping, the pour of water when a wave overtops into the pool;
 *  - drips (a falling drop rings a small bubble whose pitch rises: Minnaert resonance);
 *  - a soft plip for each touch of the water.
 *
 * Silent until enabled by a user gesture. Everything is panned by where it happens relative to
 * the camera.
 */
export type ShoreState = {
  /** 0 low .. 1 high water. */
  tide: number;
  /** 0 day .. 1 night. */
  night: number;
  /** Seconds. */
  time: number;
};

export class ShoreAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private surfGain: GainNode | null = null;
  private fizzGain: GainNode | null = null;
  private lapGain: GainNode | null = null;
  private lapFilter: BiquadFilterNode | null = null;
  private brown: AudioBuffer | null = null;
  private white: AudioBuffer | null = null;
  private waveClip: AudioBuffer | null = null;
  private dropClip: AudioBuffer | null = null;
  private tide = 0.5;
  private lastCrashTime = -10;
  private nextDrip = 2;
  enabled = false;

  get available(): boolean { return typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window); }

  async setEnabled(on: boolean): Promise<boolean> {
    if (on && !this.ctx) this.build();
    if (!this.ctx || !this.master) return false;
    const t = this.ctx.currentTime;
    if (on) {
      await this.ctx.resume();
      if (!this.waveClip || !this.dropClip) {
        try {
          const decode = async (url: string) => this.ctx!.decodeAudioData(await (await fetch(url)).arrayBuffer());
          [this.waveClip, this.dropClip] = await Promise.all([decode(waveClipUrl), decode(dropClipUrl)]);
        } catch {
          // A browser without Ogg decoding keeps the generated shore sounds.
        }
      }
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(0.9, t, 0.6);
    } else {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(0, t, 0.25);
      window.setTimeout(() => { if (!this.enabled) void this.ctx?.suspend(); }, 1500);
    }
    this.enabled = on;
    return on;
  }

  private build(): void {
    const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = this.ctx = new Ctx();
    const master = this.master = ctx.createGain();
    master.gain.value = 0;
    // Gentle bus compression keeps crashes from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.4;
    master.connect(comp).connect(ctx.destination);

    this.brown = this.noise(ctx, 6, 'brown');
    this.white = this.noise(ctx, 3, 'white');

    // Surf bed: distant roar of the sea against the rock.
    const surf = this.loop(this.brown);
    const surfLp = ctx.createBiquadFilter();
    surfLp.type = 'lowpass'; surfLp.frequency.value = 520; surfLp.Q.value = 0.4;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.25;
    surf.connect(surfLp).connect(this.surfGain).connect(master);

    // Fizz: spray and draining foam, high and quiet.
    const fizz = this.loop(this.white);
    const fizzHp = ctx.createBiquadFilter();
    fizzHp.type = 'highpass'; fizzHp.frequency.value = 3800;
    this.fizzGain = ctx.createGain();
    this.fizzGain.gain.value = 0.02;
    fizz.connect(fizzHp).connect(this.fizzGain).connect(master);

    // Pool lapping: band-limited noise with a slow swell in level and colour.
    const lap = this.loop(this.white);
    this.lapFilter = ctx.createBiquadFilter();
    this.lapFilter.type = 'bandpass'; this.lapFilter.frequency.value = 900; this.lapFilter.Q.value = 1.4;
    this.lapGain = ctx.createGain();
    this.lapGain.gain.value = 0.02;
    lap.connect(this.lapFilter).connect(this.lapGain).connect(master);
  }

  private noise(ctx: AudioContext, seconds: number, kind: 'brown' | 'white'): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } else d[i] = w * 0.5;
      }
      // Cross-fade the loop point.
      const fade = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = d[i] * k + d[len - fade + i] * (1 - k); }
    }
    return buf;
  }

  private loop(buf: AudioBuffer): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.loopStart = 0; src.loopEnd = buf.duration - 0.05;
    src.start(0, Math.random() * buf.duration * 0.8);
    return src;
  }

  private panner(pan: number): StereoPannerNode {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.max(-0.95, Math.min(0.95, pan));
    p.connect(this.master!);
    return p;
  }

  /** A breaking wave: rumble that swells then drains away as a hiss. */
  crash(strength: number, pan: number): void {
    if (!this.enabled || !this.ctx || !this.brown || !this.white) return;
    const ctx = this.ctx, t = ctx.currentTime, s = Math.min(1.3, strength);
    if (t - this.lastCrashTime < 0.7) return;
    this.lastCrashTime = t;
    const out = this.panner(pan * 0.8);
    if (this.waveClip) {
      const wave = ctx.createBufferSource();
      wave.buffer = this.waveClip;
      wave.playbackRate.value = 0.95 + Math.random() * 0.1;
      const level = ctx.createGain();
      level.gain.value = Math.min(0.23, 0.18 * s * (0.4 + 0.6 * this.tide));
      wave.connect(level).connect(out);
      wave.start(t);
      return;
    }
    const body = ctx.createBufferSource(); body.buffer = this.brown;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.linearRampToValueAtTime(900 + 500 * s, t + 0.35);
    lp.frequency.exponentialRampToValueAtTime(320, t + 3.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.55 * s, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    body.connect(lp).connect(g).connect(out);
    body.start(t, Math.random() * 3);
    body.stop(t + 3.8);
    // Backwash: foam draining off the rock.
    const hiss = ctx.createBufferSource(); hiss.buffer = this.white;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(2400, t + 0.4);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 3.5);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.linearRampToValueAtTime(0.09 * s, t + 0.6);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    hiss.connect(bp).connect(hg).connect(out);
    hiss.start(t, Math.random() * 2);
    hiss.stop(t + 4.4);
  }

  /** Water pouring over the rim into the pool. */
  pour(strength: number, pan: number): void {
    if (!this.enabled || !this.ctx || !this.white) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.panner(pan);
    const src = ctx.createBufferSource(); src.buffer = this.white;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * Math.min(1, strength), t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random()); src.stop(t + 2.4);
    for (let i = 0; i < 5; i++) this.bubble(t + 0.1 + Math.random() * 1.2, 300 + Math.random() * 500, 0.05 * strength, pan);
  }

  /** A single bubble ringing with rising pitch. */
  private bubble(at: number, freq: number, level: number, pan: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(freq * (1.4 + Math.random() * 0.4), at + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(level, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07 + 40 / freq);
    osc.connect(g).connect(this.panner(pan));
    osc.start(at); osc.stop(at + 0.2);
  }

  drip(pan: number): void {
    if (!this.enabled || !this.ctx) return;
    if (this.dropClip) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.dropClip;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.12;
      src.connect(gain).connect(this.panner(pan));
      src.start();
      return;
    }
    this.bubble(this.ctx.currentTime, 900 + Math.random() * 800, 0.08, pan);
  }

  plip(pan: number, strength = 1): void {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.bubble(t, 420 + Math.random() * 220, 0.14 * strength, pan);
    if (Math.random() < 0.6) this.bubble(t + 0.05 + Math.random() * 0.08, 800 + Math.random() * 500, 0.05, pan);
  }

  /** Per frame: bed levels follow tide and time; drips come at random. Returns true for a drip. */
  update(dt: number, s: ShoreState): boolean {
    if (!this.enabled || !this.ctx || !this.surfGain || !this.fizzGain || !this.lapGain || !this.lapFilter) return false;
    this.tide = s.tide;
    const t = this.ctx.currentTime;
    const quiet = 1 - 0.35 * s.night;
    this.surfGain.gain.setTargetAtTime((0.16 + 0.32 * s.tide) * quiet, t, 0.8);
    this.fizzGain.gain.setTargetAtTime((0.008 + 0.03 * s.tide) * quiet, t, 0.8);
    const lap = 0.5 + 0.5 * Math.sin(s.time * 0.9) * Math.sin(s.time * 0.37 + 1.0);
    this.lapGain.gain.setTargetAtTime((0.012 + 0.03 * lap) * quiet, t, 0.3);
    this.lapFilter.frequency.setTargetAtTime(700 + 500 * lap, t, 0.3);
    this.nextDrip -= dt;
    if (this.nextDrip <= 0) {
      this.nextDrip = 1.5 + Math.random() * 4.5;
      return true;
    }
    return false;
  }
}
