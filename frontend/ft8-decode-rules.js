"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FreeRig710FT8DecodeRules = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULT_FILTERS = Object.freeze({
    bypass:false, cqOnly:false, showMyCall:true, showStandard:true, showFree:true, showBeacon:true,
    anyMsgNewContinent:false, anyMsgNewCountry:false, anyMsgNewDxcc:false, anyMsgNewDxccBand:false,
    anyMsgNewCall:false, anyMsgNewBand:false, anyMsgNewMode:false, anyMsgNewGrid:false,
    minSnr:-30, dfMin:200, dfMax:3000, includeCalls:"", excludeCalls:"", ignoreCalls:"",
    continent:"", country:"", region:"", dxcc:"", gridPrefix:"", worked:"any", workedBand:false, workedMode:false,
    workedToday:false, workedYesterday:false, newDxcc:false, newDxccBand:false, newBand:false, newMode:false, newGrid:false,
    minDistanceKm:"", maxDistanceKm:"",
  });

  const DEFAULT_RULES = Object.freeze([
    {id:"mycall",label:"My Call / direct",enabled:true,priority:110,fg:"#ffffff",bg:"#7b2cff",criteria:""},
    {id:"selected",label:"Selected QSO",enabled:true,priority:105,fg:"#ffffff",bg:"#1d6a8a",criteria:""},
    {id:"new-dxcc",label:"New DXCC",enabled:true,priority:100,fg:"#111111",bg:"#ffd45a",criteria:""},
    {id:"new-country",label:"New country",enabled:true,priority:98,fg:"#101010",bg:"#ff9f43",criteria:""},
    {id:"new-dxcc-band",label:"New DXCC on band",enabled:true,priority:95,fg:"#111111",bg:"#ffc96b",criteria:""},
    {id:"cq",label:"CQ",enabled:true,priority:80,fg:"#e8fff0",bg:"#1f5a38",criteria:""},
    {id:"new-grid",label:"New grid",enabled:true,priority:70,fg:"#101010",bg:"#8ee3ff",criteria:""},
    {id:"new-call",label:"New call",enabled:true,priority:65,fg:"#dff7ff",bg:"#254a5b",criteria:""},
    {id:"region",label:"Selected region",enabled:true,priority:55,fg:"#f7e7ff",bg:"#56365f",criteria:""},
    {id:"worked",label:"Worked before",enabled:true,priority:30,fg:"#b9c3cc",bg:"#202a33",criteria:""},
    {id:"filtered",label:"Ignored / filtered",enabled:true,priority:20,fg:"#8e98a1",bg:"#15191e",criteria:""},
    {id:"nonstandard",label:"Non-standard",enabled:true,priority:10,fg:"#ffc5c5",bg:"#4b2525",criteria:""},
  ]);

  const upper = (v) => String(v ?? "").trim().toUpperCase();
  const tokens = (v) => upper(v).split(/[\s,;]+/).filter(Boolean);
  const prefixMatch = (call, list) => !list.length || list.some((p) => {
    const pat = upper(p).replace(/\*+$/, "");
    return pat && upper(call).startsWith(pat);
  });
  const ymd = (d) => d.toISOString().slice(0,10).replaceAll("-","");

  function rowCall(row, myCall="") {
    const p=row?.parsed||{}; const me=upper(myCall);
    if (p.kind === "CQ") return upper(p.call);
    const from=upper(p.from), to=upper(p.to);
    return from && from !== me ? from : (to && to !== me ? to : upper(p.call));
  }

  function gridToLatLon(gridValue) {
    const g=upper(gridValue).replace(/\s+/g,"");
    if (!/^[A-R]{2}\d{2}([A-X]{2}(\d{2})?)?$/.test(g)) return null;
    let lon=(g.charCodeAt(0)-65)*20-180;
    let lat=(g.charCodeAt(1)-65)*10-90;
    lon+=(Number(g[2])||0)*2;
    lat+=(Number(g[3])||0);
    let lonSpan=2, latSpan=1;
    if (g.length>=6) {
      lon+=(g.charCodeAt(4)-65)*(5/60); lat+=(g.charCodeAt(5)-65)*(2.5/60);
      lonSpan=5/60; latSpan=2.5/60;
    }
    if (g.length>=8) {
      lon+=(Number(g[6])||0)*(30/3600); lat+=(Number(g[7])||0)*(15/3600);
      lonSpan=30/3600; latSpan=15/3600;
    }
    return {lat:lat+latSpan/2,lon:lon+lonSpan/2};
  }

  function distanceKm(aGrid,bGrid) {
    const a=gridToLatLon(aGrid), b=gridToLatLon(bGrid); if(!a||!b)return null;
    const rad=Math.PI/180, p1=a.lat*rad,p2=b.lat*rad,dp=(b.lat-a.lat)*rad,dl=(b.lon-a.lon)*rad;
    const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
  }

  function enrich(row, context={}) {
    const call=rowCall(row, context.myCall); const lb=context.logbook;
    const worked=call ? lb?.lookupCall?.(call) : null;
    const p=row?.parsed||{}; const meta=row?.meta||{};
    const grid=upper(p.grid || meta.grid || worked?.grid || "");
    const geoApi=context.geo || (typeof globalThis!=="undefined" ? globalThis.FreeRig710FT8Geo : null);
    const ctyApi=context.cty || (typeof globalThis!=="undefined" ? globalThis.FreeRig710FT8CTY : null);
    const geo=(!row?.isTx && geoApi?.resolve) ? geoApi.resolve(call,grid) : null;
    const cty=(!row?.isTx && call && ctyApi?.lookup) ? ctyApi.lookup(call) : null;
    const firstText=(...values)=>{for(const value of values){const text=String(value??"").trim();if(text)return text;}return "";};
    const dxcc=firstText(meta.dxcc,p.dxcc,worked?.dxcc);
    // Callsign/CTY is authoritative for entity/country. Maidenhead is only a
    // QTH refinement and must never decide the country of a live station.
    const country=firstText(meta.country,p.country,cty?.name,worked?.country);
    const continent=upper(firstText(meta.continent,p.continent,cty?.continent,worked?.continent));
    const countryKey=lb?.countryKey || ((v)=>upper(v));
    const geoCountryCompatible=!geo?.country || Boolean(country && countryKey(country)===countryKey(geo.country));
    const state=firstText(meta.state,p.state,worked?.state,geoCountryCompatible?geo?.region:"");
    const city=firstText(meta.city,p.city,worked?.city,geoCountryCompatible?geo?.city:"");
    const countryCode=upper(firstText(meta.countryCode,p.countryCode,worked?.countryCode,geoCountryCompatible?geo?.countryCode:""));
    const ctyEntity=firstText(meta.ctyEntity,p.ctyEntity,cty?.entityKey,worked?.ctyEntity);
    const band=upper(context.band || ""); const mode=upper(context.mode || "FT8");
    const bands=(worked?.bands||[]).map(upper), modes=(worked?.modes||[]).map(upper);
    const ctyWorked=ctyEntity ? lb?.lookupCtyEntity?.(ctyEntity) : null;
    const dxccWorked=dxcc ? lb?.lookupDxcc?.(dxcc) : ctyWorked;
    const countryWorked=country ? lb?.lookupGeo?.("COUNTRY",country) : null;
    const continentWorked=continent ? lb?.lookupGeo?.("CONT",continent) : null;
    const dxccBands=(dxccWorked?.bands||[]).map(upper), dxccModes=(dxccWorked?.modes||[]).map(upper);
    const now=context.now instanceof Date ? context.now : new Date();
    const today=ymd(now); const yesterday=ymd(new Date(now.getTime()-86400000));
    const last=String(worked?.lastQso||"").slice(0,8);
    const standard=Boolean(p.kind && !["OTHER","DIRECTED"].includes(p.kind));
    const beacon=/\b(BEACON|WSPR)\b/i.test(String(row?.text||""));
    const directToMe=Boolean(upper(p.to) && upper(p.to)===upper(context.myCall));
    const km=grid && context.myGrid ? distanceKm(context.myGrid,grid) : null;
    return {
      call, worked, grid, dxcc, ctyEntity, ctyName:cty?.name||"", country, continent, state, city, countryCode, band, mode, dxccWorked, countryWorked,
      geoApproximate:Boolean(geo?.approximate), geoNearby:Boolean(geo?.nearby), geoCountryConflict:Boolean(geo?.country&&!geoCountryCompatible),
      geoNearbyDistanceKm:Number(geo?.nearbyDistanceKm||0), geoSource:String(geo?.source||""), ctySource:String(cty?.source||""),
      workedBefore:Boolean(worked), workedBand:Boolean(worked && band && bands.includes(band)), workedMode:Boolean(worked && mode && modes.includes(mode)),
      workedToday:Boolean(worked && last===today), workedYesterday:Boolean(worked && last===yesterday),
      newCall:Boolean(call && !worked),
      newContinent:Boolean(continent && !continentWorked),
      newCountry:Boolean(country && !countryWorked),
      newDxcc:Boolean((dxcc||ctyEntity) && !dxccWorked),
      newDxccBand:Boolean((dxcc||ctyEntity) && band && (!dxccWorked || !dxccBands.includes(band))),
      newDxccMode:Boolean((dxcc||ctyEntity) && mode && (!dxccWorked || !dxccModes.includes(mode))),
      newGrid:Boolean(grid && !lb?.lookupGrid?.(grid)),
      newBand:Boolean(call && band && (!worked || !bands.includes(band))),
      newMode:Boolean(call && mode && (!worked || !modes.includes(mode))),
      standard, freeText:!standard, beacon, directToMe, distanceKm:km,
      logStatus:upper(meta.logStatus || worked?.logStatus || ""),
    };
  }

  function numericFilter(value, minValue, maxValue) {
    if (value == null || !Number.isFinite(Number(value))) return !(minValue !== "" || maxValue !== "");
    const n=Number(value);
    if (minValue !== "" && Number.isFinite(Number(minValue)) && n < Number(minValue)) return false;
    if (maxValue !== "" && Number.isFinite(Number(maxValue)) && n > Number(maxValue)) return false;
    return true;
  }

  function interestException(e, f) {
    return Boolean(
      (f.anyMsgNewContinent && e.newContinent) ||
      (f.anyMsgNewCountry && e.newCountry) ||
      (f.anyMsgNewDxcc && e.newDxcc) ||
      (f.anyMsgNewDxccBand && e.newDxccBand) ||
      (f.anyMsgNewCall && e.newCall) ||
      (f.anyMsgNewBand && e.newBand) ||
      (f.anyMsgNewMode && e.newMode) ||
      (f.anyMsgNewGrid && e.newGrid)
    );
  }

  function passWithoutBypass(row, filters, context={}) {
    const f={...DEFAULT_FILTERS,...(filters||{})}; const e=enrich(row,context); const p=row?.parsed||{};
    // "My Call always" is intentionally absolute: once a decode is addressed
    // to this station it must remain visible even when SNR/DF/worked/geography
    // filters would otherwise hide it. This is essential for an active QSO.
    if (f.showMyCall && e.directToMe) return true;

    const inc=tokens(f.includeCalls), exc=tokens(f.excludeCalls), ign=tokens(f.ignoreCalls);

    // DF limits and explicit operator block-lists are hard constraints. Keep
    // them ahead of the interest-union path so "Any msg · new …" cannot pull
    // in a deliberately ignored/excluded call or traffic outside the RX slice.
    if (Number.isFinite(Number(f.dfMin)) && Number(row?.df) < Number(f.dfMin)) return false;
    if (Number.isFinite(Number(f.dfMax)) && Number(row?.df) > Number(f.dfMax)) return false;
    if (exc.length && prefixMatch(e.call,exc)) return false;
    if (ign.length && prefixMatch(e.call,ign)) return false;

    // "Any msg · new …" is a true interest union. If a decode matches one of
    // the selected new/worked-interest conditions it remains visible regardless
    // of CQ-only, SNR, message-class, include/geography/worked filters. This is
    // intentionally stronger than a CQ-only exception: a decoded rare/new DXCC
    // at -35 dB is still useful and should not disappear behind Min SNR.
    if (interestException(e,f)) return true;

    if (f.cqOnly && p.kind!=="CQ") return false;
    if (!f.showStandard && e.standard) return false;
    if (!f.showFree && e.freeText) return false;
    if (!f.showBeacon && e.beacon) return false;
    if (Number.isFinite(Number(f.minSnr)) && Number(row?.snr) < Number(f.minSnr)) return false;
    if (inc.length && !prefixMatch(e.call,inc)) return false;
    if (upper(f.continent) && e.continent!==upper(f.continent)) return false;
    if (upper(f.country) && !upper(e.country).includes(upper(f.country))) return false;
    if (upper(f.region) && !upper(e.state).includes(upper(f.region))) return false;
    if (String(f.dxcc||"").trim() && String(e.dxcc)!==String(f.dxcc).trim()) return false;
    if (upper(f.gridPrefix) && !e.grid.startsWith(upper(f.gridPrefix))) return false;
    if (f.worked==="only" && !e.workedBefore) return false;
    if (f.worked==="hide" && e.workedBefore) return false;
    if (f.workedBand && !e.workedBand) return false;
    if (f.workedMode && !e.workedMode) return false;
    if (f.workedToday && !e.workedToday) return false;
    if (f.workedYesterday && !e.workedYesterday) return false;
    if (f.newDxcc && !e.newDxcc) return false;
    if (f.newDxccBand && !e.newDxccBand) return false;
    if (f.newBand && !e.newBand) return false;
    if (f.newMode && !e.newMode) return false;
    if (f.newGrid && !e.newGrid) return false;
    if (!numericFilter(e.distanceKm,f.minDistanceKm,f.maxDistanceKm)) return false;
    return true;
  }

  function passes(row, filters, context={}) { return Boolean(filters?.bypass) || passWithoutBypass(row,filters,context); }

  function parseCriteria(value) {
    const out={};
    for(const piece of String(value||"").split(/[;\n]+/)){
      const i=piece.indexOf("="); if(i<1)continue;
      const key=upper(piece.slice(0,i)).replace(/[\s_-]+/g,"");
      const val=piece.slice(i+1).trim(); if(key&&val)out[key]=val;
    }
    return out;
  }

  function yesNoMatch(actual,value){const v=upper(value);if(["YES","Y","TRUE","1","ON"].includes(v))return Boolean(actual);if(["NO","N","FALSE","0","OFF"].includes(v))return !actual;return true;}
  function listMatch(actual,value,{prefix=false,contains=false}={}){
    const list=String(value||"").split(/[,|]+/).map(upper).filter(Boolean); if(!list.length)return true;
    const a=upper(actual); return list.some(v=>prefix?a.startsWith(v.replace(/\*+$/, "")):(contains?a.includes(v):a===v));
  }

  function criteriaMatches(criteriaValue,row,context,e) {
    const c=parseCriteria(criteriaValue); if(!Object.keys(c).length)return true;
    const p=row?.parsed||{};
    if(c.CALL&&!listMatch(e.call,c.CALL,{prefix:true}))return false;
    if(c.DXCC&&!listMatch(e.dxcc,c.DXCC))return false;
    if(c.COUNTRY&&!listMatch(e.country,c.COUNTRY,{contains:true}))return false;
    if(c.CONTINENT&&!listMatch(e.continent,c.CONTINENT))return false;
    if((c.STATE||c.REGION)&&!listMatch(e.state,c.STATE||c.REGION,{contains:true}))return false;
    if(c.GRID&&!listMatch(e.grid,c.GRID,{prefix:true}))return false;
    if(c.BAND&&!listMatch(e.band,c.BAND))return false;
    if(c.MODE&&!listMatch(e.mode,c.MODE))return false;
    if(c.WORKED&&!yesNoMatch(e.workedBefore,c.WORKED))return false;
    if(c.WORKEDBAND&&!yesNoMatch(e.workedBand,c.WORKEDBAND))return false;
    if(c.WORKEDMODE&&!yesNoMatch(e.workedMode,c.WORKEDMODE))return false;
    if(c.NEWCALL&&!yesNoMatch(e.newCall,c.NEWCALL))return false;
    if(c.NEWCOUNTRY&&!yesNoMatch(e.newCountry,c.NEWCOUNTRY))return false;
    if(c.NEWDXCC&&!yesNoMatch(e.newDxcc,c.NEWDXCC))return false;
    if(c.NEWDXCCBAND&&!yesNoMatch(e.newDxccBand,c.NEWDXCCBAND))return false;
    if(c.NEWGRID&&!yesNoMatch(e.newGrid,c.NEWGRID))return false;
    if(c.NEWBAND&&!yesNoMatch(e.newBand,c.NEWBAND))return false;
    if(c.NEWMODE&&!yesNoMatch(e.newMode,c.NEWMODE))return false;
    if(c.KIND&&!listMatch(p.kind,c.KIND))return false;
    if(c.STATUS&&!listMatch(e.logStatus,c.STATUS))return false;
    return true;
  }

  function matchRule(ruleId,row,context,e,wouldFilter) {
    const p=row?.parsed||{};
    switch(ruleId){
      case "mycall": return e.directToMe;
      case "selected": return e.call && e.call===upper(context.selectedCall);
      case "cq": return p.kind==="CQ";
      case "new-country": return e.newCountry;
      case "new-dxcc": return e.newDxcc;
      case "new-dxcc-band": return e.newDxccBand;
      case "new-grid": return e.newGrid;
      case "new-call": return e.newCall;
      case "region": return Boolean(context.selectedRegion && (e.continent===upper(context.selectedRegion) || upper(e.country).includes(upper(context.selectedRegion)) || upper(e.state).includes(upper(context.selectedRegion))));
      case "worked": return e.workedBefore;
      case "filtered": return wouldFilter;
      case "nonstandard": return !e.standard;
      default:return true;
    }
  }

  function winningRule(row,rules,context={},filters={}) {
    const e=enrich(row,context); const wouldFilter=!passWithoutBypass(row,filters,context);
    const enabled=(rules||DEFAULT_RULES).filter(r=>r&&r.enabled!==false).slice().sort((a,b)=>Number(b.priority||0)-Number(a.priority||0));
    return enabled.find(r=>matchRule(r.id,row,context,e,wouldFilter)&&criteriaMatches(r.criteria,row,context,e)) || null;
  }

  return Object.freeze({
    DEFAULT_FILTERS,DEFAULT_RULES,rowCall,gridToLatLon,distanceKm,enrich,passes,passWithoutBypass,
    parseCriteria,criteriaMatches,winningRule
  });
});
