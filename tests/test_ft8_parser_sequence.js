"use strict";
const assert=require("assert");
const path=require("path");

global.window={};
global.document={getElementById(){return null;},querySelectorAll(){return [];},querySelector(){return null;},activeElement:null};
global.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
global.Worker=function(){};
global.requestAnimationFrame=()=>0;
global.cancelAnimationFrame=()=>{};
require(path.join(__dirname,"..","frontend","ft8.js"));
const c=window.FT710_FT8;
assert.equal(c.parseMessage("SA7CHI SV2HTW -04").kind,"REPORT");
assert.equal(c.parseMessage("SA7CHI SV2HTW −04").kind,"REPORT");
assert.equal(c.parseMessage("SA7CHI SV2HTW R−03").kind,"R_REPORT");
assert.equal(c.parseMessage("SA7CHI SV2HTW −04").payload,"-04");
console.log("FT8 parser report normalization: OK");
