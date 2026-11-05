import "./style.css";
import { EngineSynth, type EngineType } from "./engine/synthesis";
import { Gearbox, V8_CONFIG, V12_CONFIG, EV_CONFIG } from "./engine/gearbox";
import { SpeedTracker, type SpeedMode } from "./engine/speed";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <div class="shell">
    <header class="brand-row">
      <h1 class="brand">Tesla<span>Engine</span></h1>
      <p class="tagline">Virtual exhaust</p>
    </header>

    <section class="hero-gauge" id="gauge">
      <div class="gauge-grid">
        <div class="dial">
          <div class="dial-label">Speed</div>
          <div class="dial-value" id="speedReadout">0</div>
          <div class="dial-unit">mph</div>
        </div>
        <div class="side-stats">
          <div class="stat">
            <span class="stat-k" id="rpmLabel">RPM</span>
            <span class="stat-v" id="rpmReadout">750</span>
          </div>
          <div class="stat">
            <span class="stat-k" id="gearLabel">Gear</span>
            <span class="stat-v accent" id="gearReadout">1</span>
          </div>
          <div class="stat">
            <span class="stat-k">Engine</span>
            <span class="stat-v" id="engineReadout">V8</span>
          </div>
          <div class="stat">
            <span class="stat-k">Source</span>
            <span class="stat-v" id="sourceReadout">Manual</span>
          </div>
        </div>
      </div>
      <div class="rpm-bar" aria-hidden="true"><div class="rpm-fill" id="rpmFill"></div></div>
    </section>

    <div class="engage-wrap">
      <button type="button" class="engage" id="engageBtn">Start / Engage</button>
      <div class="status" id="status">Tap Start to unlock audio, then pick GPS or Manual speed.</div>
    </div>

    <section class="panel">
      <h2>Drive input</h2>
      <div class="seg" role="group" aria-label="Speed source">
        <button type="button" id="modeManual" class="active">Manual</button>
        <button type="button" id="modeGps">GPS</button>
      </div>
      <div class="control" id="manualControl">
        <div class="control-label">
          <span>Demo speed</span>
          <strong id="manualLabel">0 mph</strong>
        </div>
        <input id="speedSlider" type="range" min="0" max="140" step="0.5" value="0" />
      </div>
      <p class="tips">
        <strong>In a Tesla:</strong> allow location for this site, keep the car moving for GPS speed,
        and leave this tab visible. Manual mode works parked for testing.
      </p>
    </section>

    <section class="panel">
      <h2>Engine</h2>
      <div class="seg three" role="group" aria-label="Engine type">
        <button type="button" id="engV8" class="active">V8</button>
        <button type="button" id="engV12">V12</button>
        <button type="button" id="engEv">EV</button>
      </div>
      <div class="control">
        <div class="control-label">
          <span>Volume</span>
          <strong id="volLabel">70%</strong>
        </div>
        <input id="volSlider" type="range" min="0" max="100" step="1" value="70" />
      </div>
      <div class="control">
        <div class="control-label">
          <span>Sportiness</span>
          <strong id="aggLabel">55%</strong>
        </div>
        <input id="aggSlider" type="range" min="0" max="100" step="1" value="55" />
      </div>
      <p class="tips">
        V8/V12: PDK Sport Plus kickdowns — raise Sportiness for eager downs.
        EV: continuous motor whine with speed/accel (no gears).
      </p>
    </section>

    <p class="tips">
      Tip: if the cabin screen sleeps, re-open this page and tap Start again.
      Wake Lock is requested when supported to help keep the display awake.
    </p>
  </div>
