import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, vendorSpec } from "./vendors.ts";
import { userBlockerCleared, userBlockerKindOf, userBlockerKindOfFailure, userBlockerText } from "./user-blockers.ts";

describe("阻塞原因", () => {
  it("厂商状态：没登录、没装要用户动手，能用、认不出的不用", () => {
    expect(userBlockerKindOf("signed_out")).toBe("vendor_signed_out");
    expect(userBlockerKindOf("not_installed")).toBe("vendor_not_installed");
    expect(userBlockerKindOf("available")).toBeNull();
    expect(userBlockerKindOf("unknown")).toBeNull();
    expect(userBlockerCleared("available")).toBe(true);
    expect(userBlockerCleared("unknown")).toBe(true);
    expect(userBlockerCleared("signed_out")).toBe(false);
  });

  it("Worker 起不来的原文：认证失败是没登录、找不到程序是没装，额度和网络不算", () => {
    expect(
      userBlockerKindOfFailure("spawn_failed: agy exited before init (exit 1): Error: authentication required. Run 'agy' to log in", "agy"),
    ).toBe("vendor_signed_out");
    expect(userBlockerKindOfFailure("claude exited: Not logged in · Please run /login", "claude")).toBe("vendor_signed_out");
    expect(userBlockerKindOfFailure("codex_not_found: codex", "codex")).toBe("vendor_not_installed");
    expect(userBlockerKindOfFailure("429 rate_limit exceeded", "codex")).toBeNull();
    expect(userBlockerKindOfFailure("spawn_failed: codex exited before thread ready (exit 1)", "codex")).toBeNull();
  });

  it("卡上的话：每家都写设备名和登录命令，不按厂商写分支", () => {
    for (const vendor of AGENT_VENDORS) {
      const signedOut = userBlockerText({ kind: "vendor_signed_out", vendor, device: "东京" });
      expect(signedOut).toContain("这台设备（东京）");
      expect(signedOut).toContain(`\`${vendorSpec(vendor).cli.loginCommand}\``);
      expect(userBlockerText({ kind: "vendor_not_installed", vendor, device: "东京" })).toContain("没装");
    }
  });
});
