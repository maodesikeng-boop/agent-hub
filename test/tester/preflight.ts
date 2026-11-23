// Checks each bench boundary before any flow runs, so an outage outside Bellwood never reads as a product failure.
import type { Bench } from "./bench.ts";
import type { FeishuDriver } from "./feishu-driver.ts";
import type { BenchCapability, PreflightResult } from "./types.ts";

/**
 * Postcondition: `available` lists each capability in `wanted` that answered:
 * local_instance and remote_instance by /api/health (the remote through the mesh proxy),
 * remote_control by its status command, feishu_bot by a tenant token and the bot's chat list, and feishu_driver by a valid user token.
 * `coverage` holds probeVendor for every vendor in VENDOR_LIST on every bench computer that answered, and an `unknown`
 * entry for each vendor on a computer that did not, so the matrix is always complete.
 * Each capability is retried once; a second failure lands in `problems` with the service that failed.
 * It sends no Feishu message and starts no model turn.
 */
export async function preflight(bench: Bench, driver: FeishuDriver | null, wanted: readonly BenchCapability[]): Promise<PreflightResult> {
  throw new Error("Not implemented");
}
