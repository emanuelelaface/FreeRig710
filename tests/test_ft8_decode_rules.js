"use strict";
const assert=require("assert");
const r=require("../frontend/ft8-decode-rules.js");
const lb={
  lookupCall:(c)=>c==="K1OLD"?{count:2,bands:["20M"],modes:["FT8"],lastQso:"202608171200",dxcc:"291",country:"USA",continent:"NA",grid:"FN31"}:null,
  lookupDxcc:(d)=>d==="291"?{count:10,bands:["40M"],modes:["FT8"]}:null,
  lookupGrid:(g)=>g.startsWith("FN31")?{count:1}:null
};
const cq={snr:-10,df:1500,text:"CQ K1NEW FN32",parsed:{kind:"CQ",call:"K1NEW",grid:"FN32",from:"K1NEW",to:""},meta:{dxcc:"291",country:"USA",continent:"NA",state:"CT"}};
const ctx={myCall:"SM0ME",myGrid:"JO89",band:"20M",mode:"FT8",logbook:lb,now:new Date("2026-08-18T12:00:00Z")};
assert.equal(r.rowCall(cq,"SM0ME"),"K1NEW");
let e=r.enrich(cq,ctx);
assert.equal(e.newCall,true);
assert.equal(e.newDxcc,false);
assert.equal(e.newDxccBand,true);
assert.ok(Number.isFinite(e.distanceKm) && e.distanceKm>5000);
assert.equal(r.passes(cq,{...r.DEFAULT_FILTERS,minSnr:-5},ctx),false);
assert.equal(r.passes(cq,{...r.DEFAULT_FILTERS,bypass:true,minSnr:-5},ctx),true);
assert.equal(r.passes(cq,{...r.DEFAULT_FILTERS,newDxccBand:true},ctx),true);
assert.equal(r.passes(cq,{...r.DEFAULT_FILTERS,minDistanceKm:10000},ctx),false);
assert.equal(r.passes(cq,{...r.DEFAULT_FILTERS,maxDistanceKm:10000},ctx),true);
const old={snr:-2,df:1000,text:"CQ K1OLD FN31",parsed:{kind:"CQ",call:"K1OLD",grid:"FN31",from:"K1OLD"},meta:{dxcc:"291",country:"USA",continent:"NA"}};
assert.equal(r.enrich(old,ctx).workedBand,true);
assert.equal(r.passes(old,{...r.DEFAULT_FILTERS,worked:"hide"},ctx),false);
assert.equal(r.passes(old,{...r.DEFAULT_FILTERS,workedBand:true},ctx),true);
assert.equal(r.winningRule(cq,r.DEFAULT_RULES,{...ctx,selectedCall:"K1NEW"},r.DEFAULT_FILTERS).id,"selected");
const custom=[
  {id:"custom-low",enabled:true,priority:5,criteria:"call=K1*;band=20M",fg:"",bg:""},
  {id:"custom-high",enabled:true,priority:50,criteria:"call=K1*;band=20M;NEWDXCCBAND=yes",fg:"",bg:""}
];
assert.equal(r.winningRule(cq,custom,ctx,r.DEFAULT_FILTERS).id,"custom-high");
assert.equal(r.criteriaMatches("continent=NA;country=USA;grid=FN;mode=FT8",cq,ctx,e),true);
assert.equal(r.criteriaMatches("state=CA",cq,ctx,e),false);
assert.equal(r.gridToLatLon("JO89")!==null,true);
assert.equal(r.gridToLatLon("BAD"),null);
console.log("FT8 decode rule tests: OK");
