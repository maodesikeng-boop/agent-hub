// codex thread/resume 时换了 developerInstructions，codex 用不用新的（S30，直接用驱动层 + 真 codex）。
// 第一个进程用说明“暗号是 A”开线程，第一轮不问暗号（免得对话历史带偏答案）；关掉进程，说明改成“暗号是 B”，
// 第二个进程 thread/resume 同一个线程，问说明里的暗号。答 B：codex 恢复时用新的说明；答 A：沿用最初的。
// 结论用在 driver/persona-note.ts 的 CODEX_RESUME_REBAKES。跑完删掉这次在 ~/.codex 里留的会话记录。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow, type DriverEvent } from "../../src/shared/index.ts";
import { createCodexDriver } from "../../src/daemon/driver/index.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { waitUntil } from "../e2e/harness.ts";
import { TURN_MS, expect, removeVendorRecordsOf, scenario, type Outcome } from "./kit.ts";

const CODEX = process.env.AGENT_HUB_CODEX || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const CODEX_MODEL = process.env.AGENT_HUB_CODEX_MODEL || "gpt-5.6-luna";

const instructions = (secret: string) => `你是一个测试助手，回复尽量短。用户的暗号是 ${secret}。`;

/** 一次试验：返回第二个进程答的暗号原文。 */
async function trial(first: string, second: string): Promise<{ answer: string; resumed: boolean | null }> {
  const dir = mkdtempSync(join(tmpdir(), "ah-codex-resume-"));
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  const store = new MemorySessionStore();
  const row: AgentSessionRow = {
    id: 1,
    role: "pm",
    conversationId: 1,
    pmId: null,
    workerId: null,
    vendor: "codex",
    vendorSessionId: randomUUID(),
    cwd,
    addDirs: [],
    generation: 1,
    model: CODEX_MODEL,
    effort: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { ...EMPTY_TOKEN_USAGE },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.add(row);
  const run = async (secret: string, text: string) => {
    writeFileSync(promptFile, instructions(secret));
    const driver = createCodexDriver({ codexPath: CODEX, store, prepareLaunch: async () => ({ promptFile, env: {}, fingerprint: "" }), log: () => {} });
    const events: DriverEvent[] = [];
    driver.onEvent((_id, e) => events.push(e));
    try {
      await driver.send(1, { messageIds: [1], source: "user", text });
      await waitUntil("这一轮结束", () => events.find((e) => e.type === "turn.ended"), TURN_MS);
      const ended = events.find((e) => e.type === "turn.ended");
      expect(ended?.type === "turn.ended" && ended.ok, `这一轮没成功：${JSON.stringify(ended)}`);
      const started = events.find((e) => e.type === "session.started");
      return {
        text: events.flatMap((e) => (e.type === "agent.text" ? [e.text] : [])).join("\n").trim(),
        resumed: started?.type === "session.started" ? started.resumed : null,
      };
    } finally {
      await driver.shutdown();
    }
  };
  try {
    await run(first, "这一轮只回复一个字：好");
    const { text, resumed } = await run(second, "开发者说明（developer instructions）里写的用户暗号是什么？只回复暗号本身。");
    return { answer: text, resumed };
  } finally {
    const current = store.get(1)!;
    removeVendorRecordsOf([{ vendor: "codex", vendor_session_id: current.vendorSessionId, cwd }]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCodexResume(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S30")) return;
  await scenario(outcomes, `S30 codex（${CODEX_MODEL}）thread/resume 时换了 developerInstructions，用不用新的`, async () => {
    const results: string[] = [];
    for (const [a, b] of [
      ["APPLE", "BANANA"],
      ["KIWI", "MANGO"],
    ] as const) {
      const { answer, resumed } = await trial(a, b);
      expect(resumed === true, `第二个进程没有 thread/resume（resumed=${resumed}）`);
      const verdict = answer.includes(b) ? "用新的" : answer.includes(a) ? "沿用最初的" : "答不上";
      results.push(`${a}→${b}：答“${answer}”（${verdict}）`);
    }
    return results.join("；");
  });
}
