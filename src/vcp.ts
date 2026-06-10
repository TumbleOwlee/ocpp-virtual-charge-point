import * as util from "node:util";
import { WebSocket } from "ws";

import { serve, type ServerType } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { OcppCall, OcppCallError, OcppCallResult } from "./ocppMessage";
import {
  type OcppMessageHandler,
  resolveMessageHandler,
} from "./ocppMessageHandler";
import { ocppOutbox } from "./ocppOutbox";
import { type OcppVersion, toProtocolVersion } from "./ocppVersion";
import {
  validateOcppIncomingRequest,
  validateOcppIncomingResponse,
  validateOcppOutgoingRequest,
  validateOcppOutgoingResponse,
} from "./schemaValidator";
import { TransactionManager } from "./transactionManager";
import { heartbeatOcppMessage } from "./v16/messages/heartbeat";
import { close } from "./close";

interface VCPOptions {
  ocppVersion: OcppVersion;
  endpoint: string;
  chargePointId: string;
  basicAuthPassword?: string;
  adminPort?: number;
  reconnectIntervalMs?: number;
  onConnected?: (vcp: VCP) => void | Promise<void>;
}

interface LogEntry {
  type: "Application";
  timestamp: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
}

export class VCP {
  private ws?: WebSocket;
  private adminServer?: ServerType;
  private messageHandler: OcppMessageHandler;
  private heartbeatIntervalId?: ReturnType<typeof setInterval>;

  private isFinishing = false;
  private _reconnectScheduled = false;

  private postMessageActions: Record<string, () => void | Promise<void>> = {};

  transactionManager = new TransactionManager();

  // Active charging limit in watts per connector (key 0 = whole charge point).
  // Set by SetChargingProfile, cleared by ClearChargingProfile.
  connectorLimitW = new Map<number, number>();

