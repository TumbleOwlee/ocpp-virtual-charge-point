require("dotenv").config();

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { call } from "./src/messageFactory";
import { OcppVersion } from "./src/ocppVersion";
import { VCP } from "./src/vcp";

import { bootNotificationOcppMessage as boot16 } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage as status16 } from "./src/v16/messages/statusNotification";

import { bootNotificationOcppOutgoing as boot201 } from "./src/v201/messages/bootNotification";
import { statusNotificationOcppOutgoing as status201 } from "./src/v201/messages/statusNotification";

import { bootNotificationOcppOutgoing as boot21 } from "./src/v21/messages/bootNotification";
import { statusNotificationOcppOutgoing as status21 } from "./src/v21/messages/statusNotification";

interface VcpConfig {
  endpoint: string;
  chargePointId: string;
  password: string;
}

const defaultConfig: VcpConfig = {
  endpoint: process.env.WS_URL ?? "ws://localhost:3000",
  chargePointId: process.env.CP_ID ?? "123456",
  password: process.env.PASSWORD ?? "",
};

const vcpConfigs: Record<string, VcpConfig> = {
  "16": { ...defaultConfig },
  "201": { ...defaultConfig },
  "21": { ...defaultConfig },
};

const vcpFactories: Record<string, (cfg: VcpConfig) => VCP> = {
  "16": (cfg) =>
    new VCP({
      endpoint: cfg.endpoint,
      chargePointId: cfg.chargePointId,
      ocppVersion: OcppVersion.OCPP_1_6,
      basicAuthPassword: cfg.password || undefined,
      reconnectIntervalMs: 15000,
      onConnected: (v) => {
        v.send(
          boot16.request({
            chargePointVendor: "Solidstudio",
            chargePointModel: "VirtualChargePoint",
            chargePointSerialNumber: "S001",
            firmwareVersion: "1.0.0",
          }),
        );
        v.send(
          status16.request({ connectorId: 1, errorCode: "NoError", status: "Available" }),
        );
      },
    }),
  "201": (cfg) =>
    new VCP({
      endpoint: cfg.endpoint,
      chargePointId: cfg.chargePointId,
      ocppVersion: OcppVersion.OCPP_2_0_1,
      basicAuthPassword: cfg.password || undefined,
      reconnectIntervalMs: 15000,
      onConnected: (v) => {
        v.send(
          boot201.request({
            reason: "PowerUp",
            chargingStation: { model: "VirtualChargePoint", vendorName: "Solidstudio" },
          }),
        );
        v.send(
          status201.request({
            evseId: 1,
            connectorId: 1,
            connectorStatus: "Available",
            timestamp: new Date().toISOString(),
          }),
        );
      },
    }),
  "21": (cfg) =>
    new VCP({
      endpoint: cfg.endpoint,
      chargePointId: cfg.chargePointId,
      ocppVersion: OcppVersion.OCPP_2_1,
      basicAuthPassword: cfg.password || undefined,
      reconnectIntervalMs: 15000,
      onConnected: (v) => {
        v.send(
          boot21.request({
            reason: "PowerUp",
            chargingStation: { model: "VirtualChargePoint", vendorName: "Solidstudio" },
          }),
        );
        v.send(
          status21.request({
            evseId: 1,
            connectorId: 1,
            connectorStatus: "Available",
            timestamp: new Date().toISOString(),
          }),
        );
      },
    }),
};

const vcpMap: Record<string, VCP> = {
  "16": vcpFactories["16"](vcpConfigs["16"]),
  "201": vcpFactories["201"](vcpConfigs["201"]),
  "21": vcpFactories["21"](vcpConfigs["21"]),
};
const started: Record<string, boolean> = { "16": false, "201": false, "21": false };

const adminApi = new Hono();

adminApi.get("/health", (c) => c.text("OK"));

