"use strict";
/*
 * FreeRig710 offline callsign -> DXCC/entity resolver.
 * Runtime parser for AD1C Big CTY (cty.dat).
 * The browser loads the same-origin static cty.dat once and performs exact-call
 * and longest-prefix lookups entirely offline afterwards.
 */
(function(root){
  const state={loaded:false,loading:false,error:"",source:"",entities:[],exact:new Map(),prefix:new Map(),prefixLengths:[]};
  const up=v=>String(v??"").trim().toUpperCase();
  const cleanCall=v=>up(v).replace(/[^A-Z0-9/]/g,"");
  // Big CTY contains a few extra WAE/contest entities prefixed with '*'.
  // They are useful for display/contest geography but must not be treated as
  // separate ARRL DXCC entities by FreeRig710 worked/new-DXCC logic.
  // European Turkey (*TA1) is DXCC Turkey (TA).
  const DXCC_ENTITY_ALIASES=Object.freeze({"IT9":"I","TA1":"TA"});

  function parseHeader(text){
    const p=String(text||"").split(":");
    if(p.length<8)return null;
    const name=p[0].trim();
    const cq=Number(p[1]); const itu=Number(p[2]); const continent=up(p[3]);
    const latitude=Number(p[4]); const longitude=Number(p[5]); const utcOffset=Number(p[6]);
    const primaryPrefix=up(p[7]).replace(/^\*/,"");
    if(!name||!primaryPrefix)return null;
    return {name,cqZone:Number.isFinite(cq)?cq:null,ituZone:Number.isFinite(itu)?itu:null,continent,latitude:Number.isFinite(latitude)?latitude:null,longitude:Number.isFinite(longitude)?longitude:null,utcOffset:Number.isFinite(utcOffset)?utcOffset:null,primaryPrefix};
  }

  function parseToken(raw,entity){
    let token=String(raw||"").trim();
    if(!token)return null;
    const exact=token.startsWith("="); if(exact)token=token.slice(1);
    let cqZone=entity.cqZone, ituZone=entity.ituZone, continent=entity.continent;
    const cq=token.match(/\((\d+)\)/); if(cq)cqZone=Number(cq[1]);
    const itu=token.match(/\[(\d+)\]/); if(itu)ituZone=Number(itu[1]);
    const cont=token.match(/\{([A-Z]{2})\}/i); if(cont)continent=up(cont[1]);
    // Remove all Big-CTY per-prefix modifiers.  We do not need their coordinate
    // payload for identification; Maidenhead remains the source for QTH detail.
    token=token
      .replace(/\([^)]*\)/g,"")
      .replace(/\[[^\]]*\]/g,"")
      .replace(/\{[^}]*\}/g,"")
      .replace(/<[^>]*>/g,"")
      .replace(/~[^~]*~/g,"")
      .replace(/^\*/,"")
      .trim().toUpperCase();
    if(!token)return null;
    return {token,exact,cqZone,ituZone,continent};
  }

  function loadText(text,source="memory"){
    const entities=[]; const exact=new Map(); const prefix=new Map();
    // A CTY entity ends at ';'.  Joining whitespace makes parsing independent
    // of the wrapping used by the distributed text file.
    const chunks=String(text||"").replace(/\r/g,"").split(";");
    for(const chunkRaw of chunks){
      const chunk=chunkRaw.replace(/\n+/g," ").trim();
      if(!chunk)continue;
      // Header has eight colon-separated fields followed by the prefix list.
      const m=chunk.match(/^([^:]+):\s*([^:]+):\s*([^:]+):\s*([^:]+):\s*([^:]+):\s*([^:]+):\s*([^:]+):\s*([^:]+):\s*([\s\S]*)$/);
      if(!m)continue;
      const entity=parseHeader(m.slice(1,9).join(":"));
      if(!entity)continue;
      const id=entities.length; entities.push(entity);
      const list=m[9].split(",");
      // Some files omit the primary prefix from the following list; make sure
      // the entity is still reachable by its canonical prefix.
      list.push(entity.primaryPrefix);
      for(const raw of list){
        const t=parseToken(raw,entity); if(!t)continue;
        const value={entityId:id,match:t.token,matchType:t.exact?"exact":"prefix",cqZone:t.cqZone,ituZone:t.ituZone,continent:t.continent};
        if(t.exact)exact.set(t.token,value); else prefix.set(t.token,value);
      }
    }
    const lengths=Array.from(new Set(Array.from(prefix.keys(),k=>k.length))).sort((a,b)=>b-a);
    state.entities=entities; state.exact=exact; state.prefix=prefix; state.prefixLengths=lengths;
    state.loaded=entities.length>0; state.loading=false; state.error=state.loaded?"":"No CTY entities parsed"; state.source=source;
    if(root?.dispatchEvent && typeof CustomEvent!=="undefined") root.dispatchEvent(new CustomEvent("freerig-ft8-cty-ready",{detail:stats()}));
    return stats();
  }

  function lookupPrefix(candidate){
    const c=cleanCall(candidate); if(!c)return null;
    for(const len of state.prefixLengths){
      if(len>c.length)continue;
      const hit=state.prefix.get(c.slice(0,len)); if(hit)return hit;
    }
    return null;
  }

  function candidateCalls(call){
    const c=cleanCall(call); if(!c)return [];
    const out=[c];
    if(c.includes("/")){
      const parts=c.split("/").filter(Boolean);
      // Prefix-first portable forms such as HA/G4RCR naturally match on the
      // full string.  Also try individual parts and base-call forms.
      for(const p of parts)out.push(p);
      if(parts.length>=2){out.push(`${parts[0]}/${parts[1]}`); out.push(`${parts[parts.length-2]}/${parts[parts.length-1]}`);}
    }
    return Array.from(new Set(out));
  }

  function materialize(hit,input){
    if(!hit)return null; const e=state.entities[hit.entityId]; if(!e)return null;
    const entityKey=DXCC_ENTITY_ALIASES[e.primaryPrefix]||e.primaryPrefix;
    return {call:cleanCall(input),name:e.name,entityKey,ctyEntityKey:e.primaryPrefix,primaryPrefix:e.primaryPrefix,continent:hit.continent||e.continent,cqZone:hit.cqZone??e.cqZone,ituZone:hit.ituZone??e.ituZone,latitude:e.latitude,longitude:e.longitude,utcOffset:e.utcOffset,match:hit.match,matchType:hit.matchType,source:"AD1C Big CTY"};
  }

  function lookup(call){
    if(!state.loaded)return null;
    const candidates=candidateCalls(call);
    // Exact exceptions always win, first on the untouched complete call.
    for(const c of candidates){const h=state.exact.get(c); if(h)return materialize(h,call);}
    // Longest-prefix match. Prefer full original form, then portable segments.
    for(const c of candidates){const h=lookupPrefix(c); if(h)return materialize(h,call);}
    return null;
  }

  async function load(url="cty.dat"){
    if(state.loading)return api.ready;
    state.loading=true; state.error="";
    try{
      const r=await fetch(url,{cache:"no-store"});
      if(!r.ok)throw new Error(`CTY HTTP ${r.status}`);
      return loadText(await r.text(),url);
    }catch(error){
      state.loading=false; state.loaded=false; state.error=error?.message||String(error);
      if(root?.dispatchEvent && typeof CustomEvent!=="undefined")root.dispatchEvent(new CustomEvent("freerig-ft8-cty-error",{detail:{error:state.error}}));
      return stats();
    }
  }

  function stats(){return Object.freeze({loaded:state.loaded,loading:state.loading,error:state.error,source:state.source,entities:state.entities.length,exact:state.exact.size,prefixes:state.prefix.size});}
  const api={load,loadText,lookup,stats};
  api.ready=(typeof fetch==="function")?load("cty.dat"):Promise.resolve(stats());
  root.FreeRig710FT8CTY=Object.freeze(api);
  if(typeof module==="object"&&module.exports)module.exports=api;
})(typeof window!=="undefined"?window:globalThis);
