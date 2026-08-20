"use strict";
const assert=require("assert");
require("../frontend/ft8-geo.js");
const rules=require("../frontend/ft8-decode-rules.js");
const context={myCall:"SM0XYZ",myGrid:"JO99",band:"20M",mode:"FT8"};
let row={snr:-8,df:1000,text:"CQ IK0ABC JN61",parsed:{kind:"CQ",call:"IK0ABC",grid:"JN61"}};
let e=rules.enrich(row,context);
assert.equal(e.country,"Italy");
assert.equal(e.continent,"EU");
assert.equal(e.state,"Lazio");
assert.equal(e.city,"Rome");
assert(e.distanceKm>0);

// A later directed/report line usually has no grid.  The resolver should reuse
// geography learned from the same callsign's previous locator-bearing decode.
row={snr:-7,df:1000,text:"SM0XYZ IK0ABC -10",parsed:{kind:"REPORT",from:"IK0ABC",to:"SM0XYZ",report:"-10"}};
e=rules.enrich(row,context);
assert.equal(e.country,"Italy");
assert.equal(e.city,"Rome");

assert(rules.passes(row,{...rules.DEFAULT_FILTERS,country:"italy"},context));
assert(rules.passes(row,{...rules.DEFAULT_FILTERS,region:"lazio"},context));
console.log("FT8.6.5.19 geo enrichment/filter integration: OK");
