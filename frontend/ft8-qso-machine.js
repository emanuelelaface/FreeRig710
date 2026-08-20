"use strict";
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.FreeRig710FT8QsoMachine=api;})(typeof window!=="undefined"?window:globalThis,function(){
  const STATES=Object.freeze(["IDLE","SELECTED","CALLING_CQ","ANSWERING_CQ","WAIT_DX_REPORT","SEND_REPORT","WAIT_R_REPORT","SEND_R_REPORT","WAIT_RR73","SEND_RR73","WAIT_73","SEND_73","COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED","ABORTED","TIMEOUT","ERROR"]);
  const TERMINAL=new Set(["COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED","ABORTED","TIMEOUT","ERROR"]);
  const WAITING=new Set(["WAIT_DX_REPORT","WAIT_R_REPORT","WAIT_RR73","WAIT_73"]);
  const upper=v=>String(v??"").trim().toUpperCase();
  const report=v=>{let n=Math.max(-30,Math.min(30,Math.round(Number(v)||0)));return `${n>=0?"+":"-"}${String(Math.abs(n)).padStart(2,"0")}`;};
  const payloadReport=v=>{const m=upper(v).match(/^R?([+-]\d\d)$/);return m?m[1]:"";};
  class QsoMachine{
    constructor(options={}){this.options={maxRetries:6,timeoutSlots:8,completeOnSent73:true,callFirst:true,autoSeq:true,...options};this.reset();}
    reset(){this.state="IDLE";this.myCall="";this.myGrid="";this.dxCall="";this.dxGrid="";this.df=null;this.rxSlotParity=null;this.txSlotParity=0;this.startedUnixMs=0;this.completedUnixMs=0;this.lastHeard="";this.lastHeardUnixMs=0;this.txReport="+00";this.rstRcvd="";this.nextMessage="";this.lastTxMessage="";this.attempts=0;this.retryAttempts=0;this.silentSlots=0;this.lastRxSlotIndex=null;this.history=[];return this.snapshot();}
    configure(options={}){this.options={...this.options,...options};return this.options;}
    identity({myCall,myGrid,txReport}={}){if(myCall!=null)this.myCall=upper(myCall);if(myGrid!=null)this.myGrid=upper(myGrid);if(txReport!=null)this.txReport=typeof txReport==="string"&&/^[+-]\d\d$/.test(txReport)?txReport:report(txReport);this._plan();return this.snapshot();}
    isActive(){return this.state!=="IDLE"&&!TERMINAL.has(this.state);}
    _transition(state,cause,meta={}){if(!STATES.includes(state))throw new Error(`Unknown QSO state ${state}`);const from=this.state;if(state!==from)this.retryAttempts=0;this.state=state;if(state==="COMPLETE"&&!this.completedUnixMs)this.completedUnixMs=Number(meta.unixMs)||Date.now();this.history.push({from,to:state,cause:String(cause||""),slotIndex:meta.slotIndex??null,utc:meta.utc||new Date(meta.unixMs||Date.now()).toISOString(),rx:meta.rx||"",tx:meta.tx||"",attempt:this.attempts,retry:this.retryAttempts});if(this.history.length>80)this.history.shift();this._plan();return this.snapshot();}
    select({dxCall,dxGrid,df,rxSlotParity,kind="CQ",unixMs=Date.now(),slotIndex=null,force=false}={}){const dx=upper(dxCall);if(!dx||!this.myCall||dx===this.myCall)return this.snapshot();if(this.isActive()&&!force){if(this.dxCall&&this.dxCall!==dx)return this.snapshot();if(this.dxCall===dx){if(dxGrid)this.dxGrid=upper(dxGrid);if(Number.isFinite(Number(df)))this.df=Math.round(Number(df));this._plan();return this.snapshot();}}
      this.dxCall=dx;this.dxGrid=upper(dxGrid);this.df=Number.isFinite(Number(df))?Math.round(Number(df)):null;this.rxSlotParity=Number(rxSlotParity)&1;this.txSlotParity=this.rxSlotParity^1;this.startedUnixMs=unixMs;this.completedUnixMs=0;this.rstRcvd="";this.attempts=0;this.retryAttempts=0;this.silentSlots=0;return this._transition(kind==="CQ"?"ANSWERING_CQ":"SELECTED","station selected",{slotIndex,unixMs});}
    startCallingCq({df,txSlotParity=0,unixMs=Date.now(),slotIndex=null,force=false}={}){if(!this.myCall||this.isActive()&&!force)return this.snapshot();this.dxCall="";this.dxGrid="";this.df=Number.isFinite(Number(df))?Math.round(Number(df)):this.df;this.rxSlotParity=(Number(txSlotParity)&1)^1;this.txSlotParity=Number(txSlotParity)&1;this.startedUnixMs=unixMs;this.completedUnixMs=0;this.rstRcvd="";this.attempts=0;this.retryAttempts=0;this.silentSlots=0;return this._transition("CALLING_CQ","operator CQ",{slotIndex,unixMs});}
    setReport(value){this.txReport=typeof value==="string"&&/^[+-]\d\d$/.test(value)?value:report(value);this._plan();return this.snapshot();}
    selectTxStage(stage,{unixMs=Date.now(),slotIndex=null}={}){
      const key=upper(stage).replace(/[^A-Z0-9_]/g,"");
      if(!this.myCall)return this.snapshot();
      if(key==="CQ")return this.startCallingCq({df:this.df,txSlotParity:this.txSlotParity,unixMs,slotIndex,force:true});
      if(!this.dxCall)return this.snapshot();
      const stateByStage={INITIAL:"ANSWERING_CQ",REPORT:"SEND_REPORT",R_REPORT:"SEND_R_REPORT",RR73:"SEND_RR73","73":"SEND_73"};
      const target=stateByStage[key];if(!target)return this.snapshot();
      this.completedUnixMs=0;this.silentSlots=0;this.retryAttempts=0;
      return this._transition(target,`operator selected ${key} message`,{slotIndex,unixMs});
    }
    onRx({parsed,text="",snr=null,slotIndex=null,unixMs=Date.now(),df=null}={}){const p=parsed||{},from=upper(p.from||p.call),to=upper(p.to),kind=upper(p.kind);if(this.state==="IDLE"||TERMINAL.has(this.state))return this.snapshot();
      if(!this.dxCall&&this.options.callFirst&&["CALLING_CQ","WAIT_DX_REPORT"].includes(this.state)&&from&&to===this.myCall){this.dxCall=from;this.dxGrid=upper(p.grid);if(Number.isFinite(Number(df)))this.df=Math.round(Number(df));this.rxSlotParity=Number(slotIndex)&1;this.txSlotParity=this.rxSlotParity^1;}
      if(this.dxCall&&from!==this.dxCall&&upper(p.call)!==this.dxCall)return this.snapshot();
      // A selected DX may be working somebody else on the same frequency.
      // Only directed QSO messages addressed to My Call are allowed to
      // advance our sequence or change the report we will transmit.
      const directedKinds=new Set(["GRID","REPORT","R_REPORT","RRR","RR73","73","DIRECTED"]);
      if(directedKinds.has(kind)&&to!==this.myCall)return this.snapshot();
      if(p.grid&&from===this.dxCall)this.dxGrid=upper(p.grid);this.lastHeard=String(text||p.raw||"");this.lastHeardUnixMs=unixMs;this.lastRxSlotIndex=slotIndex;this.silentSlots=0;
      if(Number.isFinite(Number(snr)))this.setReport(snr);const rr=payloadReport(p.payload);if((kind==="REPORT"||kind==="R_REPORT")&&rr)this.rstRcvd=rr;
      if(kind==="REPORT")return this._transition("SEND_R_REPORT","DX report received",{slotIndex,unixMs,rx:this.lastHeard});
      if(kind==="R_REPORT")return this._transition("SEND_RR73","DX R-report received",{slotIndex,unixMs,rx:this.lastHeard});
      if(kind==="RRR"||kind==="RR73")return this._transition("SEND_73",`${kind} received`,{slotIndex,unixMs,rx:this.lastHeard});
      if(kind==="73"){if(this.state==="WAIT_73"||this.state==="SEND_RR73")return this._transition("COMPLETE","DX 73 received",{slotIndex,unixMs,rx:this.lastHeard});return this._transition("SEND_73","DX 73 received",{slotIndex,unixMs,rx:this.lastHeard});}
      if(kind==="GRID"&&from===this.dxCall&&to===this.myCall)return this._transition("SEND_REPORT","DX grid/call received",{slotIndex,unixMs,rx:this.lastHeard});
      if(this.state==="CALLING_CQ"&&this.dxCall)return this._transition("SEND_REPORT","first caller selected",{slotIndex,unixMs,rx:this.lastHeard});return this.snapshot();}
    onTxComplete({message="",slotIndex=null,unixMs=Date.now()}={}){const tx=upper(message);if(!tx)return this.snapshot();const expected=upper(this.nextMessage);if(expected&&tx!==expected)return this._transition("ERROR",`TX sequence mismatch: expected ${expected}, sent ${tx}`,{slotIndex,unixMs,tx});this.lastTxMessage=tx;this.attempts+=1;this.silentSlots=0;if(WAITING.has(this.state)){this.retryAttempts+=1;if(this.retryAttempts>Number(this.options.maxRetries||6))return this._transition("TIMEOUT","retry limit",{slotIndex,unixMs,tx});this._plan();return this.snapshot();}
      switch(this.state){case "ANSWERING_CQ":case "SELECTED":return this._transition("WAIT_DX_REPORT","initial call sent",{slotIndex,unixMs,tx});case "CALLING_CQ":return this._transition("WAIT_DX_REPORT","CQ sent",{slotIndex,unixMs,tx});case "SEND_REPORT":return this._transition("WAIT_R_REPORT","report sent",{slotIndex,unixMs,tx});case "SEND_R_REPORT":return this._transition("WAIT_RR73","R-report sent",{slotIndex,unixMs,tx});case "SEND_RR73":return this._transition("WAIT_73","RR73 sent",{slotIndex,unixMs,tx});case "SEND_73":return this.options.completeOnSent73?this._transition("COMPLETE","final 73 sent",{slotIndex,unixMs,tx}):this._transition("WAIT_73","final 73 sent",{slotIndex,unixMs,tx});default:return this.snapshot();}}
    onSlot({slotIndex,ownSlot=false,unixMs=Date.now()}={}){if(!ownSlot||!WAITING.has(this.state))return this.snapshot();this.silentSlots+=1;if(this.silentSlots>Number(this.options.timeoutSlots||8))return this._transition("TIMEOUT","silent slot timeout",{slotIndex,unixMs});return this.snapshot();}
    abort(reason="operator halt",meta={}){if(this.state==="IDLE"||TERMINAL.has(this.state))return this.snapshot();return this._transition("ABORTED",reason,meta);}
    markLogPending(meta={}){return this._transition("LOG_PENDING","local log pending",meta);}
    markLocalSaved(meta={}){return this._transition("LOGGED_LOCAL","local log saved",meta);}
    markQrzPending(meta={}){return this._transition("QRZ_PENDING","QRZ logging queued",meta);}
    markQrzLogged(meta={}){return this._transition("QRZ_LOGGED","QRZ log confirmed",meta);}
    markError(reason="error",meta={}){return this._transition("ERROR",reason,meta);}
    _plan(){const me=this.myCall,dx=this.dxCall,grid=this.myGrid;if(!me){this.nextMessage="";return;}switch(this.state){case "CALLING_CQ":this.nextMessage=grid?`CQ ${me} ${grid}`:`CQ ${me}`;break;case "ANSWERING_CQ":case "SELECTED":this.nextMessage=dx&&grid?`${dx} ${me} ${grid}`:"";break;case "SEND_REPORT":this.nextMessage=dx?`${dx} ${me} ${this.txReport}`:"";break;case "SEND_R_REPORT":this.nextMessage=dx?`${dx} ${me} R${this.txReport}`:"";break;case "SEND_RR73":this.nextMessage=dx?`${dx} ${me} RR73`:"";break;case "SEND_73":this.nextMessage=dx?`${dx} ${me} 73`:"";break;case "WAIT_DX_REPORT":case "WAIT_R_REPORT":case "WAIT_RR73":case "WAIT_73":this.nextMessage=this.lastTxMessage||this.nextMessage;break;case "COMPLETE":case "LOG_PENDING":case "LOGGED_LOCAL":case "QRZ_PENDING":case "QRZ_LOGGED":case "ABORTED":case "TIMEOUT":case "ERROR":this.nextMessage="";break;default:break;}}
    snapshot(){return {state:this.state,myCall:this.myCall,myGrid:this.myGrid,dxCall:this.dxCall,dxGrid:this.dxGrid,df:this.df,rxSlotParity:this.rxSlotParity,txSlotParity:this.txSlotParity,startedUnixMs:this.startedUnixMs,completedUnixMs:this.completedUnixMs,lastHeard:this.lastHeard,lastHeardUnixMs:this.lastHeardUnixMs,txReport:this.txReport,rstRcvd:this.rstRcvd,nextMessage:this.nextMessage,lastTxMessage:this.lastTxMessage,attempts:this.attempts,retryAttempts:this.retryAttempts,silentSlots:this.silentSlots,history:this.history.slice(),options:{...this.options}};}
  }
  return Object.freeze({STATES,QsoMachine,formatReport:report});
});
