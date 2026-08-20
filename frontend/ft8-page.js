"use strict";

(() => {
  const id = (name) => document.getElementById(name);
  const LOCAL_GUI_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
  const IS_LOCAL_GUI = LOCAL_GUI_HOSTS.has(window.location.hostname);
  const TX_AUDIO_CENTER_HZ = 1500;
  const DF_LOW = 200;
  const DF_HIGH = 3000;
  const AUDIO_CHANNEL_NAME = "freerig710-audio-owner-v1";
  const SLOT_MS = 15_000;
  const AUTO_TX_ARM_LEAD_MS = 700;
  const AUTO_TX_ACTIVE_GRACE_MS = 2200;
  const AUTO_TX_STAGE_LEAD_MS = 9000;
  // Same-slot late entry: allow the selected EVEN/ODD slot while a complete
  // 12.64 s FT8 waveform can still finish safely before the following 15 s
  // boundary. The ESP32 keeps a slightly wider acceptance window for HTTP/CAT
  // validation latency; it remains authoritative for the hard deadline.
  const AUTO_TX_MAX_LATE_MS = 1450;
  const AUTO_TX_ARM_STALE_RECOVERY_MS = 3200;
  const AUTO_TX_MAX_REPEATS = 6;
  const TX_AUDIO_CONTEXT_RATE = 48000;
  const TX_CAPTURE_FRAME_MS = 20;
  const TX_WS_BACKLOG_LIMIT = 32768;
  const OWNER_ID = `ft8-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function normalizeBackend(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const url = new URL(withScheme);
      if (!/^https?:$/.test(url.protocol)) return "";
      return `${url.protocol}//${url.host}`;
    } catch (_) { return ""; }
  }

  let savedBackend = "";
  try { savedBackend = localStorage.getItem("freerig710-backend") || ""; } catch (_) {}
  const defaultBackend = normalizeBackend(window.FT710_CONFIG?.localDefaultBackend || "http://ft710.local");
  const API_BASE = IS_LOCAL_GUI ? (normalizeBackend(savedBackend) || defaultBackend) : "";

  const apiUrl = (path) => `${API_BASE}${String(path || "").startsWith("/") ? path : `/${path}`}`;
  const websocketUrl = (path) => {
    const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
    const base = API_BASE || window.location.origin;
    const url = new URL(normalizedPath, `${base.replace(/\/$/, "")}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  };
  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "text/plain;charset=UTF-8");
    const response = await fetch(apiUrl(path), { ...options, method, headers, cache: method === "GET" ? "no-store" : options.cache });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload?.detail || `HTTP ${response.status}`);
    return payload;
  }
  const post = (path, payload, options = {}) => api(path, { method: "POST", body: JSON.stringify(payload), ...options });
  window.FreeRig710API = Object.freeze({ api, post, apiUrl, websocketUrl });

  const formatHz = (hz) => Number.isFinite(Number(hz)) ? `${(Number(hz) / 1e6).toFixed(6)} MHz` : "--.---.---";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let toastTimer = null;
  function toast(message, error = false) {
    const el = id("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3200);
  }

  const page = {
    activeBand: null,
    dialHz: null,
    txDfHz: 1500,
    txSlotParity: 0,
    state: null,
    stateTimer: null,
    autoGainTimer: null,
    autoGainBusy: false,
    rfGainSlopeDbPerStep: null,
    rfGainPending: null,
    rfGainSettleUntil: 0,
    configuring: false,
    socket: null,
    audioReady: false,
    audioStarting: false,
    audioRate: 48000,
    audioChannel: null,
    lastRadioPower: null,
    radioRearmPending: false,
    levelHistory: [],
    txLevelDbfs: null,
    txLevelTuned: false,
    txPowerW: null,
    powerDragging: false,
    powerControlBusy: false,
    powerPendingW: null,
    powerPendingUntil: 0,
    powerSendTimer: null,
    powerRequestSeq: 0,
    rfGainDragging: false,
    rfGainControlBusy: false,
    rfGainManualPending: null,
    rfGainManualPendingUntil: 0,
    rfGainSendTimer: null,
    rfGainRequestSeq: 0,
    tuneRunning: false,
    tuneAbortRequested: false,
    tuneToneActive: false,
    tuneToneLevelDbfs: -32,
    tuneTonePhase: 0,
    tuneKeepaliveTimer: null,
    tuneStopping: null,
    txAudioContext: null,
    txCaptureNode: null,
    txSilentGain: null,
    txClockCaptureEnabled: false,
    txClockSourceNode: null,
    txClockGainNode: null,
    txClockFramesSent: 0,
    txClockBytesSent: 0,
    txClockBacklogFault: false,
    txWaveform: null,
    txStageWaveform: null,
    txWaveformMeta: null,
    txPlanMessage: "",
    txPlanRevision: 0,
    txStreaming: false,
    txAbortRequested: false,
    txSource: "NONE",
    txSourceWaiter: null,
    waveUploadSeq: 1,
    waveBeginWaiter: null,
    waveReadyWaiter: null,
    stagedWaveformId: 0,
    stagedWaveformKey: "",
    stagedWaveformMessage: "",
    stagedWaveformRevision: 0,
    autoTxEnabled: false,
    autoTxPreparing: false,
    autoTxSchedulerTimer: null,
    autoTxArming: false,
    autoTxSessionActive: false,
    autoTxTargetSlotIndex: null,
    autoTxLastSlotIndex: null,
    autoTxKeepaliveTimer: null,
    autoTxActiveWaiter: null,
    autoTxIdleWaiter: null,
    autoTxLastMessage: "",
    autoTxRepeatCount: 0,
    autoTxLastStartDelayMs: null,
    autoTxBackend: null,
    autoTxHaltPromise: null,
    autoTxPreparePromise: null,
    autoTxPreparePromiseKey: "",
    staleArmCancelPromise: null,
    armedTxMessage: "",
    armedWaveformId: 0,
    armedSlotIndex: null,
    armedPlanRevision: 0,
    autoTxSchedulerBusy: false,
    autoTxArmingSinceMs: 0,
    autoTxLastRecoveryCheckMs: 0,
    txVfoApplyPromise: null,
    txVfoApplyGeneration: 0,
    txVfoAppliedGeneration: 0,
    autoTxStagePromise: null,
    autoTxStagePromiseKey: "",
    qsoFinishPromise: null,
    lastLoggedQsoKey: "",

    init() {
      window.FT710_FT8?.init();
      window.FT710_FT8?.setControlSender((payload) => this.sendAudioControl(payload));
      try {
        this.txDfHz = clamp(Number(localStorage.getItem("freerig710-ft8-tx-df-v1")) || 1500, DF_LOW, DF_HIGH);
        this.txSlotParity = Number(localStorage.getItem("freerig710-ft8-tx-slot-v1")) & 1;
        const target = Number(localStorage.getItem("freerig710-ft8-rf-target-v1"));
        if (Number.isFinite(target) && target >= -70 && target <= -30) id("ft8-rf-target").value = String(target);
        const auto = localStorage.getItem("freerig710-ft8-auto-rf-v1");
        if (auto != null) id("ft8-auto-rf").checked = auto === "1";
      } catch (_) {}
      id("ft8-tx-slot-select").value = String(this.txSlotParity);
      window.FT710_FT8?.setTxSlotParity(this.txSlotParity);
      this.syncWaterfallAxis();
      this.updateTxPlan(false);
      id("ft8-tx-level-label").textContent = "not tuned";
      id("ft8-tune-tx").disabled = true;
      this.qsoPlanChanged(window.FT710_FT8?.getTxPlan?.() || {});

      id("ft8-band-select").addEventListener("change", (event) => void this.selectBand(event.currentTarget));
      document.querySelectorAll("[data-ft8-band]").forEach(button=>button.addEventListener("click",()=>{const select=id("ft8-band-select");if(!select)return;select.value=button.dataset.ft8Band||"";select.dispatchEvent(new Event("change",{bubbles:true}));}));
      this.syncBandButtons(id("ft8-band-select")?.value||"");
      id("ft8-waterfall-hitbox").addEventListener("click", (event) => void this.selectWaterfallDf(event));
      id("ft8-tx-slot-select").addEventListener("change", (event) => {
        this.txSlotParity = Number(event.currentTarget.value) & 1;
        try { localStorage.setItem("freerig710-ft8-tx-slot-v1", String(this.txSlotParity)); } catch (_) {}
        window.FT710_FT8?.setTxSlotParity(this.txSlotParity);
        this.autoTxTargetSlotIndex = null;
        this.renderAutoTxState();
      });
      id("ft8-rf-target").addEventListener("change", (event) => {
        const value = clamp(Math.round(Number(event.currentTarget.value) || -50), -70, -30);
        event.currentTarget.value = String(value);
        try { localStorage.setItem("freerig710-ft8-rf-target-v1", String(value)); } catch (_) {}
      });
      id("ft8-auto-rf").addEventListener("change", (event) => {
        const automatic = event.currentTarget.checked;
        try { localStorage.setItem("freerig710-ft8-auto-rf-v1", automatic ? "1" : "0"); } catch (_) {}
        const slider = id("ft8-rf-gain-slider");
        if (slider) slider.disabled = automatic || this.tuneRunning;
        this.levelHistory.length = 0;
        this.rfGainPending = null;
      });

      const powerInput = id("ft8-tx-power");
      powerInput?.addEventListener("input", (event) => {
        this.powerDragging = true;
        const value = clamp(Math.round(Number(event.currentTarget.value) || 5), 5, 100);
        this.setPowerOptimistic(value);
        clearTimeout(this.powerSendTimer);
        this.powerSendTimer = setTimeout(() => void this.setFt8Power(value), 250);
      });
      powerInput?.addEventListener("change", (event) => {
        this.powerDragging = false;
        const value = clamp(Math.round(Number(event.currentTarget.value) || 5), 5, 100);
        clearTimeout(this.powerSendTimer);
        this.powerSendTimer = null;
        void this.setFt8Power(value);
      });
      powerInput?.addEventListener("pointerup", () => { this.powerDragging = false; });

      const rfGainInput = id("ft8-rf-gain-slider");
      if (rfGainInput) {
        rfGainInput.disabled = Boolean(id("ft8-auto-rf")?.checked);
        rfGainInput.addEventListener("input", (event) => {
          this.rfGainDragging = true;
          const value = clamp(Math.round(Number(event.currentTarget.value) || 0), 0, 255);
          this.setRfGainOptimistic(value);
          clearTimeout(this.rfGainSendTimer);
          this.rfGainSendTimer = setTimeout(() => void this.setManualRfGain(value), 250);
        });
        rfGainInput.addEventListener("change", (event) => {
          this.rfGainDragging = false;
          const value = clamp(Math.round(Number(event.currentTarget.value) || 0), 0, 255);
          clearTimeout(this.rfGainSendTimer);
          this.rfGainSendTimer = null;
          void this.setManualRfGain(value);
        });
        rfGainInput.addEventListener("pointerup", () => { this.rfGainDragging = false; });
      }
      id("ft8-tune-tx")?.addEventListener("click", () => void this.runAlcTune());
      id("ft8-stop-tune")?.addEventListener("click", () => void this.stopAlcTune("operator stop"));
      id("ft8-generate-wave")?.addEventListener("click", () => void this.generateTxWaveform());
      id("ft8-send-wave")?.addEventListener("click", () => void this.sendTxWaveform());
      id("ft8-stop-wave")?.addEventListener("click", () => void this.stopTxWaveform("halt requested"));
      id("ft8-enable-tx")?.addEventListener("click", () => void this.enableAutoTx());
      id("ft8-halt-tx")?.addEventListener("click", () => { window.FT710_FT8?.abortQso?.("Halt TX"); void this.haltAutoTx("operator halt"); });
      window.FT710_FT8?.preloadEncoder?.();

      if (typeof BroadcastChannel !== "undefined") {
        this.audioChannel = new BroadcastChannel(AUDIO_CHANNEL_NAME);
        this.audioChannel.onmessage = (event) => {
          const msg = event.data;
          if (!msg || msg.type !== "claim" || msg.owner === OWNER_ID) return;
          if (this.socket || this.audioStarting) {
            this.closeAudio(`Audio moved to ${msg.source || "another FreeRig710 tab"}`);
            toast("Audio moved to another FreeRig710 tab", true);
          }
        };
      }

      this.stateTimer = setInterval(() => void this.pollState(), 750);
      this.autoGainTimer = setInterval(() => void this.autoAdjustRfGain(), 300);
      this.autoTxSchedulerTimer = setInterval(() => {
        if (this.autoTxSchedulerBusy) return;
        this.autoTxSchedulerBusy = true;
        Promise.resolve(this.autoTxSchedulerTick())
          .catch((error) => {
            const reason = error?.message || String(error);
            console.error("FT8 auto-TX scheduler:", error);
            id("ft8-tx-progress") && (id("ft8-tx-progress").textContent = `scheduler · ${reason}`);
          })
          .finally(() => { this.autoTxSchedulerBusy = false; });
      }, 100);
      this.renderAutoTxState();
      void this.pollState();
    },

    claimAudio() {
      this.audioChannel?.postMessage({ type: "claim", owner: OWNER_ID, source: "FT8" });
    },

    async pollState() {
      try {
        const result = await api("/api/v1/state");
        this.state = result;
        const power = result?.radio_power || "--";
        const radioBadge = id("ft8-radio-state");
        radioBadge.textContent = `RADIO ${power}`;
        radioBadge.classList.toggle("live", power === "ON");
        radioBadge.classList.toggle("error", power === "OFF");
        const radioRfGain = Number(result?.rf_gain);
        if (Number.isFinite(radioRfGain)) {
          const actualRfGain = clamp(Math.round(radioRfGain), 0, 255);
          const gainReadout = id("ft8-rf-gain");
          gainReadout.textContent = `${actualRfGain} / 255`;
          gainReadout.title = Number.isFinite(this.rfGainSlopeDbPerStep)
            ? `Auto RF Gain model: ${this.rfGainSlopeDbPerStep.toFixed(3)} dB/step`
            : "Auto RF Gain model: learning";
          if (this.rfGainManualPending != null && actualRfGain === this.rfGainManualPending) {
            this.rfGainManualPending = null;
            this.rfGainManualPendingUntil = 0;
          }
          const preserveManualRf = this.rfGainDragging || this.rfGainControlBusy ||
            (this.rfGainManualPending != null && Date.now() < this.rfGainManualPendingUntil);
          if (!preserveManualRf) {
            this.rfGainManualPending = null;
            this.rfGainManualPendingUntil = 0;
            id("ft8-rf-gain-slider").value = String(actualRfGain);
            id("ft8-rf-gain-slider-label").textContent = String(actualRfGain);
          }
        } else {
          const gainReadout = id("ft8-rf-gain");
          gainReadout.textContent = "-- / 255";
          gainReadout.title = "Auto RF Gain unavailable";
          if (!this.rfGainDragging) id("ft8-rf-gain-slider-label").textContent = "--";
        }
        const rfSlider = id("ft8-rf-gain-slider");
        if (rfSlider) rfSlider.disabled = Boolean(id("ft8-auto-rf")?.checked) || this.tuneRunning || power !== "ON";

        const radioPower = Number(result?.tx_power_w);
        if (Number.isFinite(radioPower) && !this.tuneRunning) {
          const actualPower = clamp(Math.round(radioPower), 5, 100);
          if (this.powerPendingW != null && actualPower === this.powerPendingW) {
            this.powerPendingW = null;
            this.powerPendingUntil = 0;
          }
          const preservePower = this.powerDragging || this.powerControlBusy ||
            (this.powerPendingW != null && Date.now() < this.powerPendingUntil);
          if (!preservePower) {
            this.powerPendingW = null;
            this.powerPendingUntil = 0;
            this.txPowerW = actualPower;
            id("ft8-tx-power").value = String(actualPower);
            id("ft8-tx-power-label").textContent = `${actualPower} W`;
          }
        }
        if (this.txStreaming && !this.autoTxSessionActive && (result?.ptt_active || result?.tx_state === "TX")) void this.stopTxWaveform("Radio left RX during FT8 waveform test");
        if (this.autoTxEnabled && power !== "ON") void this.haltAutoTx("radio powered off");

        if (this.lastRadioPower && this.lastRadioPower !== "ON" && power === "ON" && this.activeBand && !this.configuring) {
          this.radioRearmPending = true;
          setTimeout(() => { if (this.radioRearmPending) void this.configureRadioForFt8(true); }, 900);
        }
        if (power !== "ON") {
          this.radioRearmPending = false;
          if (this.tuneRunning) void this.stopAlcTune("radio powered off");
          if (this.audioReady || this.audioStarting) this.closeAudio("Radio is not ON");
        }
        this.lastRadioPower = power;
      } catch (error) {
        const radioBadge = id("ft8-radio-state");
        radioBadge.textContent = "RADIO OFFLINE";
        radioBadge.classList.add("error");
      }
    },

    syncBandButtons(band=this.activeBand||"") {
      document.querySelectorAll("[data-ft8-band]").forEach(button=>{const active=button.dataset.ft8Band===band;button.classList.toggle("active",active);button.setAttribute("aria-pressed",active?"true":"false");});
    },

    async selectBand(select) {
      if (this.tuneRunning) { toast("Stop TX Tune before changing band", true); return; }
      if (this.autoTxEnabled || this.autoTxArming || this.autoTxSessionActive) await this.haltAutoTx("band changed");
      const option = select.selectedOptions[0];
      const band = select.value;
      const dialHz = Number(option?.dataset?.hz);
      if (!band || !Number.isFinite(dialHz)) return;
      const bandChanged = this.activeBand && this.activeBand !== band;
      this.activeBand = band;
      this.dialHz = dialHz;
      this.syncBandButtons(band);
      this.rfGainPending = null;
      this.rfGainSettleUntil = 0;
      this.levelHistory.length = 0;
      this.loadRfGainModel(band);
      this.loadTxCalibration(band);
      try { localStorage.setItem("freerig710-ft8-band-v1", band); } catch (_) {}
      if (bandChanged) {
        window.FT710_FT8?.resetQso?.();
        this.invalidateTxWaveform("band changed");
      }
      this.updateTxPlan(false);
      await this.configureRadioForFt8(false);
    },

    loadRfGainModel(band) {
      let slope = NaN;
      try { slope = Number(localStorage.getItem(`freerig710-ft8-rf-slope-v1-${band}`)); } catch (_) {}
      this.rfGainSlopeDbPerStep = Number.isFinite(slope) && slope >= 0.02 && slope <= 2.0 ? slope : null;
    },

    saveRfGainModel() {
      if (!this.activeBand || !Number.isFinite(this.rfGainSlopeDbPerStep)) return;
      try { localStorage.setItem(`freerig710-ft8-rf-slope-v1-${this.activeBand}`, String(this.rfGainSlopeDbPerStep)); } catch (_) {}
    },

    loadTxCalibration(band) {
      let level = NaN;
      try { level = Number(localStorage.getItem(`freerig710-ft8-tx-level-v2-${band}`)); } catch (_) {}
      this.txLevelTuned = Number.isFinite(level) && level >= -40 && level <= -1;
      this.txLevelDbfs = this.txLevelTuned ? level : null;
      id("ft8-tx-level-label").textContent = this.txLevelTuned ? `${this.txLevelDbfs.toFixed(1)} dBFS · ALC tuned` : "not tuned for this band";
      id("ft8-generate-wave").disabled = !this.txPlanMessage || !this.txLevelTuned || this.txStreaming || this.tuneRunning;
    },

    saveTxCalibration(level, onsetLevel = null) {
      if (!this.activeBand || !Number.isFinite(level)) return;
      this.txLevelDbfs = clamp(Number(level), -40, -1);
      this.txLevelTuned = true;
      try { localStorage.setItem(`freerig710-ft8-tx-level-v2-${this.activeBand}`, String(this.txLevelDbfs)); } catch (_) {}
      const onset = Number.isFinite(onsetLevel) ? ` · onset ${Number(onsetLevel).toFixed(1)}` : "";
      id("ft8-tx-level-label").textContent = `${this.txLevelDbfs.toFixed(1)} dBFS · ALC tuned${onset}`;
      this.invalidateTxWaveform("TX level calibrated · generate waveform");
      this.renderAutoTxState();
      id("ft8-generate-wave").disabled = !this.txPlanMessage || this.txStreaming || this.tuneRunning;
    },

    setPowerOptimistic(watts) {
      const value = clamp(Math.round(Number(watts) || 5), 5, 100);
      this.txPowerW = value;
      this.powerPendingW = value;
      this.powerPendingUntil = Date.now() + 3000;
      id("ft8-tx-power").value = String(value);
      id("ft8-tx-power-label").textContent = `${value} W`;
    },

    async setFt8Power(watts) {
      if (this.tuneRunning) { toast("Stop TX Tune before changing power", true); return; }
      const value = clamp(Math.round(Number(watts) || 5), 5, 100);
      const requestSeq = ++this.powerRequestSeq;
      this.setPowerOptimistic(value);
      this.powerControlBusy = true;
      try {
        const result = await post("/api/v1/radio/tx-power", { watts: value });
        if (requestSeq !== this.powerRequestSeq) return;
        const confirmed = Number(result?.state?.tx_power_w);
        if (Number.isFinite(confirmed) && Math.round(confirmed) === value) {
          this.powerPendingW = null;
          this.powerPendingUntil = 0;
        }
      } catch (error) {
        if (requestSeq === this.powerRequestSeq) {
          this.powerPendingW = null;
          this.powerPendingUntil = 0;
          toast(`Power change failed: ${error.message || error}`, true);
        }
      } finally {
        if (requestSeq === this.powerRequestSeq) this.powerControlBusy = false;
      }
    },

    setRfGainOptimistic(value) {
      const gain = clamp(Math.round(Number(value) || 0), 0, 255);
      this.rfGainManualPending = gain;
      this.rfGainManualPendingUntil = Date.now() + 3000;
      id("ft8-rf-gain-slider").value = String(gain);
      id("ft8-rf-gain-slider-label").textContent = String(gain);
    },

    async setManualRfGain(value) {
      if (id("ft8-auto-rf")?.checked) return;
      if (this.tuneRunning) { toast("Stop TX Tune before changing RF gain", true); return; }
      const gain = clamp(Math.round(Number(value) || 0), 0, 255);
      const requestSeq = ++this.rfGainRequestSeq;
      this.setRfGainOptimistic(gain);
      this.rfGainControlBusy = true;
      try {
        const result = await post("/api/v1/radio/rf-gain", { value: gain });
        if (requestSeq !== this.rfGainRequestSeq) return;
        const confirmed = Number(result?.state?.rf_gain);
        if (Number.isFinite(confirmed) && Math.round(confirmed) === gain) {
          this.rfGainManualPending = null;
          this.rfGainManualPendingUntil = 0;
        }
        this.levelHistory.length = 0;
        this.rfGainPending = null;
        this.rfGainSettleUntil = Date.now() + 700;
      } catch (error) {
        if (requestSeq === this.rfGainRequestSeq) {
          this.rfGainManualPending = null;
          this.rfGainManualPendingUntil = 0;
          toast(`RF gain change failed: ${error.message || error}`, true);
        }
      } finally {
        if (requestSeq === this.rfGainRequestSeq) this.rfGainControlBusy = false;
      }
    },

    async configureRadioForFt8(recovery = false) {
      if (!this.activeBand || !Number.isFinite(this.dialHz) || this.configuring) return;
      this.configuring = true;
      this.radioRearmPending = false;
      const status = id("ft8-radio-config-state");
      status.textContent = recovery ? "Radio returned: re-applying FT8 configuration…" : `Configuring ${this.activeBand} FT8…`;
      try {
        const state = await api("/api/v1/state");
        if (state?.radio_power !== "ON") throw new Error("Radio must be ON before selecting an FT8 band");

        // Safe RX-only preparation. No PTT/TX command is sent here.
        await post("/api/v1/radio/vfo/split", { mode: "OFF" });
        await post("/api/v1/radio/vfo/select", { vfo: "A" });
        await post("/api/v1/radio/frequency", { frequency_hz: this.dialHz, vfo: "A" });
        await post("/api/v1/radio/mode", { mode: "DATA-U", vfo: "A" });
        await post("/api/v1/radio/frequency", { frequency_hz: this.txVfoBDialHz(), vfo: "B" });
        await post("/api/v1/radio/mode", { mode: "DATA-U", vfo: "B" });
        await post("/api/v1/radio/vfo/select", { vfo: "A" });
        await post("/api/v1/radio/vfo/split", { mode: "A_TO_B" });
        await post("/api/v1/radio/rf-sql-vr", { value: "RF" });
        await post("/api/v1/radio/dnr", { enabled: false });
        await post("/api/v1/radio/noise-blanker", { enabled: false });
        await post("/api/v1/radio/auto-notch", { enabled: false });
        await post("/api/v1/radio/filter", { width_code: 19, shift_hz: 0, manual_notch_enabled: false, contour_enabled: false });

        status.textContent = `${this.activeBand} ready · VFO A RX ${formatHz(this.dialHz)} · DATA-U · split A→B · digital filters OFF · 3.2 kHz RX width`;
        await this.ensureAudio();
        window.FT710_FT8?.enableDecode(true);
        toast(`${this.activeBand} FT8 RX ready`);
      } catch (error) {
        status.textContent = `FT8 setup failed: ${error.message || error}`;
        toast(error.message || String(error), true);
      } finally {
        this.configuring = false;
      }
    },

    syncWaterfallAxis() {
      document.querySelectorAll(".ft8-axis-top [data-df]").forEach((tick) => {
        const df = Number(tick.dataset.df);
        if (!Number.isFinite(df)) return;
        const pct = 100 * (df - DF_LOW) / (DF_HIGH - DF_LOW);
        tick.style.setProperty("--ft8-axis-left", `${clamp(pct, 0, 100)}%`);
      });
    },

    txVfoBDialHz() {
      if (!Number.isFinite(this.dialHz)) return NaN;
      return Math.round(this.dialHz + this.txDfHz - TX_AUDIO_CENTER_HZ);
    },

    txRfHz() {
      if (!Number.isFinite(this.dialHz)) return NaN;
      return Math.round(this.dialHz + this.txDfHz);
    },

    updateTxPlan(pushRadio = false) {
      id("ft8-rx-dial").textContent = formatHz(this.dialHz);
      id("ft8-tx-rf").textContent = formatHz(this.txRfHz());
      id("ft8-vfo-b").textContent = formatHz(this.txVfoBDialHz());
      id("ft8-tx-df-label").textContent = `TX DF ${Math.round(this.txDfHz)} Hz · future audio center ${TX_AUDIO_CENTER_HZ} Hz`;
      id("ft8-tx-cursor-label").textContent = String(Math.round(this.txDfHz));
      const pct = 100 * (this.txDfHz - DF_LOW) / (DF_HIGH - DF_LOW);
      id("ft8-tx-cursor").style.left = `${clamp(pct, 0, 100)}%`;
      if (pushRadio && this.activeBand && this.state?.radio_power === "ON") void this.applyTxVfoB();
    },

    async selectWaterfallDf(event) {
      if (this.tuneRunning) { toast("Stop TX Tune before changing TX frequency", true); return; }
      if (this.autoTxArming || this.autoTxSessionActive) { toast("Halt FT8 TX before changing TX frequency", true); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      this.txDfHz = Math.round((DF_LOW + fraction * (DF_HIGH - DF_LOW)) / 10) * 10;
      try { localStorage.setItem("freerig710-ft8-tx-df-v1", String(this.txDfHz)); } catch (_) {}
      this.updateTxPlan(true);
    },

    async applyTxVfoB() {
      if (this.tuneRunning) return false;
      if (!this.activeBand || !Number.isFinite(this.txVfoBDialHz())) return false;
      const generation = ++this.txVfoApplyGeneration;
      const targetHz = Math.round(this.txVfoBDialHz());
      const targetDf = Math.round(this.txDfHz);
      const previous = this.txVfoApplyPromise || Promise.resolve(true);
      const task = previous.catch(() => false).then(async () => {
        // If a newer cursor/QSO selection arrived before this queued CAT write
        // began, skip the stale write entirely.
        if (generation !== this.txVfoApplyGeneration) return false;
        await post("/api/v1/radio/frequency", { frequency_hz: targetHz, vfo: "B" });
        if (generation !== this.txVfoApplyGeneration) return false;
        await post("/api/v1/radio/vfo/split", { mode: "A_TO_B" });
        if (generation !== this.txVfoApplyGeneration) return false;
        this.txVfoAppliedGeneration = generation;
        const stateEl = id("ft8-radio-config-state");
        if (stateEl) stateEl.textContent = `${this.activeBand} · TX cursor ${targetDf} Hz → VFO B ${formatHz(targetHz)} · AUTO TX ready when enabled`;
        return true;
      });
      this.txVfoApplyPromise = task;
      try { return await task; }
      catch (error) {
        if (generation === this.txVfoApplyGeneration) toast(`TX cursor CAT update failed: ${error.message || error}`, true);
        throw error;
      }
    },

    ft8TxRadioStateMatches(state, expectedA, expectedB) {
      return Boolean(
        state &&
        state.radio_power === "ON" &&
        !state.ptt_active &&
        state.tx_state !== "TX" &&
        state.rx_vfo === "A" &&
        state.tx_vfo === "B" &&
        state.split_enabled &&
        state.vfo_a_mode === "DATA-U" &&
        state.vfo_b_mode === "DATA-U" &&
        Math.abs(Number(state.vfo_a_hz) - Number(expectedA)) <= 5 &&
        Math.abs(Number(state.vfo_b_hz) - Number(expectedB)) <= 5
      );
    },

    async ensureFt8TxRadioState(expectedA, expectedB) {
      // qsoSelected()/waterfall clicks update VFO B asynchronously.  Never let
      // the arm path race that CAT write: wait for the latest queued update.
      const pending = this.txVfoApplyPromise;
      if (pending) {
        try { await pending; }
        catch (_) { /* the explicit state check below will report the failure */ }
      }

      let state = await api("/api/v1/state");
      this.state = state;
      if (this.ft8TxRadioStateMatches(state, expectedA, expectedB)) return state;

      // If RX VFO A and both DATA-U modes are still intact, a mismatch in B or
      // split is normally a delayed/stale cursor CAT update. Re-apply only the
      // TX-side B/split setup once, while still safely in RX, then verify it.
      const safeToRepair = Boolean(
        state?.radio_power === "ON" && !state?.ptt_active && state?.tx_state !== "TX" &&
        state?.rx_vfo === "A" && state?.vfo_a_mode === "DATA-U" && state?.vfo_b_mode === "DATA-U" &&
        Math.abs(Number(state?.vfo_a_hz) - Number(expectedA)) <= 5
      );
      if (safeToRepair) {
        try { await this.applyTxVfoB(); } catch (_) {}
        for (let attempt = 0; attempt < 3; attempt += 1) {
          state = await api("/api/v1/state");
          this.state = state;
          if (this.ft8TxRadioStateMatches(state, expectedA, expectedB)) return state;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }

      const observedA = Number.isFinite(Number(state?.vfo_a_hz)) ? Math.round(Number(state.vfo_a_hz)) : 0;
      const observedB = Number.isFinite(Number(state?.vfo_b_hz)) ? Math.round(Number(state.vfo_b_hz)) : 0;
      const split = state?.split_enabled ? `${state?.rx_vfo || "?"}→${state?.tx_vfo || "?"}` : "OFF";
      throw new Error(`VFO/split state not ready: A ${observedA}/${expectedA}, B ${observedB}/${expectedB}, split ${split}`);
    },

    getOperatingContext() {
      const qso=window.FT710_FT8?.getQsoSnapshot?.()||{};
      const df=Number(qso.df);
      const txDf=Number(this.txDfHz);
      return {
        band:this.activeBand||"",dialHz:this.dialHz,txPowerW:Number(this.txPowerW)||Number(this.state?.tx_power_w)||0,
        frequencyHz:Number.isFinite(Number(this.dialHz))&&Number.isFinite(txDf)?Math.round(Number(this.dialHz)+txDf):null,
        rxFrequencyHz:Number.isFinite(Number(this.dialHz))&&Number.isFinite(df)?Math.round(Number(this.dialHz)+df):null,
      };
    },

    qsoSelected(info) {
      if (this.tuneRunning) { toast("Stop TX Tune before selecting another QSO frequency", true); return; }
      if (this.autoTxSessionActive) { toast("Wait for the current FT8 transmission to finish before selecting another QSO", true); return; }
      if (Number.isFinite(Number(info?.df))) {
        this.txDfHz = clamp(Math.round(Number(info.df) / 10) * 10, DF_LOW, DF_HIGH);
        try { localStorage.setItem("freerig710-ft8-tx-df-v1", String(this.txDfHz)); } catch (_) {}
      }
      if (info?.txSlotParity != null) {
        this.txSlotParity = Number(info.txSlotParity) & 1;
        id("ft8-tx-slot-select").value = String(this.txSlotParity);
        window.FT710_FT8?.setTxSlotParity(this.txSlotParity);
        try { localStorage.setItem("freerig710-ft8-tx-slot-v1", String(this.txSlotParity)); } catch (_) {}
      }
      this.updateTxPlan(true);
    },

    async ensureAudio() {
      if (this.audioReady || this.audioStarting) return;
      this.audioStarting = true;
      this.claimAudio();
      const badge = id("ft8-audio-state");
      badge.textContent = "AUDIO CONNECTING";
      badge.className = "ft8-page-pill";
      await new Promise((resolve) => setTimeout(resolve, 120));
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(websocketUrl("/api/v1/audio/ws"));
        ws.binaryType = "arraybuffer";
        this.socket = ws;
        const timeout = setTimeout(() => {
          if (!this.audioReady) {
            try { ws.close(); } catch (_) {}
            reject(new Error("FT8 RX audio WebSocket timeout"));
          }
        }, 6500);
        ws.onmessage = (event) => {
          if (typeof event.data === "string") {
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            if (message.type === "ready") {
              clearTimeout(timeout);
              // A staged waveform is owned by one concrete audio WebSocket fd on
              // the ESP32.  Every new WS handshake therefore invalidates any
              // browser-side cached staging id, even if the encoded PCM itself
              // is still valid locally.
              this.stagedWaveformId = 0;
              this.stagedWaveformKey = "";
              this.stagedWaveformMessage = "";
              this.stagedWaveformRevision = 0;
              this.audioReady = true;
              this.audioStarting = false;
              if (this.autoTxEnabled) this.txAbortRequested = false;
              this.audioRate = Number(message.sample_rate) || 48000;
              this.txSource = String(message.tx_source || "NONE");
              id("ft8-tx-source-state") && (id("ft8-tx-source-state").textContent = this.txSource);
              badge.textContent = `AUDIO RX ${this.audioRate / 1000}K`;
              badge.className = "ft8-page-pill live";
              window.FT710_FT8?.setAudioReady(true);
              window.FT710_FT8?.enableDecode(true);
              if (id("ft8-send-wave")) id("ft8-send-wave").disabled = true;
              this.setTuneControls(false);
              resolve();
            } else if (message.type === "timing_probe") {
              window.FT710_FT8?.handleControl(message);
            } else if (message.type === "tx_source") {
              this.handleTxSourceAck(message);
            } else if (message.type === "ft8_waveform_begin") {
              const waiter = this.waveBeginWaiter;
              if (waiter) { this.waveBeginWaiter = null; clearTimeout(waiter.timeout); message.ok === false ? waiter.reject(new Error(message.error || "waveform upload rejected")) : waiter.resolve(message); }
            } else if (message.type === "ft8_waveform_ready") {
              const waiter = this.waveReadyWaiter;
              if (waiter) { this.waveReadyWaiter = null; clearTimeout(waiter.timeout); waiter.resolve(message); }
            } else if (message.type === "ft8_waveform_error") {
              const waiter = this.waveReadyWaiter || this.waveBeginWaiter;
              this.waveReadyWaiter = null; this.waveBeginWaiter = null;
              if (waiter) { clearTimeout(waiter.timeout); waiter.reject(new Error(message.error || "waveform upload failed")); }
            } else if (message.type === "ft8_tx_state") {
              this.handleAutoTxState(message);
            } else if (message.type === "tx_abort") {
              if (this.autoTxEnabled || this.autoTxArming || this.autoTxSessionActive) void this.haltAutoTx(message.reason || "ESP32 aborted FT8 TX", true);
              else void this.stopTxWaveform(message.reason || "ESP32 aborted FT8 audio");
            }
            return;
          }
          if (event.data instanceof ArrayBuffer) window.FT710_FT8?.feedAudio(event.data, this.audioRate);
        };
        ws.onerror = () => {
          if (!this.audioReady) { clearTimeout(timeout); this.audioStarting = false; reject(new Error("FT8 RX audio WebSocket failed")); }
        };
        ws.onclose = () => {
          clearTimeout(timeout);
          const wasReady = this.audioReady;
          // ESP32 clears staged QSO PCM when the owning audio WebSocket goes
          // away.  Mirror that immediately; otherwise an automatic reconnect
          // could reuse a stale waveform id and /ft8/tx/arm would correctly
          // reject it as "not fully staged".
          this.stagedWaveformId = 0;
          this.stagedWaveformKey = "";
          this.stagedWaveformMessage = "";
          this.stagedWaveformRevision = 0;
          for (const name of ["waveBeginWaiter", "waveReadyWaiter"]) {
            const waiter = this[name];
            if (waiter) { clearTimeout(waiter.timeout); waiter.reject(new Error("audio WebSocket closed during waveform staging")); this[name] = null; }
          }
          this.socket = null;
          this.audioReady = false;
          this.audioStarting = false;
          badge.textContent = "AUDIO OFF";
          badge.className = "ft8-page-pill";
          window.FT710_FT8?.setAudioReady(false);
          if (wasReady && this.activeBand && this.state?.radio_power === "ON") {
            setTimeout(() => { if (!this.audioReady && this.activeBand && this.state?.radio_power === "ON") void this.ensureAudio().catch(() => {}); }, 1200);
          }
        };
      });
    },

    closeAudio(reason = "FT8 audio closed") {
      this.txAbortRequested = true;
      this.txStreaming = false;
      this.tuneAbortRequested = true;
      this.tuneToneActive = false;
      this.stopTxClockSource();
      clearInterval(this.tuneKeepaliveTimer);
      this.tuneKeepaliveTimer = null;
      this.txSource = "NONE";
      this.autoTxEnabled = false;
      this.autoTxPreparing = false;
      this.autoTxArming = false;
      this.autoTxSessionActive = false;
      clearInterval(this.autoTxKeepaliveTimer);
      this.autoTxKeepaliveTimer = null;
      if (this.autoTxActiveWaiter) {
        clearTimeout(this.autoTxActiveWaiter.timeout);
        this.autoTxActiveWaiter.reject(new Error("audio WebSocket closed"));
        this.autoTxActiveWaiter = null;
      }
      if (this.autoTxIdleWaiter) {
        clearTimeout(this.autoTxIdleWaiter.timeout);
        this.autoTxIdleWaiter.reject(new Error("audio WebSocket closed"));
        this.autoTxIdleWaiter = null;
      }
      for (const name of ["waveBeginWaiter", "waveReadyWaiter"]) {
        const waiter = this[name];
        if (waiter) { clearTimeout(waiter.timeout); waiter.reject(new Error("audio WebSocket closed")); this[name] = null; }
      }
      this.stagedWaveformId = 0;
      this.stagedWaveformKey = "";
      this.stagedWaveformMessage = "";
      this.stagedWaveformRevision = 0;
      id("ft8-tx-source-state") && (id("ft8-tx-source-state").textContent = "NONE");
      this.renderAutoTxState();
      const ws = this.socket;
      this.socket = null;
      this.audioReady = false;
      this.audioStarting = false;
      window.FT710_FT8?.enableDecode(false);
      window.FT710_FT8?.setAudioReady(false);
      if (ws && ws.readyState < WebSocket.CLOSING) try { ws.close(1000, reason); } catch (_) {}
      const badge = id("ft8-audio-state");
      badge.textContent = "AUDIO OFF";
      badge.className = "ft8-page-pill";
      if (this.tuneRunning) {
        this.tuneRunning = false;
        this.setTuneControls(false);
      } else {
        id("ft8-tune-tx").disabled = true;
      }
    },

    sendAudioControl(payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify(payload));
      return true;
    },

    getTxDf() {
      return Number(this.txDfHz);
    },

    getTxSlotParity() {
      return Number(this.txSlotParity) & 1;
    },

    canReplanQso() {
      return !this.autoTxSessionActive && !this.tuneRunning;
    },

    enableAutoTxFromSelection() {
      this.rearmAutoTxFromSelection();
    },

    rearmAutoTxFromSelection() {
      if (this.autoTxSessionActive) return;
      const plan = window.FT710_FT8?.getTxPlan?.() || {};
      const message = String(plan.message || "").trim();
      if (!message) {
        const qso = window.FT710_FT8?.getQsoSnapshot?.() || {};
        if (qso.dxCall && !String(qso.myGrid || "").trim()) toast("Set MY GRID first", true);
        else toast("Selected decode does not have a valid TX continuation", true);
        return;
      }
      const previousMessage = this.txPlanMessage;
      this.txPlanMessage = message;
      const revision = ++this.txPlanRevision;
      this.autoTxRepeatCount = 0;
      this.autoTxLastMessage = message;
      this.autoTxLastSlotIndex = null;
      this.autoTxTargetSlotIndex = null;
      // A manual click is an explicit recovery point, even when the outgoing
      // text is identical to the previous retry.  Give it a fresh revision so
      // every old encode/stage/arm continuation becomes stale deterministically.
      const mustCancelArm = this.armedSlotIndex != null || this.autoTxArming;
      this.invalidateStagedWaveform();
      this.renderAutoTxState("re-armed from selected decode");
      void (async () => {
        try {
          // Serialize STOP before uploading the replacement waveform.  Without
          // this ordering, a late /tx/stop from the old arm could clear a new
          // PSRAM stage that had already finished uploading.
          if (mustCancelArm) await this.cancelStaleArmedTx(previousMessage, message, true);
          if (!this.txPlanStillCurrent(message, revision)) return;
          if (!this.autoTxEnabled && !this.autoTxPreparing) { await this.enableAutoTx(); return; }
          if (this.autoTxEnabled && await this.prepareAutoTxWaveform(message, revision)) {
            await this.ensureAutoTxWaveformStaged(message, revision);
          }
        } catch (error) {
          if (error?.code !== "FT8_STALE_PLAN") console.warn("FT8 manual re-arm pre-stage:", error);
        }
      })();
    },

    txPlanStillCurrent(message, revision = this.txPlanRevision) {
      const plan = window.FT710_FT8?.getTxPlan?.() || {};
      return Number(revision) === Number(this.txPlanRevision) && String(plan.message || "").trim() === String(message || "").trim();
    },

    stalePlanError(message, revision) {
      const error = new Error(`stale FT8 TX plan r${revision}: ${String(message || "<empty>").trim()}`);
      error.code = "FT8_STALE_PLAN";
      return error;
    },

    isRecoverableAutoTxError(error) {
      const reason = String(error?.message || error || "").toLowerCase();
      return [
        "waveform is not fully staged",
        "staged waveform was lost",
        "staged waveform/message/revision binding changed",
        "48 khz waveform is not ready",
        "audio websocket changed before ft8 tx arm",
        "audio websocket is not connected",
        "audio websocket closed",
        "current ft8 tx slot is already too late",
        "ft8 slot became too late",
        "ft8 slot must be armed",
      ].some((part) => reason.includes(part));
    },

    async cancelStaleArmedTx(previousMessage, nextMessage, force = false) {
      if (this.staleArmCancelPromise) return this.staleArmCancelPromise;
      const stale = String(this.armedTxMessage || previousMessage || "").trim();
      const fresh = String(nextMessage || "").trim();
      if (this.autoTxSessionActive || (!this.autoTxEnabled && !this.autoTxPreparing) || (!force && this.armedSlotIndex == null) || !stale || (!force && stale === fresh)) return;
      this.staleArmCancelPromise = (async () => {
        const waiter = this.autoTxActiveWaiter;
        if (waiter) {
          this.autoTxActiveWaiter = null;
          clearTimeout(waiter.timeout);
          const error = new Error(`Auto Seq replaced armed message ${stale} -> ${fresh || "<none>"}`);
          error.code = "FT8_STALE_PLAN";
          waiter.reject(error);
        }
        try { await post("/api/v1/ft8/tx/stop", { reason: `Auto Seq advanced: ${stale} -> ${fresh || "none"}` }); } catch (_) {}
        this.armedTxMessage = "";
        this.armedWaveformId = 0;
        this.armedSlotIndex = null;
        this.armedPlanRevision = 0;
        this.autoTxArming = false;
        id("ft8-tx-progress") && (id("ft8-tx-progress").textContent = `stale TX cancelled · next ${fresh || "message"}`);
      })().finally(() => { this.staleArmCancelPromise = null; });
      return this.staleArmCancelPromise;
    },

    qsoPlanChanged(plan) {
      const message = String(plan?.message || "").trim();
      const state = String(plan?.state || "IDLE");
      if (message !== this.txPlanMessage) {
        const previousMessage = this.txPlanMessage;
        this.txPlanMessage = message;
        const revision = ++this.txPlanRevision;
        // Any already-armed waveform for the previous text is stale whether
        // or not the browser's autoTxArming flag is perfectly synchronized
        // with the backend at this exact instant.
        if (this.autoTxEnabled && !this.autoTxSessionActive && this.armedSlotIndex != null && this.armedTxMessage && this.armedTxMessage !== message) {
          void this.cancelStaleArmedTx(previousMessage, message);
        }
        this.autoTxRepeatCount = 0;
        this.autoTxLastMessage = message;
        this.invalidateTxWaveform(message ? `planned message r${revision} changed · regenerate waveform` : "not generated");
        if (this.autoTxEnabled && message) {
          // Latest-plan-wins: an old scheduler continuation is never allowed
          // to re-stage JO65 after a newer R-report waveform has completed.
          void (async () => {
            try {
              if (await this.prepareAutoTxWaveform(message, revision)) await this.ensureAutoTxWaveformStaged(message, revision);
            } catch (error) {
              if (error?.code !== "FT8_STALE_PLAN") console.warn("FT8 next-message pre-stage:", error);
            }
          })();
        }
      }
      const el = id("ft8-tx-message");
      if (el) el.textContent = message || "Select a QSO first";
      const generate = id("ft8-generate-wave");
      if (generate) generate.disabled = !message || !this.txLevelTuned || this.txStreaming || this.tuneRunning || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive;
      if (this.autoTxEnabled && state === "COMPLETE" && !this.autoTxArming && !this.autoTxSessionActive) void this.finishCompletedQso();
      this.renderAutoTxState();
    },

    async finishCompletedQso() {
      if (this.qsoFinishPromise) return this.qsoFinishPromise;
      this.qsoFinishPromise = (async () => {
        await window.FT710_FT8?.handleCompletedQso?.(window.FT710_FT8?.getQsoSnapshot?.());
        await this.haltAutoTx("QSO complete", false);
      })().finally(() => { this.qsoFinishPromise = null; });
      return this.qsoFinishPromise;
    },

    encoderStateChanged(info) {
      const detail = info?.ready ? (info.detail || "ready") : `ERROR · ${info?.detail || "not ready"}`;
      id("ft8-encoder-state") && (id("ft8-encoder-state").textContent = detail);
      id("ft8-encoder-diag") && (id("ft8-encoder-diag").textContent = detail);
    },

    invalidateStagedWaveform() {
      this.stagedWaveformId = 0;
      this.stagedWaveformKey = "";
      this.stagedWaveformMessage = "";
      this.stagedWaveformRevision = 0;
    },

    preparedWaveformMatches(message) {
      const wanted = String(message || "").trim().toUpperCase();
      return Boolean(
        wanted &&
        this.txStageWaveform instanceof Int16Array &&
        this.txStageWaveform.length === 606720 &&
        String(this.txWaveformMeta?.message || "").trim().toUpperCase() === wanted &&
        Number(this.txWaveformMeta?.levelDbfs) === Number(this.txLevelDbfs)
      );
    },

    invalidateTxWaveform(detail = "not generated") {
      if (this.txStreaming) return;
      this.txWaveform = null;
      this.txStageWaveform = null;
      this.txWaveformMeta = null;
      this.invalidateStagedWaveform();
      id("ft8-waveform-state") && (id("ft8-waveform-state").textContent = detail);
      const send = id("ft8-send-wave");
      if (send) send.disabled = true;
    },

    async generateTxWaveform(expectedMessage = "", expectedRevision = null) {
      if (this.txStreaming || this.tuneRunning) return;
      const plan = window.FT710_FT8?.getTxPlan?.() || {};
      const message = String(expectedMessage || plan.message || "").trim();
      if (!message) { toast("Select a decoded station/QSO before generating FT8", true); return; }
      if (!this.txLevelTuned || !Number.isFinite(this.txLevelDbfs)) { toast("Run Tune TX first to calibrate the audio level for this band", true); return; }
      const button = id("ft8-generate-wave");
      button && (button.disabled = true);
      id("ft8-waveform-state").textContent = "encoding WSJT-X waveform + offline 48 kHz render…";
      try {
        const result = await window.FT710_FT8.encodeTxWaveform(message, TX_AUDIO_CENTER_HZ, this.txLevelDbfs);
        if (String(result?.message || "").trim().toUpperCase() !== message.toUpperCase()) throw new Error(`encoder message mismatch: wanted ${message}, got ${result?.message || "<empty>"}`);
        if (!(result?.pcm instanceof Int16Array) || result.pcm.length !== 606720) throw new Error(`encoder returned ${result?.pcm?.length || 0} samples; expected 606720 @ 48 kHz`);
        if (Number(result?.sampleRate) !== 48000 || Number(result?.stagedSampleRate) !== 48000) throw new Error(`FT8 staged render must be 48000 Hz, got ${result?.sampleRate}`);
        if (expectedRevision != null && !this.txPlanStillCurrent(message, expectedRevision)) throw this.stalePlanError(message, expectedRevision);
        this.txWaveform = result.pcm;
        this.txStageWaveform = result.pcm;
        this.txWaveformMeta = result;
        const seconds = result.durationMs / 1000;
        id("ft8-waveform-state").textContent = `${seconds.toFixed(2)} s · 48 kHz · ${result.pcm.length} samples · peak ${result.peakPcm}`;
        id("ft8-tx-spectrum").textContent = `${result.audioBaseHz.toFixed(2)}–${result.audioTopHz.toFixed(2)} Hz · ${result.levelDbfs} dBFS · RMS ${result.rmsDbfs.toFixed(1)} dBFS`;
        id("ft8-tx-progress").textContent = `ready · ${result.resampler || "WSJT-X-port offline render"} · encode/render ${result.elapsedMs.toFixed(0)} ms`;
        id("ft8-send-wave").disabled = true;
        toast(`FT8 waveform ready: ${message}`);
      } catch (error) {
        const detail = error?.message || String(error);
        if (error?.code !== "FT8_STALE_PLAN") {
          this.invalidateTxWaveform(`ERROR · ${detail}`);
          toast(`FT8 waveform generation failed: ${detail}`, true);
        }
        throw error;
      } finally {
        if (button) button.disabled = !this.txPlanMessage || !this.txLevelTuned || this.txStreaming || this.tuneRunning;
      }
    },

    handleTxSourceAck(message) {
      const source = String(message?.source || "NONE").toUpperCase();
      this.txSource = source;
      id("ft8-tx-source-state") && (id("ft8-tx-source-state").textContent = message?.ok === false ? `${source} · ERROR` : source);
      const waiter = this.txSourceWaiter;
      if (waiter) {
        this.txSourceWaiter = null;
        clearTimeout(waiter.timeout);
        if (message?.ok === false) waiter.reject(new Error(message.error || "TX source rejected"));
        else waiter.resolve(source);
      }
    },

    setTxSource(source) {
      const wanted = String(source || "NONE").toUpperCase();
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("audio WebSocket is not connected"));
      if (this.txSourceWaiter) {
        clearTimeout(this.txSourceWaiter.timeout);
        this.txSourceWaiter.reject(new Error("TX source request superseded"));
        this.txSourceWaiter = null;
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.txSourceWaiter) this.txSourceWaiter = null;
          reject(new Error("ESP32 TX source ACK timeout"));
        }, 1800);
        this.txSourceWaiter = { resolve, reject, timeout };
        this.sendAudioControl({ type: "tx_source", source: wanted });
      });
    },

    waitForWaveformBegin(timeoutMs = 2500) {
      if (this.waveBeginWaiter) { clearTimeout(this.waveBeginWaiter.timeout); this.waveBeginWaiter.reject(new Error("waveform begin superseded")); }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { if (this.waveBeginWaiter) this.waveBeginWaiter = null; reject(new Error("ESP32 waveform begin ACK timeout")); }, timeoutMs);
        this.waveBeginWaiter = { resolve, reject, timeout };
      });
    },

    waitForWaveformReady(timeoutMs = 5500) {
      if (this.waveReadyWaiter) { clearTimeout(this.waveReadyWaiter.timeout); this.waveReadyWaiter.reject(new Error("waveform upload superseded")); }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { if (this.waveReadyWaiter) this.waveReadyWaiter = null; reject(new Error("ESP32 waveform upload timeout")); }, timeoutMs);
        this.waveReadyWaiter = { resolve, reject, timeout };
      });
    },

    async verifyAutoTxWaveformStaged(waveId, expectedBytes, attempts = 1) {
      for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
        try {
          const status = await api("/api/v1/ft8/status");
          const wave = status?.ft8?.tx_waveform || {};
          if (Boolean(wave.ready) && !wave.uploading && Number(wave.id) === Number(waveId) &&
              Number(wave.expected_bytes) === Number(expectedBytes) && Number(wave.received_bytes) === Number(expectedBytes) &&
              Number(wave.sample_rate_hz) === 48000) return true;
        } catch (_) {}
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return false;
    },

    async ensureAutoTxWaveformStaged(message, revision = this.txPlanRevision, options = {}) {
      const wanted = String(message || "").trim();
      const requireEnabled = options.requireEnabled !== false;
      if (!this.txPlanStillCurrent(wanted, revision)) throw this.stalePlanError(wanted, revision);
      if (!this.preparedWaveformMatches(wanted)) {
        throw new Error("FT8 48 kHz waveform is not ready to stage");
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("audio WebSocket is not connected");
      // Freeze the exact PCM/message pair before the first await.  A later
      // decode may advance Auto Seq and replace this.txStageWaveform; the
      // upload in progress must never silently switch to that other buffer.
      const stageWaveform = this.txStageWaveform;
      const stageMessage = wanted;
      const stageLevelDbfs = Number(this.txWaveformMeta?.levelDbfs);
      const bytesLength = stageWaveform.byteLength;
      const key = `${stageMessage}|${stageLevelDbfs}|48000|${bytesLength}`;
      const promiseKey = `${revision}|${key}`;
      if (this.stagedWaveformId && this.stagedWaveformKey === key && this.stagedWaveformMessage === stageMessage && this.stagedWaveformRevision === revision) {
        if (await this.verifyAutoTxWaveformStaged(this.stagedWaveformId, bytesLength, 2)) return this.stagedWaveformId;
        this.stagedWaveformId = 0;
        this.stagedWaveformKey = "";
        this.stagedWaveformMessage = "";
        this.stagedWaveformRevision = 0;
      }
      if (this.autoTxStagePromise && this.autoTxStagePromiseKey === promiseKey) {
        const id = await this.autoTxStagePromise;
        if (!this.txPlanStillCurrent(stageMessage, revision)) throw this.stalePlanError(stageMessage, revision);
        return id;
      }
      if (this.autoTxStagePromise) {
        await this.autoTxStagePromise.catch(() => {});
        if (!this.txPlanStillCurrent(stageMessage, revision)) throw this.stalePlanError(stageMessage, revision);
        return this.ensureAutoTxWaveformStaged(stageMessage, revision, options);
      }
      this.autoTxStagePromiseKey = promiseKey;
      this.autoTxStagePromise = (async () => {
        if (!this.txPlanStillCurrent(stageMessage, revision)) throw this.stalePlanError(stageMessage, revision);
        const waveId = this.waveUploadSeq = (this.waveUploadSeq % 2000000000) + 1;
        const beginAck = this.waitForWaveformBegin();
        this.sendAudioControl({ type: "ft8_waveform_begin", id: waveId, bytes: bytesLength, sample_rate: 48000 });
        await beginAck;
        const readyAck = this.waitForWaveformReady();
        const bytes = new Uint8Array(stageWaveform.buffer, stageWaveform.byteOffset, stageWaveform.byteLength);
        const frameBytes = 16000; // backend max is 16384
        const started = performance.now();
        for (let offset = 0; offset < bytes.length; offset += frameBytes) {
          if ((requireEnabled && !this.autoTxEnabled) || this.txAbortRequested) throw new Error("FT8 TX disabled during waveform staging");
          while (this.socket?.bufferedAmount > 262144) await new Promise((r) => setTimeout(r, 1));
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("audio WebSocket closed during waveform staging");
          this.socket.send(bytes.subarray(offset, Math.min(bytes.length, offset + frameBytes)));
        }
        const ready = await readyAck;
        if (!this.txPlanStillCurrent(stageMessage, revision)) throw this.stalePlanError(stageMessage, revision);
        if (Number(ready?.id) !== waveId || Number(ready?.bytes) !== bytes.length) throw new Error("ESP32 staged waveform ACK mismatch");
        // ft8_waveform_ready is emitted by the ESP32 only after every byte has
        // reached PSRAM and the stage is marked ready.  Do not spend another
        // HTTP round-trip here: /ft8/tx/arm performs the authoritative final
        // owner/id/length/rate validation. This matters for same-slot late TX.
        this.stagedWaveformId = waveId;
        this.stagedWaveformKey = key;
        this.stagedWaveformMessage = stageMessage;
        this.stagedWaveformRevision = revision;
        id("ft8-tx-progress") && (id("ft8-tx-progress").textContent = `staged 48 kHz on ESP32 · ${(bytes.length / 1024).toFixed(0)} KiB · ${(performance.now() - started).toFixed(0)} ms`);
        return waveId;
      })().finally(() => { this.autoTxStagePromise = null; this.autoTxStagePromiseKey = ""; });
      return this.autoTxStagePromise;
    },

    async refreshTxDiagnostics() {
      try {
        const result = await api("/api/v1/ft8/status");
        const f = result?.ft8 || {};
        const tx = f.audio_tx || {};
        id("ft8-tx-buffer").textContent = `${tx.input_buffered_bytes ?? 0} B · peak ${tx.input_peak_abs ?? 0}`;
        const staged = f.tx_waveform || {};
        const stageText = staged.ready
          ? ` · stage ${staged.consumed_bytes ?? 0}/${staged.expected_bytes ?? 0} B`
          : (staged.uploading ? ` · upload ${staged.received_bytes ?? 0}/${staged.expected_bytes ?? 0} B` : "");
        id("ft8-tx-counters").textContent = `${f.audio_ws_tx_ft8_bytes ?? 0} FT8 B · ${f.audio_ws_tx_rejected_bytes ?? 0} rejected · ${tx.input_bytes_dropped_old ?? 0} dropped-old${stageText}`;
        if (f.tx_source) {
          this.txSource = String(f.tx_source);
          id("ft8-tx-source-state").textContent = this.txSource;
        }
        const autoTx = f.tx || {};
        this.autoTxBackend = autoTx;
        const catQuietBadge = id("ft8-cat-quiet");
        if (catQuietBadge) {
          const txActive = Boolean(autoTx.active);
          catQuietBadge.hidden = !txActive;
          if (txActive) {
            const quiet = Boolean(autoTx.cat_quiet_active);
            catQuietBadge.textContent = quiet ? "CAT QUIET ON" : "CAT QUIET OFF";
            catQuietBadge.classList.toggle("live", quiet);
            catQuietBadge.classList.toggle("error", !quiet);
            catQuietBadge.classList.remove("warning");
          } else {
            catQuietBadge.classList.remove("live", "error", "warning");
          }
        }
        if (autoTx.running && !this.autoTxSessionActive) {
          if (!this.autoTxArming) this.autoTxArmingSinceMs = Date.now();
          this.autoTxArming = true;
        }
        if (autoTx.active) {
          this.autoTxSessionActive = true;
          this.autoTxArmingSinceMs = 0;
        }
        if (!autoTx.running) {
          this.autoTxSessionActive = false;
          if (!this.txStreaming) {
            this.autoTxArming = false;
            this.autoTxArmingSinceMs = 0;
          }
        }
        this.renderAutoTxState(autoTx.running ? String(autoTx.phase || "") : null);
        const tune = f.tune || {};
        const running = Boolean(tune.running);
        if (running || this.tuneRunning) {
          const phase = String(tune.phase || (running ? "TUNING" : "stopping"));
          id("ft8-tune-state").textContent = `${phase}${tune.active ? " · PTT ON" : ""}`;
          id("ft8-tune-state").classList.toggle("active", running);
          id("ft8-tune-meter").textContent = `ALC ${tune.alc_raw ?? "--"} · PO ${tune.po_raw ?? "--"}`;
          id("ft8-tune-meter").classList.toggle("active", running);
        } else {
          id("ft8-tune-state").textContent = tune.last_reason ? `idle · ${tune.last_reason}` : "idle";
          id("ft8-tune-state").classList.remove("active");
          id("ft8-tune-meter").classList.remove("active");
        }
        const original = Number(tune.original_power_w);
        const restored = Number(tune.restored_power_w);
        id("ft8-tune-power-restore").textContent = Number.isFinite(original) && original > 0
          ? `${original} W → 5 W → ${restored > 0 ? `${restored} W` : (running ? "pending" : "--")}`
          : "--";
        return f;
      } catch (_) { return null; }
    },

    setTuneControls(running) {
      this.tuneRunning = Boolean(running);
      id("ft8-tune-tx").disabled = running || !this.activeBand || !this.audioReady || this.powerControlBusy;
      id("ft8-stop-tune").disabled = !running;
      id("ft8-tx-power").disabled = running;
      const rfSlider = id("ft8-rf-gain-slider");
      if (rfSlider) rfSlider.disabled = running || Boolean(id("ft8-auto-rf")?.checked);
      id("ft8-band-select").disabled = running;
      id("ft8-tx-slot-select").disabled = running;
      id("ft8-generate-wave").disabled = running || !this.txPlanMessage || !this.txLevelTuned;
      id("ft8-send-wave").disabled = true;
      document.querySelector(".ft8-tx-lab")?.classList.toggle("tuning", running);
      this.renderAutoTxState();
    },

    // FT8.5.10.3: Tune and automatic FT8 RF intentionally do not use a
    // real-time browser PCM clock. Tune is generated on the ESP32 UAC1
    // clock; automatic FT8 is fully rendered/staged before the slot.

    async waitForTuneActive(timeoutMs = 4200) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (this.tuneAbortRequested) throw new Error("TX Tune stopped");
        const f = await this.refreshTxDiagnostics();
        if (f?.tune?.active) return f.tune;
        if (f?.tune && !f.tune.running && f.tune.last_reason) throw new Error(f.tune.last_reason);
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error("ESP32 did not enter bounded TX Tune state");
    },

    async collectTuneAlc(count, lastReadCount, timeoutMs = 1300) {
      const values = [];
      let seen = Number(lastReadCount) || 0;
      const deadline = performance.now() + timeoutMs;
      while (values.length < count && performance.now() < deadline) {
        if (this.tuneAbortRequested) throw new Error("TX Tune stopped");
        const f = await this.refreshTxDiagnostics();
        const tune = f?.tune || {};
        if (!tune.running) throw new Error(tune.last_reason || "ESP32 ended TX Tune");
        const reads = Number(tune.meter_reads) || 0;
        if (reads > seen) {
          values.push(Number(tune.alc_raw) || 0);
          seen = reads;
        }
        if (values.length < count) await new Promise((r) => setTimeout(r, 90));
      }
      if (!values.length) throw new Error("No ALC meter readings from CAT RM4");
      return { values, readCount: seen };
    },

    async runAlcTune() {
      if (this.tuneRunning || this.txStreaming) return;
      if (this.autoTxEnabled || this.autoTxArming || this.autoTxSessionActive) { toast("Halt automatic FT8 TX before ALC Tune", true); return; }
      if (this.powerControlBusy) { toast("Wait for the RF power command to settle before TX Tune", true); return; }
      clearTimeout(this.powerSendTimer);
      this.powerSendTimer = null;
      this.powerPendingW = null;
      this.powerPendingUntil = 0;
      if (!this.activeBand) { toast("Select an FT8 band first", true); return; }
      if (this.state?.radio_power !== "ON") { toast("Radio must be ON", true); return; }
      if (this.state?.ptt_active || this.state?.tx_state === "TX") { toast("Radio must be in RX before TX Tune", true); return; }
      try { await this.ensureAudio(); } catch (error) { toast(error.message || String(error), true); return; }
      if (!this.audioReady) { toast("FT8 audio WebSocket is not connected", true); return; }

      // The backend deliberately clears any staged QSO waveform when Tune
      // starts. Mirror that state locally so the next automatic slot uploads
      // a fresh waveform instead of reusing a stale browser-side id.
      this.stagedWaveformId = 0;
      this.stagedWaveformKey = "";
      this.stagedWaveformMessage = "";
      this.stagedWaveformRevision = 0;
      this.tuneAbortRequested = false;
      this.setTuneControls(true);
      id("ft8-tune-state").textContent = "starting · preparing 5 W tune";
      id("ft8-tx-progress").textContent = "TX Tune: preparing 1500 Hz tone · automatic QSO TX temporarily locked";
      let tuneSucceeded = false;
      let onsetLevel = null;
      try {
        await this.setTxSource("FT8");
        this.tuneToneLevelDbfs = -32;

        // FT8.5.1: never send PCM while the bounded Tune session is only
        // STARTING/KEYING.  Wait for the ESP32 to acknowledge real PTT first.
        await api("/api/v1/ft8/tune/start", { method: "POST" });
        this.tuneKeepaliveTimer = setInterval(() => {
          if (!this.tuneRunning || !this.audioReady) return;
          this.sendAudioControl({ type: "ft8_tune_keepalive" });
        }, 400);
        this.sendAudioControl({ type: "ft8_tune_keepalive" });
        let tune = await this.waitForTuneActive();
        id("ft8-tx-power-label").textContent = "5 W · TUNE";

        id("ft8-tx-progress").textContent = "TX Tune 5 W · 1500 Hz generated on raw deep-isoc UAC1 path · no browser PCM pacing";

        // Establish the raw RM4 baseline at a deliberately low audio level.
        let sample = await this.collectTuneAlc(3, Number(tune.meter_reads) || 0, 1600);
        let readCount = sample.readCount;
        const baselineSorted = [...sample.values].sort((a, b) => a - b);
        const baseline = baselineSorted[Math.floor(baselineSorted.length / 2)];
        const onsetThreshold = Math.max(3, baseline + 2);
        let level = -32;
        id("ft8-tune-state").textContent = `baseline ALC ${baseline} · threshold ${onsetThreshold}`;

        while (!this.tuneAbortRequested) {
          await post("/api/v1/ft8/tune/level", { dbfs: level });
          this.tuneToneLevelDbfs = level;
          id("ft8-tx-progress").textContent = `TX Tune 5 W · tone ${level.toFixed(1)} dBFS · raw deep-isoc UAC1 path · waiting for ALC onset…`;
          await new Promise((r) => setTimeout(r, 260));
          sample = await this.collectTuneAlc(2, readCount, 1050);
          readCount = sample.readCount;
          const values = sample.values;
          const high = Math.max(...values);
          const hits = values.filter((v) => v >= onsetThreshold).length;
          id("ft8-tune-meter").textContent = `ALC ${values.join("/")} · threshold ${onsetThreshold}`;

          if (hits >= 2 || high >= baseline + 5) {
            onsetLevel = level;
            const operatingLevel = clamp(level - 1, -40, -1);
            this.saveTxCalibration(operatingLevel, onsetLevel);
            id("ft8-tx-progress").textContent = `ALC onset at ${onsetLevel.toFixed(1)} dBFS · operating level ${operatingLevel.toFixed(1)} dBFS`;
            tuneSucceeded = true;
            break;
          }
          if (level >= -3) throw new Error("ALC onset not detected by -3 dBFS; check FT-710 USB DATA input level before transmitting");
          const step = level < -24 ? 6 : level < -16 ? 4 : level < -10 ? 2 : 1;
          level = Math.min(-3, level + step);
        }
        // Backend oscillator is stopped by /ft8/tune/stop after calibration/abort.
      } catch (error) {
        if (!this.tuneAbortRequested) {
          id("ft8-tx-progress").textContent = `TX Tune failed · ${error.message || error}`;
          toast(error.message || String(error), true);
        }
      } finally {
        await this.stopAlcTune(tuneSucceeded ? "ALC calibration complete" : "TX Tune stopped");
        if (tuneSucceeded) toast(`TX audio calibrated${onsetLevel != null ? ` · ALC onset ${onsetLevel.toFixed(1)} dBFS` : ""}`);
      }
    },

    async stopAlcTune(reason = "operator stop") {
      if (this.tuneStopping) return this.tuneStopping;
      if (!this.tuneRunning && !this.tuneToneActive) return;
      this.tuneStopping = (async () => {
        this.tuneAbortRequested = true;
        clearInterval(this.tuneKeepaliveTimer);
        this.tuneKeepaliveTimer = null;
        // The tune tone is generated inside the P4 UAC1 path; stop the bounded
        // backend Tune session, which stops the oscillator before TX0/restore.
        try { await api("/api/v1/ft8/tune/stop", { method: "POST" }); } catch (_) {}
        try { if (this.socket?.readyState === WebSocket.OPEN) await this.setTxSource("NONE"); } catch (_) {}
        const deadline = performance.now() + 3500;
        while (performance.now() < deadline) {
          const f = await this.refreshTxDiagnostics();
          if (!f?.tune?.running) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        this.tuneRunning = false;
        this.setTuneControls(false);
        try { await this.pollState(); } catch (_) {}
        id("ft8-tune-state").textContent = `idle · ${reason}`;
        this.tuneAbortRequested = false;
      })().finally(() => { this.tuneStopping = null; });
      return this.tuneStopping;
    },

    renderAutoTxState(detail = null) {
      const stateEl = id("ft8-auto-tx-state");
      const slotEl = id("ft8-auto-tx-slot");
      const timingEl = id("ft8-auto-tx-timing");
      const enable = id("ft8-enable-tx");
      const halt = id("ft8-halt-tx");
      let text = "disabled";
      if (this.autoTxSessionActive) text = "TX ACTIVE · ESP32 lease";
      else if (this.autoTxArming) text = "ARMED · waiting slot/PTT ACK";
      else if (this.autoTxPreparing) text = "PREPARING · encode/stage";
      else if (this.autoTxEnabled) text = "enabled · waiting selected slot";
      if (detail) text += ` · ${detail}`;
      if (stateEl) {
        stateEl.textContent = text;
        stateEl.classList.toggle("active", this.autoTxSessionActive);
        stateEl.classList.toggle("armed", this.autoTxEnabled && !this.autoTxSessionActive);
      }
      if (slotEl) slotEl.textContent = this.autoTxTargetSlotIndex == null
        ? "--"
        : `${this.autoTxTargetSlotIndex & 1 ? "ODD" : "EVEN"} · ${this.autoTxTargetSlotIndex}`;
      if (timingEl) timingEl.textContent = Number.isFinite(this.autoTxLastStartDelayMs)
        ? `PTT +${this.autoTxLastStartDelayMs.toFixed(0)} ms from UTC slot`
        : "--";
      if (enable) enable.disabled = this.autoTxEnabled || this.autoTxPreparing || this.tuneRunning || !this.activeBand || !this.audioReady || !this.txLevelTuned || !this.txPlanMessage;
      if (halt) halt.disabled = !(this.autoTxEnabled || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive);
      id("ft8-tune-tx") && (id("ft8-tune-tx").disabled = this.tuneRunning || this.autoTxPreparing || this.autoTxEnabled || !this.activeBand || !this.audioReady || this.powerControlBusy);
      id("ft8-band-select") && (id("ft8-band-select").disabled = this.tuneRunning || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive);
      id("ft8-tx-slot-select") && (id("ft8-tx-slot-select").disabled = this.tuneRunning || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive);
      id("ft8-tx-power") && (id("ft8-tx-power").disabled = this.tuneRunning || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive);
      const rfSlider = id("ft8-rf-gain-slider");
      if (rfSlider) rfSlider.disabled = this.tuneRunning || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive || Boolean(id("ft8-auto-rf")?.checked);
      document.querySelector(".ft8-tx-lab")?.classList.toggle("auto-tx-active", this.autoTxSessionActive);
      document.querySelector(".ft8-tx-lab")?.classList.toggle("auto-tx-armed", this.autoTxEnabled && !this.autoTxSessionActive);
    },

    async enableAutoTx() {
      if (this.autoTxEnabled || this.autoTxPreparing || this.autoTxArming || this.autoTxSessionActive) return;
      if (this.tuneRunning || this.txStreaming) { toast("Stop TX Tune/audio test before enabling FT8 TX", true); return; }
      this.txAbortRequested = false;
      this.autoTxArmingSinceMs = 0;
      if (!this.activeBand || !Number.isFinite(this.dialHz)) { toast("Select an FT8 band first", true); return; }
      if (!this.txPlanMessage) {
        const qso = window.FT710_FT8?.getQsoSnapshot?.() || {};
        if (qso.dxCall && !String(qso.myGrid || "").trim()) toast("Set MY GRID first", true);
        else toast("Select a decoded station/QSO first", true);
        return;
      }
      if (!this.txLevelTuned || !Number.isFinite(this.txLevelDbfs)) { toast("Run Tune TX first to calibrate FT8 audio", true); return; }

      this.autoTxPreparing = true;
      this.renderAutoTxState("validating current QSO plan");
      try {
        await this.ensureAudio();
        const timing = window.FT710_FT8?.getTimingEstimate?.() || {};
        if (!timing.valid) throw new Error("ESP32 UTC timing is not synchronized yet");

        if (this.txVfoApplyPromise) await this.txVfoApplyPromise;
        else await this.applyTxVfoB();

        const state = await api("/api/v1/state");
        this.state = state;
        if (state?.radio_power !== "ON" || state?.ptt_active || state?.tx_state === "TX") {
          throw new Error("radio must be stably ON and in RX");
        }

        // The QSO may legitimately advance while the encoder or the 1.2 MiB
        // PSRAM upload is running.  Treat that as a stale plan, not as a TX
        // fault: discard the obsolete continuation and prepare the latest
        // message.  This removes the old 'generation completed without READY
        // buffer' race where a correct newer plan invalidated an older encode.
        let stable = null;
        for (let attempt = 0; attempt < 4 && !stable; attempt += 1) {
          if (this.txAbortRequested) throw new Error("FT8 TX enable cancelled");
          const plan = window.FT710_FT8?.getTxPlan?.() || {};
          const message = String(plan.message || "").trim();
          const revision = this.txPlanRevision;
          if (!message) throw new Error("selected QSO has no transmit message");
          try {
            this.renderAutoTxState(`preparing r${revision} · ${message}`);
            if (!(await this.prepareAutoTxWaveform(message, revision)) || !this.preparedWaveformMatches(message)) {
              throw new Error(`FT8 encoder did not produce the expected 48 kHz buffer for ${message}`);
            }
            const waveformId = await this.ensureAutoTxWaveformStaged(message, revision, { requireEnabled: false });
            if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
            const stagedOk = await this.verifyAutoTxWaveformStaged(waveformId, this.txStageWaveform.byteLength, 3);
            // A decode can advance Auto Seq while /ft8/status is in flight.
            // Re-check after the final READY verification as well, otherwise
            // an obsolete waveform can win the enable race by a few ms.
            if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
            if (!stagedOk) {
              this.invalidateStagedWaveform();
              throw new Error("ESP32 did not confirm the staged FT8 waveform as READY");
            }
            stable = { message, revision, waveformId };
          } catch (error) {
            if (error?.code === "FT8_STALE_PLAN") continue;
            throw error;
          }
        }
        if (!stable) throw new Error("QSO changed repeatedly while arming; click the latest decode again");
        if (!this.txPlanStillCurrent(stable.message, stable.revision)) throw this.stalePlanError(stable.message, stable.revision);

        this.autoTxEnabled = true;
        this.autoTxRepeatCount = 0;
        this.autoTxLastMessage = stable.message;
        this.autoTxTargetSlotIndex = null;
        id("ft8-tx-progress").textContent = `AUTO TX ready · ${stable.message} · waveform ${stable.waveformId} · waiting ${this.txSlotParity ? "ODD" : "EVEN"} slot`;
        toast("FT8 automatic TX armed");
      } catch (error) {
        if (error?.code !== "FT8_STALE_PLAN") toast(`FT8 TX not armed: ${error?.message || error}`, true);
      } finally {
        this.autoTxPreparing = false;
        this.renderAutoTxState();
      }
    },

    async haltAutoTx(reason = "operator halt", fromBackend = false) {
      if (this.autoTxHaltPromise) return this.autoTxHaltPromise;
      this.autoTxHaltPromise = (async () => {
        this.autoTxEnabled = false;
        this.autoTxPreparing = false;
        this.autoTxArming = false;
        this.autoTxArmingSinceMs = 0;
        this.txAbortRequested = true;
        this.stopTxClockSource();
        clearInterval(this.autoTxKeepaliveTimer);
        this.autoTxKeepaliveTimer = null;
        if (this.autoTxActiveWaiter) {
          clearTimeout(this.autoTxActiveWaiter.timeout);
          this.autoTxActiveWaiter.reject(new Error(reason));
          this.autoTxActiveWaiter = null;
        }
        if (this.autoTxIdleWaiter) {
          clearTimeout(this.autoTxIdleWaiter.timeout);
          this.autoTxIdleWaiter.reject(new Error(reason));
          this.autoTxIdleWaiter = null;
        }
        if (!fromBackend) {
          try { await post("/api/v1/ft8/tx/stop", { reason }); } catch (_) {}
        }
        try { if (this.socket?.readyState === WebSocket.OPEN) await this.setTxSource("NONE"); } catch (_) {}
        this.autoTxSessionActive = false;
        this.txStreaming = false;
        this.autoTxTargetSlotIndex = null;
        this.renderAutoTxState(reason);
        id("ft8-tx-progress").textContent = `AUTO TX halted · ${reason}`;
        void this.refreshTxDiagnostics();
      })().finally(() => { this.autoTxHaltPromise = null; this.txAbortRequested = false; });
      return this.autoTxHaltPromise;
    },

    async prepareAutoTxWaveform(expectedMessage = "", revision = this.txPlanRevision) {
      const plan = window.FT710_FT8?.getTxPlan?.() || {};
      const message = String(expectedMessage || plan.message || "").trim();
      if (!message || !this.txLevelTuned) return false;
      if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
      if (this.preparedWaveformMatches(message)) return true;
      const key = `${revision}|${message}|${Number(this.txLevelDbfs)}`;
      if (this.autoTxPreparePromise) {
        if (this.autoTxPreparePromiseKey === key) {
          const ready = await this.autoTxPreparePromise;
          if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
          return ready;
        }
        await this.autoTxPreparePromise.catch(() => {});
        if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
        return this.prepareAutoTxWaveform(message, revision);
      }
      this.autoTxPreparePromiseKey = key;
      this.autoTxPreparePromise = (async () => {
        await this.generateTxWaveform(message, revision);
        if (!this.txPlanStillCurrent(message, revision)) throw this.stalePlanError(message, revision);
        return this.preparedWaveformMatches(message);
      })().finally(() => { this.autoTxPreparePromise = null; this.autoTxPreparePromiseKey = ""; });
      return this.autoTxPreparePromise;
    },

    nextSelectedTxSlotIndex() {
      const timing = window.FT710_FT8?.getTimingEstimate?.() || {};
      if (!timing.valid || !Number.isFinite(timing.serverUnixMs)) return null;
      const current = Math.floor(timing.serverUnixMs / SLOT_MS);
      const phase = timing.serverUnixMs - current * SLOT_MS;
      if ((current & 1) === (this.txSlotParity & 1) && phase <= AUTO_TX_MAX_LATE_MS && current !== this.autoTxLastSlotIndex) return current;
      for (let i = 1; i <= 3; i += 1) {
        const candidate = current + i;
        if ((candidate & 1) === (this.txSlotParity & 1)) return candidate;
      }
      return null;
    },

    async recoverStaleAutoTxLatch() {
      if (!this.autoTxEnabled || this.autoTxSessionActive || !this.autoTxArming) return false;
      const now = Date.now();
      if (!this.autoTxArmingSinceMs) this.autoTxArmingSinceMs = now;
      if (now - this.autoTxArmingSinceMs < AUTO_TX_ARM_STALE_RECOVERY_MS) return false;
      if (now - this.autoTxLastRecoveryCheckMs < 800) return false;
      this.autoTxLastRecoveryCheckMs = now;
      const f = await this.refreshTxDiagnostics();
      if (!f?.tx) return false;
      const backend = f.tx;
      if (backend.running === false && backend.active === false && this.autoTxEnabled) {
        this.autoTxArming = false;
        this.autoTxArmingSinceMs = 0;
        this.armedTxMessage = "";
        this.armedWaveformId = 0;
        this.armedSlotIndex = null;
        this.armedPlanRevision = 0;
        this.renderAutoTxState("recovered stale arm latch");
        return true;
      }
      return false;
    },

    async autoTxSchedulerTick() {
      if (!this.autoTxEnabled || this.autoTxPreparing || this.autoTxSessionActive || this.tuneRunning || this.txStreaming) return;
      // A stale abort latch can survive an audio teardown while the operator
      // has already re-enabled automatic TX.  Once no TX is active/arming,
      // clear it automatically instead of requiring Halt -> Enable.
      if (this.txAbortRequested && !this.autoTxArming) this.txAbortRequested = false;
      if (this.autoTxArming) {
        await this.recoverStaleAutoTxLatch();
        if (this.autoTxArming) return;
      }
      if (!this.audioReady || this.state?.radio_power !== "ON") return;
      const plan = window.FT710_FT8?.getTxPlan?.() || {};
      const message = String(plan.message || "").trim();
      const revision = this.txPlanRevision;
      if (!message) return;
      if (String(plan.state || "") === "COMPLETE") { await this.finishCompletedQso(); return; }
      if (message !== this.autoTxLastMessage) { this.autoTxLastMessage = message; this.autoTxRepeatCount = 0; }
      if (this.autoTxRepeatCount >= AUTO_TX_MAX_REPEATS) { await this.haltAutoTx(`repeat safety limit ${AUTO_TX_MAX_REPEATS} reached`); return; }

      const slotIndex = this.nextSelectedTxSlotIndex();
      if (slotIndex == null || slotIndex === this.autoTxLastSlotIndex) return;
      let timing = window.FT710_FT8?.getTimingEstimate?.() || {};
      if (!timing.valid || !Number.isFinite(timing.serverUnixMs)) return;
      const targetUnixMs = slotIndex * SLOT_MS;
      let lead = targetUnixMs - timing.serverUnixMs;
      this.autoTxTargetSlotIndex = slotIndex;
      this.renderAutoTxState(lead >= 0 ? `T-${(lead / 1000).toFixed(1)} s` : `T+${(-lead / 1000).toFixed(1)} s`);

      // Render and stage the complete 48 kHz WSJT-X-port waveform before the
      // selected slot.  RF playback is then driven only by the ESP32/UAC1
      // clock; browser scheduling cannot create modulation gaps.
      if (lead > AUTO_TX_STAGE_LEAD_MS) return;
      if (lead < -AUTO_TX_MAX_LATE_MS) return;
      let waveformId;
      try {
        if (!(await this.prepareAutoTxWaveform(message, revision))) return;
        waveformId = await this.ensureAutoTxWaveformStaged(message, revision);
      } catch (error) {
        if (error?.code === "FT8_STALE_PLAN") return;
        throw error;
      }

      // A retry waveform may be staged well before the next TX slot, but it
      // MUST NOT be armed that early.  FT8 decodes from the RX slot arrive
      // near its end; arming the old retry several seconds in advance would
      // make the ESP32 transmit a stale message even after Auto Seq advances
      // to the newly decoded report.
      const refreshedPlan = window.FT710_FT8?.getTxPlan?.() || {};
      const refreshedMessage = String(refreshedPlan.message || "").trim();
      if (refreshedMessage !== message || !this.txPlanStillCurrent(message, revision)) return;

      timing = window.FT710_FT8?.getTimingEstimate?.() || {};
      if (!timing.valid || !Number.isFinite(timing.serverUnixMs)) return;
      lead = targetUnixMs - timing.serverUnixMs;
      this.autoTxTargetSlotIndex = slotIndex;
      this.renderAutoTxState(lead >= 0 ? `staged · T-${(lead / 1000).toFixed(1)} s` : `staged · T+${(-lead / 1000).toFixed(1)} s`);
      if (lead > AUTO_TX_ARM_LEAD_MS || lead < -AUTO_TX_MAX_LATE_MS) return;

      // Do not arm a retry while the decode of the immediately preceding RX
      // slot is still running.  A late decoder result can legitimately change
      // JO65 -> R+xx; transmitting the old retry just because the worker has
      // not returned yet is worse than skipping one slot.
      const precedingRxSlot = slotIndex - 1;
      if (window.FT710_FT8?.isDecodePendingForSlot?.(precedingRxSlot)) {
        this.renderAutoTxState(`waiting RX decode · slot ${precedingRxSlot}`);
        return;
      }

      // Re-check the plan immediately before handing an already-staged
      // waveform to the authoritative ESP32 slot scheduler.  This closes the
      // last async race between decode/Auto Seq and /ft8/tx/arm.
      const finalPlan = window.FT710_FT8?.getTxPlan?.() || {};
      if (String(finalPlan.message || "").trim() !== message || !this.txPlanStillCurrent(message, revision)) return;
      await this.runAutoTxSlot(slotIndex, message, waveformId, revision);
    },

    waitForAutoTxActive(slotIndex, timeoutMs) {
      timeoutMs = Math.max(2500, Math.min(9000, Number(timeoutMs) || 3500));
      if (this.autoTxActiveWaiter) {
        clearTimeout(this.autoTxActiveWaiter.timeout);
        this.autoTxActiveWaiter.reject(new Error("FT8 TX ACTIVE waiter superseded"));
        this.autoTxActiveWaiter = null;
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.autoTxActiveWaiter) this.autoTxActiveWaiter = null;
          reject(new Error("ESP32 did not confirm FT8 PTT ACTIVE"));
        }, timeoutMs);
        this.autoTxActiveWaiter = { slotIndex, resolve, reject, timeout };
      });
    },

    waitForAutoTxIdle(timeoutMs = 15000) {
      if (this.autoTxIdleWaiter) { clearTimeout(this.autoTxIdleWaiter.timeout); this.autoTxIdleWaiter.reject(new Error("FT8 TX IDLE waiter superseded")); }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { if (this.autoTxIdleWaiter) this.autoTxIdleWaiter = null; reject(new Error("ESP32 FT8 TX completion timeout")); }, timeoutMs);
        this.autoTxIdleWaiter = { resolve, reject, timeout };
      });
    },

    handleAutoTxState(message) {
      const state = String(message?.state || "").toUpperCase();
      if (state === "ACTIVE") {
        this.autoTxSessionActive = true;
        this.autoTxArming = false;
        this.autoTxArmingSinceMs = 0;
        this.autoTxBackend = message;
        if (Number.isFinite(Number(message?.waveform_id)) && this.armedWaveformId && Number(message.waveform_id) !== Number(this.armedWaveformId)) {
          void this.haltAutoTx("ESP32 ACTIVE waveform id does not match browser arm", false);
          return;
        }
        const catQuietBadge = id("ft8-cat-quiet");
        if (catQuietBadge) {
          catQuietBadge.hidden = false;
          catQuietBadge.textContent = "CAT QUIET CHECK";
          catQuietBadge.classList.add("warning");
          catQuietBadge.classList.remove("live", "error");
        }
        void this.refreshTxDiagnostics();
        const target = Number(message.target_unix_ms);
        const ptt = Number(message.ptt_unix_ms);
        if (Number.isFinite(target) && Number.isFinite(ptt)) this.autoTxLastStartDelayMs = ptt - target;
        const waiter = this.autoTxActiveWaiter;
        if (waiter && Number(message.slot_index) === Number(waiter.slotIndex)) {
          this.autoTxActiveWaiter = null;
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
        this.renderAutoTxState();
      } else if (state === "IDLE") {
        this.autoTxSessionActive = false;
        this.autoTxArming = false;
        this.autoTxArmingSinceMs = 0;
        this.autoTxBackend = message;
        const catQuietBadge = id("ft8-cat-quiet");
        if (catQuietBadge) {
          catQuietBadge.hidden = true;
          catQuietBadge.classList.remove("live", "error", "warning");
        }
        const waiter = this.autoTxIdleWaiter;
        if (waiter) { this.autoTxIdleWaiter = null; clearTimeout(waiter.timeout); message?.ok === false ? waiter.reject(new Error(message.reason || "ESP32 aborted FT8 TX")) : waiter.resolve(message); }
        this.renderAutoTxState(message.reason || null);
      }
    },

    async runAutoTxSlot(slotIndex, message, waveformId, revision = this.txPlanRevision) {
      if (!this.autoTxEnabled || this.autoTxArming || this.autoTxSessionActive) return;
      this.autoTxArming = true;
      this.autoTxArmingSinceMs = Date.now();
      this.autoTxTargetSlotIndex = slotIndex;
      this.txAbortRequested = false;
      this.renderAutoTxState();
      try {
        const planAtStart = window.FT710_FT8?.getTxPlan?.() || {};
        if (String(planAtStart.message || "").trim() !== String(message || "").trim() || !this.txPlanStillCurrent(message, revision)) {
          this.autoTxArming = false;
          return;
        }
        if (!(await this.prepareAutoTxWaveform(message, revision))) throw new Error("FT8 48 kHz waveform is not ready");
        const planAfterPrepare = window.FT710_FT8?.getTxPlan?.() || {};
        if (String(planAfterPrepare.message || "").trim() !== String(message || "").trim() || !this.txPlanStillCurrent(message, revision)) {
          this.autoTxArming = false;
          return;
        }
        if (this.stagedWaveformId !== waveformId || this.stagedWaveformMessage !== String(message || "").trim() || this.stagedWaveformRevision !== revision) throw new Error("FT8 staged waveform/message/revision binding changed before arm");
        const timingForArm = window.FT710_FT8?.getTimingEstimate?.() || {};
        const alreadyInsideTargetSlot = Number.isFinite(timingForArm.serverUnixMs) && timingForArm.serverUnixMs >= slotIndex * SLOT_MS;
        // In the late-start fast path avoid a redundant /ft8/status request.
        // The ESP32 /arm endpoint itself revalidates the staged waveform before
        // it can claim the TX source, so safety remains backend-authoritative.
        if (!alreadyInsideTargetSlot && !(await this.verifyAutoTxWaveformStaged(waveformId, this.txStageWaveform?.byteLength || 0, 2))) throw new Error("FT8 staged waveform was lost before arm");
        const expectedA = Math.round(Number(this.dialHz));
        const expectedB = Math.round(Number(this.txVfoBDialHz()));
        // Wait only for our latest CAT setter to finish. Do not gate the arm on
        // the browser's cached /state VFO-B value: the ESP32 arm endpoint now
        // refreshes FA/FB/VS/ST directly from CAT whenever the cache disagrees.
        if (this.txVfoApplyPromise) await this.txVfoApplyPromise;
        const state = await api("/api/v1/state");
        this.state = state;
        const expectedPower = clamp(Math.round(Number(state?.tx_power_w) || Number(this.txPowerW) || 5), 5, 100);
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.audioReady) throw new Error("audio WebSocket changed before FT8 TX arm");
        const planBeforeArm = window.FT710_FT8?.getTxPlan?.() || {};
        if (String(planBeforeArm.message || "").trim() !== String(message || "").trim() || !this.txPlanStillCurrent(message, revision)) {
          this.autoTxArming = false;
          return;
        }
        await post("/api/v1/ft8/tx/arm", {
          slot_index: slotIndex,
          slot_parity: this.txSlotParity & 1,
          vfo_a_hz: expectedA,
          vfo_b_hz: expectedB,
          waveform_id: waveformId,
          streamed_audio: false,
          power_w: expectedPower,
        });
        this.armedTxMessage = String(message || "").trim();
        this.armedWaveformId = waveformId;
        this.armedSlotIndex = slotIndex;
        this.armedPlanRevision = revision;
        // The QSO can advance while the HTTP arm request itself is in flight.
        // If that happened, revoke this arm immediately; never let a stale
        // initial-call waveform reach PTT simply because /arm returned late.
        if (!this.txPlanStillCurrent(message, revision)) {
          try { await post("/api/v1/ft8/tx/stop", { reason: `stale plan after arm r${revision}` }); } catch (_) {}
          this.armedTxMessage = ""; this.armedWaveformId = 0; this.armedSlotIndex = null; this.armedPlanRevision = 0;
          throw this.stalePlanError(message, revision);
        }
        this.autoTxKeepaliveTimer = setInterval(() => {
          if (this.autoTxEnabled && this.audioReady && (this.autoTxArming || this.autoTxSessionActive)) this.sendAudioControl({ type: "ft8_tx_keepalive" });
        }, 400);
        this.sendAudioControl({ type: "ft8_tx_keepalive" });
        id("ft8-tx-progress").textContent = `armed ${slotIndex & 1 ? "ODD" : "EVEN"} · ${message} · waveform ${waveformId} · waiting ESP32 PTT`;
        const timingBeforeWait = window.FT710_FT8?.getTimingEstimate?.() || {};
        const waitLeadMs = Number.isFinite(timingBeforeWait.serverUnixMs) ? Math.max(0, slotIndex * SLOT_MS - timingBeforeWait.serverUnixMs) : 0;
        const activeTimeoutMs = waitLeadMs + AUTO_TX_ACTIVE_GRACE_MS;
        if (!(this.autoTxSessionActive && Number(this.autoTxBackend?.slot_index) === Number(slotIndex))) await this.waitForAutoTxActive(slotIndex, activeTimeoutMs);
        this.autoTxArming = false;
        if (!this.autoTxEnabled) throw new Error("automatic TX disabled before slot start");
        const activeWaveformId = Number(this.autoTxBackend?.waveform_id || waveformId);
        if (activeWaveformId !== Number(this.armedWaveformId) || this.armedTxMessage !== String(message || "").trim() || this.armedPlanRevision !== revision) throw new Error("ESP32 ACTIVE waveform/message/revision binding mismatch");
        const transmittedMessage = this.armedTxMessage;
        window.FT710_FT8?.notifyTxStarted?.({message:transmittedMessage,slotIndex,waveformId:activeWaveformId});
        this.txStreaming = true;
        id("ft8-tx-progress").textContent = `TX ${slotIndex & 1 ? "ODD" : "EVEN"} · ${transmittedMessage} · waveform ${activeWaveformId} · ESP32 staged 48 kHz PCM`;
        const idle = await this.waitForAutoTxIdle(15000);
        this.txStreaming = false;
        if (idle?.ok === false) throw new Error(idle.reason || "ESP32 aborted FT8 TX");
        id("ft8-tx-progress").textContent = `TX complete · ${transmittedMessage} · waveform ${activeWaveformId} · staged/lossless`;
        this.autoTxLastSlotIndex = slotIndex;
        this.autoTxRepeatCount += 1;
        window.FT710_FT8?.notifyTxComplete?.({ message: transmittedMessage, slotIndex, waveformId: activeWaveformId });
        this.armedTxMessage = ""; this.armedWaveformId = 0; this.armedSlotIndex = null;
        if (String(window.FT710_FT8?.getTxPlan?.()?.state || "") === "COMPLETE") await this.finishCompletedQso();
      } catch (error) {
        const reason = error?.message || String(error);
        if (error?.code === "FT8_STALE_PLAN") {
          id("ft8-tx-progress") && (id("ft8-tx-progress").textContent = `stale armed TX cancelled · waiting correct message`);
        } else if (this.autoTxEnabled && this.isRecoverableAutoTxError(error)) {
          // A missed timing window, lost staged buffer or WS reconnect before
          // PTT is recoverable.  Skip this slot, keep the QSO armed and let the
          // scheduler regenerate/re-stage for the next valid TX opportunity.
          this.autoTxLastSlotIndex = slotIndex;
          if (/waveform|websocket/i.test(reason)) this.invalidateStagedWaveform();
          id("ft8-tx-progress") && (id("ft8-tx-progress").textContent = `AUTO TX recovery · ${reason} · retrying next ${this.txSlotParity ? "ODD" : "EVEN"} slot`);
          this.renderAutoTxState("recovering · next slot");
        } else {
          if (this.autoTxEnabled) toast(`FT8 TX stopped: ${reason}`, true);
          await this.haltAutoTx(reason);
        }
      } finally {
        clearInterval(this.autoTxKeepaliveTimer);
        this.autoTxKeepaliveTimer = null;
        this.autoTxArming = false;
        this.autoTxArmingSinceMs = 0;
        this.autoTxSessionActive = false;
        this.txStreaming = false;
        if (!this.autoTxBackend?.active) { this.armedTxMessage = ""; this.armedWaveformId = 0; this.armedSlotIndex = null; this.armedPlanRevision = 0; }
        this.renderAutoTxState();
      }
    },

    async sendTxWaveform() {
      toast("RX-only realtime FT8 send is disabled in FT8.5.10.3; Auto TX uses staged/lossless PCM so browser scheduling cannot modulate the RF envelope", true);
    },

    async stopTxWaveform(reason = "halt requested") {
      const wasStreaming = this.txStreaming;
      this.txAbortRequested = true;
      this.stopTxClockSource();
      try { if (this.socket?.readyState === WebSocket.OPEN) await this.setTxSource("NONE"); } catch (_) {}
      this.txStreaming = false;
      id("ft8-stop-wave") && (id("ft8-stop-wave").disabled = true);
      id("ft8-send-wave") && (id("ft8-send-wave").disabled = true);
      id("ft8-generate-wave") && (id("ft8-generate-wave").disabled = !this.txPlanMessage || !this.txLevelTuned || this.tuneRunning);
      if (wasStreaming) id("ft8-tx-progress").textContent = `halted · ${reason}`;
      void this.refreshTxDiagnostics();
    },

    async autoAdjustRfGain() {
      if (!id("ft8-auto-rf")?.checked || this.autoGainBusy || !this.activeBand || !this.audioReady || this.state?.radio_power !== "ON") return;
      if (this.tuneRunning || this.txStreaming || this.autoTxArming || this.autoTxSessionActive || this.state?.ptt_active || this.state?.tx_state === "TX") return;
      const instantaneous = Number(window.FT710_FT8?.lastLevelDb);
      const current = Number(this.state?.rf_gain);
      const target = clamp(Number(id("ft8-rf-target")?.value) || -50, -70, -30);
      if (!Number.isFinite(instantaneous) || instantaneous < -95 || !Number.isFinite(current)) return;

      const now = Date.now();
      if (now < this.rfGainSettleUntil) return;
      this.levelHistory.push(instantaneous);
      if (this.levelHistory.length > 12) this.levelHistory.shift();
      if (this.levelHistory.length < 5) return;
      const sorted = [...this.levelHistory].sort((a, b) => a - b);
      const level = sorted[Math.floor((sorted.length - 1) * 0.25)];

      // After every deliberate RG move, measure the actual dBFS response.  Yaesu
      // documents RG as 000..255 but does not define a dB-per-code scale, so we
      // learn the local slope on the live receiver instead of pretending a fixed
      // CAT step is a fixed dB value.
      if (this.rfGainPending) {
        const pending = this.rfGainPending;
        if (current === pending.fromGain && now - pending.appliedAt < 2600) return;
        const dg = current - pending.fromGain;
        const dl = level - pending.fromLevel;
        if (Math.abs(dg) >= 2) {
          const observed = dl / dg;
          if (Number.isFinite(observed) && observed > 0.02 && observed < 2.0) {
            this.rfGainSlopeDbPerStep = Number.isFinite(this.rfGainSlopeDbPerStep)
              ? this.rfGainSlopeDbPerStep * 0.65 + observed * 0.35
              : observed;
            this.saveRfGainModel();
          } else if (!Number.isFinite(this.rfGainSlopeDbPerStep)) {
            // Only a temporary fallback if the first probe coincided with a
            // changing signal. The next real response replaces/refines it.
            this.rfGainSlopeDbPerStep = 0.25;
          }
        }
        this.rfGainPending = null;
      }

      const error = target - level;
      if (Math.abs(error) <= 1.5) {
        const slopeText = Number.isFinite(this.rfGainSlopeDbPerStep) ? `${this.rfGainSlopeDbPerStep.toFixed(3)} dB/step` : "learning";
        const gainReadout=id("ft8-rf-gain");if(gainReadout){gainReadout.textContent=`${current} / 255`;gainReadout.title=`Auto RF Gain · ${level.toFixed(1)} dBFS · ${slopeText}`;}
        return;
      }

      let next = current;
      let kind = "correction";
      if (!Number.isFinite(this.rfGainSlopeDbPerStep)) {
        // One fast probe determines how many dBFS one RG code actually changes
        // on this band/receiver state. Far from target the probe is larger;
        // near target it is intentionally small to avoid the old overshoot.
        kind = "probe";
        const probe = Math.abs(error) > 12 ? 16 : (Math.abs(error) > 6 ? 10 : 5);
        next = clamp(current + (error > 0 ? probe : -probe), 0, 255);
      } else {
        let delta = Math.round(error / this.rfGainSlopeDbPerStep);
        const ae = Math.abs(error);
        const maxDelta = ae > 20 ? 90 : (ae > 10 ? 60 : (ae > 5 ? 35 : (ae > 2.5 ? 14 : 6)));
        delta = clamp(delta, -maxDelta, maxDelta);
        if (delta === 0) delta = error > 0 ? 1 : -1;
        next = clamp(current + delta, 0, 255);
      }
      if (next === current) return;

      this.autoGainBusy = true;
      try {
        await post("/api/v1/radio/rf-gain", { value: next });
        this.rfGainPending = { fromGain: current, fromLevel: level, toGain: next, appliedAt: Date.now(), kind };
        this.levelHistory.length = 0;
        this.rfGainSettleUntil = Date.now() + 900;
        const model = Number.isFinite(this.rfGainSlopeDbPerStep) ? `${this.rfGainSlopeDbPerStep.toFixed(3)} dB/step` : "measuring dB/step";
        const gainReadout=id("ft8-rf-gain");if(gainReadout){gainReadout.textContent=`${next} / 255`;gainReadout.title=`Auto RF Gain · ${current} → ${next} · ${level.toFixed(1)} dBFS · ${model}`;}
      } catch (_) {
        this.rfGainPending = null;
      } finally {
        this.autoGainBusy = false;
      }
    },
  };

  window.FT710_FT8_PAGE = page;
  window.addEventListener("pagehide", () => {
    clearInterval(page.stateTimer);
    clearInterval(page.autoGainTimer);
    clearInterval(page.autoTxSchedulerTimer);
    clearInterval(page.autoTxKeepaliveTimer);
    if (page.socket?.readyState === WebSocket.OPEN) {
      if (page.tuneRunning || page.tuneToneActive) page.sendAudioControl({ type: "ptt", enabled: false });
      if (page.autoTxEnabled || page.autoTxArming || page.autoTxSessionActive) page.sendAudioControl({ type: "tx_source", source: "NONE" });
      page.sendAudioControl({ type: "tx_source", source: "NONE" });
    }
    page.closeAudio("FT8 tab closed");
    page.audioChannel?.close();
  });
  page.init();
})();
