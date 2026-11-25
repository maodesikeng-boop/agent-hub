import { describe, it } from "vitest";
import { VENDOR_LIST } from "./registry.ts";

describe("checklist contract for every registered vendor", () => {
  for (const spec of VENDOR_LIST) {
    it.todo(`${spec.id}: declared checklist sources match the parsers wired into its driver`);
    it.todo(`${spec.id}: every enable arg and env variable reaches the launched command`);
  }
  it.todo("an unknown vendor with no sources produces no checklist message and still gets a timed action line");
});
