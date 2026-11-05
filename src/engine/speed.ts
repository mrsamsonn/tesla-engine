/** GPS + manual speed source for the engine sim. */

export type SpeedMode = "manual" | "gps";

export type SpeedReading = {
  mph: number;
  mps: number;
  mode: SpeedMode;
  gpsAvailable: boolean;
  gpsDenied: boolean;
  gpsAccuracy: number | null;
  statusText: string;
};

type Listener = (reading: SpeedReading) => void;

const MPS_TO_MPH = 2.23693629;

export class SpeedTracker {
  private mode: SpeedMode = "manual";
  private manualMph = 0;
  private gpsMph = 0;
  /** EMA of GPS mph to calm jitter before gearbox accel intent */
  private gpsSmoothedMph = 0;
  private gpsSmoothInitialized = false;
  private gpsAccuracy: number | null = null;
  private gpsAvailable = false;
  private gpsDenied = false;
  private watchId: number | null = null;
  private listeners = new Set<Listener>();
  private statusText = "Manual mode — drag the speed control";

  get reading(): SpeedReading {
    const mph =
      this.mode === "gps" && this.gpsAvailable
        ? this.gpsSmoothedMph
        : this.manualMph;
    return {
      mph,
      mps: mph / MPS_TO_MPH,
      mode: this.mode,
      gpsAvailable: this.gpsAvailable,
      gpsDenied: this.gpsDenied,
      gpsAccuracy: this.gpsAccuracy,
      statusText: this.statusText,
    };
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.reading);
    return () => this.listeners.delete(fn);
  }

  setMode(mode: SpeedMode) {
    this.mode = mode;
    if (mode === "gps") {
      this.startGps();
    } else {
      this.statusText = "Manual mode — drag the speed control";
      this.emit();
    }
  }

  setManualMph(mph: number) {
    this.manualMph = Math.max(0, Math.min(180, mph));
    if (this.mode === "manual") {
      this.statusText =
        this.manualMph < 0.5
          ? "Manual idle — raise speed to hear revs"
          : `Manual ${Math.round(this.manualMph)} mph`;
      this.emit();
    }
  }

  stop() {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private startGps() {
    if (!("geolocation" in navigator)) {
      this.gpsDenied = true;
      this.gpsAvailable = false;
      this.statusText = "Geolocation not supported — use Manual";
      this.mode = "manual";
      this.emit();
      return;
    }

    this.statusText = "Requesting location permission…";
    this.emit();

    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.gpsDenied = false;
        this.gpsAccuracy = pos.coords.accuracy;
        const speed = pos.coords.speed;
        if (speed == null || Number.isNaN(speed) || speed < 0) {
          this.gpsAvailable = true;
          this.gpsMph = 0;
          this.gpsSmoothedMph = 0;
          this.gpsSmoothInitialized = false;
          this.statusText =
            "GPS locked — speed unavailable while stationary (or browser withheld it). Drive, or use Manual.";
        } else {
          this.gpsAvailable = true;
          this.gpsMph = speed * MPS_TO_MPH;
          // Light EMA: enough to kill GPS noise, not enough to hide real kickdowns
          if (!this.gpsSmoothInitialized) {
            this.gpsSmoothedMph = this.gpsMph;
            this.gpsSmoothInitialized = true;
          } else {
            this.gpsSmoothedMph += (this.gpsMph - this.gpsSmoothedMph) * 0.28;
          }
          this.statusText = `GPS ${Math.round(this.gpsSmoothedMph)} mph · ±${Math.round(pos.coords.accuracy)} m`;
        }
        this.emit();
      },
      (err) => {
        this.gpsAvailable = false;
        this.gpsDenied = err.code === err.PERMISSION_DENIED;
        if (err.code === err.PERMISSION_DENIED) {
          this.statusText =
            "Location denied — enable location for this site, then tap GPS again. Using Manual for now.";
          this.mode = "manual";
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          this.statusText = "GPS unavailable — try again outdoors, or use Manual.";
        } else {
          this.statusText = "GPS timeout — retry or use Manual.";
        }
        this.emit();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 15000,
      },
    );
  }

  private emit() {
    const r = this.reading;
    for (const fn of this.listeners) fn(r);
  }
}
