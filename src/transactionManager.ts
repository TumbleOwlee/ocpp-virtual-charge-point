import type { VCP } from "./vcp";

const METER_VALUES_INTERVAL_SEC = 15;
const DEFAULT_LIMIT_W = 11_000; // 11 kW ≈ 16 A per phase at 230 V

type TransactionId = string | number;

interface TransactionState {
  startedAt: Date;
  idTag: string;
  transactionId: TransactionId;
  meterValue: number;
  evseId?: number;
  connectorId: number;
  limitW: number;
}

interface StartTransactionProps {
  transactionId: TransactionId;
  idTag: string;
  evseId?: number;
  connectorId: number;
  limitW: number;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
}

type StoredTransaction = TransactionState & {
  meterValuesTimer: ReturnType<typeof setInterval>;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
};

export class TransactionManager {
  transactions: Map<TransactionId, StoredTransaction> = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(vcp: VCP, startTransactionProps: StartTransactionProps) {
    const { transactionId, meterValuesCallback } = startTransactionProps;
    const fireMeterValues = () => {
      // biome-ignore lint/style/noNonNullAssertion: transaction must exist while timer runs
      const tx = this.transactions.get(transactionId)!;
      const { meterValuesTimer: _t, meterValuesCallback: _cb, ...state } = tx;
      tx.meterValuesCallback({
        ...state,
        meterValue: this.getMeterValue(transactionId),
      });
    };
    const meterValuesTimer = setInterval(
      fireMeterValues,
      METER_VALUES_INTERVAL_SEC * 1000,
    );
    this.transactions.set(transactionId, {
      transactionId,
      idTag: startTransactionProps.idTag,
      meterValue: 0,
      startedAt: new Date(),
      evseId: startTransactionProps.evseId,
      connectorId: startTransactionProps.connectorId,
      limitW: startTransactionProps.limitW,
      meterValuesTimer,
      meterValuesCallback,
    });
  }

  // Update the active limit for all transactions on a connector and immediately
  // send a MeterValues message reflecting the new limit.
  updateLimitAndFlush(connectorId: number, limitW: number): void {
    for (const [txId, tx] of this.transactions) {
      if (connectorId === 0 || tx.connectorId === connectorId) {
        tx.limitW = limitW;
        const { meterValuesTimer: _t, meterValuesCallback, ...state } = tx;
        meterValuesCallback({
          ...state,
          meterValue: this.getMeterValue(txId),
        });
      }
    }
  }

  stopTransaction(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }
    this.transactions.delete(transactionId);
  }

  getMeterValue(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return 0;
    }
    const elapsedMs = new Date().getTime() - transaction.startedAt.getTime();
    // Wh = W × h = limitW × (elapsedMs / 3_600_000)
    return (transaction.limitW * elapsedMs) / 3_600_000;
  }

  getDefaultLimitW(): number {
    return DEFAULT_LIMIT_W;
  }
}