`;

const synth = new EngineSynth();
const speed = new SpeedTracker();
let gearbox = new Gearbox(V8_CONFIG);

let engine: EngineType = "v8";
let volume = 0.7;
let aggressiveness = 0.55;
let engaged = false;
let wakeLock: WakeLockSentinel | null = null;
let lastShiftFlash = 0;

const el = {
  engageBtn: qs<HTMLButtonElement>("#engageBtn"),
  status: qs<HTMLElement>("#status"),
  speedReadout: qs<HTMLElement>("#speedReadout"),
  rpmReadout: qs<HTMLElement>("#rpmReadout"),
  gearReadout: qs<HTMLElement>("#gearReadout"),
  engineReadout: qs<HTMLElement>("#engineReadout"),
  sourceReadout: qs<HTMLElement>("#sourceReadout"),
  rpmFill: qs<HTMLElement>("#rpmFill"),
  gauge: qs<HTMLElement>("#gauge"),
  modeManual: qs<HTMLButtonElement>("#modeManual"),
  modeGps: qs<HTMLButtonElement>("#modeGps"),
  speedSlider: qs<HTMLInputElement>("#speedSlider"),
  manualLabel: qs<HTMLElement>("#manualLabel"),
  engV8: qs<HTMLButtonElement>("#engV8"),
  engV12: qs<HTMLButtonElement>("#engV12"),
  engEv: qs<HTMLButtonElement>("#engEv"),
  rpmLabel: qs<HTMLElement>("#rpmLabel"),
  gearLabel: qs<HTMLElement>("#gearLabel"),
  volSlider: qs<HTMLInputElement>("#volSlider"),
  volLabel: qs<HTMLElement>("#volLabel"),
  aggSlider: qs<HTMLInputElement>("#aggSlider"),
  aggLabel: qs<HTMLElement>("#aggLabel"),
};

function engineLabel(t: EngineType): string {
  return t === "ev" ? "EV" : t === "v12" ? "V12" : "V8";
}

function configFor(t: EngineType) {
  return t === "ev" ? EV_CONFIG : t === "v12" ? V12_CONFIG : V8_CONFIG;
}

function qs<T extends Element>(sel: string): T {
  return document.querySelector(sel) as T;
}

function setStatus(text: string, kind: "" | "warn" | "ok" = "") {
  el.status.textContent = text;
  el.status.className = `status${kind ? ` ${kind}` : ""}`;
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    /* unsupported or denied — tip already in UI */
  }
}

el.engageBtn.addEventListener("click", async () => {
  if (!engaged) {
    await synth.engage();
    engaged = true;
    el.engageBtn.textContent = "Engine Live";
    el.engageBtn.classList.add("running");
    el.gauge.classList.add("pulse-on");
    setStatus("Engine live — raise speed (Manual) or enable GPS while driving.", "ok");
    await requestWakeLock();
  } else {
    await synth.suspend();
    engaged = false;
    el.engageBtn.textContent = "Start / Engage";
    el.engageBtn.classList.remove("running");
    el.gauge.classList.remove("pulse-on");
    setStatus("Audio paused. Tap Start to engage again.");
    wakeLock?.release().catch(() => undefined);
    wakeLock = null;
  }
});

function setMode(mode: SpeedMode) {
  speed.setMode(mode);
  el.modeManual.classList.toggle("active", mode === "manual");
  el.modeGps.classList.toggle("active", mode === "gps");
  el.sourceReadout.textContent = mode === "gps" ? "GPS" : "Manual";
}

el.modeManual.addEventListener("click", () => setMode("manual"));
el.modeGps.addEventListener("click", () => {
  setMode("gps");
  setStatus("Requesting location… Allow access when prompted.", "warn");
});

el.speedSlider.addEventListener("input", () => {
  const mph = Number(el.speedSlider.value);
  speed.setManualMph(mph);
  el.manualLabel.textContent = `${Math.round(mph)} mph`;
});

function setEngineType(next: EngineType) {
  engine = next;
  synth.setEngine(next);
  gearbox = new Gearbox(configFor(next));
  el.engV8.classList.toggle("active", next === "v8");
  el.engV12.classList.toggle("active", next === "v12");
  el.engEv.classList.toggle("active", next === "ev");
  el.engineReadout.textContent = engineLabel(next);
  el.rpmLabel.textContent = next === "ev" ? "Motor" : "RPM";
  el.gearLabel.textContent = next === "ev" ? "Drive" : "Gear";
}

el.engV8.addEventListener("click", () => setEngineType("v8"));
el.engV12.addEventListener("click", () => setEngineType("v12"));
el.engEv.addEventListener("click", () => setEngineType("ev"));

el.volSlider.addEventListener("input", () => {
  volume = Number(el.volSlider.value) / 100;
  el.volLabel.textContent = `${Math.round(volume * 100)}%`;
});

el.aggSlider.addEventListener("input", () => {
  aggressiveness = Number(el.aggSlider.value) / 100;
  el.aggLabel.textContent = `${Math.round(aggressiveness * 100)}%`;
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && engaged) {
    await synth.engage();
    await requestWakeLock();
  }
});

speed.subscribe((reading) => {
  if (reading.mode === "gps") {
    if (reading.gpsDenied) {
      setStatus(reading.statusText, "warn");
      el.modeManual.classList.add("active");
      el.modeGps.classList.remove("active");
      el.sourceReadout.textContent = "Manual";
    } else {
      setStatus(reading.statusText, reading.gpsAvailable ? "ok" : "warn");
    }
  } else if (!engaged) {
    /* keep engage prompt */
  } else {
    setStatus(reading.statusText);
  }
});

const redline = () => configFor(engine).redline;

function frame() {
  const reading = speed.reading;
  const mph = reading.mph;
  const gb = gearbox.updateWithAggressiveness(mph, aggressiveness);
  const rl = redline();
  const idleFloor = engine === "ev" ? 400 : 600;

  el.speedReadout.textContent = String(Math.round(mph));
  el.rpmReadout.textContent = String(Math.round(gb.rpm));
  el.gearReadout.textContent = engine === "ev" ? "D" : String(gb.gear);

  const pct = Math.min(100, ((gb.rpm - idleFloor) / (rl - idleFloor)) * 100);
  el.rpmFill.style.width = `${pct}%`;
  el.speedReadout.classList.toggle("hot", gb.rpm > rl * 0.92);

  if (gb.shift && performance.now() - lastShiftFlash > 160) {
    lastShiftFlash = performance.now();
    el.gauge.classList.remove("shift-flash");
    void el.gauge.offsetWidth;
    el.gauge.classList.add("shift-flash");
  }
  el.gauge.classList.toggle("kickdown", gb.kickdown);

  if (engaged) {
    synth.update({
      engine,
      rpm: gb.rpm,
      load: gb.load,
      volume,
      aggressiveness,
      shifting: gb.shift,
    });
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
