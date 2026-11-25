import { describe, it } from "vitest";
import { VENDOR_LIST } from "../vendors/registry.ts";

describe("progress pipeline from vendor frames to the API", () => {
  for (const spec of VENDOR_LIST) {
    it.todo(`${spec.id}: fixture frames pass through the driver and ledger to GET conversation messages and session.status`);
  }
});
