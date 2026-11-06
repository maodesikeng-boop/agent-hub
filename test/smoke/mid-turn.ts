// 一轮中途把消息交给 agent（docs/mid-turn-messages.md）：直接用驱动层 + 真 CLI（claude 用小模型，codex 用 model/list 里最便宜的）。
// S27 claude、S28 codex，每家两个：
//   a 项目经理在跑一条 `sleep 8` 时用户说“停下”：send 返回中途送达，这条在那条命令跑完后就被取走（处理中），agent 不再跑后面的命令；
//   b 同样写进一条，然后点停止：这条标已取消（message.cancelled），停止后不再自己接着跑。
// 数据都在临时目录；进程只按驱动层自己的 PID 关（shutdown）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow, type AgentVendor, type Driver, type DriverEvent } from "../../src/shared/index.ts";
import { createClaudeDriver, createCodexDriver } from "../../src/daemon/driver/index.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { sleep, waitUntil } from "../e2e/harness.ts";
import { CLAUDE, MODEL, TURN_MS, expect, scenario, type Outcome } from "./kit.ts";

const CODEX = process.env.AGENT_HUB_CODEX || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
/** codex 的 model/list 里最便宜的（本机账号实测：gpt-6-luna、gpt-5.6-terra、gpt-5.6-luna）。 */
const CODEX_MODEL = process.env.AGENT_HUB_CODEX_MODEL || "gpt-5.6-luna";

const TASK =
  "用 shell 依次运行 3 条命令，每条单独运行一次：(1) `sleep 8; echo ONE` (2) `sleep 8; echo TWO` (3) `sleep 8; echo THREE`。" +
  "每条跑完用一句话报告它的输出，再跑下一条。";
const STOP = "停下，只跑这一条就够了，后面的都不要跑。回复里带上 ACK-STOP。";
const PROMPT = "你是一个测试助手，按用户的话做，回复尽量短。用户在你干活时发来的新消息要立刻照做。";

interface Rig {
  driver: Driver;
  events: DriverEvent[];
  sessionId: number;
  dir: string;
}

function rig(vendor: AgentVendor): Rig {
  const dir = mkdtempSync(join(tmpdir(), `agent-hub-smoke-midturn-${vendor}-`));
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, PROMPT);
  const store = new MemorySessionStore();
  const row: AgentSessionRow = {
    id: 1,
    role: "pm",
    conversationId: 1,
    pmId: null,
    workerId: null,
    vendor,
    vendorSessionId: randomUUID(),
    cwd,
    addDirs: [],
    generation: 1,
    model: vendor === "codex" ? CODEX_MODEL : MODEL,
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
  const common = { sessionLogsDir: join(dir, "state", "logs", "sessions"), store, prepareLaunch: async () => ({ promptFile, env: {}, fingerprint: "" }), log: () => {} };
  const driver: Driver =
    vendor === "codex" ? createCodexDriver({ ...common, codexPath: CODEX, stateDir: join(dir, "state") }) : createClaudeDriver({ ...common, claudePath: CLAUDE });
  const events: DriverEvent[] = [];
  driver.onEvent((_id, event) => events.push(event));
  return { driver, events, sessionId: 1, dir };
}

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const of = <T extends DriverEvent["type"]>(r: Rig, type: T) => r.events.filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);
/** agent 发起的跑 sleep 的命令（claude 的 Bash、codex 的 commandExecution）。 */
const sleepTools = (r: Rig) => of(r, "agent.tool").filter((e) => JSON.stringify(e.input).includes("sleep 8"));

/** 发任务，等第一条 sleep 命令开始跑，再发“停下”。 */
async function sendStopWhileRunning(r: Rig): Promise<void> {
  await r.driver.send(r.sessionId, user(1, TASK));
  await waitUntil("第一条 sleep 命令开始", () => sleepTools(r)[0], TURN_MS);
  await sleep(1_000);
  const result = await r.driver.send(r.sessionId, user(2, STOP));
  expect(result.kind === "written" && result.midTurn === true, `“停下”没有中途送达：${JSON.stringify(result)}`);
}

