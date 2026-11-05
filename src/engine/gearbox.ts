/** Simulated multi-gear mapping from road speed → RPM with PDK Sport Plus shifts. */

export type EngineConfig = {
  idleRpm: number;
  redline: number;
  /** mph per 1000 rpm in the ratio=1 gear — lower = shorter overall, earlier road shifts */
  mphPerThousandInTop: number;
  gearRatios: number[]; // relative to top-ish (=1)
  /** Continuous drive (EV) — no discrete shifts */
  continuous?: boolean;
};

/** Shorter map so 35–85 mph still climbs RPM and shifts often. */
export const V8_CONFIG: EngineConfig = {
  idleRpm: 750,
  redline: 7200,
  mphPerThousandInTop: 26,
  gearRatios: [3.9, 2.55, 1.85, 1.35, 1.0, 0.78],
};

export const V12_CONFIG: EngineConfig = {
  idleRpm: 700,
  redline: 8500,
  mphPerThousandInTop: 28,
  gearRatios: [3.7, 2.45, 1.8, 1.4, 1.1, 0.9, 0.72],
};

/** Single-speed EV drive unit — pitch from speed/load only. */
export const EV_CONFIG: EngineConfig = {
  idleRpm: 0,
  redline: 16000,
  mphPerThousandInTop: 12,
  gearRatios: [1],
  continuous: true,
};

export type ShiftKind = "up" | "down" | null;

export type GearboxState = {
  gear: number; // 1-indexed; EV stays 1
  rpm: number;
  shift: ShiftKind;
  /** 0–1 throttle proxy from acceleration */
  load: number;
  /** True while holding a kickdown / hard-accel pull */
  kickdown: boolean;
};

/**
 * Dual-clutch Sport Plus logic for ICE; continuous motor RPM for EV.
 */
export class Gearbox {
  private config: EngineConfig;
  private gear = 1;
  private lastSpeedMph = 0;
  private lastTs = performance.now();
  private shiftCooldownUntil = 0;
  private pendingShift: ShiftKind = null;
  private pendingShiftUntil = 0;
  private smoothedAccel = 0;
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
    const rawAccel = Math.max(-18, Math.min(22, (speedMph - this.lastSpeedMph) / dt));
    const fastAlpha = Math.min(1, dt * 5);
    const intentAlpha = Math.min(1, dt * 2.2);
    this.smoothedAccel += (rawAccel - this.smoothedAccel) * fastAlpha;
    this.intentAccel += (rawAccel - this.intentAccel) * intentAlpha;
    this.lastSpeedMph = speedMph;
    this.lastTs = now;

    const sport = Math.max(0, Math.min(1, this.aggressiveness));
    // Sport Plus bias: high sportiness → eager kickdowns & assertive lifts
    const sportPlus = sport * sport; // nonlinear toward the top of the slider

    if (this.config.continuous) {
      return this.updateEv(speedMph, sport, now);
    }

    // Sport Plus: lower kick threshold, quicker arm, deeper drops
    const kickThreshold = 4.4 - sport * 2.2 - sportPlus * 0.8;
    const moderateAccel = 0.9 + sport * 0.5;
    const liftThreshold = -1.2 - sport * 0.9 - sportPlus * 0.5;
    const inKickdown = now < this.kickdownUntil;

