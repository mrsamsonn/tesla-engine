/**
 * Procedural V8 / V12 exhaust-ish synthesis via Web Audio.
 * No sample packs — oscillators, filtered noise, and RPM-synced pulses.
 */

export type EngineType = "v8" | "v12";

export type SynthParams = {
  engine: EngineType;
  rpm: number;
  load: number; // 0–1
  volume: number; // 0–1
  aggressiveness: number; // 0–1
  shifting: "up" | "down" | null;
};

type Harmonic = {
  osc: OscillatorNode;
  gain: GainNode;
  ratio: number;
};

export class EngineSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private presence: BiquadFilterNode | null = null;
  private harmonics: Harmonic[] = [];
  private noiseGain: GainNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private pulseGain: GainNode | null = null;
  private pulseOsc: OscillatorNode | null = null;
  private rumbleOsc: OscillatorNode | null = null;
  private rumbleGain: GainNode | null = null;
  private started = false;
  private engine: EngineType = "v8";
  private lastShiftAt = 0;

  get isRunning() {
    return this.started && this.ctx?.state === "running";
  }

  async engage(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.buildGraph(this.ctx);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.started = true;
  }

  async suspend() {
    if (this.ctx && this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  setEngine(engine: EngineType) {
    if (engine === this.engine) return;
    this.engine = engine;
    if (this.ctx) {
      this.teardownVoices();
      this.buildVoices(this.ctx);
    }
  }

  update(p: SynthParams) {
    if (!this.ctx || !this.master || !this.filter || !this.started) return;
    if (p.engine !== this.engine) this.setEngine(p.engine);

    const now = this.ctx.currentTime;
    const rpm = Math.max(600, p.rpm);
    const cyl = p.engine === "v12" ? 12 : 8;
    // Four-stroke firing rate (Hz) for all cylinders
    const fireHz = (rpm / 60) * (cyl / 2);
    const fund = rpm / 60; // crank fundamental

    // Master volume with load swell
    const vol =
      p.volume *
      (0.35 + p.load * 0.45 + p.aggressiveness * 0.15) *
      (p.shifting === "up" ? 0.55 : p.shifting === "down" ? 1.15 : 1);
    this.master.gain.setTargetAtTime(vol, now, 0.04);

    // Filter opens with RPM / load
    const baseCutoff =
      p.engine === "v12"
        ? 420 + rpm * 0.55 + p.load * 1800
        : 280 + rpm * 0.48 + p.load * 2200;
    const cutoff = Math.min(
      6200,
      baseCutoff * (0.85 + p.aggressiveness * 0.35),
    );
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.06);
    this.filter.Q.setTargetAtTime(0.7 + p.load * 1.4, now, 0.08);

    if (this.presence) {
      this.presence.frequency.setTargetAtTime(
        p.engine === "v12" ? 1800 : 1100,
        now,
        0.1,
      );
      this.presence.gain.setTargetAtTime(
        3 + p.load * 6 + p.aggressiveness * 4,
        now,
        0.1,
      );
    }

    // Harmonics track crank / cylinder character
    for (const h of this.harmonics) {
      const freq = Math.min(this.ctx.sampleRate / 2 - 100, fund * h.ratio);
      h.osc.frequency.setTargetAtTime(freq, now, 0.03);
      const amp =
        (0.08 / Math.sqrt(h.ratio)) *
        (p.engine === "v8" && h.ratio % 2 !== 0 ? 1.25 : 1) *
        (0.7 + p.load * 0.6);
      h.gain.gain.setTargetAtTime(amp, now, 0.05);
    }

    if (this.pulseOsc && this.pulseGain) {
      this.pulseOsc.frequency.setTargetAtTime(Math.max(8, fireHz), now, 0.025);
      const pulseAmp =
        (p.engine === "v8" ? 0.22 : 0.12) *
        (0.5 + p.load * 0.8) *
        (0.7 + p.aggressiveness * 0.5);
      this.pulseGain.gain.setTargetAtTime(pulseAmp, now, 0.05);
    }

    if (this.noiseGain) {
      const noiseAmp =
        (p.engine === "v8" ? 0.14 : 0.08) *
        (0.35 + p.load * 0.9) *
        (0.6 + p.aggressiveness * 0.5);
      this.noiseGain.gain.setTargetAtTime(noiseAmp, now, 0.06);
    }

    if (this.rumbleOsc && this.rumbleGain) {
      // Cross-plane V8 rumble ~ half-order; V12 smoother low hum
      const rumbleRatio = p.engine === "v8" ? 0.5 : 1;
      this.rumbleOsc.frequency.setTargetAtTime(
        Math.max(20, fund * rumbleRatio),
        now,
        0.04,
      );
      this.rumbleGain.gain.setTargetAtTime(
        p.engine === "v8" ? 0.18 + p.load * 0.12 : 0.06 + p.load * 0.05,
        now,
        0.06,
      );
    }

    if (p.shifting && this.ctx.currentTime - this.lastShiftAt > 0.15) {
      this.lastShiftAt = this.ctx.currentTime;
      this.playShiftBlip(p.shifting, p.aggressiveness);
    }
  }

  private buildGraph(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.8;

    this.presence = ctx.createBiquadFilter();
    this.presence.type = "peaking";
    this.presence.frequency.value = 1200;
    this.presence.Q.value = 1.2;
    this.presence.gain.value = 4;

    this.filter.connect(this.presence);
    this.presence.connect(this.master);
    this.master.connect(ctx.destination);

    this.buildVoices(ctx);
  }

  private buildVoices(ctx: AudioContext) {
    if (!this.filter) return;

    const ratios =
      this.engine === "v12"
        ? [1, 2, 3, 4, 5, 6, 8]
        : [0.5, 1, 1.5, 2, 3, 4, 5];

    this.harmonics = ratios.map((ratio) => {
      const osc = ctx.createOscillator();
      osc.type = this.engine === "v12" ? "sawtooth" : "square";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.filter!);
      osc.start();
      return { osc, gain, ratio };
    });

    // Exhaust noise
    const bufferSize = 2 * ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = this.engine === "v8" ? 900 : 1400;
    noiseFilter.Q.value = 0.6;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(noiseFilter);
    noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);
    noise.start();
    this.noiseSource = noise;

    // Cylinder pulse (soft AM feel via LFO into gain — separate audible chirp)
    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.type = "sine";
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    const pulseShape = ctx.createWaveShaper();
    pulseShape.curve = makePulseCurve();
    this.pulseOsc.connect(pulseShape);
    pulseShape.connect(this.pulseGain);
    this.pulseGain.connect(this.filter);
    this.pulseOsc.start();

    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = "sine";
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleOsc.connect(this.rumbleGain);
    this.rumbleGain.connect(this.filter);
    this.rumbleOsc.start();
  }

  private teardownVoices() {
    for (const h of this.harmonics) {
      try {
        h.osc.stop();
        h.osc.disconnect();
        h.gain.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.harmonics = [];
    try {
      this.pulseOsc?.stop();
      this.pulseOsc?.disconnect();
      this.rumbleOsc?.stop();
      this.rumbleOsc?.disconnect();
      this.noiseSource?.stop();
      this.noiseSource?.disconnect();
      this.noiseGain?.disconnect();
      this.pulseGain?.disconnect();
      this.rumbleGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.pulseOsc = null;
    this.rumbleOsc = null;
    this.noiseSource = null;
    this.noiseGain = null;
    this.pulseGain = null;
    this.rumbleGain = null;
  }

  private playShiftBlip(kind: "up" | "down", aggressiveness: number) {
    if (!this.ctx || !this.filter) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    const startF = kind === "down" ? 90 : 220;
    const endF = kind === "down" ? 320 + aggressiveness * 180 : 110;
    osc.frequency.setValueAtTime(startF, now);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, endF),
      now + (kind === "down" ? 0.12 : 0.08),
    );
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(
      0.2 + aggressiveness * 0.15,
      now + 0.01,
    );
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(g);
    g.connect(this.filter);
    osc.start(now);
    osc.stop(now + 0.16);
  }
}

function makePulseCurve(): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Soft pulse / rectifier-ish for firing accents
    curve[i] = Math.tanh(x * 3) * Math.abs(x);
  }
  return curve;
}
