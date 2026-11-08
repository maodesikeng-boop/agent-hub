// execFile 同步抛 EPERM（沙箱里、或系统不让起 ps）：约定是“ps 跑不了”，退回只杀 pid（或它的组），不能变成 rejected Promise。
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: () => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  },
}));

import { probePr } from "../git/pr.ts";
import { agyOfSession } from "./agy-protocol.ts";
import { codexOfSession } from "./codex-protocol.ts";
import { claudeOfSession, forceKillTree } from "./process.ts";

afterEach(() => vi.restoreAllMocks());

describe("execFile 同步抛 EPERM", () => {
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

  it("claudeOfSession / codexOfSession / agyOfSession 返回 null", async () => {
    await expect(claudeOfSession(424242, "sid")).resolves.toBeNull();
    await expect(codexOfSession(424242)).resolves.toBeNull();
    await expect(agyOfSession(424242, "sid")).resolves.toBeNull();
  });

  it("probePr 当没有，不抛", async () => {
    await expect(probePr("/tmp", "hub/1-x", 1_000)).resolves.toBeNull();
  });
});
