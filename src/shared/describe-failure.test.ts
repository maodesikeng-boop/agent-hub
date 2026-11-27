// 出错的说法：按通用类型分，厂商的错误特征在 shared/vendors.ts。
import { describe, expect, it } from "vitest";
import { describeFailure, isNestedMacOsSandboxError, MACOS_NESTED_SANDBOX_MESSAGE } from "./errors.ts";
import { AGENT_VENDORS } from "./vendors.ts";

describe("describeFailure：错误分类", () => {
  it("服务繁忙：529 / overloaded / 5xx", () => {
    for (const raw of ["error_during_execution: API Error: 529 Overloaded", 'API Error: 500 {"type":"api_error"}', "overloaded_error"]) {
      expect(describeFailure(raw)).toMatchObject({ kind: "busy", text: "Claude 服务繁忙，稍后重试", raw });
    }
  });

  it("额度用完", () => {
    for (const raw of ["Claude AI usage limit reached|1762300000", "API Error: 429 rate_limit_error", "Credit balance is too low"]) {
      expect(describeFailure(raw)).toMatchObject({ kind: "quota", text: "Claude 额度用完了" });
    }
  });

  it("网络断了：通用的网络错误，不分厂商", () => {
    for (const raw of ["fetch failed: ECONNRESET", "getaddrinfo ENOTFOUND api.anthropic.com", "socket hang up", "API Error: Connection error."]) {
      expect(describeFailure(raw)).toMatchObject({ kind: "network", text: "网络断了，稍后重试" });
    }
  });

  it("没能启动：驱动层的启动错误码", () => {
    expect(describeFailure("spawn_failed: x", { vendor: "codex" })).toMatchObject({ kind: "start", text: "Codex 没能启动" });
    expect(describeFailure("start_timeout")).toMatchObject({ kind: "start" });
  });

  it("找不到程序：按错误码里的厂商说“找不到 X”，不是一律 claude", () => {
    expect(describeFailure("claude_not_found: spawn claude ENOENT")).toMatchObject({ kind: "missing", text: "找不到 Claude" });
    expect(describeFailure("codex_not_found: /x/codex: spawn ENOENT")).toMatchObject({ kind: "missing", text: "找不到 Codex" });
    expect(describeFailure("agy_not_found: /x/agy: spawn ENOENT", { vendor: "agy" })).toMatchObject({ kind: "missing", text: "找不到 Antigravity" });
  });

  it("未知：默认写“出错了”；要原样的（已经是给人看的话）传 raw，认不出的 JSON 原文仍写“出错了”", () => {
    expect(describeFailure("disk full: /tmp")).toEqual({ kind: "unknown", text: "出错了", raw: "disk full: /tmp" });
    expect(describeFailure("被停止了", { unknown: "raw" })).toEqual({ kind: "unknown", text: "被停止了", raw: "被停止了" });
    expect(describeFailure('{"type":"error","message":"mystery"}', { unknown: "raw" })).toEqual({
      kind: "unknown",
      text: "出错了",
      raw: '{"type":"error","message":"mystery"}',
    });
    expect(describeFailure('  {"error":"weird"}', { unknown: "raw" })).toEqual({
      kind: "unknown",
      text: "出错了",
      raw: '  {"error":"weird"}',
    });
    expect(describeFailure("")).toMatchObject({ kind: "unknown", text: "出错了" });
  });

  it("acceptance S2/S11/S12: classifies macOS nested sandbox-exec exit 71 with actionable message across all vendors without false positives", () => {
    expect(isNestedMacOsSandboxError("sandbox-exec: sandbox_apply: Operation not permitted", 71)).toBe(true);
    expect(isNestedMacOsSandboxError("spawn_failed: claude exited before system/init (exit code 71): sandbox-exec: sandbox_apply: Operation not permitted")).toBe(true);
    expect(isNestedMacOsSandboxError("ACP process exited before initialization (code=71, signal=null): sandbox_apply: Operation not permitted")).toBe(true);
    expect(isNestedMacOsSandboxError("process exited with exit code 71: unrelated os error", 71)).toBe(false);
    expect(isNestedMacOsSandboxError("bwrap: setting up uid map: Permission denied", 1)).toBe(false);

    for (const vendor of AGENT_VENDORS) {
      const raw = `spawn_failed: ${vendor} exited before init (exit code 71): sandbox-exec: sandbox_apply: Operation not permitted`;
      expect(describeFailure(raw, { vendor }), vendor).toEqual({
        kind: "start",
        text: MACOS_NESTED_SANDBOX_MESSAGE,
        raw,
      });
    }
  });
});