adminApi.get("/status", (c) =>
  c.json({
    "16": { connected: vcpMap["16"].isConnected(), started: started["16"], config: { endpoint: vcpConfigs["16"].endpoint, chargePointId: vcpConfigs["16"].chargePointId, passwordSet: !!vcpConfigs["16"].password } },
    "201": { connected: vcpMap["201"].isConnected(), started: started["201"], config: { endpoint: vcpConfigs["201"].endpoint, chargePointId: vcpConfigs["201"].chargePointId, passwordSet: !!vcpConfigs["201"].password } },
    "21": { connected: vcpMap["21"].isConnected(), started: started["21"], config: { endpoint: vcpConfigs["21"].endpoint, chargePointId: vcpConfigs["21"].chargePointId, passwordSet: !!vcpConfigs["21"].password } },
  }),
);

adminApi.post(
  "/start",
  zValidator(
    "json",
    z.object({
      version: z.enum(["16", "201", "21"]),
      endpoint: z.string().optional(),
      chargePointId: z.string().optional(),
      password: z.string().optional(),
    }),
  ),
  (c) => {
    const { version, endpoint, chargePointId, password } = c.req.valid("json");
    if (endpoint) vcpConfigs[version].endpoint = endpoint;
    if (chargePointId) vcpConfigs[version].chargePointId = chargePointId;
    if (password !== undefined) vcpConfigs[version].password = password;
    vcpMap[version].close();
    vcpMap[version] = vcpFactories[version](vcpConfigs[version]);
    started[version] = true;
    vcpMap[version].connect().catch(() => {});
    return c.text("OK");
  },
);

adminApi.post(
  "/stop",
  zValidator("json", z.object({ version: z.enum(["16", "201", "21"]) })),
  (c) => {
    const { version } = c.req.valid("json");
    started[version] = false;
    vcpMap[version].close();
    return c.text("OK");
  },
);

adminApi.get("/", (c) => c.html(MULTI_ADMIN_UI_HTML));

adminApi.post(
  "/execute",
  zValidator(
    "json",
    z.object({
      version: z.enum(["16", "201", "21"]),
      action: z.string(),
      payload: z.any(),
    }),
  ),
  (c) => {
    const { version, action, payload } = c.req.valid("json");
    const vcp = vcpMap[version];
    try {
      vcp.send(call(action, payload));
    } catch (e) {
      return c.json({ error: String(e) }, 503);
    }
    return c.text("OK");
  },
);

const port = Number.parseInt(process.env.ADMIN_PORT ?? "9999");
serve({ fetch: adminApi.fetch, port });
console.log(`Multi-VCP admin UI: http://localhost:${port}`);

