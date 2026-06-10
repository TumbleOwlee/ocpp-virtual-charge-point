import { logger } from "./logger";
import { delay } from "./utils";
import type { VCP } from "./vcp";

const vcps: Map<VCP, () => Promise<VCP>> = new Map();

export async function close(vcp: VCP) {
  if (!process.env.AUTO_RESTART) {
    logger.error("Connection lost. Set AUTO_RESTART=true to enable reconnect.");
    return;
  }

  logger.info("Auto-restart enabled. Closing old VCP...");
  vcp.close();
  logger.info("Waiting for 15 seconds...");
  await delay(15000);
  logger.info("Starting new VCP");

  const main = vcps.get(vcp);
  if (!main) {
    logger.error("Main function not found for VCP");
    return;
  }

  deregisterVcp(vcp);
  const newVcp = await main();
  registerVcp(newVcp, main);
}

export function registerVcp(vcp: VCP, main: () => Promise<VCP>) {
  vcps.set(vcp, main);
}

export function deregisterVcp(vcp: VCP) {
  vcps.delete(vcp);
}
