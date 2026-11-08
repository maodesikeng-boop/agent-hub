import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS } from "../../shared/index.ts";
import { AGY_SIGNED_OUT_STDOUT } from "../driver/test-helpers.ts";
import { codexAuthFileAvailability } from "./codex.ts";
import { VENDOR_CATALOG_PROBES } from "./index.ts";

describe("各家怎么从名单那次查询里看登录状态", () => {
  it("每家都登记了", () => {
    for (const v of AGENT_VENDORS) expect(VENDOR_CATALOG_PROBES[v]).toBeDefined();
  });

  it("claude：initialize 回应里有 account（实测有 email）是能用；没有说不清", () => {
    const { availabilityOf } = VENDOR_CATALOG_PROBES.claude;
    expect(availabilityOf({ models: [], account: { email: "a@b.c", organization: "X" } })).toBe("available");
    expect(availabilityOf({ models: [], account: {} })).toBe("unknown");
    expect(availabilityOf({ models: [], account: { apiProvider: "firstParty" } })).toBe("unknown");
    expect(availabilityOf({ models: [] })).toBe("unknown");
  });

  it("codex：account/read 回 account: null 且要 OpenAI 登录是没登录；有账号能用；没问到说不清", () => {
    const { availabilityOf } = VENDOR_CATALOG_PROBES.codex;
    expect(availabilityOf({ models: [], account: { account: null, requiresOpenaiAuth: true } })).toBe("signed_out");
    expect(availabilityOf({ models: [], account: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } })).toBe("available");
    expect(availabilityOf({ models: [], account: { account: null, requiresOpenaiAuth: false } })).toBe("available");
    expect(availabilityOf({ models: [] })).toBe("unknown");
  });

  it("agy：问到名单是能用；东京实测没登录打印的那段话是没登录", () => {
    const probe = VENDOR_CATALOG_PROBES.agy;
    expect(probe.availabilityOf({})).toBe("available");
    expect(probe.availabilityOfError?.(new Error(`agy 没回有效 JSON（models）：${AGY_SIGNED_OUT_STDOUT}`))).toBe("signed_out");
    expect(probe.availabilityOfError?.(new Error("agy 超时（15000 ms 没回 models）"))).toBe("unknown");
  });

  it("codex 补充判断：读 $CODEX_HOME/auth.json 在不在（不起进程）", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("signed_out");
      writeFileSync(join(dir, "auth.json"), "{}");
      expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("available");
      expect(codexAuthFileAvailability({}, dir.replace(/\/[^/]+$/u, "/nope"))).toBe("signed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
