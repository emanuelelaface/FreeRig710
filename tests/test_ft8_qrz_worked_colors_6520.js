const assert=require("assert");
const rules=require("../frontend/ft8-decode-rules.js");
const workedCountries=new Map([["ICELAND",{key:"COUNTRY:ICELAND",count:2,bands:["20M"],modes:["FT8"]}]]);
const lb={
 lookupCall:c=>c==="TF1OLD"?{key:c,count:1,bands:["20M"],modes:["FT8"],lastQso:"20260820"}:null,
 lookupDxcc:()=>null,
 lookupGrid:()=>null,
 lookupGeo:(kind,value)=>kind==="COUNTRY"?workedCountries.get(String(value).toUpperCase())||null:null,
};
const geo={resolve:(call,grid)=>({country:"Iceland",continent:"EU",region:"Capital Region",city:"Reykjavik",approximate:true,source:"test"})};
const context={myCall:"SA7CHI",myGrid:"JO99",band:"20M",mode:"FT8",logbook:lb,geo};
let row={snr:-5,df:1000,text:"CQ TF3NEW HP94",parsed:{kind:"CQ",call:"TF3NEW",from:"TF3NEW",grid:"HP94"}};
let e=rules.enrich(row,context);assert.equal(e.country,"Iceland");assert.equal(e.newCountry,false);
workedCountries.clear();e=rules.enrich(row,context);assert.equal(e.newCountry,true);
const win=rules.winningRule(row,rules.DEFAULT_RULES,context,rules.DEFAULT_FILTERS);assert.equal(win.id,"new-country");assert(win.priority>rules.DEFAULT_RULES.find(r=>r.id==="cq").priority);
console.log("FT8.6.5.20 new-country/worked color behavior: OK");
