/** Road-speed gear maps: Porsche PDK Sport + Ferrari V12 + EV continuous. */

export type EngineConfig = {
  idleRpm: number;
  redline: number;
  /** mph per 1000 rpm in the ratio=1 gear */
  mphPerThousandInTop: number;
  gearRatios: number[];
  continuous?: boolean;
  /** Shift personality */
  character?: "pdk" | "ferrari";
};

/** Porsche PDK Sports — 7-speed, road fun through 65–85 mph. */
export const PORSCHE_CONFIG: EngineConfig = {
  idleRpm: 800,
  redline: 7800,
  mphPerThousandInTop: 32,
  // Spaced so each gear covers a useful city→highway band
  gearRatios: [4.0, 2.7, 1.95, 1.5, 1.2, 1.0, 0.84],
  character: "pdk",
};

/** Ferrari exotic V12 — high-strung, still shifts at road speeds. */
export const FERRARI_CONFIG: EngineConfig = {
  idleRpm: 900,
  redline: 9000,
  mphPerThousandInTop: 30,
  gearRatios: [3.8, 2.6, 1.9, 1.45, 1.15, 0.95, 0.8],
  character: "ferrari",
};

/** @deprecated use PORSCHE_CONFIG */
export const V8_CONFIG = PORSCHE_CONFIG;
/** @deprecated use FERRARI_CONFIG */
export const V12_CONFIG = FERRARI_CONFIG;

export const EV_CONFIG: EngineConfig = {
  idleRpm: 0,
  redline: 16000,
  mphPerThousandInTop: 12,
  gearRatios: [1],
  continuous: true,
};

export type ShiftKind = "up" | "down" | null;

export type GearboxState = {
  gear: number;
  rpm: number;
  shift: ShiftKind;
  load: number;
  kickdown: boolean;
};

