// ---------------------------------------------------------------------------
// Charging session logic (start/stop, meter values for OCPP 1.6 and 2.0.1)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { CONFIG, randomRfid } from "./config.js";
import { C, logInfo, stats } from "./stats.js";
import type { ChargingSession, OcppProtocol } from "./types.js";

// ---------------------------------------------------------------------------
// Station interface for charging — avoids circular dependency
// ---------------------------------------------------------------------------

interface ChargingStation {
  readonly id: string;
  readonly protocol: OcppProtocol;
  state: string;
  session: ChargingSession | null;
  meterBaseWh: number;
  chargingProfileLimitW: number | null;
  send(action: string, payload: unknown): Promise<unknown>;
  sendStatusNotification(status: string): Promise<void>;
}

// When no ChargingProfile is active the station charges at its rated maximum.
const DEFAULT_MAX_POWER_W = 22_000;
const NOMINAL_VOLTAGE_V = 230;

function activePowerW(station: ChargingStation): number {
  return station.chargingProfileLimitW ?? DEFAULT_MAX_POWER_W;
}

// ---------------------------------------------------------------------------
// Start charging session (entry point)
// ---------------------------------------------------------------------------

export function startChargingSession(
  station: ChargingStation,
  idTag?: string,
  connectorId = 1,
): void {
  if (station.session || station.state !== "available") return;

  const rfid = idTag ?? randomRfid();

  station.session = {
    transactionId: null,
    idTag: rfid,
    meterStartWh: station.meterBaseWh,
    accumulatedEnergyWh: 0,
    lastMeterAt: Date.now(),
    startedAt: Date.now(),
    meterTimer: null,
    seqNo: 0,
  };

  logInfo(station.id, `${C.yellow}Started charging${C.reset} (${rfid})`);

  if (station.protocol === "ocpp1.6") {
    startSession16(station, connectorId);
  } else {
    startSession201(station, connectorId);
  }
}

// ---------------------------------------------------------------------------
// OCPP 1.6 session lifecycle
// ---------------------------------------------------------------------------

async function startSession16(
  station: ChargingStation,
  connectorId: number,
): Promise<void> {
  if (!station.session) return;

  station.state = "preparing";
  await station.sendStatusNotification("Preparing");
  if (!station.session) return;

  const response = await station.send("StartTransaction", {
    connectorId,
    idTag: station.session.idTag,
    meterStart: Math.floor(station.session.meterStartWh),
    timestamp: new Date().toISOString(),
  });
  if (!station.session) return;

  if (response && typeof response === "object") {
    const res = response as Record<string, unknown>;
    station.session.transactionId =
      typeof res.transactionId === "number" ? res.transactionId : Math.floor(Math.random() * 900000) + 100000;
  } else {
    station.session.transactionId = Math.floor(Math.random() * 900000) + 100000;
  }

  station.state = "charging";
  await station.sendStatusNotification("Charging");
  if (!station.session) return;

  station.session.meterTimer = setInterval(() => {
    sendMeterValues16(station, connectorId);
  }, CONFIG.meterIntervalMs);
}

function sendMeterValues16(
  station: ChargingStation,
  connectorId: number,
): void {
  if (!station.session) return;

  const now = Date.now();
  const elapsedMs = now - station.session.lastMeterAt;
  const powerW = activePowerW(station);
  station.session.accumulatedEnergyWh += powerW * (elapsedMs / 3_600_000);
  station.session.lastMeterAt = now;

  const totalMeterWh = station.session.meterStartWh + station.session.accumulatedEnergyWh;
  const currentA = powerW / NOMINAL_VOLTAGE_V;

  station.send("MeterValues", {
    connectorId,
    transactionId: station.session.transactionId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: (totalMeterWh / 1000).toFixed(3),
            measurand: "Energy.Active.Import.Register",
            unit: "kWh",
          },
          {
            value: (powerW / 1000).toFixed(3),
            measurand: "Power.Active.Import",
            unit: "kW",
          },
          {
            value: NOMINAL_VOLTAGE_V.toFixed(1),
            measurand: "Voltage",
            unit: "V",
          },
          {
            value: currentA.toFixed(1),
            measurand: "Current.Import",
            unit: "A",
          },
        ],
      },
    ],
  });
}

async function stopSession16(
  station: ChargingStation,
  reason: string,
): Promise<void> {
  if (!station.session) return;

  const meterStop = Math.floor(
    station.session.meterStartWh + station.session.accumulatedEnergyWh,
  );

  await station.send("StopTransaction", {
    transactionId: station.session.transactionId,
    meterStop,
    timestamp: new Date().toISOString(),
    reason,
  });
}

// ---------------------------------------------------------------------------
// OCPP 2.0.1 session lifecycle
// ---------------------------------------------------------------------------

async function startSession201(
  station: ChargingStation,
  connectorId: number,
): Promise<void> {
  if (!station.session) return;

  const txId = randomUUID();
  station.session.transactionId = txId;

  station.state = "preparing";
  await station.sendStatusNotification("Preparing");
  if (!station.session) return;

  station.session.seqNo = 0;
  await station.send("TransactionEvent", {
    eventType: "Started",
    timestamp: new Date().toISOString(),
    triggerReason: "Authorized",
    seqNo: station.session.seqNo,
    transactionInfo: {
      transactionId: txId,
      chargingState: "EVConnected",
    },
    idToken: {
      idToken: station.session.idTag,
      type: "ISO14443",
    },
    evse: {
      id: 1,
      connectorId,
    },
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: 0,
            measurand: "Energy.Active.Import.Register",
            unitOfMeasure: { unit: "Wh" },
          },
        ],
      },
    ],
  });

  if (!station.session) return;

  station.state = "charging";
  await station.sendStatusNotification("Charging");
  if (!station.session) return;

  station.session.meterTimer = setInterval(() => {
    sendMeterValues201(station, connectorId);
  }, CONFIG.meterIntervalMs);
}

