"use strict";

(() => {
  const KEYS = Object.freeze({
    call: "freerig710-settings-call",
    grid: "freerig710-settings-grid",
    backend: "freerig710-backend",
  });

  const LEGACY_KEYS = Object.freeze({
    call: ["ardop_v02_call", "freerig710-js8-my-call"],
    grid: ["ardop_v02_locator", "freerig710-ft8-my-grid-v1", "freerig710-js8-my-grid"],
  });

  function readStorage(key) {
    try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
  }

  function writeStorage(key, value) {
    try {
      const text = String(value || "");
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch (_) { /* localStorage is optional. */ }
  }

  function normalizeCall(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9/]/g, "").slice(0, 16);
  }

  function normalizeGrid(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-R0-9]/g, "").slice(0, 8);
  }

  function normalizeBackend(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const url = new URL(withScheme);
      if (!/^https?:$/.test(url.protocol)) return "";
      return `${url.protocol}//${url.host}`;
    } catch (_) {
      return "";
    }
  }

  function firstLegacy(kind) {
    for (const key of LEGACY_KEYS[kind] || []) {
      const value = kind === "call" ? normalizeCall(readStorage(key)) : normalizeGrid(readStorage(key));
      if (value) return value;
    }
    return "";
  }

  function get() {
    const call = normalizeCall(readStorage(KEYS.call)) || firstLegacy("call");
    const grid = normalizeGrid(readStorage(KEYS.grid)) || firstLegacy("grid");
    const backend = normalizeBackend(readStorage(KEYS.backend));
    return { call, grid, backend };
  }

  function set(values = {}) {
    const next = {};
    if (Object.prototype.hasOwnProperty.call(values, "call")) {
      next.call = normalizeCall(values.call);
      writeStorage(KEYS.call, next.call);
    }
    if (Object.prototype.hasOwnProperty.call(values, "grid")) {
      next.grid = normalizeGrid(values.grid);
      writeStorage(KEYS.grid, next.grid);
    }
    if (Object.prototype.hasOwnProperty.call(values, "backend")) {
      next.backend = normalizeBackend(values.backend);
      writeStorage(KEYS.backend, next.backend);
    }
    window.dispatchEvent(new CustomEvent("freerig710-settings-changed", { detail: get() }));
    return get();
  }

  function seed(values = {}) {
    const current = get();
    const next = {};
    if (!current.call && values.call) next.call = values.call;
    if (!current.grid && values.grid) next.grid = values.grid;
    return Object.keys(next).length ? set(next) : current;
  }

  window.FreeRig710Settings = Object.freeze({
    keys: KEYS,
    get,
    set,
    seed,
    normalizeCall,
    normalizeGrid,
    normalizeBackend,
  });
})();
