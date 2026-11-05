/**
 * Procedural Porsche flat-6 / Ferrari V12 exhaust + EV jet/sonic whoosh.
 * No sample packs — oscillators, filtered noise, and RPM-synced pulses.
 */

export type EngineType = "porsche" | "ferrari" | "ev";

export type SynthParams = {
  engine: EngineType;
  rpm: number;
  load: number; // 0–1
  volume: number; // 0–1
  aggressiveness: number; // 0–1
  shifting: "up" | "down" | null;
  /** Road speed — drives EV jet curve (ignored for ICE) */
  speedMph?: number;
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
  private noiseFilter: BiquadFilterNode | null = null;
  private roarGain: GainNode | null = null;
  private roarFilter: BiquadFilterNode | null = null;
  private pulseGain: GainNode | null = null;
  private pulseOsc: OscillatorNode | null = null;
  private rumbleOsc: OscillatorNode | null = null;
  private rumbleGain: GainNode | null = null;
  private started = false;
  private engine: EngineType = "porsche";
  private lastShiftAt = 0;
  private lastLoad = 0;

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

    if (p.engine === "ev") {
      this.updateEv(p);
      return;
    }

    const now = this.ctx.currentTime;
    const rpm = Math.max(600, p.rpm);
    const ferrari = p.engine === "ferrari";
    const cyl = ferrari ? 12 : 6;
    const fireHz = (rpm / 60) * (cyl / 2);
    const fund = rpm / 60;

    // PDK ups are snappy cutouts; Ferrari downs scream
    const shiftMul =
      p.shifting === "up" ? (ferrari ? 0.5 : 0.42) : p.shifting === "down" ? 1.25 : 1;
    const vol =
      p.volume *
      (0.34 + p.load * 0.48 + p.aggressiveness * 0.16) *
      shiftMul;
    this.master.gain.setTargetAtTime(vol, now, ferrari ? 0.035 : 0.028);

    const baseCutoff = ferrari
      ? 520 + rpm * 0.62 + p.load * 2100
      : 360 + rpm * 0.58 + p.load * 1900;
    const cutoff = Math.min(
      ferrari ? 7200 : 6400,
      baseCutoff * (0.88 + p.aggressiveness * 0.32),
    );
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
    this.filter.Q.setTargetAtTime(0.65 + p.load * 1.5, now, 0.07);

    if (this.presence) {
      this.presence.frequency.setTargetAtTime(
        ferrari ? 2100 + rpm * 0.05 : 1400 + rpm * 0.04,
        now,
        0.09,
      );
      this.presence.gain.setTargetAtTime(
        (ferrari ? 4 : 3.5) + p.load * 7 + p.aggressiveness * 4,
        now,
        0.09,
      );
    }

    for (const h of this.harmonics) {
      const freq = Math.min(this.ctx.sampleRate / 2 - 100, fund * h.ratio);
      h.osc.frequency.setTargetAtTime(freq, now, 0.025);
      // Flat-6: emphasize 1.5 / odd-ish rasp; Ferrari: bright upper stack
      const characterBoost = ferrari
        ? h.ratio >= 3
          ? 1.35
          : 0.95
        : h.ratio === 1.5 || h.ratio === 3
          ? 1.4
          : 1;
      const amp =
        (0.085 / Math.sqrt(h.ratio)) *
        characterBoost *
        (0.7 + p.load * 0.65);
      h.gain.gain.setTargetAtTime(amp, now, 0.045);
    }

    if (this.pulseOsc && this.pulseGain) {
      this.pulseOsc.frequency.setTargetAtTime(Math.max(10, fireHz), now, 0.02);
      const pulseAmp =
        (ferrari ? 0.14 : 0.2) *
        (0.5 + p.load * 0.85) *
        (0.75 + p.aggressiveness * 0.45);
      this.pulseGain.gain.setTargetAtTime(pulseAmp, now, 0.045);
    }

    if (this.noiseGain) {
      const noiseAmp =
        (ferrari ? 0.09 : 0.12) *
        (0.35 + p.load * 0.95) *
        (0.65 + p.aggressiveness * 0.45);
      this.noiseGain.gain.setTargetAtTime(noiseAmp, now, 0.055);
    }

    if (this.roarGain) this.roarGain.gain.setTargetAtTime(0, now, 0.05);

    if (this.rumbleOsc && this.rumbleGain) {
      // Flat-6: light boxer thrum; Ferrari: thinner low end, more scream above
      const rumbleRatio = ferrari ? 1 : 0.75;
      this.rumbleOsc.frequency.setTargetAtTime(
        Math.max(22, fund * rumbleRatio),
        now,
        0.04,
      );
      this.rumbleGain.gain.setTargetAtTime(
        ferrari ? 0.05 + p.load * 0.05 : 0.1 + p.load * 0.08,
        now,
        0.055,
      );
    }

    if (p.shifting && this.ctx.currentTime - this.lastShiftAt > 0.1) {
      this.lastShiftAt = this.ctx.currentTime;
      this.playShiftBlip(p.shifting, p.aggressiveness, ferrari);
    }
  }

  /**
   * Fighter-jet / sonic whoosh: layered roar + tonal core.
   * Present at crawl; intensity & pitch near max by 65–85 mph, then plateau.
   */
  private updateEv(p: SynthParams) {
    if (!this.ctx || !this.master || !this.filter) return;
    const now = this.ctx.currentTime;
    const mph = Math.max(0, p.speedMph ?? 0);
    const { intensity, pitch } = jetSpeedCurve(mph);
    const sport = Math.max(0, Math.min(1, p.aggressiveness));
    const load = Math.max(0, Math.min(1, p.load));
    // Pressure bloom on hard accel (Doppler-ish rush)
    const dLoad = Math.max(0, load - this.lastLoad);
    this.lastLoad = load;
    const bloom = Math.min(1, load * 0.85 + dLoad * 8);

    const body =
      0.42 + intensity * 0.48 + bloom * 0.22 + sport * 0.1;
    const vol = p.volume * Math.min(1.15, body);
    this.master.gain.setTargetAtTime(vol, now, 0.06);

    // Wide-open lowpass so the roar stays thick, not thin
    const cutoff = Math.min(
      7800,
      900 + pitch * 4200 + bloom * 1600 + sport * 600,
    );
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.07);
    this.filter.Q.setTargetAtTime(0.55 + bloom * 0.6, now, 0.08);

    if (this.presence) {
      // Chest / boom band — not a piercing EV whistle
      this.presence.frequency.setTargetAtTime(
        480 + pitch * 520 + bloom * 280,
        now,
        0.09,
      );
      this.presence.gain.setTargetAtTime(
        6 + intensity * 5 + bloom * 5 + sport * 2,
        now,
        0.09,
      );
    }

    // Tonal jet core (few low–mid saws) — plateaus with pitch
    const coreHz = 62 + pitch * 95 + bloom * 28;
    for (const h of this.harmonics) {
      const freq = Math.min(2200, coreHz * h.ratio);
      h.osc.frequency.setTargetAtTime(freq, now, 0.05);
      const amp =
        (0.14 / Math.sqrt(h.ratio)) *
        (0.55 + intensity * 0.55 + bloom * 0.35) *
        (h.ratio <= 2 ? 1.25 : 0.7);
      h.gain.gain.setTargetAtTime(amp, now, 0.06);
    }

    // Primary air-rush / afterburner noise
    if (this.noiseFilter && this.noiseGain) {
      this.noiseFilter.frequency.setTargetAtTime(
        380 + pitch * 1100 + bloom * 500,
        now,
        0.08,
      );
      this.noiseFilter.Q.setTargetAtTime(0.45 + bloom * 0.25, now, 0.1);
      this.noiseGain.gain.setTargetAtTime(
        0.16 + intensity * 0.28 + bloom * 0.18 + sport * 0.06,
        now,
        0.07,
      );
    }

    // Second roar layer (broader, lower) — jet body
    if (this.roarFilter && this.roarGain) {
      this.roarFilter.frequency.setTargetAtTime(
        180 + pitch * 420 + bloom * 200,
        now,
        0.09,
      );
      this.roarGain.gain.setTargetAtTime(
        0.2 + intensity * 0.32 + bloom * 0.14,
        now,
        0.08,
      );
    }

    // Whoosh sweep tone (flyby energy)
    if (this.pulseOsc && this.pulseGain) {
      this.pulseOsc.frequency.setTargetAtTime(
        140 + pitch * 380 + bloom * 120,
        now,
        0.06,
      );
      this.pulseGain.gain.setTargetAtTime(
        0.05 + intensity * 0.12 + bloom * 0.14,
        now,
        0.07,
      );
    }

    // Sub pressure / afterburner thrum
    if (this.rumbleOsc && this.rumbleGain) {
      this.rumbleOsc.frequency.setTargetAtTime(
        38 + pitch * 36 + bloom * 18,
        now,
        0.07,
      );
      this.rumbleGain.gain.setTargetAtTime(
        0.14 + intensity * 0.16 + bloom * 0.12,
        now,
        0.08,
      );
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
      this.engine === "ev"
        ? [1, 1.5, 2, 2.5]
        : this.engine === "ferrari"
          ? [1, 2, 3, 4, 5, 6, 8]
          : [1, 1.5, 2, 3, 4, 5, 6]; // Porsche flat-6 rasp

    this.harmonics = ratios.map((ratio) => {
      const osc = ctx.createOscillator();
      osc.type =
        this.engine === "ev"
          ? "sawtooth"
          : this.engine === "ferrari"
            ? "sawtooth"
            : "sawtooth";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.filter!);
      osc.start();
      return { osc, gain, ratio };
    });

    const bufferSize = 2 * ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    this.noiseSource = noise;

    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = "bandpass";
    this.noiseFilter.frequency.value =
      this.engine === "ev" ? 700 : this.engine === "porsche" ? 1100 : 1600;
    this.noiseFilter.Q.value = this.engine === "ev" ? 0.5 : 0.65;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);

    // Extra roar layer for EV (same buffer, separate band) — skipped for ICE
    if (this.engine === "ev") {
      this.roarFilter = ctx.createBiquadFilter();
      this.roarFilter.type = "lowpass";
      this.roarFilter.frequency.value = 500;
      this.roarFilter.Q.value = 0.7;
      this.roarGain = ctx.createGain();
      this.roarGain.gain.value = 0;
      noise.connect(this.roarFilter);
      this.roarFilter.connect(this.roarGain);
      this.roarGain.connect(this.filter);
    }

    noise.start();

    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.type = this.engine === "ev" ? "sawtooth" : "sine";
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    if (this.engine === "ev") {
      this.pulseOsc.connect(this.pulseGain);
      this.pulseGain.connect(this.filter);
    } else {
      const pulseShape = ctx.createWaveShaper();
      pulseShape.curve = makePulseCurve();
      this.pulseOsc.connect(pulseShape);
      pulseShape.connect(this.pulseGain);
      this.pulseGain.connect(this.filter);
    }
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
      this.noiseFilter?.disconnect();
      this.noiseGain?.disconnect();
      this.roarFilter?.disconnect();
      this.roarGain?.disconnect();
      this.pulseGain?.disconnect();
      this.rumbleGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.pulseOsc = null;
    this.rumbleOsc = null;
    this.noiseSource = null;
    this.noiseFilter = null;
    this.noiseGain = null;
    this.roarFilter = null;
    this.roarGain = null;
    this.pulseGain = null;
    this.rumbleGain = null;
  }

  private playShiftBlip(
    kind: "up" | "down",
    aggressiveness: number,
    ferrari = false,
  ) {
    if (!this.ctx || !this.filter) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    const startF = kind === "down" ? (ferrari ? 120 : 95) : ferrari ? 280 : 240;
    const endF =
      kind === "down"
        ? 360 + aggressiveness * 240
        : ferrari
          ? 130
          : 100;
    const dur = kind === "down" ? (ferrari ? 0.11 : 0.09) : ferrari ? 0.06 : 0.05;
    osc.frequency.setValueAtTime(startF, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endF), now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(
      0.2 + aggressiveness * 0.22,
      now + 0.008,
    );
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.03);
    osc.connect(g);
    g.connect(this.filter);
    osc.start(now);
    osc.stop(now + dur + 0.04);
  }
}

/** Soft at crawl, near peak by 65–85 mph, light plateau above. */
function jetSpeedCurve(mph: number): { intensity: number; pitch: number } {
  const m = Math.max(0, mph);
  // Present while crawling (not silent until 30+)
  const crawl = 1 - Math.exp(-m / 14);
  // Sigmoid centered ~58 mph → ~0.9 by 75
  const rise = 1 / (1 + Math.exp(-(m - 52) / 9));
  let intensity = Math.min(1, crawl * 0.38 + rise * 0.72);
  // Soft plateau past ~88 so it doesn't scream forever upward
  if (m > 88) {
    intensity = Math.min(1, intensity + Math.min(0.06, (m - 88) * 0.003));
  }

  // Pitch climbs to ~1 around 80, then barely moves
  let pitch = Math.min(1, m / 78);
  if (m > 78) {
    pitch = Math.min(1.05, 1 + (m - 78) * 0.002);
  }
  pitch = Math.min(1, pitch);

  return { intensity, pitch };
}

function makePulseCurve(): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 3) * Math.abs(x);
  }
  return curve;
}
