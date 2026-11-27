// 只读 Worker 的判断只看 LaunchFiles.readonly（回归，设计第 6 节测试 8）：agy、codex 不再反读 claude 的设置文件，
// 改设置文件里的权限档名（dontAsk 改成别的）影响不到另两家。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE, buildReadonlyPolicy, type AgentSessionRow, type LaunchFiles } from "../../shared/index.ts";
import { buildAgyAcpLaunchArgs } from "../../vendors/agy/acp-config.ts";
import { readCodexLaunchConfig } from "../../vendors/codex/protocol.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "readonly-launch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const session = (vendor: "agy" | "codex"): AgentSessionRow => ({
  id: 1,
  role: "worker",
  conversationId: 1,
  pmId: null,
  workerId: 1,
  vendor,
  vendorSessionId: "",
  cwd: dir,
  addDirs: [],
  generation: 1,
  model: null,
  effort: null,
  pid: null,
  status: "idle",
  hasCompletedTurn: false,
  lastEventAt: null,
  rateLimit: null,
  usage: { ...EMPTY_TOKEN_USAGE },
  createdAt: 1,
  updatedAt: 1,
});

/** settingsFile 里写什么权限档：dontAsk（claude 现在的只读档）、随便改的名字、auto。 */
function files(defaultMode: string, readonly: boolean): LaunchFiles {
  const settingsFile = join(dir, `settings-${defaultMode}.json`);
  writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode } }));
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "你是 Worker");
  const base = { promptFile, settingsFile, env: { HUB_SOCK: "/s" }, fingerprint: "f" };
  return readonly ? { ...base, readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state" }), tmpDir: dir } : base;
}

describe("agy：只读看 LaunchFiles.readonly，不看设置文件", () => {
  it("有 readonly → 不传 --dangerously-skip-permissions；设置文件里的档名叫什么都一样", () => {
    for (const defaultMode of ["dontAsk", "renamed-readonly-mode", "auto"]) {
      const args = buildAgyAcpLaunchArgs({
        row: session("agy"),
        files: files(defaultMode, true),
        resume: false,
        executablePath: "agy",
      });
      expect(args).toEqual(["acp", "--sandbox=false"]);
      expect(args).not.toContain("--dangerously-skip-permissions");
    }
  });

  it("没有 readonly → 传 --dangerously-skip-permissions；设置文件里写 dontAsk 也不算只读", () => {
    const args = buildAgyAcpLaunchArgs({
      row: session("agy"),
      files: files("dontAsk", false),
      resume: false,
      executablePath: "agy",
    });
    expect(args).toEqual(["acp", "--sandbox=false", "--dangerously-skip-permissions"]);
  });
});

describe("codex：只读看 LaunchFiles.readonly，不看设置文件", () => {
  it("有 readonly → readonly: true；设置文件里的档名叫什么都一样", () => {
    for (const defaultMode of ["dontAsk", "renamed-readonly-mode", "auto"]) {
      expect(readCodexLaunchConfig(files(defaultMode, true)).readonly).toBe(true);
    }
  });

  it("没有 readonly → false；设置文件里写 dontAsk 也不算只读；其余（提示词、环境变量配置）照旧", () => {
    const config = readCodexLaunchConfig(files("dontAsk", false));
    expect(config.readonly).toBe(false);
    expect(config.developerInstructions).toBe("你是 Worker");
    expect(config.config["shell_environment_policy.set"]).toEqual({ HUB_SOCK: "/s" });
  });
});