/**
 * PDK/Ferrari ICE maps with hysteresis so we climb the box and don't
 * bounce back into 2nd/3rd after every upshift. Kickdowns stay accel-driven.
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
  /** Block RPM-only downs briefly after an upshift (anti-hunt). */
  private upshiftHoldUntil = 0;

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
    this.upshiftHoldUntil = 0;
  }

  update(speedMph: number, now = performance.now()): GearboxState {
    const dt = Math.max(0.016, Math.min(0.25, (now - this.lastTs) / 1000));
    const rawAccel = Math.max(
      -18,
      Math.min(22, (speedMph - this.lastSpeedMph) / dt),
    );
    this.smoothedAccel +=
      (rawAccel - this.smoothedAccel) * Math.min(1, dt * 5);
    this.intentAccel +=
      (rawAccel - this.intentAccel) * Math.min(1, dt * 2.2);
    this.lastSpeedMph = speedMph;
    this.lastTs = now;

    const sport = Math.max(0, Math.min(1, this.aggressiveness));
    const sportPlus = sport * sport;
    const pdk = this.config.character !== "ferrari";

    if (this.config.continuous) {
      return this.updateEv(speedMph, sport, now);
    }

    const kickThreshold = (pdk ? 3.8 : 4.2) - sport * 2.0 - sportPlus * 0.9;
    const moderateAccel = 0.85 + sport * 0.45;
    const liftThreshold = -1.0 - sport * 0.85 - sportPlus * 0.55;
    const inKickdown = now < this.kickdownUntil;

    if (this.intentAccel >= kickThreshold) {
      if (this.kickdownArmedUntil === 0) {
        this.kickdownArmedUntil = now + Math.max(35, 90 - sport * 50);
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

    if (now >= this.shiftCooldownUntil && speedMph > 0.4) {
      const maxGear = this.config.gearRatios.length;
      let rpm = this.rpmAt(speedMph, this.gear);

      const kickReady =
        this.kickdownArmedUntil > 0 && now >= this.kickdownArmedUntil;

      if (kickReady && this.gear > 1 && this.intentAccel >= kickThreshold) {
        const targetFrac = 0.7 + sport * 0.14 + sportPlus * 0.05;
        const maxDrop = 1 + Math.floor(sport * 2 + sportPlus);
        let dropped = 0;
        while (
          dropped < maxDrop &&
          this.gear > 1 &&
          this.rpmAt(speedMph, this.gear - 1) < this.config.redline * 0.96
        ) {
          const next = this.rpmAt(speedMph, this.gear - 1);
          if (dropped > 0 && next >= this.config.redline * targetFrac) break;
          this.gear -= 1;
          dropped += 1;
        }
        if (dropped > 0) {
          this.fireShift("down", now, true);
          this.kickdownUntil = now + 900 + sport * 600 + sportPlus * 350;
          this.kickdownArmedUntil = 0;
          this.upshiftHoldUntil = 0;
          shift = "down";
        }
      } else if (!inKickdown) {
        // --- Upshifts: climb the box; allow multi-step catch-up for slider/GPS jumps ---
        const pulling = this.intentAccel >= moderateAccel;
        const upFrac = pulling
          ? (pdk ? 0.58 : 0.64) + sport * 0.12 + sportPlus * 0.05
          : (pdk ? 0.36 : 0.4) + sport * 0.06;
        const upRpm = this.config.redline * Math.min(0.9, upFrac);
        // Soft cruise ceiling — always available so we aren't stuck waiting for redline
        const cruiseCeil =
          this.config.redline *
          ((pdk ? 0.34 : 0.36) + sport * 0.04 + (pulling ? 0.12 : 0));

        let ups = 0;
        const maxUps = pulling ? 1 : 3; // cruise catch-up through several gears
        while (
          ups < maxUps &&
          this.gear < maxGear &&
          (this.rpmAt(speedMph, this.gear) >= upRpm ||
            this.rpmAt(speedMph, this.gear) >= cruiseCeil)
        ) {
          // Don't upshift into a landing RPM below a healthy cruise floor
          const landing = this.rpmAt(speedMph, this.gear + 1);
          if (landing < this.config.idleRpm + 500 && speedMph > 8) break;
          this.gear += 1;
          ups += 1;
        }
        if (ups > 0) {
          this.fireShift("up", now, false);
          this.upshiftHoldUntil = now + 550 + sport * 150;
          shift = "up";
        } else if (this.gear > 1 && now >= this.upshiftHoldUntil) {
          // --- Downs: prefer clear lift; lug-downs only at very low RPM ---
          rpm = this.rpmAt(speedMph, this.gear);
          const clearLift = this.intentAccel <= liftThreshold;
          // Lug floor sits well below post-upshift landing RPM (anti-stuck-in-2nd)
          const lugRpm =
            this.config.idleRpm + 350 + sport * 150 - (pdk ? 0 : 50);
          const lowRpm = rpm <= lugRpm && this.intentAccel < 0.35;

          if (clearLift || lowRpm) {
            const nextRpm = this.rpmAt(speedMph, this.gear - 1);
            const ceiling = clearLift
              ? 0.92 + sportPlus * 0.04
              : 0.78;
            if (nextRpm < this.config.redline * Math.min(0.97, ceiling)) {
              this.gear -= 1;
              this.fireShift("down", now, false);
              shift = "down";
              if (
                clearLift &&
                sportPlus > 0.4 &&
                this.gear > 1 &&
                this.rpmAt(speedMph, this.gear - 1) <
                  this.config.redline * 0.86
              ) {
                this.gear -= 1;
              }
            }
          }
        }

        // Speed-band safety: if somehow still in a too-low gear at highway, nudge up
        if (shift === null && this.gear < maxGear && !pulling) {
          const minGear = this.minGearForSpeed(speedMph);
          if (this.gear < minGear) {
            this.gear = Math.min(maxGear, minGear);
            this.fireShift("up", now, false);
            this.upshiftHoldUntil = now + 400;
            shift = "up";
          }
        }
      } else {
        // Kickdown hold — upshift only near redline
        rpm = this.rpmAt(speedMph, this.gear);
        const holdUp =
          this.config.redline * (0.86 + sport * 0.06 + sportPlus * 0.04);
        if (this.gear < maxGear && rpm >= holdUp) {
          this.gear += 1;
          this.fireShift("up", now, false);
          this.upshiftHoldUntil = now + 400;
          shift = "up";
        }
      }
    }

    if (speedMph < 0.4) {
      this.gear = 1;
      this.kickdownUntil = 0;
      this.kickdownArmedUntil = 0;
      this.upshiftHoldUntil = 0;
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

  /** Lowest gear we should be in at steady cruise for this speed (1-indexed). */
  private minGearForSpeed(speedMph: number): number {
    const maxGear = this.config.gearRatios.length;
    // Progressive bands — by ~75 mph we should be in upper gears
    const bands =
      maxGear >= 7
        ? [0, 10, 20, 32, 45, 58, 70, 85]
        : [0, 12, 24, 38, 52, 68, 85];
    let g = 1;
    for (let i = 1; i < bands.length && i < maxGear; i++) {
      if (speedMph >= bands[i]!) g = i + 1;
    }
    return Math.min(maxGear, g);
  }

  private updateEv(
    speedMph: number,
    sport: number,
    now: number,
  ): GearboxState {
    this.gear = 1;
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
    const pdk = this.config.character !== "ferrari";
    this.pendingShift = kind;
    // PDK Sports: snappier upshift cutouts
    const upFlash = pdk ? 110 : 140;
    this.pendingShiftUntil =
      now + (kind === "up" ? upFlash : kickdown ? 240 : 170);
    this.shiftCooldownUntil =
      now +
      (kind === "up"
        ? pdk
          ? 280
          : 340
        : kickdown
          ? 480 - sport * 60
          : 360 - sport * 80);
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
