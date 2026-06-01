import { z } from "zod";
import {
  type OcppCall,
  type OcppCallResult,
  OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema, IdTagInfoSchema, IdTokenSchema } from "./_common";
import { meterValuesOcppMessage } from "./meterValues";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

const StartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  idTag: IdTokenSchema,
  meterStart: z.number().int(),
  reservationId: z.number().int().nullish(),
  timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
  StartTransactionReqType,
  StartTransactionResType
> {
  resHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<StartTransactionReqType>>,
    result: OcppCallResult<z.infer<StartTransactionResType>>,
  ): Promise<void> => {
    const connectorId = call.payload.connectorId;
    // Connector-specific limit takes precedence over charge-point-wide (id 0).
    const limitW =
      vcp.connectorLimitW.get(connectorId) ??
      vcp.connectorLimitW.get(0) ??
      vcp.transactionManager.getDefaultLimitW();

    vcp.transactionManager.startTransaction(vcp, {
      transactionId: result.payload.transactionId,
      idTag: call.payload.idTag,
      connectorId,
      limitW,
      meterValuesCallback: async (transactionState) => {
        const powerKw = transactionState.limitW / 1000;
        const currentA = transactionState.limitW / (3 * 230);
        vcp.send(
          meterValuesOcppMessage.request({
            connectorId,
            transactionId: result.payload.transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: (transactionState.meterValue / 1000).toFixed(3),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                  },
                  {
                    value: powerKw.toFixed(2),
                    measurand: "Power.Active.Import",
                    unit: "kW",
                  },
                  {
                    value: currentA.toFixed(2),
                    measurand: "Current.Import",
                    unit: "A",
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    if (result.payload.idTagInfo.status !== "Accepted") {
      vcp.send(
        stopTransactionOcppMessage.request({
          transactionId: result.payload.transactionId,
          meterStop: 0,
          reason: "DeAuthorized",
          timestamp: new Date().toISOString(),
        }),
      );
      vcp.send(
        statusNotificationOcppMessage.request({
          connectorId: call.payload.connectorId,
          errorCode: "NoError",
          status: "Available",
        }),
      );
      return;
    }
  };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
  "StartTransaction",
  StartTransactionReqSchema,
  StartTransactionResSchema,
);
