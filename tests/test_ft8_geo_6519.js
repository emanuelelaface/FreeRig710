"use strict";
const assert=require("assert");
require("../frontend/ft8-geo.js");
const geo=global.FreeRig710FT8Geo;
assert(geo,"offline geo API missing");
assert(geo.stats.records>8000,"geo index unexpectedly small");

const rome=geo.lookupGrid("JN61");
assert.equal(geo.lookupGrid("JN61aa00").city,"Rome");
assert(rome && rome.continent==="EU" && rome.country==="Italy");
assert(rome.region==="Lazio");
assert(rome.city==="Rome");
assert(rome.approximate===true);

const stockholm=geo.lookupGrid("JO99");
assert(stockholm && stockholm.country==="Sweden" && stockholm.region==="Stockholm");
const tokyo=geo.lookupGrid("PM95");
assert(tokyo && tokyo.continent==="AS" && tokyo.country==="Japan" && tokyo.city==="Tokyo");
assert.strictEqual(geo.lookupGrid("ZZ99"),null);

geo.clearCallCache();
const learned=geo.resolve("IK0ABC","JN61");
assert(learned && learned.city==="Rome");
const cached=geo.resolve("IK0ABC","");
assert(cached && cached.country==="Italy" && cached.city==="Rome","call -> last grid geo cache failed");
console.log("FT8.6.5.19 offline Maidenhead geo lookup: OK");