  constructor(private vcpOptions: VCPOptions) {
    this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);
    if (vcpOptions.adminPort) {
      const adminApi = new Hono();
      adminApi.get("/health", (c) => c.text("OK"));
      adminApi.get("/status", (c) => {
        return c.json({ connected: this.ws?.readyState === WebSocket.OPEN });
      });
      adminApi.get("/", (c) => c.html(ADMIN_UI_HTML));
      adminApi.post(
        "/execute",
        zValidator(
          "json",
          z.object({
            action: z.string(),
            payload: z.any(),
          }),
        ),
        (c) => {
          const validated = c.req.valid("json");
          try {
            this.send(call(validated.action, validated.payload));
          } catch (e) {
            return c.json({ error: String(e) }, 503);
          }
          return c.text("OK");
        },
      );
      this.adminServer = serve({
        fetch: adminApi.fetch,
        port: vcpOptions.adminPort,
      });
    }
  }

  async connect(): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);
    this.isFinishing = false;
    return new Promise((resolve) => {
      const websocketUrl = `${this.vcpOptions.endpoint}/${this.vcpOptions.chargePointId}`;
      const protocol = toProtocolVersion(this.vcpOptions.ocppVersion);
      this.ws = new WebSocket(websocketUrl, [protocol], {
        rejectUnauthorized: false,
        followRedirects: true,
        headers: {
          ...(this.vcpOptions.basicAuthPassword && {
            Authorization: `Basic ${Buffer.from(
              `${this.vcpOptions.chargePointId}:${this.vcpOptions.basicAuthPassword}`,
            ).toString("base64")}`,
          }),
        },
      });

      this.ws.on("open", async () => {
        if (this.vcpOptions.onConnected) {
          try {
            await this.vcpOptions.onConnected(this);
          } catch (e) {
            logger.error(`Error in onConnected callback: ${e}`);
          }
        }
        resolve();
      });
      this.ws.on("message", (message: string) => this._onMessage(message));
      this.ws.on("ping", () => {
        logger.info("Received PING");
      });
      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });
      this.ws.on("close", (code: number, reason: string) =>
        this._onClose(code, reason),
      );
      this.ws.on("error", (error: Error) => {
        logger.error("Websocket error:");
        logger.error(error);
        this._handleDisconnect();
      });
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  send(ocppCall: OcppCall<any>) {
    if (!this.ws) {
      logger.error("Cannot send: WebSocket not connected");
      return;
    }
    ocppOutbox.enqueue(ocppCall);
    const jsonMessage = JSON.stringify([
      2,
      ocppCall.messageId,
      ocppCall.action,
      ocppCall.payload,
    ]);
    logger.info(`Sending message ➡️  ${jsonMessage}`);
    try {
      validateOcppOutgoingRequest(
        this.vcpOptions.ocppVersion,
        ocppCall.action,
        JSON.parse(JSON.stringify(ocppCall.payload)),
      );
    } catch (e) {
      logger.error(`Schema validation error for ${ocppCall.action}: ${e}`);
    }
    try {
      this.ws.send(jsonMessage);
    } catch (e) {
      logger.error(`Failed to send WebSocket message: ${e}`);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respond(result: OcppCallResult<any>) {
    if (!this.ws) {
      logger.error("Cannot respond: WebSocket not connected");
      return;
    }
    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    try {
      validateOcppIncomingResponse(
        this.vcpOptions.ocppVersion,
        result.action,
        JSON.parse(JSON.stringify(result.payload)),
      );
    } catch (e) {
      logger.error(`Schema validation error for ${result.action}: ${e}`);
    }
    try {
      this.ws.send(jsonMessage);
    } catch (e) {
      logger.error(`Failed to send WebSocket response: ${e}`);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respondError(error: OcppCallError<any>) {
    if (!this.ws) {
      logger.error("Cannot respondError: WebSocket not connected");
      return;
    }
    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    try {
      this.ws.send(jsonMessage);
    } catch (e) {
      logger.error(`Failed to send WebSocket error response: ${e}`);
    }
  }

  configureHeartbeat(interval: number) {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
    }
    this.heartbeatIntervalId = setInterval(() => {
      this.send(heartbeatOcppMessage.request({}));
    }, interval);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.isFinishing = true;
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    if (this.adminServer) {
      this.adminServer.close();
      this.adminServer = undefined;
    }
  }

  async getDiagnosticData(): Promise<LogEntry[]> {
    try {
      const transport = logger.transports[0];

      const logStream = new Promise<LogEntry[]>((resolve) => {
        const entries: LogEntry[] = [];

        transport.on(
          "logged",
          (info: {
            timestamp: string;
            level: string;
            message: string;
            [key: string]: unknown;
          }) => {
            entries.push({
              type: "Application",
              timestamp: info.timestamp || new Date().toISOString(),
              level: info.level,
              message: info.message,
              metadata: Object.fromEntries(
                Object.entries(info).filter(
                  ([key]) => !["timestamp", "level", "message"].includes(key),
                ),
              ),
            });
          },
        );

        setTimeout(() => resolve(entries), 10000);
      });

      return await logStream;
    } catch (err) {
      logger.error("Failed to read application logs:", err);
      return [];
    }
  }

  async postMessageAction(
    action: string,
    callback: () => void | Promise<void>,
  ) {
    this.postMessageActions[action] = callback;
  }

  private _onMessage(message: string) {
    logger.info(`Receive message ⬅️  ${message}`);
    // biome-ignore lint/suspicious/noExplicitAny: ocpp message format
    let data: any[];
    try {
      data = JSON.parse(message);
    } catch (err) {
      logger.error(`Failed to parse message: ${err}`);
      return;
    }
    const [type, ...rest] = data;
    if (type === 2) {
      const [messageId, action, payload] = rest;
      try {
        validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
      } catch (e) {
        logger.error(`Incoming request validation error for ${action}: ${e}`);
      }
      try {
        this.messageHandler.handleCall(this, { messageId, action, payload });
      } catch (e) {
        logger.error(`Error handling incoming call ${action}: ${e}`);
      }
      if (this.postMessageActions[action]) {
        logger.info(`Executing postMessageAction for ${action}`);
        try {
          this.postMessageActions[action]();
        } catch (e) {
          logger.error(`Error in postMessageAction for ${action}: ${e}`);
        }
      }
    } else if (type === 3) {
      const [messageId, payload] = rest;
      const enqueuedCall = ocppOutbox.get(messageId);
      if (!enqueuedCall) {
        logger.error(`Received CallResult for unknown messageId=${messageId}`);
        return;
      }
      try {
        validateOcppOutgoingResponse(
          this.vcpOptions.ocppVersion,
          enqueuedCall.action,
          payload,
        );
      } catch (e) {
        logger.error(`Outgoing response validation error for ${enqueuedCall.action}: ${e}`);
      }
      try {
        this.messageHandler.handleCallResult(this, enqueuedCall, {
          messageId,
          payload,
          action: enqueuedCall.action,
        });
      } catch (e) {
        logger.error(`Error handling CallResult for ${enqueuedCall.action}: ${e}`);
      }
    } else if (type === 4) {
      const [messageId, errorCode, errorDescription, errorDetails] = rest;
      try {
        this.messageHandler.handleCallError(this, {
          messageId,
          errorCode,
          errorDescription,
          errorDetails,
        });
      } catch (e) {
        logger.error(`Error handling CallError: ${e}`);
      }
    } else {
      logger.error(`Unrecognized message type ${type}`);
    }
  }

  private _handleDisconnect() {
    if (this.vcpOptions.reconnectIntervalMs !== undefined) {
      this._scheduleReconnect();
    } else {
      close(this);
    }
  }

  private _scheduleReconnect() {
    if (this.isFinishing || this._reconnectScheduled) return;
    this._reconnectScheduled = true;
    const ms = this.vcpOptions.reconnectIntervalMs!;
    logger.info(`Reconnecting in ${ms / 1000}s...`);
    setTimeout(() => {
      this._reconnectScheduled = false;
      this._doReconnect();
    }, ms);
  }

  private _doReconnect() {
    if (this.isFinishing) return;
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    this.connect().catch((e) => logger.error(`Reconnect error: ${e}`));
  }

  private _onClose(code: number, reason: string) {
    if (this.isFinishing) {
      return;
    }
    logger.info(`Connection closed. code=${code}, reason=${reason}`);
    this._handleDisconnect();
  }
}

const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OCPP VCP Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:16px}
h1{font-size:18px;margin-bottom:8px;color:#fff}
.status{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;margin-bottom:14px}
.ok{background:#1a3a1a;color:#4caf50;border:1px solid #2e5c2e}
.err{background:#3a1a1a;color:#f44336;border:1px solid #5c2e2e}
.params{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.p{display:flex;flex-direction:column;gap:3px}
.p label{font-size:11px;color:#888}
.p input{background:#1e1e1e;border:1px solid #333;color:#e0e0e0;padding:4px 8px;border-radius:4px;font-size:13px;width:150px}
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
.le.ok .m{color:#4caf50}
.le.er .m{color:#f44336}
</style>
</head>
<body>
<h1>OCPP VCP Admin <span style="color:#555;font-weight:normal;font-size:13px">1.6</span></h1>
<div id="st" class="status">...</div>
<div class="params">
  <div class="p"><label>RFID Tag</label><input id="idTag" value="AABBCCDD"></div>
  <div class="p"><label>Transaction ID</label><input id="txId" type="number" value="1"></div>
  <div class="p"><label>Connector ID</label><input id="cId" type="number" value="1"></div>
  <div class="p"><label>Meter Stop (Wh)</label><input id="mSt" type="number" value="2000"></div>
</div>
<div id="groups"></div>
<div id="log"></div>
<script>
var g = function(id){ return document.getElementById(id); };
var ts = function(){ return new Date().toISOString(); };
var idTag = function(){ return g('idTag').value; };
var txId = function(){ return parseInt(g('txId').value)||1; };
var cId = function(){ return parseInt(g('cId').value)||1; };
var mSt = function(){ return parseInt(g('mSt').value)||2000; };

var COMMANDS = [
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
  {gr:'Status Notification',lb:'Connector 2 Available',ac:'StatusNotification',pl:function(){return {connectorId:2,errorCode:'NoError',status:'Available',timestamp:ts()};}},
  {gr:'Transaction',lb:'Start Transaction',ac:'StartTransaction',pl:function(){return {connectorId:cId(),idTag:idTag(),meterStart:0,timestamp:ts()};}},
  {gr:'Transaction',lb:'Start Transaction (Reserved)',ac:'StartTransaction',pl:function(){return {connectorId:cId(),idTag:idTag(),meterStart:0,reservationId:44,timestamp:ts()};}},
  {gr:'Transaction',lb:'Stop Transaction',ac:'StopTransaction',pl:function(){return {transactionId:txId(),timestamp:ts(),meterStop:mSt()};}},
  {gr:'Transaction',lb:'Meter Values',ac:'MeterValues',pl:function(){return {connectorId:cId(),transactionId:txId(),meterValue:[{timestamp:ts(),sampledValue:[{value:1,measurand:'Power.Active.Import',unit:'kW'},{value:'43.123456789',measurand:'Energy.Active.Import.Register',unit:'kWh'}]}]};}},
  {gr:'Transaction',lb:'Meter Values (Power L1-N)',ac:'MeterValues',pl:function(){return {connectorId:cId(),transactionId:txId(),meterValue:[{timestamp:ts(),sampledValue:[{value:'0',context:'Sample.Periodic',format:'Raw',measurand:'Power.Active.Import',phase:'L1-N',location:'Outlet',unit:'Wh'},{value:'0',context:'Sample.Periodic',format:'Raw',measurand:'Power.Active.Import',phase:'L1-N',location:'Outlet',unit:'Percent'}]}]};}},
  {gr:'Data Transfer',lb:'Data Transfer',ac:'DataTransfer',pl:function(){return {vendorId:'TEST',data:'TEST'};}},
  {gr:'Firmware',lb:'Firmware Status: Installed',ac:'FirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
  {gr:'Security',lb:'Log Status: Uploaded',ac:'LogStatusNotification',pl:function(){return {status:'Uploaded'};}},
  {gr:'Security',lb:'Security Event Notification',ac:'SecurityEventNotification',pl:function(){return {timestamp:ts(),type:'InalidCentralSystemCertificate'};}},
  {gr:'Security',lb:'Sign Certificate',ac:'SignCertificate',pl:function(){return {csr:'-----BEGIN CERTIFICATE REQUEST-----'};}},
  {gr:'Security',lb:'Signed Firmware Status: Installed',ac:'SignedFirmwareStatusNotification',pl:function(){return {status:'Installed'};}},
];

var SEQUENCES = [
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
];

function send(action, payload, cb) {
  fetch('/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,payload:payload})})
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); cb(null); })
    .catch(function(e){ cb(e); });
}

function addLog(msg, type) {
  var el = g('log');
  var d = document.createElement('div');
  d.className = 'le '+(type||'');
  var t = new Date().toTimeString().slice(0,8);
  d.innerHTML = '<span class="t">'+t+'</span><span class="m">'+msg+'</span>';
  el.insertBefore(d, el.firstChild);
}

function flash(btn, cls) {
  btn.classList.add(cls);
  setTimeout(function(){ btn.classList.remove(cls); }, 700);
}

function onCmd(btn, ac, pl) {
  var payload = typeof pl === 'function' ? pl() : pl;
  send(ac, payload, function(err) {
    if(err){ flash(btn,'flash-err'); addLog('x '+ac+': '+err.message,'er'); }
    else { flash(btn,'flash-ok'); addLog('> '+ac,'ok'); }
  });
}

function runSeq(btn, steps, i) {
  if(i >= steps.length){ btn.disabled = false; return; }
  var step = steps[i];
  var exec = function() {
    var payload = typeof step.pl === 'function' ? step.pl() : step.pl;
    send(step.ac, payload, function(err) {
      var label = step.ac+(payload.status ? ' ('+payload.status+')' : '');
      if(err) addLog('x '+label+': '+err.message,'er');
      else addLog('> '+label,'ok');
      runSeq(btn, steps, i+1);
    });
  };
  if(step.d > 0) setTimeout(exec, step.d); else exec();
}

var gmap = {};
COMMANDS.forEach(function(c){
  if(!gmap[c.gr]) gmap[c.gr]={cmds:[],seqs:[]};
  gmap[c.gr].cmds.push(c);
});
SEQUENCES.forEach(function(s){
  if(!gmap[s.gr]) gmap[s.gr]={cmds:[],seqs:[]};
  gmap[s.gr].seqs.push(s);
});

var cont = g('groups');
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

function checkStatus() {
  fetch('/status').then(function(r){ return r.json(); }).then(function(d){
    var el = g('st');
    if(d.connected){ el.textContent='WS Connected'; el.className='status ok'; }
    else { el.textContent='WS Disconnected'; el.className='status err'; }
  }).catch(function(){ var el=g('st'); el.textContent='Admin Offline'; el.className='status err'; });
}
checkStatus();
setInterval(checkStatus,5000);
</script>
</body>
</html>`;
