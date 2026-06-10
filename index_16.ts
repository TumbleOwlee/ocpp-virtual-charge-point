require("dotenv").config();

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "./src/v16/messages/statusNotification";
import { VCP } from "./src/vcp";

const vcp = new VCP({
  endpoint: process.env.WS_URL ?? "ws://localhost:3000",
  chargePointId: process.env.CP_ID ?? "123456",
  ocppVersion: OcppVersion.OCPP_1_6,
  basicAuthPassword: process.env.PASSWORD ?? undefined,
  adminPort: Number.parseInt(process.env.ADMIN_PORT ?? "9999"),
  reconnectIntervalMs: 15000,
  onConnected: (v) => {
    v.send(
      bootNotificationOcppMessage.request({
        chargePointVendor: "Solidstudio",
        chargePointModel: "VirtualChargePoint",
        chargePointSerialNumber: "S001",
        firmwareVersion: "1.0.0",
      }),
    );
    v.send(
      statusNotificationOcppMessage.request({
        connectorId: 1,
        errorCode: "NoError",
        status: "Available",
      }),
    );
  },
});

vcp.connect();
