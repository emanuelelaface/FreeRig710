"use strict";
const assert = require("assert");
const lb = require("../frontend/ft8-logbook.js");
function field(name, value, type="") { return `<${name}:${String(value).length}${type ? `:${type}` : ""}>${value}`; }
{
  const adi = `${field("ADIF_VER","3.1.7")}<EOH>${field("CALL","K1ABC")}${field("QSO_DATE","20260818")}${field("TIME_ON","191500")}${field("BAND","20M")}${field("MODE","FT8")}<EOR>`;
  const r = lb.parseAdi(adi); assert.equal(r.records.length,1); assert.equal(r.records[0].fields.CALL,"K1ABC"); assert.equal(r.stats.errors,0);
}
{
  const adi = `${field("call","SM0ABC")}${field("qso_date","20240101")}${field("time_on","1200")}${field("band","40m")}${field("mode","FT8")}${field("X_UNKNOWN","kept")}<eor>`;
  const r = lb.parseAdi(adi); assert.equal(r.records[0].fields.X_UNKNOWN,"kept"); const n = lb.normalizeRecord(r.records[0],"test"); assert.equal(n.call,"SM0ABC"); assert.equal(n.modeKey,"FT8");
}
{
  const p = new lb.ADIIncrementalParser(); const a=[]; a.push(...p.feed("<CALL:5>K1",false)); a.push(...p.feed("ABC<QSO_DATE:8>20260818<TIME_ON:6>191500<BAND:3>20M<MODE:3>FT8<EOR>",true)); assert.equal(a.length,1); assert.equal(a[0].fields.CALL,"K1ABC");
}
{ const r = lb.parseAdi("<CALL:X>BAD<EOR>"); assert.ok(r.stats.errors >= 1); }
{
  const a=lb.normalizeRecord({fields:{CALL:"K1ABC",STATION_CALLSIGN:"SM0XYZ",QSO_DATE:"20260818",TIME_ON:"191500",BAND:"20M",MODE:"FT8"}},"a");
  const b=lb.normalizeRecord({fields:{CALL:"K1ABC",STATION_CALLSIGN:"SM0XYZ",QSO_DATE:"20260818",TIME_ON:"191500",BAND:"20M",MODE:"FT8",GRIDSQUARE:"FN31",COUNTRY:"USA"}},"b");
  assert.equal(a.id,b.id); const m=lb.mergeRecords(a,b); assert.equal(m.fields.GRIDSQUARE,"FN31"); assert.ok(m.sources.includes("a")&&m.sources.includes("b"));
}
console.log("FT8 ADIF parser tests: OK");