async function closeRig(r: Rig, keep: boolean): Promise<void> {
  await r.driver.shutdown();
  if (!keep) rmSync(r.dir, { recursive: true, force: true });
}

async function runVendor(outcomes: Outcome[], only: (name: string) => boolean, name: string, vendor: AgentVendor): Promise<void> {
  if (only(`${name}a`)) {
    const r = rig(vendor);
    const ok = await scenario(outcomes, `${name}a ${vendor} 跑 sleep 8 时用户说“停下”：中途送达，命令跑完就读到，不再跑后面的`, async () => {
      await sendStopWhileRunning(r);
      const toolsAtSend = sleepTools(r).length;
      await waitUntil("“停下”所在那一轮结束", () => of(r, "turn.ended").find((e) => e.messageIds.includes(2)), TURN_MS);
      const processing = r.events.findIndex((e) => e.type === "message.processing" && e.messageIds.includes(2));
      expect(processing >= 0, "“停下”没出处理中");
      // 下一步就看到：被取走时还没开始第三条命令
      const toolsAtTaken = r.events.slice(0, processing).filter((e) => e.type === "agent.tool" && JSON.stringify(e.input).includes("sleep 8")).length;
      expect(toolsAtTaken <= toolsAtSend + 1, `“停下”被取走前又跑了 ${toolsAtTaken - toolsAtSend} 条命令`);
      const ended = of(r, "turn.ended");
      const texts = of(r, "agent.text").map((e) => e.text).join("\n");
      expect(texts.includes("ACK-STOP"), `回复里没有 ACK-STOP：${texts.slice(-300)}`);
      expect(!texts.includes("THREE"), "停下之后还跑了第三条");
      return `中途送达；第 ${toolsAtTaken} 条命令跑完被取走；一共 ${sleepTools(r).length} 条命令、${ended.length} 个 turn.ended（${ended.map((e) => `[${e.messageIds.join(",")}]`).join(" ")}）`;
    });
    await closeRig(r, !ok);
  }
  if (only(`${name}b`)) {
    const r = rig(vendor);
    const ok = await scenario(outcomes, `${name}b ${vendor} 写进去还没读到就点停止：标已取消，停止后不再接着跑`, async () => {
      await sendStopWhileRunning(r);
      await r.driver.interrupt(r.sessionId);
      await waitUntil(
        "停止收尾",
        () => of(r, "message.cancelled")[0] ?? of(r, "message.processing").find((e) => e.messageIds.includes(2)),
        TURN_MS,
      );
      const cancelled = of(r, "message.cancelled");
      expect(cancelled.some((e) => e.messageIds.includes(2) && e.reason === "stop"), `“停下”没标已取消：${JSON.stringify(r.events.map((e) => e.type))}`);
      // claude 的回执（取消）比被打断那一轮的 result 先到：等第一条那一轮收尾了再开始数
      await waitUntil("被打断那一轮收尾", () => of(r, "turn.ended").find((e) => e.messageIds.includes(1)) ?? of(r, "session.exited")[0], TURN_MS);
      const endedBefore = of(r, "turn.ended").length;
      await sleep(8_000);
      expect(!of(r, "message.processing").some((e) => e.messageIds.includes(2)), "已取消的那条后来又被处理了");
      expect(of(r, "turn.ended").length === endedBefore, "停止后它自己又跑了一轮");
      const first = of(r, "turn.ended").find((e) => e.messageIds.includes(1));
      return `已取消 [${cancelled.flatMap((e) => e.messageIds).join(",")}]；第一条那一轮 interrupted=${first?.interrupted}；停止后 8 秒没有新的一轮`;
    });
    await closeRig(r, !ok);
  }
}

export async function runMidTurn(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  await runVendor(outcomes, only, "S27", "claude");
  await runVendor(outcomes, only, "S28", "codex");
}
