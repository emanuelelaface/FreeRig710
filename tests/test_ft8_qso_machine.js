"use strict";
const assert=require("assert");const {QsoMachine}=require("../frontend/ft8-qso-machine.js");
function p(raw,kind,from,to,grid="",payload=""){return {raw,kind,from,to,grid,payload};}
// Answer CQ -> reports -> RR73 -> 73 -> complete; reports are retained for logging.
{
 const m=new QsoMachine();m.identity({myCall:"SM0ME",myGrid:"JO89",txReport:-12});m.select({dxCall:"K1DX",dxGrid:"FN31",df:1200,rxSlotParity:0,kind:"CQ",slotIndex:10,unixMs:1000});assert.equal(m.snapshot().state,"ANSWERING_CQ");assert.equal(m.snapshot().nextMessage,"K1DX SM0ME JO89");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:11});assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 m.onRx({parsed:p("SM0ME K1DX -08","REPORT","K1DX","SM0ME","","-08"),text:"SM0ME K1DX -08",snr:-12,slotIndex:12});assert.equal(m.snapshot().state,"SEND_R_REPORT");assert.equal(m.snapshot().nextMessage,"K1DX SM0ME R-12");assert.equal(m.snapshot().rstRcvd,"-08");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:13});assert.equal(m.snapshot().state,"WAIT_RR73");
 m.onRx({parsed:p("SM0ME K1DX RR73","RR73","K1DX","SM0ME"),text:"SM0ME K1DX RR73",slotIndex:14});assert.equal(m.snapshot().state,"SEND_73");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:15,unixMs:2000});assert.equal(m.snapshot().state,"COMPLETE");assert.equal(m.snapshot().completedUnixMs,2000);
}
// Calling CQ with Call 1st.
{
 const m=new QsoMachine({callFirst:true});m.identity({myCall:"SM0ME",myGrid:"JO89",txReport:-5});m.startCallingCq({txSlotParity:0});assert.equal(m.snapshot().nextMessage,"CQ SM0ME JO89");m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:20});m.onRx({parsed:p("SM0ME W1AA FN42","GRID","W1AA","SM0ME","FN42"),text:"SM0ME W1AA FN42",snr:-5,slotIndex:21});assert.equal(m.snapshot().dxCall,"W1AA");assert.equal(m.snapshot().state,"SEND_REPORT");m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:22});m.onRx({parsed:p("SM0ME W1AA R-07","R_REPORT","W1AA","SM0ME","","R-07"),text:"SM0ME W1AA R-07",slotIndex:23});assert.equal(m.snapshot().state,"SEND_RR73");assert.equal(m.snapshot().rstRcvd,"-07");m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:24});assert.equal(m.snapshot().state,"WAIT_73");m.onRx({parsed:p("SM0ME W1AA 73","73","W1AA","SM0ME"),text:"SM0ME W1AA 73",slotIndex:25});assert.equal(m.snapshot().state,"COMPLETE");
}
// A new CQ/click cannot steal an active QSO; force can only be used by explicit operator reset flows.
{
 const m=new QsoMachine();m.identity({myCall:"SM0ME",myGrid:"JO89"});m.select({dxCall:"K1DX",rxSlotParity:0,kind:"CQ",df:800});const before=m.snapshot();m.select({dxCall:"JA1ZZ",rxSlotParity:1,kind:"CQ",df:1800});assert.equal(m.snapshot().dxCall,"K1DX");assert.equal(m.snapshot().df,before.df);m.select({dxCall:"K1DX",dxGrid:"FN31",df:820,rxSlotParity:0,kind:"CQ"});assert.equal(m.snapshot().dxGrid,"FN31");assert.equal(m.snapshot().df,820);
}
// Timeout, per-stage retry cap, and abort.
{const m=new QsoMachine({timeoutSlots:2});m.identity({myCall:"SM0ME",myGrid:"JO89"});m.select({dxCall:"K1DX",rxSlotParity:0,kind:"CQ"});m.onTxComplete({message:m.snapshot().nextMessage});m.onSlot({ownSlot:true});m.onSlot({ownSlot:true});m.onSlot({ownSlot:true});assert.equal(m.snapshot().state,"TIMEOUT");}
{const m=new QsoMachine({maxRetries:2});m.identity({myCall:"SM0ME",myGrid:"JO89"});m.select({dxCall:"K1DX",rxSlotParity:0,kind:"CQ"});m.onTxComplete({message:m.snapshot().nextMessage});assert.equal(m.snapshot().state,"WAIT_DX_REPORT");m.onTxComplete({message:m.snapshot().nextMessage});m.onTxComplete({message:m.snapshot().nextMessage});assert.equal(m.snapshot().state,"WAIT_DX_REPORT");m.onTxComplete({message:m.snapshot().nextMessage});assert.equal(m.snapshot().state,"TIMEOUT");}
{const m=new QsoMachine();m.identity({myCall:"SM0ME",myGrid:"JO89"});m.select({dxCall:"K1DX",rxSlotParity:0,kind:"CQ"});m.abort("Halt TX");assert.equal(m.snapshot().state,"ABORTED");assert.equal(m.snapshot().nextMessage,"");}
console.log("FT8 QSO state-machine tests: OK");
// Operator can select any outgoing message stage and continue deterministically from there.
{
 const m=new QsoMachine();m.identity({myCall:"SM0ME",myGrid:"JO89",txReport:-9});m.select({dxCall:"K1DX",dxGrid:"FN31",df:1500,rxSlotParity:0,kind:"CQ"});
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:1});assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 m.selectTxStage("RR73");assert.equal(m.snapshot().state,"SEND_RR73");assert.equal(m.snapshot().nextMessage,"K1DX SM0ME RR73");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:3});assert.equal(m.snapshot().state,"WAIT_73");
 m.selectTxStage("R_REPORT");assert.equal(m.snapshot().state,"SEND_R_REPORT");assert.equal(m.snapshot().nextMessage,"K1DX SM0ME R-09");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:5});assert.equal(m.snapshot().state,"WAIT_RR73");
 m.selectTxStage("73");assert.equal(m.snapshot().state,"SEND_73");m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:7});assert.equal(m.snapshot().state,"COMPLETE");
 m.selectTxStage("REPORT");assert.equal(m.snapshot().state,"SEND_REPORT");assert.equal(m.snapshot().completedUnixMs,0);
}
console.log("FT8 manual message-stage tests: OK");