const MULTI_ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OCPP VCP Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:16px}
.header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
h1{font-size:18px;color:#fff}
.tabs{display:flex;gap:4px}
.tab{background:#1e1e1e;border:1px solid #333;color:#888;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px;transition:background .1s,color .1s}
.tab.active{background:#2a2a3e;border-color:#555;color:#fff}
.tab:hover{color:#ccc}
.statuses{display:flex;gap:10px;margin-left:auto}
.sv{display:flex;align-items:center;gap:5px;font-size:11px;color:#666}
.dot{width:8px;height:8px;border-radius:50%;background:#333}
.dot.ok{background:#4caf50}
.dot.err{background:#f44336}
.dot.idle{background:#444}
.panel-hdr{margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #1e1e1e}
.cfg-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.cfg-row .p input{width:190px}
.cfg-row .p .pw{width:130px}
input:disabled{opacity:.4;cursor:default}
.ctrl-row{display:flex;align-items:center;gap:10px}
.vcp-label{font-size:12px;color:#666}
.start-btn{background:#1a3a1a;border:1px solid #2e5c2e;color:#4caf50;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:12px}
.start-btn:hover{background:#224a22;border-color:#4caf50}
.stop-btn{background:#3a1a1a;border:1px solid #5c2e2e;color:#f44336;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:12px}
.stop-btn:hover{background:#4a2222;border-color:#f44336}
.cmds-area.disabled button{opacity:.35;pointer-events:none}
.params{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.p{display:flex;flex-direction:column;gap:3px}
.p label{font-size:11px;color:#888}
.p input{background:#1e1e1e;border:1px solid #333;color:#e0e0e0;padding:4px 8px;border-radius:4px;font-size:13px;width:150px}
.panel{display:none}
.panel.active{display:block}
.group{margin-bottom:13px}
.group h2{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;border-bottom:1px solid #1e1e1e;padding-bottom:3px}
.btns{display:flex;flex-wrap:wrap;gap:5px}
button{background:#1e1e2e;border:1px solid #333;color:#bbb;padding:5px 11px;border-radius:4px;cursor:pointer;font-size:12px;transition:background .1s,border-color .1s}
button:hover{background:#2a2a3e;border-color:#555;color:#fff}
button:disabled{opacity:.5;cursor:default}
.seq{border-color:#4a3a00;color:#ffc107}
.seq:hover{background:#2a2000;border-color:#ffc107}
.flash-ok{background:#1a3a1a!important;border-color:#4caf50!important;color:#4caf50!important}
.flash-err{background:#3a1a1a!important;border-color:#f44336!important;color:#f44336!important}
#log{background:#111;border:1px solid #222;border-radius:4px;padding:8px;font-family:monospace;font-size:11px;height:180px;overflow-y:auto;margin-top:14px}
.le{padding:1px 0;border-bottom:1px solid #191919;color:#888}
.le .t{color:#444;margin-right:6px}
.le .v{color:#555;margin-right:4px}
.le.ok .m{color:#4caf50}
.le.er .m{color:#f44336}
</style>
</head>
<body>
<div class="header">
  <h1>OCPP VCP Admin</h1>
  <div class="tabs">
    <button class="tab active" data-v="16">1.6</button>
    <button class="tab" data-v="201">2.0.1</button>
    <button class="tab" data-v="21">2.1</button>
  </div>
  <div class="statuses">
    <div class="sv"><div class="dot" id="dot-16"></div><span>1.6</span></div>
    <div class="sv"><div class="dot" id="dot-201"></div><span>2.0.1</span></div>
    <div class="sv"><div class="dot" id="dot-21"></div><span>2.1</span></div>
  </div>
</div>
<div class="params">
  <div class="p"><label>RFID Tag</label><input id="idTag" value="AABBCCDD"></div>
  <div class="p"><label>Transaction ID</label><input id="txId" value="TX001"></div>
  <div class="p"><label>Connector ID</label><input id="cId" type="number" value="1"></div>
  <div class="p"><label>EVSE ID</label><input id="evseId" type="number" value="1"></div>
  <div class="p"><label>Meter Stop (Wh)</label><input id="mSt" type="number" value="2000"></div>
</div>
<div id="panel-16" class="panel active">
  <div class="panel-hdr">
    <div class="cfg-row">
      <div class="p"><label>Endpoint</label><input id="ep-16" value="ws://localhost:3000"></div>
      <div class="p"><label>Charge Point ID</label><input id="cpid-16" value="123456"></div>
      <div class="p"><label>Password</label><input id="pw-16" class="pw" type="password" placeholder="(optional)"></div>
    </div>
    <div class="ctrl-row">
      <button id="ss-16" class="start-btn" onclick="toggleVcp('16')">Start</button>
      <span id="vl-16" class="vcp-label">Idle</span>
    </div>
  </div>
  <div id="groups-16" class="cmds-area disabled"></div>
</div>
<div id="panel-201" class="panel">
  <div class="panel-hdr">
    <div class="cfg-row">
      <div class="p"><label>Endpoint</label><input id="ep-201" value="ws://localhost:3000"></div>
      <div class="p"><label>Charge Point ID</label><input id="cpid-201" value="123456"></div>
      <div class="p"><label>Password</label><input id="pw-201" class="pw" type="password" placeholder="(optional)"></div>
    </div>
    <div class="ctrl-row">
      <button id="ss-201" class="start-btn" onclick="toggleVcp('201')">Start</button>
      <span id="vl-201" class="vcp-label">Idle</span>
    </div>
  </div>
  <div id="groups-201" class="cmds-area disabled"></div>
</div>
<div id="panel-21" class="panel">
  <div class="panel-hdr">
    <div class="cfg-row">
      <div class="p"><label>Endpoint</label><input id="ep-21" value="ws://localhost:3000"></div>
      <div class="p"><label>Charge Point ID</label><input id="cpid-21" value="123456"></div>
      <div class="p"><label>Password</label><input id="pw-21" class="pw" type="password" placeholder="(optional)"></div>
    </div>
    <div class="ctrl-row">
      <button id="ss-21" class="start-btn" onclick="toggleVcp('21')">Start</button>
      <span id="vl-21" class="vcp-label">Idle</span>
    </div>
  </div>
  <div id="groups-21" class="cmds-area disabled"></div>
</div>
<div id="log"></div>
<script>
var g = function(id){ return document.getElementById(id); };
var ts = function(){ return new Date().toISOString(); };
var idTag = function(){ return g('idTag').value; };
var txId = function(){ return g('txId').value||'TX001'; };
var cId = function(){ return parseInt(g('cId').value)||1; };
var evseId = function(){ return parseInt(g('evseId').value)||1; };
var mSt = function(){ return parseInt(g('mSt').value)||2000; };
var activeVer = '16';

var COMMANDS = {
  '16': [
    {gr:'Authorize',lb:'Authorize',ac:'Authorize',pl:function(){return {idTag:idTag()};}},
    {gr:'Authorize',lb:'Authorize (non-existing)',ac:'Authorize',pl:function(){return {idTag:'non-existing-token'};}},
    {gr:'Status Notification',lb:'Available',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Available',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Preparing',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Preparing',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Charging',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Charging',timestamp:ts()};}},
    {gr:'Status Notification',lb:'SuspendedEV',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'SuspendedEV',timestamp:ts()};}},
    {gr:'Status Notification',lb:'SuspendedEVSE',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'SuspendedEVSE',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Finishing',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Finishing',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Reserved',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Reserved',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Unavailable',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'NoError',status:'Unavailable',timestamp:ts()};}},
    {gr:'Status Notification',lb:'Faulted',ac:'StatusNotification',pl:function(){return {connectorId:cId(),errorCode:'InternalError',status:'Faulted',timestamp:ts()};}},
    {gr:'Transaction',lb:'Start Transaction',ac:'StartTransaction',pl:function(){return {connectorId:cId(),idTag:idTag(),meterStart:0,timestamp:ts()};}},
    {gr:'Transaction',lb:'Start Transaction (Reserved)',ac:'StartTransaction',pl:function(){return {connectorId:cId(),idTag:idTag(),meterStart:0,reservationId:44,timestamp:ts()};}},
    {gr:'Transaction',lb:'Stop Transaction',ac:'StopTransaction',pl:function(){return {transactionId:parseInt(txId())||1,timestamp:ts(),meterStop:mSt()};}},
    {gr:'Transaction',lb:'Meter Values',ac:'MeterValues',pl:function(){return {connectorId:cId(),transactionId:parseInt(txId())||1,meterValue:[{timestamp:ts(),sampledValue:[{value:1,measurand:'Power.Active.Import',unit:'kW'},{value:'43.123456789',measurand:'Energy.Active.Import.Register',unit:'kWh'}]}]};}},
    {gr:'Data Transfer',lb:'DataTransfer',ac:'DataTransfer',pl:function(){return {vendorId:'TEST',data:'TEST'};}},
    {gr:'Firmware',lb:'FirmwareStatus: Installed',ac:'FirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
    {gr:'Security',lb:'LogStatus: Uploaded',ac:'LogStatusNotification',pl:function(){return {status:'Uploaded'};}},
    {gr:'Security',lb:'SecurityEventNotification',ac:'SecurityEventNotification',pl:function(){return {timestamp:ts(),type:'InalidCentralSystemCertificate'};}},
    {gr:'Security',lb:'SignCertificate',ac:'SignCertificate',pl:function(){return {csr:'-----BEGIN CERTIFICATE REQUEST-----'};}},
    {gr:'Security',lb:'SignedFirmwareStatus: Installed',ac:'SignedFirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
  ],
  '201': [
    {gr:'Authorize',lb:'Authorize',ac:'Authorize',pl:function(){return {idToken:{idToken:idTag(),type:'ISO14443'}};}},
    {gr:'Status Notification',lb:'Available',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Available',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Occupied',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Occupied',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Reserved',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Reserved',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Unavailable',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Unavailable',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Faulted',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Faulted',evseId:evseId(),connectorId:cId()};}},
    {gr:'Transaction',lb:'TransactionEvent: Started',ac:'TransactionEvent',pl:function(){return {eventType:'Started',timestamp:ts(),triggerReason:'Authorized',seqNo:0,transactionInfo:{transactionId:txId()},idToken:{idToken:idTag(),type:'ISO14443'},evse:{id:evseId(),connectorId:cId()}};}},
    {gr:'Transaction',lb:'TransactionEvent: Updated (Meter)',ac:'TransactionEvent',pl:function(){return {eventType:'Updated',timestamp:ts(),triggerReason:'MeterValuePeriodic',seqNo:1,transactionInfo:{transactionId:txId()},meterValue:[{timestamp:ts(),sampledValue:[{value:'1000',measurand:'Power.Active.Import',unitOfMeasure:{unit:'W'}},{value:'43.12',measurand:'Energy.Active.Import.Register',unitOfMeasure:{unit:'kWh'}}]}]};}},
    {gr:'Transaction',lb:'TransactionEvent: Ended',ac:'TransactionEvent',pl:function(){return {eventType:'Ended',timestamp:ts(),triggerReason:'StopAuthorized',seqNo:2,transactionInfo:{transactionId:txId(),stoppedReason:'Local'},meterValue:[{timestamp:ts(),sampledValue:[{value:String(mSt()),measurand:'Energy.Active.Import.Register',unitOfMeasure:{unit:'Wh'}}]}]};}},
    {gr:'Data Transfer',lb:'DataTransfer',ac:'DataTransfer',pl:function(){return {vendorId:'TEST',data:'TEST'};}},
    {gr:'Firmware',lb:'FirmwareStatus: Installed',ac:'FirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
    {gr:'Security',lb:'LogStatus: Uploaded',ac:'LogStatusNotification',pl:function(){return {status:'Uploaded',requestId:1};}},
    {gr:'Security',lb:'SecurityEventNotification',ac:'SecurityEventNotification',pl:function(){return {timestamp:ts(),type:'InvalidCentralSystemCertificate'};}},
    {gr:'Security',lb:'SignCertificate',ac:'SignCertificate',pl:function(){return {csr:'-----BEGIN CERTIFICATE REQUEST-----',certificateType:'ChargingStationCertificate'};}},
  ],
  '21': [
    {gr:'Authorize',lb:'Authorize',ac:'Authorize',pl:function(){return {idToken:{idToken:idTag(),type:'ISO14443'}};}},
    {gr:'Status Notification',lb:'Available',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Available',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Occupied',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Occupied',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Reserved',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Reserved',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Unavailable',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Unavailable',evseId:evseId(),connectorId:cId()};}},
    {gr:'Status Notification',lb:'Faulted',ac:'StatusNotification',pl:function(){return {timestamp:ts(),connectorStatus:'Faulted',evseId:evseId(),connectorId:cId()};}},
    {gr:'Transaction',lb:'TransactionEvent: Started',ac:'TransactionEvent',pl:function(){return {eventType:'Started',timestamp:ts(),triggerReason:'Authorized',seqNo:0,transactionInfo:{transactionId:txId()},idToken:{idToken:idTag(),type:'ISO14443'},evse:{id:evseId(),connectorId:cId()}};}},
    {gr:'Transaction',lb:'TransactionEvent: Updated (Meter)',ac:'TransactionEvent',pl:function(){return {eventType:'Updated',timestamp:ts(),triggerReason:'MeterValuePeriodic',seqNo:1,transactionInfo:{transactionId:txId()},meterValue:[{timestamp:ts(),sampledValue:[{value:'1000',measurand:'Power.Active.Import',unitOfMeasure:{unit:'W'}},{value:'43.12',measurand:'Energy.Active.Import.Register',unitOfMeasure:{unit:'kWh'}}]}]};}},
    {gr:'Transaction',lb:'TransactionEvent: Ended',ac:'TransactionEvent',pl:function(){return {eventType:'Ended',timestamp:ts(),triggerReason:'StopAuthorized',seqNo:2,transactionInfo:{transactionId:txId(),stoppedReason:'Local'},meterValue:[{timestamp:ts(),sampledValue:[{value:String(mSt()),measurand:'Energy.Active.Import.Register',unitOfMeasure:{unit:'Wh'}}]}]};}},
    {gr:'Data Transfer',lb:'DataTransfer',ac:'DataTransfer',pl:function(){return {vendorId:'TEST',data:'TEST'};}},
    {gr:'Firmware',lb:'FirmwareStatus: Installed',ac:'FirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
    {gr:'Security',lb:'LogStatus: Uploaded',ac:'LogStatusNotification',pl:function(){return {status:'Uploaded',requestId:1};}},
    {gr:'Security',lb:'SecurityEventNotification',ac:'SecurityEventNotification',pl:function(){return {timestamp:ts(),type:'InvalidCentralSystemCertificate'};}},
    {gr:'Security',lb:'SignCertificate',ac:'SignCertificate',pl:function(){return {csr:'-----BEGIN CERTIFICATE REQUEST-----',certificateType:'ChargingStationCertificate'};}},
  ],
};

var SEQUENCES = {
  '16': [
    {gr:'Security',lb:'▶ Firmware Update OK Sequence',steps:[
      {d:0,ac:'SignedFirmwareStatusNotification',pl:{status:'Downloading'}},
      {d:2000,ac:'SignedFirmwareStatusNotification',pl:{status:'Downloaded'}},
      {d:2000,ac:'SignedFirmwareStatusNotification',pl:{status:'SignatureVerified'}},
      {d:0,ac:'StatusNotification',pl:function(){return {status:'Unavailable',connectorId:1,errorCode:'NoError',timestamp:ts()};}},
      {d:2000,ac:'SignedFirmwareStatusNotification',pl:{status:'Installing'}},
      {d:2000,ac:'SignedFirmwareStatusNotification',pl:{status:'InstallRebooting'}},
      {d:2000,ac:'SecurityEventNotification',pl:function(){return {timestamp:ts(),type:'FirmwareUpdated'};}},
      {d:0,ac:'StatusNotification',pl:function(){return {status:'Available',connectorId:1,errorCode:'NoError',timestamp:ts()};}},
      {d:2000,ac:'SignedFirmwareStatusNotification',pl:{status:'Installed'}},
    ]},
  ],
  '201': [],
  '21': [],
};

function send(action, payload, cb) {
  fetch('/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:activeVer,action:action,payload:payload})})
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); cb(null); })
    .catch(function(e){ cb(e); });
}

function addLog(ver, msg, type) {
  var el = g('log');
  var d = document.createElement('div');
  d.className = 'le '+(type||'');
  var t = new Date().toTimeString().slice(0,8);
  d.innerHTML = '<span class="t">'+t+'</span><span class="v">['+ver+']</span><span class="m">'+msg+'</span>';
  el.insertBefore(d, el.firstChild);
}

function flash(btn, cls) {
  btn.classList.add(cls);
  setTimeout(function(){ btn.classList.remove(cls); }, 700);
}

function onCmd(btn, ac, pl) {
  var ver = activeVer;
  var payload = typeof pl === 'function' ? pl() : pl;
  send(ac, payload, function(err) {
    if(err){ flash(btn,'flash-err'); addLog(ver,'x '+ac+': '+err.message,'er'); }
    else { flash(btn,'flash-ok'); addLog(ver,'> '+ac,'ok'); }
  });
}

function runSeq(btn, steps, i) {
  if(i >= steps.length){ btn.disabled = false; return; }
  var step = steps[i];
  var exec = function() {
    var payload = typeof step.pl === 'function' ? step.pl() : step.pl;
    send(step.ac, payload, function(err) {
      var label = step.ac+(payload.status ? ' ('+payload.status+')' : '');
      if(err) addLog(activeVer,'x '+label+': '+err.message,'er');
      else addLog(activeVer,'> '+label,'ok');
      runSeq(btn, steps, i+1);
    });
  };
  if(step.d > 0) setTimeout(exec, step.d); else exec();
}

function buildPanel(ver) {
  var cmds = COMMANDS[ver]||[];
  var seqs = SEQUENCES[ver]||[];
  var gmap = {};
  cmds.forEach(function(c){
    if(!gmap[c.gr]) gmap[c.gr]={cmds:[],seqs:[]};
    gmap[c.gr].cmds.push(c);
  });
  seqs.forEach(function(s){
    if(!gmap[s.gr]) gmap[s.gr]={cmds:[],seqs:[]};
    gmap[s.gr].seqs.push(s);
  });
  var cont = g('groups-'+ver);
  Object.keys(gmap).forEach(function(name) {
    var item = gmap[name];
    var div = document.createElement('div');
    div.className = 'group';
    var h2 = document.createElement('h2');
    h2.textContent = name;
    div.appendChild(h2);
    var btns = document.createElement('div');
    btns.className = 'btns';
    item.cmds.forEach(function(cmd) {
      var btn = document.createElement('button');
      btn.textContent = cmd.lb;
      btn.onclick = (function(b,ac,pl){ return function(){ onCmd(b,ac,pl); }; })(btn,cmd.ac,cmd.pl);
      btns.appendChild(btn);
    });
    item.seqs.forEach(function(seq) {
      var btn = document.createElement('button');
      btn.textContent = seq.lb;
      btn.className = 'seq';
      btn.onclick = (function(b,steps){ return function(){ b.disabled=true; runSeq(b,steps,0); }; })(btn,seq.steps);
      btns.appendChild(btn);
    });
    div.appendChild(btns);
    cont.appendChild(div);
  });
}

buildPanel('16');
buildPanel('201');
buildPanel('21');

document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    var ver = tab.getAttribute('data-v');
    activeVer = ver;
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
    g('panel-'+ver).classList.add('active');
  });
});

function toggleVcp(ver) {
  var btn = g('ss-'+ver);
  var isStart = btn.classList.contains('start-btn');
  if (isStart) {
    var body = {
      version: ver,
      endpoint: g('ep-'+ver).value.trim(),
      chargePointId: g('cpid-'+ver).value.trim(),
      password: g('pw-'+ver).value,
    };
    fetch('/start', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})
      .then(function(){ checkStatus(); });
  } else {
    fetch('/stop', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({version: ver})})
      .then(function(){ checkStatus(); });
  }
}

var initialised = {};

function checkStatus() {
  fetch('/status').then(function(r){ return r.json(); }).then(function(d){
    ['16','201','21'].forEach(function(v){
      var dot = g('dot-'+v);
      var btn = g('ss-'+v);
      var lbl = g('vl-'+v);
      var cmds = g('groups-'+v);
      var s = d[v] || {};
      var cfg = s.config || {};
      var cfgInputsDisabled = !!s.started;
      ['ep','cpid','pw'].forEach(function(fld){
        var el = g(fld+'-'+v);
        if(el) el.disabled = cfgInputsDisabled;
      });
      if(!initialised[v] && cfg.endpoint) {
        g('ep-'+v).value = cfg.endpoint;
        g('cpid-'+v).value = cfg.chargePointId || '';
        if(cfg.passwordSet) g('pw-'+v).placeholder = '(set)';
        initialised[v] = true;
      }
      if(!s.started) {
        dot.className='dot idle';
        btn.textContent='Start'; btn.className='start-btn';
        lbl.textContent='Idle';
        cmds.classList.add('disabled');
      } else if(s.connected) {
        dot.className='dot ok';
        btn.textContent='Stop'; btn.className='stop-btn';
        lbl.textContent='Connected';
        cmds.classList.remove('disabled');
      } else {
        dot.className='dot err';
        btn.textContent='Stop'; btn.className='stop-btn';
        lbl.textContent='Reconnecting...';
        cmds.classList.add('disabled');
      }
    });
  }).catch(function(){
    ['16','201','21'].forEach(function(v){ g('dot-'+v).className='dot err'; });
  });
}
checkStatus();
setInterval(checkStatus,5000);
</script>
</body>
</html>`;
