import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBench } from "../fake-bench.ts";
import { BENCH_ECHO_REPLY } from "../fake-script.ts";
import type { FeishuDriver, FeishuMessage } from "../feishu-driver.ts";
import { feishuRunners } from "./feishu.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function message(messageId: string, text: string, status?: string): FeishuMessage {
  return {
    messageId, chatId: "oc_router", senderType: "app", senderId: "cli_test", msgType: "interactive",
    createTime: 1, updateTime: 1, deleted: false, updated: false,
    content: JSON.stringify({ status, config: { streaming_mode: false }, body: { elements: [{ tag: "markdown", content: text }] } }),
  };
}

async function run(id: string, cards: FeishuMessage[]) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "tester-feishu-flow-"));
  dirs.push(root);
  const sent: FeishuMessage = { ...message("om_sent", "Bench check"), senderType: "user", senderId: "owner" };
  const driver: FeishuDriver = {
    testChats: async () => [{ chatId: sent.chatId, kind: "router" }, { chatId: "oc_group", kind: "project", deviceId: "dev_mac", pmId: 1 }],
    sendAsUser: async () => sent.messageId,
    listMessages: async () => [sent, ...cards],
    waitForBotMessage: async (_chat, _since, done) => {
      const found = cards.find(done);
      if (found === undefined) throw new Error("no reply");
      return found;
    },
    ensureUserToken: async () => 0,
  };
  const { bench } = fakeBench({
    version: 1, root, sandboxProject: root, testAccount: { githubLogin: "bench-bot" },
    guards: { dataDirs: [], uiPorts: [], meshPorts: [], feishuAppIds: [], githubLogins: [] },
    feishu: { botAppId: "cli_test", driverAppId: "cli_driver" },
    instances: [{ name: "mac", role: "local", dataDir: root, userHome: root, uiPort: 4417, meshPort: 4421, env: {} }],
  });
  const execution = feishuRunners[id]!({
    bench: {
      ...bench,
      local: () => {
        const local = bench.local();
        return { ...local, state: vi.fn().mockResolvedValue({ pms: [], conversations: [] }), api: { ...local.api, json: vi.fn().mockResolvedValue({ pmId: 1, conversationId: 1 }) } };
      },
      remote: () => ({ ...bench.remote(), stop: async () => {}, start: async () => {} }),
    },
    feishu: driver, evidenceDir: root, instance: "local", signal: new AbortController().signal, log: () => {},
  });
  await vi.runAllTimersAsync();
  return execution;
}

describe("Feishu Router flows", () => {
  it.each(["feishu.dm-router", "feishu.reconnect-catch-up"])("fails %s on a nonempty terminal error card", async (id) => {
    const result = await run(id, [message("om_error", "没办成：出错了")]);
    expect(result.checks.filter(({ ok }) => !ok)).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("没办成：出错了") }),
    ]));
  });

  it("fails a DM when the card carries a failed status", async () => {
    const result = await run("feishu.dm-router", [message("om_error", "Could not complete your request", "failed")]);
    expect(result.checks.some(({ ok }) => !ok)).toBe(true);
  });

  it("fails a DM when Feishu reports a delivery error as a plain message", async () => {
    const result = await run("feishu.dm-router", [{ ...message("om_error", ""), msgType: "text", content: JSON.stringify({ text: "没送到：没有可用厂商" }) }]);
    expect(result.checks).toContainEqual(expect.objectContaining({ check: "reply-final", ok: false }));
  });

  it("fails reconnect catch-up when two different answers follow one DM", async () => {
    const result = await run("feishu.reconnect-catch-up", [message("om_first", "First answer"), message("om_second", "Second answer")]);
    expect(result.checks).toContainEqual(expect.objectContaining({ check: "answered-once", ok: false }));
  });

  it.each(["feishu.dm-router", "feishu.reconnect-catch-up"])("passes %s with one successful answer", async (id) => {
    const result = await run(id, [message("om_reply", "One short answer")]);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.filter(({ ok }) => !ok)).toEqual([]);
  });
});

describe("Feishu project group flows", () => {
  it("rejects a group failure card even when it includes the expected reply text", async () => {
    const result = await run("feishu.group-round-trip", [message("om_error", `${BENCH_ECHO_REPLY}\n没回成：模型出错`)]);
    expect(result.checks).toContainEqual(expect.objectContaining({ check: "reply-text", ok: false }));
  });

  it("still passes the scenario that deliberately produces a model failure card", async () => {
    const result = await run("feishu.failed-turn-card", [message("om_failure", "没回成：模型出错")]);
    expect(result.checks).toContainEqual(expect.objectContaining({ check: "reason-shown", ok: true }));
    expect(result.checks.filter(({ ok }) => !ok)).toEqual([]);
  });
});