function sendMeterValues201(
  station: ChargingStation,
  connectorId: number,
): void {
  if (!station.session) return;

  const now = Date.now();
  const elapsedMs = now - station.session.lastMeterAt;
  const powerW = activePowerW(station);
  station.session.accumulatedEnergyWh += powerW * (elapsedMs / 3_600_000);
  station.session.lastMeterAt = now;
  station.session.seqNo++;

  const totalMeterWh = station.session.meterStartWh + station.session.accumulatedEnergyWh;
  const currentA = powerW / NOMINAL_VOLTAGE_V;

  station.send("TransactionEvent", {
    eventType: "Updated",
    timestamp: new Date().toISOString(),
    triggerReason: "MeterValuePeriodic",
    seqNo: station.session.seqNo,
    transactionInfo: {
      transactionId: station.session.transactionId,
      chargingState: "Charging",
    },
    evse: {
      id: 1,
      connectorId,
    },
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: parseFloat(totalMeterWh.toFixed(1)),
            measurand: "Energy.Active.Import.Register",
            unitOfMeasure: { unit: "Wh" },
          },
          {
            value: parseFloat(powerW.toFixed(0)),
            measurand: "Power.Active.Import",
            unitOfMeasure: { unit: "W" },
          },
          {
            value: parseFloat(NOMINAL_VOLTAGE_V.toFixed(1)),
            measurand: "Voltage",
            unitOfMeasure: { unit: "V" },
          },
          {
            value: parseFloat(currentA.toFixed(2)),
            measurand: "Current.Import",
            unitOfMeasure: { unit: "A" },
          },
        ],
      },
    ],
  });
}

async function stopSession201(
  station: ChargingStation,
  reason: string,
): Promise<void> {
  if (!station.session) return;

  station.session.seqNo++;
  const stoppedReason = reason === "Remote" ? "Remote" : "Local";

  await station.send("TransactionEvent", {
    eventType: "Ended",
    timestamp: new Date().toISOString(),
    triggerReason: reason === "Remote" ? "RemoteStop" : "StopAuthorized",
    seqNo: station.session.seqNo,
    transactionInfo: {
      transactionId: station.session.transactionId,
      chargingState: "Idle",
      stoppedReason,
    },
    evse: {
      id: 1,
      connectorId: 1,
    },
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: parseFloat(
              (station.session.meterStartWh + station.session.accumulatedEnergyWh).toFixed(1),
            ),
            measurand: "Energy.Active.Import.Register",
            unitOfMeasure: { unit: "Wh" },
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Stop charging session (entry point)
// ---------------------------------------------------------------------------

export async function stopChargingSession(
  station: ChargingStation,
  reason: string,
): Promise<void> {
  if (!station.session) return;

  const session = station.session;

  if (session.meterTimer) {
    clearInterval(session.meterTimer);
    session.meterTimer = null;
  }

  // Final energy accumulation up to stop moment
  const now = Date.now();
  const elapsedMs = now - session.lastMeterAt;
  session.accumulatedEnergyWh += activePowerW(station) * (elapsedMs / 3_600_000);
  session.lastMeterAt = now;

  station.state = "finishing";

  if (station.protocol === "ocpp1.6") {
    await stopSession16(station, reason);
  } else {
    await stopSession201(station, reason);
  }

  const deliveredKwh = session.accumulatedEnergyWh / 1000;
  const durationMin = (now - session.startedAt) / 60_000;

  station.meterBaseWh += session.accumulatedEnergyWh;

  stats.sessionsCompleted++;
  stats.totalEnergyKwh += deliveredKwh;
  stats.totalSessionDurationMs += now - session.startedAt;
  stats.sessionCount++;

  logInfo(
    station.id,
    `${C.green}Stopped charging${C.reset} (${deliveredKwh.toFixed(1)} kWh, ${durationMin.toFixed(1)} min, reason: ${reason})`,
  );

  station.session = null;
  station.state = "available";
  station.sendStatusNotification("Available").catch(() => {});
}

// ---------------------------------------------------------------------------
// Abort session (on disconnect — no OCPP messages sent)
// ---------------------------------------------------------------------------

export function abortSession(station: ChargingStation): void {
  if (!station.session) return;
  if (station.session.meterTimer) {
    clearInterval(station.session.meterTimer);
    station.session.meterTimer = null;
  }
  const now = Date.now();
  const elapsedMs = now - station.session.lastMeterAt;
  station.session.accumulatedEnergyWh += activePowerW(station) * (elapsedMs / 3_600_000);

  const deliveredKwh = station.session.accumulatedEnergyWh / 1000;
  station.meterBaseWh += station.session.accumulatedEnergyWh;
  stats.sessionsCompleted++;
  stats.totalEnergyKwh += deliveredKwh;
  stats.totalSessionDurationMs += now - station.session.startedAt;
  stats.sessionCount++;
  station.session = null;
}
