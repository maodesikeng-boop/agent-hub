import type { Driver } from "../../shared/index.ts";
import { createAgyAcpDriver, type AgyAcpDriverOptions } from "./acp-config.ts";

export type AgyDriverOptions = AgyAcpDriverOptions;

export function createAgyDriver(options: AgyDriverOptions): Driver {
  return createAgyAcpDriver(options);
}