    if (this.intentAccel >= kickThreshold) {
      if (this.kickdownArmedUntil === 0) {
        this.kickdownArmedUntil = now + Math.max(40, 95 - sport * 55);
      }
    } else if (this.intentAccel < kickThreshold * 0.5) {
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

      const kickReady =
        this.kickdownArmedUntil > 0 && now >= this.kickdownArmedUntil;
      if (kickReady && this.gear > 1 && this.intentAccel >= kickThreshold) {
        const targetRpmFrac = 0.68 + sport * 0.16 + sportPlus * 0.06;
        const maxDrop = 1 + Math.floor(sport * 2 + sportPlus); // 1–4 gears
        let dropped = 0;
        while (
          dropped < maxDrop &&
          this.gear > 1 &&
          this.rpmAt(speedMph, this.gear - 1) < this.config.redline * 0.96
        ) {
          const next = this.rpmAt(speedMph, this.gear - 1);
          if (dropped > 0 && next >= this.config.redline * targetRpmFrac) break;
          this.gear -= 1;
          dropped += 1;
        }
        if (dropped > 0) {
          this.fireShift("down", now, true);
          this.kickdownUntil = now + 1000 + sport * 700 + sportPlus * 400;
          this.kickdownArmedUntil = 0;
          shift = "down";
        }
      } else if (!inKickdown) {
        // Earlier cruise ups for city/highway; hold lower under pull (Sport Plus)
        const accelBias = Math.max(0, Math.min(1, this.intentAccel / 6));
        const upFrac =
          this.intentAccel >= moderateAccel
            ? 0.62 + sport * 0.14 + accelBias * 0.1 + sportPlus * 0.06
            : 0.4 + sport * 0.08;
        const upRpm = this.config.redline * Math.min(0.92, upFrac);
        const cruiseCeil =
          this.intentAccel < 0.5
            ? this.config.redline * (0.38 + sport * 0.05)
            : Infinity;

        if (this.gear < maxGear && (rpm >= upRpm || rpm >= cruiseCeil)) {
          this.gear += 1;
          this.fireShift("up", now, false);
          shift = "up";
        } else if (this.gear > 1) {
          // Assertive rev-matched downs on lift/brake
          const downRpm =
            this.config.idleRpm +
            1200 +
            sport * 550 +
            sportPlus * 350 -
            Math.min(0, this.intentAccel) * 120;
          const clearLift = this.intentAccel <= liftThreshold;
          const lowRpm = rpm <= downRpm;
          if (clearLift || lowRpm) {
            const nextRpm = this.rpmAt(speedMph, this.gear - 1);
            const ceiling = clearLift
              ? 0.94 + sportPlus * 0.02
              : 0.86 + sport * 0.04;
            if (nextRpm < this.config.redline * Math.min(0.98, ceiling)) {
              this.gear -= 1;
              this.fireShift("down", now, false);
              shift = "down";
              // Chain a second down on hard brake / high Sport Plus
              if (
                clearLift &&
                sportPlus > 0.35 &&
                this.gear > 1 &&
                this.rpmAt(speedMph, this.gear - 1) < this.config.redline * 0.88
              ) {
                this.gear -= 1;
              }
            }
          }
        }
      } else {
        // Kickdown hold: stay in lower gears until near redline
        const holdUp = this.config.redline * (0.88 + sport * 0.06 + sportPlus * 0.04);
        if (this.gear < maxGear && rpm >= holdUp) {
          this.gear += 1;
          this.fireShift("up", now, false);
          shift = "up";
        }
      }
    }

    if (speedMph < 0.4) {
      this.gear = 1;
      this.kickdownUntil = 0;
      this.kickdownArmedUntil = 0;
    }

    const rpm = this.rpmAt(speedMph, this.gear);
    const kickBoost = now < this.kickdownUntil ? 0.28 : 0;
    const load = Math.max(
      0,
      Math.min(
        1,
        (this.smoothedAccel + 2.5) / 8.5 +
          speedMph / 120 +
          kickBoost +
          sport * 0.1,
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

  private updateEv(
    speedMph: number,
    sport: number,
    now: number,
  ): GearboxState {
    this.gear = 1;
    // Motor "rpm" climbs with road speed + accel load (continuous, no shifts)
    const base =
      speedMph < 0.35
        ? 400
        : (speedMph / this.config.mphPerThousandInTop) * 1000;
    const pull = Math.max(0, this.smoothedAccel) * (180 + sport * 120);
    const rpm = Math.max(
      400,
      Math.min(this.config.redline, base + pull),
    );
    const load = Math.max(
      0,
      Math.min(
        1,
        (this.smoothedAccel + 1.5) / 8 + speedMph / 110 + sport * 0.12,
      ),
    );
    // Clear any leftover ICE shift state
    this.pendingShift = null;
    this.kickdownUntil = 0;
    this.kickdownArmedUntil = 0;
    void now;
    return { gear: 1, rpm, shift: null, load, kickdown: false };
  }

  updateWithAggressiveness(
    speedMph: number,
    aggressiveness: number,
    now = performance.now(),
  ): GearboxState {
    this.aggressiveness = aggressiveness;
    return this.update(speedMph, now);
  }

  private fireShift(kind: ShiftKind, now: number, kickdown: boolean) {
    const sport = this.aggressiveness;
    this.pendingShift = kind;
    this.pendingShiftUntil =
      now + (kind === "up" ? 140 : kickdown ? 240 : 180 - sport * 40);
    this.shiftCooldownUntil =
      now +
      (kind === "up"
        ? 360
        : kickdown
          ? 520 - sport * 80
          : 400 - sport * 100);
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
