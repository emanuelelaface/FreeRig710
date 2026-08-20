"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FreeRig710FT8Logbook = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DB_NAME = "freerig710-ft8-logbook";
  const DB_VERSION = 3;
  const ADIF_VERSION = "3.1.7";
  const PRIORITY_FIELDS = new Set([
    "CALL","STATION_CALLSIGN","QSO_DATE","TIME_ON","TIME_OFF","BAND","FREQ","FREQ_RX",
    "MODE","SUBMODE","RST_SENT","RST_RCVD","GRIDSQUARE","MY_GRIDSQUARE","DXCC","COUNTRY",
    "CONT","CQZ","ITUZ","STATE","CNTY","TX_PWR","COMMENT","QSL_RCVD","LOTW_QSL_RCVD",
    "EQSL_QSL_RCVD","APP_QRZLOG_LOGID","MY_RIG"
  ]);

  const upper = (v) => String(v ?? "").trim().toUpperCase();
  const text = (v) => String(v ?? "").trim();
  const uniq = (items) => Array.from(new Set((items || []).filter(Boolean))).sort();
  const isoNow = () => new Date().toISOString();

  // Country names come from several sources (QRZ ADIF, GeoNames, manual ADIF).
  // Compare a canonical geopolitical country key, while keeping DXCC entities
  // separate.  Example: England/Scotland/Wales/Northern Ireland all map to the
  // country key UNITED KINGDOM, but their ADIF DXCC numbers are untouched.
  const COUNTRY_KEY_SCHEMA = 3;
  const COUNTRY_ALIASES = Object.freeze({
    "UK":"UNITED KINGDOM", "U K":"UNITED KINGDOM", "GREAT BRITAIN":"UNITED KINGDOM", "BRITAIN":"UNITED KINGDOM",
    "ENGLAND":"UNITED KINGDOM", "SCOTLAND":"UNITED KINGDOM", "WALES":"UNITED KINGDOM", "NORTHERN IRELAND":"UNITED KINGDOM",
    "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND":"UNITED KINGDOM",
    "THE NETHERLANDS":"NETHERLANDS", "HOLLAND":"NETHERLANDS",
    "REPUBLIC OF KOSOVO":"KOSOVO", "REPUBLIC OF KOSOVA":"KOSOVO", "KOSOVA":"KOSOVO",
    "UNITED STATES OF AMERICA":"UNITED STATES", "USA":"UNITED STATES", "U S A":"UNITED STATES",
    "RUSSIAN FEDERATION":"RUSSIA", "EUROPEAN RUSSIA":"RUSSIA", "ASIATIC RUSSIA":"RUSSIA",
    "CZECH REPUBLIC":"CZECHIA", "SLOVAK REPUBLIC":"SLOVAKIA",
    "TURKIYE":"TURKEY",
    "SWAZILAND":"ESWATINI",
    "MACEDONIA":"NORTH MACEDONIA", "FORMER YUGOSLAV REPUBLIC OF MACEDONIA":"NORTH MACEDONIA",
    "CAPE VERDE":"CABO VERDE", "EAST TIMOR":"TIMOR LESTE",
    "REPUBLIC OF KOREA":"SOUTH KOREA", "KOREA REPUBLIC OF":"SOUTH KOREA", "KOREA SOUTH":"SOUTH KOREA",
    "DEMOCRATIC PEOPLES REPUBLIC OF KOREA":"NORTH KOREA", "KOREA DEMOCRATIC PEOPLES REPUBLIC OF":"NORTH KOREA", "KOREA NORTH":"NORTH KOREA",
    "MOLDOVA REPUBLIC OF":"MOLDOVA", "REPUBLIC OF MOLDOVA":"MOLDOVA",
    "IRAN ISLAMIC REPUBLIC OF":"IRAN", "SYRIAN ARAB REPUBLIC":"SYRIA",
    "LAO PEOPLES DEMOCRATIC REPUBLIC":"LAOS", "BRUNEI DARUSSALAM":"BRUNEI",
    "BOLIVIA PLURINATIONAL STATE OF":"BOLIVIA", "VENEZUELA BOLIVARIAN REPUBLIC OF":"VENEZUELA",
    "TANZANIA UNITED REPUBLIC OF":"TANZANIA",
    "FEDERATED STATES OF MICRONESIA":"MICRONESIA", "MICRONESIA FEDERATED STATES OF":"MICRONESIA",
    "HOLY SEE":"VATICAN CITY", "VATICAN CITY STATE":"VATICAN CITY"
  });

  function countryKey(value) {
    let key = text(value);
    if (!key) return "";
    try { key = key.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
    key = key.toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
    if (key.startsWith("THE ")) key = key.slice(4);
    return COUNTRY_ALIASES[key] || key;
  }

  function normalizedMode(fields) {
    const mode = upper(fields.MODE);
    const submode = upper(fields.SUBMODE);
    return submode || mode;
  }

  function duplicateKey(fields) {
    const station = upper(fields.STATION_CALLSIGN) || "?";
    const call = upper(fields.CALL) || "?";
    const date = text(fields.QSO_DATE) || "?";
    const time = text(fields.TIME_ON).replace(/[^0-9]/g, "").slice(0, 6).padEnd(6, "0") || "000000";
    const band = upper(fields.BAND) || "?";
    const mode = normalizedMode(fields) || "?";
    return [station, call, date, time, band, mode].join("|");
  }

  function recordRichness(record) {
    const f = record?.fields || {};
    let score = 0;
    for (const [k, v] of Object.entries(f)) {
      if (v == null || String(v).trim() === "") continue;
      score += PRIORITY_FIELDS.has(k) ? 3 : 1;
    }
    return score;
  }

  function normalizeRecord(parsed, source = "adi") {
    const srcFields = parsed?.fields || parsed || {};
    const fields = {};
    for (const [name, value] of Object.entries(srcFields)) fields[upper(name)] = text(value);
    for (const name of ["CALL","STATION_CALLSIGN","BAND","MODE","SUBMODE","GRIDSQUARE","MY_GRIDSQUARE","COUNTRY","CONT","STATE","CNTY"]) {
      if (fields[name]) fields[name] = upper(fields[name]);
    }
    // Country/DXCC entity is derived from the callsign database, never from a
    // coarse Maidenhead cell.  A 4-character grid can cross national borders.
    // QRZ fields, when present, remain authoritative; CTY only fills omissions.
    const ctyApi = typeof globalThis !== "undefined" ? globalThis.FreeRig710FT8CTY : null;
    const cty = fields.CALL && ctyApi?.lookup ? ctyApi.lookup(fields.CALL) : null;
    const qrzSource = String(source || "").toLowerCase() === "qrz";
    const qrzCountry = Boolean(fields.COUNTRY);
    const qrzContinent = Boolean(fields.CONT);
    if (!fields.COUNTRY && cty?.name) fields.COUNTRY = upper(cty.name);
    if (!fields.CONT && cty?.continent) fields.CONT = upper(cty.continent);
    if (qrzSource) {
      fields.APP_FREERIG_COUNTRY_SOURCE = qrzCountry ? "QRZ" : (cty?.name ? "CTY" : "");
      fields.APP_FREERIG_CONT_SOURCE = qrzContinent ? "QRZ" : (cty?.continent ? "CTY" : "");
    } else if (cty?.name && !fields.APP_FREERIG_COUNTRY_SOURCE) fields.APP_FREERIG_COUNTRY_SOURCE = "CTY";
    const record = {
      id: duplicateKey(fields),
      fields,
      raw: text(parsed?.raw),
      call: upper(fields.CALL),
      stationCallsign: upper(fields.STATION_CALLSIGN),
      qsoDate: text(fields.QSO_DATE),
      timeOn: text(fields.TIME_ON),
      band: upper(fields.BAND),
      mode: upper(fields.MODE),
      submode: upper(fields.SUBMODE),
      modeKey: normalizedMode(fields),
      grid: upper(fields.GRIDSQUARE),
      dxcc: text(fields.DXCC),
      ctyEntity: text(cty?.entityKey),
      ctyName: text(cty?.name),
      country: text(fields.COUNTRY),
      continent: upper(fields.CONT),
      state: upper(fields.STATE),
      importedAt: isoNow(),
      updatedAt: isoNow(),
      sources: [String(source || "adi")],
    };
    record.richness = recordRichness(record);
    return record;
  }

  function mergeRecords(existing, incoming, options = {}) {
    if (!existing) return incoming;
    const aScore = recordRichness(existing), bScore = recordRichness(incoming);
    const authoritative = Boolean(options.authoritative);
    const primary = authoritative ? incoming : (bScore > aScore ? incoming : existing);
    const secondary = primary === incoming ? existing : incoming;
    let mergedFields;
    if (authoritative) {
      // QRZ reconciliation: values actually returned by QRZ overwrite local/CTY
      // values. Missing QRZ fields may still be filled by CTY in normalizeRecord.
      mergedFields = { ...(existing.fields || {}) };
      for (const [k,v] of Object.entries(incoming.fields || {})) {
        if (String(v ?? "").trim()) mergedFields[k] = v;
      }
      // Remove stale geography fields that were previously inferred from grid.
      for (const k of ["COUNTRY","CONT","STATE","CNTY"]) {
        if (!(k in (incoming.fields || {})) || !String(incoming.fields?.[k] ?? "").trim()) delete mergedFields[k];
      }
    } else {
      mergedFields = { ...(secondary.fields || {}), ...(primary.fields || {}) };
      for (const [k, v] of Object.entries(secondary.fields || {})) {
        if (!String(mergedFields[k] ?? "").trim() && String(v ?? "").trim()) mergedFields[k] = v;
      }
    }
    const source = authoritative ? "qrz" : ((primary.sources || [])[0] || "merge");
    const normalized = normalizeRecord({ fields: mergedFields, raw: primary.raw || secondary.raw || "" }, source);
    normalized.id = existing.id || incoming.id;
    normalized.importedAt = existing.importedAt || incoming.importedAt || isoNow();
    normalized.updatedAt = isoNow();
    normalized.sources = uniq([...(existing.sources || []), ...(incoming.sources || [])]);
    normalized.logStatus = primary.logStatus || secondary.logStatus || "";
    normalized.qrzLogId = primary.qrzLogId || secondary.qrzLogId || "";
    normalized.qrzError = primary.qrzError || secondary.qrzError || "";
    normalized.richness = recordRichness(normalized);
    return normalized;
  }

  class ADIIncrementalParser {
    constructor() {
      this.buffer = "";
      this.current = {};
      this.rawParts = [];
      this.inHeader = false;
      this.seenEoh = false;
      this.records = 0;
      this.errors = 0;
      this.ignored = 0;
      this.errorMessages = [];
    }

    _error(message) {
      this.errors += 1;
      if (this.errorMessages.length < 20) this.errorMessages.push(message);
    }

    _emitRecord(out) {
      if (Object.keys(this.current).length) {
        out.push({ fields: { ...this.current }, raw: this.rawParts.join("") });
        this.records += 1;
      } else {
        this.ignored += 1;
      }
      this.current = {};
      this.rawParts = [];
    }

    feed(chunk, final = false) {
      this.buffer += String(chunk ?? "");
      const out = [];
      while (true) {
        const lt = this.buffer.indexOf("<");
        if (lt < 0) {
          if (final) this.buffer = "";
          break;
        }
        if (lt > 0) this.buffer = this.buffer.slice(lt);
        const gt = this.buffer.indexOf(">");
        if (gt < 0) break;
        const tagText = this.buffer.slice(1, gt).trim();
        const tagUpper = tagText.toUpperCase();
        if (tagUpper === "EOH") {
          this.seenEoh = true; this.inHeader = false; this.buffer = this.buffer.slice(gt + 1); continue;
        }
        if (tagUpper === "EOR") {
          this.buffer = this.buffer.slice(gt + 1); this._emitRecord(out); continue;
        }
        const parts = tagText.split(":");
        const name = upper(parts[0]);
        const lenText = parts[1];
        if (!name || lenText == null || !/^\d+$/.test(lenText)) {
          this._error(`Malformed ADIF tag <${tagText}>`);
          this.buffer = this.buffer.slice(gt + 1);
          continue;
        }
        const length = Number(lenText);
        if (!Number.isSafeInteger(length) || length < 0 || length > 4_000_000) {
          this._error(`Invalid length in <${tagText}>`);
          this.buffer = this.buffer.slice(gt + 1);
          continue;
        }
        const dataStart = gt + 1;
        if (this.buffer.length < dataStart + length) break;
        const value = this.buffer.slice(dataStart, dataStart + length);
        const rawPiece = this.buffer.slice(0, dataStart + length);
        this.buffer = this.buffer.slice(dataStart + length);
        const isHeaderField = !this.seenEoh && /^(ADIF_VER|CREATED_TIMESTAMP|PROGRAMID|PROGRAMVERSION|USERDEF\d*)$/.test(name);
        if (isHeaderField && !Object.keys(this.current).length) {
          this.inHeader = true;
          continue;
        }
        this.inHeader = false;
        this.current[name] = value;
        this.rawParts.push(rawPiece);
      }
      if (final) {
        if (this.buffer.trim()) this._error("Trailing incomplete ADIF data");
        if (Object.keys(this.current).length) {
          this._error("Record without <EOR>; accepted at end of file");
          this._emitRecord(out);
        }
        this.buffer = "";
      }
      return out;
    }
  }

  function parseAdi(textValue) {
    const parser = new ADIIncrementalParser();
    const records = parser.feed(textValue, true);
    return { records, stats: { records: parser.records, errors: parser.errors, ignored: parser.ignored, errorMessages: parser.errorMessages } };
  }

  function reqPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    });
  }

  let dbPromise = null;
  let workedCallCache = new Map();
  let workedDxccCache = new Map();
  let workedCtyCache = new Map();
  let workedGridCache = new Map();
  let workedGeoCache = new Map();

  function openDb() {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        let qso;
        if (!db.objectStoreNames.contains("qso_records")) qso = db.createObjectStore("qso_records", { keyPath: "id" });
        else qso = req.transaction.objectStore("qso_records");
        const ensureIndex = (name, keyPath) => { if (!qso.indexNames.contains(name)) qso.createIndex(name, keyPath, { unique: false }); };
        ensureIndex("call", "call");
        ensureIndex("band", "band");
        ensureIndex("modeKey", "modeKey");
        ensureIndex("dxcc", "dxcc");
        ensureIndex("grid", "grid");
        ensureIndex("qsoDate", "qsoDate");
        ensureIndex("callBand", ["call", "band"]);
        ensureIndex("callMode", ["call", "modeKey"]);
        ensureIndex("callBandMode", ["call", "band", "modeKey"]);
        const ensureStore = (name, options) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options); };
        ensureStore("worked_call_index", { keyPath: "key" });
        ensureStore("worked_dxcc_index", { keyPath: "key" });
        ensureStore("worked_cty_index", { keyPath: "key" });
        ensureStore("worked_grid_index", { keyPath: "key" });
        ensureStore("worked_geo_index", { keyPath: "key" });
        ensureStore("import_jobs", { keyPath: "id", autoIncrement: true });
        ensureStore("qrz_sync_state", { keyPath: "key" });
        ensureStore("preferences", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Unable to open FT8 logbook"));
    });
    return dbPromise;
  }

  async function putBatch(parsedRecords, source = "adi", options = {}) {
    if (!parsedRecords.length) return { imported: 0, duplicates: 0 };
    const db = await openDb();
    let imported = 0, duplicates = 0;
    for (let offset = 0; offset < parsedRecords.length; offset += 200) {
      const batch = parsedRecords.slice(offset, offset + 200).map((r) => normalizeRecord(r, source));
      const tx = db.transaction(["qso_records"], "readwrite");
      const store = tx.objectStore("qso_records");
      for (const incoming of batch) {
        const existing = await reqPromise(store.get(incoming.id));
        if (existing) { duplicates += 1; store.put(mergeRecords(existing, incoming, options)); }
        else { imported += 1; store.put(incoming); }
      }
      await txDone(tx);
    }
    return { imported, duplicates };
  }

  function updateSummary(map, key, record, kind) {
    if (!key) return;
    const current = map.get(key) || { key, count: 0, bands: [], modes: [], calls: [], lastQso: "", country: "", continent: "", state: "" };
    current.count += 1;
    current.bands = uniq([...current.bands, record.band]);
    current.modes = uniq([...current.modes, record.modeKey]);
    current.calls = uniq([...current.calls, record.call]);
    const stamp = `${record.qsoDate || ""}${record.timeOn || ""}`;
    if (stamp > current.lastQso) current.lastQso = stamp;
    current.country = current.country || record.country || "";
    current.continent = current.continent || record.continent || "";
    current.state = current.state || record.state || "";
    current.logStatus = record.logStatus || current.logStatus || "";
    if (kind === "call") {
      current.call = record.call;
      current.dxcc = current.dxcc || record.dxcc || "";
      current.grid = current.grid || record.grid || "";
    }
    map.set(key, current);
  }

  function geoKeys(record) {
    const out = [];
    const canonicalCountry = countryKey(record.country);
    if (record.continent) out.push(`CONT:${upper(record.continent)}`);
    if (canonicalCountry) out.push(`COUNTRY:${canonicalCountry}`);
    if (record.state) {
      out.push(`STATE:${upper(record.state)}`);
      if (canonicalCountry) out.push(`STATE:${canonicalCountry}:${upper(record.state)}`);
    }
    const county = upper(record.fields?.CNTY);
    if (county) {
      out.push(`CNTY:${county}`);
      if (canonicalCountry) out.push(`CNTY:${canonicalCountry}:${county}`);
    }
    return uniq(out);
  }

  async function rebuildIndices() {
    const db = await openDb();
    const calls = new Map(), dxccs = new Map(), ctys = new Map(), grids = new Map(), geos = new Map();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("qso_records", "readonly");
      const req = tx.objectStore("qso_records").openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const r = cur.value;
        updateSummary(calls, r.call, r, "call");
        updateSummary(dxccs, r.dxcc, r, "dxcc");
        updateSummary(ctys, r.ctyEntity, r, "cty");
        if (r.grid) {
          updateSummary(grids, r.grid.slice(0, 2), r, "grid");
          if (r.grid.length >= 4) updateSummary(grids, r.grid.slice(0, 4), r, "grid");
          updateSummary(grids, r.grid, r, "grid");
        }
        for (const key of geoKeys(r)) updateSummary(geos, key, r, "geo");
        cur.continue();
      };
      req.onerror = () => reject(req.error || new Error("Unable to scan QSO index"));
    });
    const tx = db.transaction(["worked_call_index","worked_dxcc_index","worked_cty_index","worked_grid_index","worked_geo_index"], "readwrite");
    const sc = tx.objectStore("worked_call_index"), sd = tx.objectStore("worked_dxcc_index"), st = tx.objectStore("worked_cty_index"), sg = tx.objectStore("worked_grid_index"), sx = tx.objectStore("worked_geo_index");
    sc.clear(); sd.clear(); st.clear(); sg.clear(); sx.clear();
    for (const v of calls.values()) sc.put(v);
    for (const v of dxccs.values()) sd.put(v);
    for (const v of ctys.values()) st.put(v);
    for (const v of grids.values()) sg.put(v);
    for (const v of geos.values()) sx.put(v);
    await txDone(tx);
    workedCallCache = calls; workedDxccCache = dxccs; workedCtyCache = ctys; workedGridCache = grids; workedGeoCache = geos;
    const detail = { calls: calls.size, dxcc: dxccs.size, cty: ctys.size, grids: grids.size, geo: geos.size };
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("freerig-ft8-logbook-updated", { detail }));
    return detail;
  }

  async function loadIndexCaches() {
    const db = await openDb();
    const readAll = async (storeName) => {
      const tx = db.transaction(storeName, "readonly");
      const rows = await reqPromise(tx.objectStore(storeName).getAll());
      await txDone(tx);
      return new Map(rows.map((r) => [r.key, r]));
    };
    workedCallCache = await readAll("worked_call_index");
    workedDxccCache = await readAll("worked_dxcc_index");
    workedCtyCache = await readAll("worked_cty_index");
    workedGridCache = await readAll("worked_grid_index");
    workedGeoCache = await readAll("worked_geo_index");
    const countries = Array.from(workedGeoCache.keys()).filter((key) => String(key).startsWith("COUNTRY:")).length;
    return { calls: workedCallCache.size, dxcc: workedDxccCache.size, cty: workedCtyCache.size, countries, grids: workedGridCache.size, geo: workedGeoCache.size };
  }

  async function importAdiText(value, options = {}) {
    const parser = new ADIIncrementalParser();
    const parsed = parser.feed(value, true);
    const result = await putBatch(parsed, options.source || "adi-text", { authoritative: Boolean(options.authoritative) });
    const indices = options.deferRebuild ? null : await rebuildIndices();
    return { ...result, parsed: parser.records, errors: parser.errors, ignored: parser.ignored, errorMessages: parser.errorMessages, indices };
  }

  async function replaceAllRecords(parsedRecords, options = {}) {
    const source = options.source || "authoritative";
    const normalizedById = new Map();
    let duplicates = 0;
    for (const parsed of parsedRecords || []) {
      const record = normalizeRecord(parsed, source);
      if (!record.call || !record.id) continue;
      if (normalizedById.has(record.id)) duplicates += 1;
      normalizedById.set(record.id, record);
    }
    const db = await openDb();
    const tx = db.transaction("qso_records", "readwrite");
    const store = tx.objectStore("qso_records");
    store.clear();
    for (const record of normalizedById.values()) store.put(record);
    await txDone(tx);
    const indices = await rebuildIndices();
    return { stored: normalizedById.size, duplicates, indices };
  }

  async function importAdiFile(file, options = {}) {
    if (!file || typeof file.stream !== "function") throw new Error("Select an .adi file");
    const parser = new ADIIncrementalParser();
    const reader = file.stream().getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let bytes = 0, imported = 0, duplicates = 0;
    while (true) {
      if (options.signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const records = parser.feed(decoder.decode(value, { stream: true }), false);
      if (records.length) {
        const r = await putBatch(records, options.source || `file:${file.name || "adi"}`);
        imported += r.imported; duplicates += r.duplicates;
      }
      options.onProgress?.({ bytes, total: Number(file.size) || 0, parsed: parser.records, imported, duplicates, errors: parser.errors });
    }
    const finalRecords = parser.feed(decoder.decode() || "", true);
    if (finalRecords.length) {
      const r = await putBatch(finalRecords, options.source || `file:${file.name || "adi"}`);
      imported += r.imported; duplicates += r.duplicates;
    }
    const indices = await rebuildIndices();
    const db = await openDb();
    const tx = db.transaction("import_jobs", "readwrite");
    tx.objectStore("import_jobs").add({ source: file.name || "ADI", size: file.size || 0, imported, duplicates, parsed: parser.records, errors: parser.errors, ignored: parser.ignored, at: isoNow() });
    await txDone(tx);
    options.onProgress?.({ bytes: file.size || bytes, total: file.size || bytes, parsed: parser.records, imported, duplicates, errors: parser.errors, done: true });
    return { imported, duplicates, parsed: parser.records, errors: parser.errors, ignored: parser.ignored, errorMessages: parser.errorMessages, indices };
  }

  async function saveLocalQso(fields, options = {}) {
    const parsed = { fields: { ...fields }, raw: options.raw || "" };
    const result = await putBatch([parsed], options.source || "local-ft8");
    await rebuildIndices();
    const record = normalizeRecord(parsed, options.source || "local-ft8");
    const db = await openDb();
    const tx = db.transaction("qso_records", "readonly");
    const saved = await reqPromise(tx.objectStore("qso_records").get(record.id));
    await txDone(tx);
    return { ...result, record: saved || record };
  }

  async function updateQso(id, patch) {
    const db = await openDb();
    const tx = db.transaction("qso_records", "readwrite");
    const store = tx.objectStore("qso_records");
    const rec = await reqPromise(store.get(id));
    if (!rec) throw new Error("Local QSO not found");
    const next = { ...rec, ...patch, fields: { ...(rec.fields || {}), ...(patch.fields || {}) }, updatedAt: isoNow() };
    store.put(next);
    await txDone(tx);
    await rebuildIndices();
    return next;
  }

  async function replaceLocalQso(id, fields, patch = {}) {
    const db = await openDb();
    const tx = db.transaction("qso_records", "readwrite");
    const store = tx.objectStore("qso_records");
    const existing = await reqPromise(store.get(id));
    if (!existing) throw new Error("Local QSO not found");
    const normalized = normalizeRecord({ fields: { ...(existing.fields || {}), ...(fields || {}) }, raw: existing.raw || "" }, (existing.sources || ["local-ft8"])[0]);
    normalized.importedAt = existing.importedAt || normalized.importedAt;
    normalized.sources = uniq([...(existing.sources || []), "local-ft8"]);
    normalized.logStatus = patch.logStatus ?? existing.logStatus ?? "";
    normalized.qrzLogId = patch.qrzLogId ?? existing.qrzLogId ?? "";
    normalized.qrzError = patch.qrzError ?? existing.qrzError ?? "";
    const targetId = normalized.id;
    if (targetId !== id) {
      const collision = await reqPromise(store.get(targetId));
      store.delete(id);
      if (collision) {
        const merged = mergeRecords(collision, normalized);
        merged.id = targetId;
        merged.logStatus = normalized.logStatus || collision.logStatus || "";
        merged.qrzLogId = normalized.qrzLogId || collision.qrzLogId || "";
        merged.qrzError = normalized.qrzError || collision.qrzError || "";
        store.put(merged);
      } else store.put(normalized);
    } else store.put(normalized);
    await txDone(tx);
    await rebuildIndices();
    const readTx = db.transaction("qso_records", "readonly");
    const saved = await reqPromise(readTx.objectStore("qso_records").get(targetId));
    await txDone(readTx);
    return saved || normalized;
  }

  async function reconcileCtyMetadata() {
    const ctyApi = typeof globalThis !== "undefined" ? globalThis.FreeRig710FT8CTY : null;
    if (!ctyApi?.lookup || !ctyApi?.stats?.().loaded) return { updated: 0, skipped: true };
    const db = await openDb();
    let updated = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("qso_records", "readwrite");
      const store = tx.objectStore("qso_records");
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const rec = cur.value; const cty = rec.call ? ctyApi.lookup(rec.call) : null;
        if (cty) {
          const fields = { ...(rec.fields || {}) };
          const source = upper(fields.APP_FREERIG_COUNTRY_SOURCE);
          let changed = false;
          if (source !== "QRZ" && upper(fields.COUNTRY) !== upper(cty.name)) { fields.COUNTRY = upper(cty.name); fields.APP_FREERIG_COUNTRY_SOURCE = "CTY"; changed = true; }
          if (upper(fields.CONT) !== upper(cty.continent) && upper(fields.APP_FREERIG_CONT_SOURCE) !== "QRZ") { fields.CONT = upper(cty.continent); fields.APP_FREERIG_CONT_SOURCE = "CTY"; changed = true; }
          if (rec.ctyEntity !== cty.entityKey || rec.ctyName !== cty.name) changed = true;
          if (changed) {
            const next = { ...rec, fields, country:text(fields.COUNTRY), continent:upper(fields.CONT), ctyEntity:text(cty.entityKey), ctyName:text(cty.name), updatedAt:isoNow() };
            next.richness = recordRichness(next); cur.update(next); updated += 1;
          }
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error || new Error("Unable to reconcile CTY metadata"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("CTY reconciliation failed"));
      tx.onabort = () => reject(tx.error || new Error("CTY reconciliation aborted"));
    });
    if (updated) await rebuildIndices();
    return { updated, skipped:false };
  }

  async function getPreference(key, fallback = null) {
    const db = await openDb();
    const tx = db.transaction("preferences", "readonly");
    const item = await reqPromise(tx.objectStore("preferences").get(String(key)));
    await txDone(tx);
    return item ? item.value : fallback;
  }

  async function setPreference(key, value) {
    const db = await openDb();
    const tx = db.transaction("preferences", "readwrite");
    tx.objectStore("preferences").put({ key: String(key), value, updatedAt: isoNow() });
    await txDone(tx);
    return value;
  }

  async function getSyncState(key = "qrz") {
    const db = await openDb();
    const tx = db.transaction("qrz_sync_state", "readonly");
    const item = await reqPromise(tx.objectStore("qrz_sync_state").get(String(key)));
    await txDone(tx);
    return item || null;
  }

  async function setSyncState(key, value) {
    const db = await openDb();
    const tx = db.transaction("qrz_sync_state", "readwrite");
    tx.objectStore("qrz_sync_state").put({ key: String(key), ...value, updatedAt: isoNow() });
    await txDone(tx);
  }

  function lookupCall(call) { return workedCallCache.get(upper(call)) || null; }
  function lookupDxcc(dxcc) { return workedDxccCache.get(text(dxcc)) || null; }
  function lookupCtyEntity(entity) { return workedCtyCache.get(upper(entity)) || null; }
  function lookupGrid(grid) {
    const g = upper(grid);
    return workedGridCache.get(g) || workedGridCache.get(g.slice(0, 4)) || workedGridCache.get(g.slice(0, 2)) || null;
  }
  function lookupGeo(kind, value, country = "") {
    const k = upper(kind);
    const v = k === "COUNTRY" ? countryKey(value) : upper(value);
    const c = countryKey(country);
    if (!k || !v) return null;
    return workedGeoCache.get(c ? `${k}:${c}:${v}` : `${k}:${v}`) || workedGeoCache.get(`${k}:${v}`) || null;
  }

  return Object.freeze({
    ADIF_VERSION, COUNTRY_KEY_SCHEMA, countryKey, ADIIncrementalParser, parseAdi, duplicateKey, normalizeRecord, mergeRecords,
    openDb, importAdiText, importAdiFile, replaceAllRecords, rebuildIndices, loadIndexCaches,
    saveLocalQso, updateQso, replaceLocalQso, reconcileCtyMetadata, getPreference, setPreference, getSyncState, setSyncState,
    lookupCall, lookupDxcc, lookupCtyEntity, lookupGrid, lookupGeo,
  });
});
