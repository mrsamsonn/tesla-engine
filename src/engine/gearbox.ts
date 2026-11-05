/** Simulated multi-gear mapping from road speed → RPM with PDK-style shifts. */

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
  /** True while holding a kickdown / hard-accel pull */
  kickdown: boolean;
};

/**
 * Dual-clutch-inspired logic: shift from sustained accel intent, not just RPM.
 * Hard throttle → multi-gear kickdown + high-RPM hold; lift → rev-matched downs.
 */
export class Gearbox {
  private config: EngineConfig;
  private gear = 1;
  private lastSpeedMph = 0;
  private lastTs = performance.now();
  private shiftCooldownUntil = 0;
  private pendingShift: ShiftKind = null;
  private pendingShiftUntil = 0;
  /** Fast EMA for exhaust load feel */
  private smoothedAccel = 0;
  /** Slower EMA for shift / kickdown decisions (rejects GPS spikes) */
  private intentAccel = 0;
  private kickdownUntil = 0;
  private kickdownArmedUntil = 0;
  private aggressiveness = 0.55;

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
    this.intentAccel = 0;
    this.kickdownUntil = 0;
    this.kickdownArmedUntil = 0;
  }

  update(speedMph: number, now = performance.now()): GearboxState {
    const dt = Math.max(0.016, Math.min(0.25, (now - this.lastTs) / 1000));
    // Clamp single-frame spikes (GPS jumps) before filtering
    const rawAccel = Math.max(-18, Math.min(22, (speedMph - this.lastSpeedMph) / dt));
    const fastAlpha = Math.min(1, dt * 5);
    const intentAlpha = Math.min(1, dt * 2.2);
    this.smoothedAccel += (rawAccel - this.smoothedAccel) * fastAlpha;
    this.intentAccel += (rawAccel - this.intentAccel) * intentAlpha;
    this.lastSpeedMph = speedMph;
    this.lastTs = now;

    const sport = Math.max(0, Math.min(1, this.aggressiveness));
    const kickThreshold = 5.2 - sport * 2.4; // mph/s — sportier = easier kickdown
    const moderateAccel = 1.2 + sport * 0.6;
    const liftThreshold = -1.8 - sport * 0.6;
    const inKickdown = now < this.kickdownUntil;

    // Require sustained intent before arming a kickdown (noise rejection)
    if (this.intentAccel >= kickThreshold) {
      if (this.kickdownArmedUntil === 0) {
        this.kickdownArmedUntil = now + (120 - sport * 50);
      }
    } else if (this.intentAccel < kickThreshold * 0.55) {
      this.kickdownArmedUntil = 0;
    }

    let shift: ShiftKind = null;
    if (this.pendingShift && now < this.pendingShiftUntil) {
      shift = this.pendingShift;
    } else {
      this.pendingShift = null;
    }

    if (now >= this.shiftCooldownUntil && speedMph > 0.5) {
      const maxGear = this.config.gearRatios.length;
      const rpm = this.rpmAt(speedMph, this.gear);

      // --- Hard throttle: multi-gear kickdown ---
      const kickReady =
        this.kickdownArmedUntil > 0 && now >= this.kickdownArmedUntil;
      if (kickReady && this.gear > 1 && this.intentAccel >= kickThreshold) {
        const targetRpmFrac = 0.72 + sport * 0.14; // sit higher in the band
        const maxDrop = 1 + Math.floor(sport * 2); // 1–3 gears
        let dropped = 0;
        while (
          dropped < maxDrop &&
          this.gear > 1 &&
          this.rpmAt(speedMph, this.gear - 1) < this.config.redline * 0.95
        ) {
          const next = this.rpmAt(speedMph, this.gear - 1);
          // Keep dropping while next gear still sits under the target pull band
          if (dropped > 0 && next >= this.config.redline * targetRpmFrac) break;
          this.gear -= 1;
          dropped += 1;
        }
        if (dropped > 0) {
          this.fireShift("down", now, true);
          this.kickdownUntil = now + 900 + sport * 500;
          this.kickdownArmedUntil = 0;
          shift = "down";
        }
      } else if (!inKickdown) {
        // --- Upshift: delay under moderate/hard accel; cruise earlier ---
        const accelBias = Math.max(0, Math.min(1, this.intentAccel / 7));
        const upFrac =
          this.intentAccel >= moderateAccel
            ? 0.78 + sport * 0.12 + accelBias * 0.08 // hold gear / delayed upshift
            : 0.58 + sport * 0.06; // cruise upshift
        const upRpm = this.config.redline * Math.min(0.96, upFrac);
        const cruiseCeil =
          this.intentAccel < 0.6 ? this.config.redline * (0.52 + sport * 0.04) : Infinity;

        if (this.gear < maxGear && (rpm >= upRpm || rpm >= cruiseCeil)) {
          this.gear += 1;
          this.fireShift("up", now, false);
          shift = "up";
        } else if (this.gear > 1) {
          // --- Lift / decel: rev-matched downshift, hysteresis vs noise ---
          const downRpm =
            this.config.idleRpm + 900 + sport * 350 - Math.min(0, this.intentAccel) * 80;
          const clearLift = this.intentAccel <= liftThreshold;
          const lowRpm = rpm <= downRpm;
          if (clearLift || lowRpm) {
            const nextRpm = this.rpmAt(speedMph, this.gear - 1);
            // Rev-match window: don't slam into the limiter on a tiny speed dip
            if (nextRpm < this.config.redline * (clearLift ? 0.9 : 0.82)) {
              this.gear -= 1;
              this.fireShift("down", now, false);
              shift = "down";
            }
          }
        }
      } else {
        // In kickdown hold: only upshift near hard redline; no early cruise ups
        const holdUp = this.config.redline * (0.9 + sport * 0.05);
        if (this.gear < maxGear && rpm >= holdUp) {
          this.gear += 1;
          this.fireShift("up", now, false);
          shift = "up";
        }
      }
    }

    // Parked / near-zero: idle in gear 1
    if (speedMph < 0.4) {
      this.gear = 1;
      this.kickdownUntil = 0;
      this.kickdownArmedUntil = 0;
    }

    const rpm = this.rpmAt(speedMph, this.gear);
    const kickBoost = now < this.kickdownUntil ? 0.22 : 0;
    const load = Math.max(
      0,
      Math.min(
        1,
        (this.smoothedAccel + 2.5) / 9 + speedMph / 130 + kickBoost + sport * 0.08,
      ),
    );

    return {
      gear: this.gear,
      rpm,
      shift,
      load,
      kickdown: now < this.kickdownUntil,
    };
  }

  /** Sportiness raises kickdown sensitivity and delayed-upshift RPM. */
  updateWithAggressiveness(
    speedMph: number,
    aggressiveness: number,
    now = performance.now(),
  ): GearboxState {
    this.aggressiveness = aggressiveness;
    return this.update(speedMph, now);
  }

  private fireShift(kind: ShiftKind, now: number, kickdown: boolean) {
    this.pendingShift = kind;
    this.pendingShiftUntil = now + (kind === "up" ? 160 : kickdown ? 280 : 220);
    this.shiftCooldownUntil =
      now + (kind === "up" ? 420 : kickdown ? 680 : 540);
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
