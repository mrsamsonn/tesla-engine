/** Simulated multi-gear mapping from road speed → RPM with shift events. */

export type EngineConfig = {
  idleRpm: number;
  redline: number;
  /** Final drive × tire circumference factor: mph per 1000 rpm in top gear-ish */
  mphPerThousandInTop: number;
  gearRatios: number[]; // relative to top gear (=1)
};

export const V8_CONFIG: EngineConfig = {
  idleRpm: 750,
  redline: 7200,
  mphPerThousandInTop: 48,
  gearRatios: [3.6, 2.4, 1.7, 1.3, 1.0, 0.82],
};

export const V12_CONFIG: EngineConfig = {
  idleRpm: 700,
  redline: 8500,
  mphPerThousandInTop: 52,
  gearRatios: [3.4, 2.3, 1.65, 1.25, 1.0, 0.85, 0.72],
};

export type ShiftKind = "up" | "down" | null;

export type GearboxState = {
  gear: number; // 1-indexed
  rpm: number;
  shift: ShiftKind;
  /** 0–1 throttle proxy from acceleration */
  load: number;
};

export class Gearbox {
  private config: EngineConfig;
  private gear = 1;
  private lastSpeedMph = 0;
  private lastTs = performance.now();
  private shiftCooldownUntil = 0;
  private pendingShift: ShiftKind = null;
  private pendingShiftUntil = 0;
  private smoothedAccel = 0;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  setConfig(config: EngineConfig) {
    this.config = config;
    this.gear = Math.min(this.gear, config.gearRatios.length);
  }

  reset() {
    this.gear = 1;
    this.lastSpeedMph = 0;
    this.lastTs = performance.now();
    this.shiftCooldownUntil = 0;
    this.pendingShift = null;
    this.pendingShiftUntil = 0;
    this.smoothedAccel = 0;
  }

  update(speedMph: number, now = performance.now()): GearboxState {
    const dt = Math.max(0.016, Math.min(0.25, (now - this.lastTs) / 1000));
    const rawAccel = (speedMph - this.lastSpeedMph) / dt; // mph/s
    this.smoothedAccel += (rawAccel - this.smoothedAccel) * Math.min(1, dt * 4);
    this.lastSpeedMph = speedMph;
    this.lastTs = now;

    let shift: ShiftKind = null;
    if (this.pendingShift && now < this.pendingShiftUntil) {
      shift = this.pendingShift;
    } else {
      this.pendingShift = null;
    }

    if (now >= this.shiftCooldownUntil && speedMph > 0.5) {
      const rpm = this.rpmAt(speedMph, this.gear);
      const maxGear = this.config.gearRatios.length;
      const upRpm = this.config.redline * 0.88;
      const downRpm = this.config.idleRpm + 900;

      if (this.smoothedAccel > 0.8 && rpm >= upRpm && this.gear < maxGear) {
        this.gear += 1;
        this.fireShift("up", now);
        shift = "up";
      } else if (
        this.smoothedAccel < -1.2 &&
        rpm <= downRpm &&
        this.gear > 1
      ) {
        this.gear -= 1;
        this.fireShift("down", now);
        shift = "down";
      } else if (rpm >= this.config.redline * 0.95 && this.gear < maxGear) {
        this.gear += 1;
        this.fireShift("up", now);
        shift = "up";
      } else if (rpm < this.config.idleRpm + 400 && this.gear > 1 && speedMph > 1) {
        this.gear -= 1;
        this.fireShift("down", now);
        shift = "down";
      }
    }

    // Parked / near-zero: idle in gear 1
    if (speedMph < 0.4) {
      this.gear = 1;
    }

    const rpm = this.rpmAt(speedMph, this.gear);
    const load = Math.max(
      0,
      Math.min(1, (this.smoothedAccel + 2) / 8 + speedMph / 120),
    );

    return { gear: this.gear, rpm, shift, load };
  }

  /** Force sportier shift points when aggressiveness is high. */
  updateWithAggressiveness(
    speedMph: number,
    aggressiveness: number,
    now = performance.now(),
  ): GearboxState {
    // Temporarily widen/narrow thresholds via redline proxy
    const saved = this.config.redline;
    this.config.redline = saved * (0.82 + aggressiveness * 0.2);
    const state = this.update(speedMph, now);
    this.config.redline = saved;
    return state;
  }

  private fireShift(kind: ShiftKind, now: number) {
    this.pendingShift = kind;
    this.pendingShiftUntil = now + (kind === "up" ? 180 : 220);
    this.shiftCooldownUntil = now + (kind === "up" ? 450 : 520);
  }

  private rpmAt(speedMph: number, gear: number): number {
    const ratio = this.config.gearRatios[gear - 1] ?? 1;
    if (speedMph < 0.35) return this.config.idleRpm;
    const rpm =
      (speedMph / this.config.mphPerThousandInTop) * 1000 * ratio;
    return Math.max(
      this.config.idleRpm,
      Math.min(this.config.redline * 1.02, rpm),
    );
  }
}
