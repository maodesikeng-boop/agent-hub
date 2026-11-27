// execFile 同步抛 EPERM（沙箱里、或系统不让起 ps）：约定是“ps 跑不了”，退回只杀 pid（或它的组），不能变成 rejected Promise。
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: () => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  },
}));

import { EMPTY_TOKEN_USAGE, type AgentSessionRow } from "../../shared/index.ts";
import { identifyAcpStaleProcess } from "../../vendors/_common/acp/protocol.ts";
import { matchesAgyAcpStaleProcess } from "../../vendors/agy/acp-config.ts";
import { probePr } from "../git/pr.ts";
import { codexOfSession } from "../../vendors/codex/protocol.ts";
import { claudeOfSession } from "../../vendors/claude/protocol.ts";
import { forceKillTree } from "./process.ts";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("execFile 同步抛 EPERM", () => {
  it("forceKillTree 正常 resolve，照样 SIGKILL 它的组", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(forceKillTree(424242, true)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
  });

  it("forceKillTree 不拥有组：照样 SIGKILL 它本身", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(forceKillTree(424243, false)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(424243, "SIGKILL");
  });

  it("claudeOfSession / codexOfSession / identifyAcpStaleProcess(agy) 返回 null", async () => {
    await expect(claudeOfSession(424242, "sid")).resolves.toBeNull();
    await expect(codexOfSession(424242)).resolves.toBeNull();
    const agyRow: AgentSessionRow = {
      id: 1,
      role: "pm",
      conversationId: 1,
      pmId: 1,
      workerId: null,
      vendor: "agy",
      vendorSessionId: "sid",
      cwd: "/tmp",
      addDirs: [],
      generation: 1,
      model: null,
      effort: null,
      pid: 424242,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: EMPTY_TOKEN_USAGE,
      createdAt: 1,
      updatedAt: 1,
    };
    await expect(
      identifyAcpStaleProcess(424242, agyRow, "agy", "agy", [], matchesAgyAcpStaleProcess),
    ).resolves.toBeNull();
  });

  it("probePr 当没有，不抛", async () => {
    await expect(probePr("/tmp", "hub/1-x", 1_000)).resolves.toBeNull();
  });
});