// Regression: answering a CQ must advance from the initial grid exchange to
// an R-report as soon as the DX report addressed to us is decoded.  This is
// the exact SA7CHI/F4VVJ sequence observed on-air in FT8.6.5.7.
{
 const m=new QsoMachine();
 m.identity({myCall:"SA7CHI",myGrid:"JO65",txReport:0});
 m.select({dxCall:"F4VVJ",dxGrid:"JN24",df:472,rxSlotParity:0,kind:"CQ",slotIndex:100,unixMs:1000});
 assert.equal(m.snapshot().nextMessage,"F4VVJ SA7CHI JO65");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:101,unixMs:2000});
 assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 const snap=m.onRx({parsed:p("SA7CHI F4VVJ -01","REPORT","F4VVJ","SA7CHI","","-01"),text:"SA7CHI F4VVJ -01",snr:4.3,slotIndex:102,unixMs:3000,df:472});
 assert.equal(snap.state,"SEND_R_REPORT");
 assert.equal(snap.rstRcvd,"-01");
 assert.equal(snap.txReport,"+04");
 assert.equal(snap.nextMessage,"F4VVJ SA7CHI R+04");
}

// Safety invariant: if the scheduler reports completion of a waveform that is
// not the message currently required by the QSO state, never advance the QSO.
// Stop in ERROR instead of pretending (for example) that an R-report was sent.
{
 const m=new QsoMachine();
 m.identity({myCall:"SA7CHI",myGrid:"JO65",txReport:4});
 m.select({dxCall:"SV2HTW",dxGrid:"KN10",df:613,rxSlotParity:1,kind:"CQ",slotIndex:200,unixMs:1000});
 m.onTxComplete({message:"SV2HTW SA7CHI JO65",slotIndex:201,unixMs:2000});
 const ready=m.onRx({parsed:p("SA7CHI SV2HTW -09","REPORT","SV2HTW","SA7CHI","","-09"),text:"SA7CHI SV2HTW -09",snr:3.6,slotIndex:202,unixMs:3000,df:613});
 assert.equal(ready.state,"SEND_R_REPORT");
 assert.equal(ready.nextMessage,"SV2HTW SA7CHI R+04");
 const bad=m.onTxComplete({message:"SV2HTW SA7CHI JO65",slotIndex:203,unixMs:4000});
 assert.equal(bad.state,"ERROR");
 assert.match(bad.history.at(-1).cause,/TX sequence mismatch/);
}
console.log("FT8 TX message/state integrity test: OK");

// A selected DX working somebody else must never advance our QSO.
{
 const m=new QsoMachine();m.identity({myCall:"SA7CHI",myGrid:"JO65",txReport:+4});
 m.select({dxCall:"SV2HTW",dxGrid:"KN10",df:613,rxSlotParity:0,kind:"CQ",slotIndex:200});
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:201});
 assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 const before=m.snapshot();
 m.onRx({parsed:p("OTHER SV2HTW -03","REPORT","SV2HTW","OTHER","","-03"),text:"OTHER SV2HTW -03",snr:9.4,slotIndex:202});
 assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 assert.equal(m.snapshot().nextMessage,before.nextMessage);
 m.onRx({parsed:p("SA7CHI SV2HTW -03","REPORT","SV2HTW","SA7CHI","","-03"),text:"SA7CHI SV2HTW -03",snr:6.4,slotIndex:202});
 assert.equal(m.snapshot().state,"SEND_R_REPORT");
 assert.equal(m.snapshot().nextMessage,"SV2HTW SA7CHI R+06");
}
console.log("FT8 directed-message QSO guard: OK");

// Clicking a non-CQ Band Activity message selects its transmitter and starts
// the same normal initial-call sequence; a reply to us advances Auto Seq.
{
 const m=new QsoMachine();m.identity({myCall:"SA7CHI",myGrid:"JO65",txReport:-7});
 m.select({dxCall:"SV2HTW",dxGrid:"",df:911,rxSlotParity:1,kind:"REPORT",slotIndex:300,unixMs:1000});
 assert.equal(m.snapshot().state,"SELECTED");
 assert.equal(m.snapshot().nextMessage,"SV2HTW SA7CHI JO65");
 m.onTxComplete({message:m.snapshot().nextMessage,slotIndex:301,unixMs:2000});
 assert.equal(m.snapshot().state,"WAIT_DX_REPORT");
 const reply=m.onRx({parsed:p("SA7CHI SV2HTW -05","REPORT","SV2HTW","SA7CHI","","-05"),text:"SA7CHI SV2HTW -05",snr:-3.2,slotIndex:302,unixMs:3000,df:911});
 assert.equal(reply.state,"SEND_R_REPORT");
 assert.equal(reply.nextMessage,"SV2HTW SA7CHI R-03");
}
console.log("FT8 non-CQ selected-station QSO flow: OK");
