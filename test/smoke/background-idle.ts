// 后台任务不算闲着（docs/m0-report.md“后台任务事件”）：直接用驱动层 + 真 claude，空闲时间临时调短（驱动层的 idleCloseMs 选项，默认值不动）。
// S26 agent 起一个比空闲时间长的后台 `sleep`：claude 进程没被空闲关闭杀掉（pid 没变、sleep 跑完），跑完后 claude 自己开的那一轮能正常汇报，
//     汇报完再闲够 idleCloseMs 才关。
// S26b 对照：兜底上限压到最短（等于没有这个保护，行为和改之前一样），同样的活后台 sleep 被空闲关闭杀掉、拿不到结果——证明 S26 测得出差别。
// 数据都在临时目录；只按 PID 关自己起的进程。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow, type DriverEvent } from "../../src/shared/index.ts";
import { createClaudeDriver } from "../../src/daemon/driver/index.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { waitUntil } from "../e2e/harness.ts";
import { CLAUDE, MODEL, TURN_MS, expect, processTable, removeOwnClaudeProjects, scenario, writeClaudeWrapper, type Outcome } from "./kit.ts";

/** 空闲关闭时间（冒烟临时调短）；后台 sleep 要明显比它长。 */
const IDLE_MS = 6_000;
const SLEEP_SEC = 24;

const PROMPT =
  `用 Bash 工具运行 \`sleep ${SLEEP_SEC} && echo BG-DONE\`，必须设 run_in_background 为 true（后台运行）。启动后不要等、不要轮询、不要读输出，立刻只回复一句“后台已启动”。` +
  "后台命令跑完你会收到完成通知，那时再回复一句“后台完成 BG-DONE”。这两句话都直接回复这几个字就行，不用别的内容。";

interface Run {
  events: DriverEvent[];
  claudePids: Set<number>;
  sleepPids: Set<number>;
}

/** 起一个会话发 PROMPT，一直看到 session.exited 或超时；记下期间出现过的 claude、sleep 进程号。 */
async function run(holdMaxMs: number | undefined): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "ah-bg-"));
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "你是一个测试助手，按用户的话做，回复尽量短。");
  const store = new MemorySessionStore();
  const row: AgentSessionRow = {
    id: 1,
    role: "pm",
    conversationId: 1,
    pmId: null,
    workerId: null,
    vendor: "claude",
    vendorSessionId: randomUUID(),
    cwd,
    addDirs: [],
    generation: 1,
    model: MODEL,
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
  const driver = createClaudeDriver({
    // 单个 claude 进程跑完，不 --resume：不存会话记录
    claudePath: writeClaudeWrapper(dir, { claude: CLAUDE, persist: false }),
    stateDir: dir,
    store,
    prepareLaunch: async () => ({ promptFile, env: {}, fingerprint: "" }),
    idleCloseMs: IDLE_MS,
    ...(holdMaxMs === undefined ? {} : { backgroundHoldMaxMs: holdMaxMs }),
    log: () => {},
  });
  const result: Run = { events: [], claudePids: new Set(), sleepPids: new Set() };
  driver.onEvent((_id, event) => result.events.push(event));
  const sample = () => {
    const pid = store.get(1)?.pid;
    if (pid != null) {
      result.claudePids.add(pid);
      const table = processTable();
      for (const [p, info] of table) {
        if (info.command.trim() !== `sleep ${SLEEP_SEC}`) continue;
        for (let cur = info.ppid; cur > 1; cur = table.get(cur)?.ppid ?? 0) {
          if (cur === pid) {
            result.sleepPids.add(p);
            break;
          }
        }
      }
    }
  };
  const poll = setInterval(sample, 500);
  try {
    await driver.send(1, { messageIds: [1], source: "user", text: PROMPT });
    await waitUntil("session.exited", () => result.events.some((e) => e.type === "session.exited") || undefined, TURN_MS);
    return result;
  } finally {
    clearInterval(poll);
    await driver.shutdown();
    // 只按 PID 补一刀：我们看到过的 sleep 进程
    for (const pid of result.sleepPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经没了
      }
    }
    removeOwnClaudeProjects(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

const texts = (events: DriverEvent[]) => events.flatMap((e) => (e.type === "agent.text" ? [e.text] : []));
const exits = (events: DriverEvent[]) => events.flatMap((e) => (e.type === "session.exited" ? [e] : []));

export async function runBackgroundIdle(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S26")) {
    await scenario(outcomes, `S26 后台 sleep ${SLEEP_SEC} 秒比空闲时间（${IDLE_MS / 1000} 秒）长：不被空闲关闭杀掉，跑完 claude 自己开的一轮正常汇报`, async () => {
      const r = await run(undefined);
      const t = texts(r.events);
      expect(t.some((x) => x.includes("后台已启动")), `没有“后台已启动”：${JSON.stringify(t)}`);
      expect(t.some((x) => x.includes("BG-DONE")), `没有收到后台跑完那一轮的汇报：${JSON.stringify(t)}`);
      const ended = r.events.flatMap((e) => (e.type === "turn.ended" ? [e] : []));
      expect(ended.length === 2 && ended[1]!.messageIds.length === 0 && ended[1]!.ok, `第二轮不是 claude 自己开的、成功的一轮：${JSON.stringify(ended)}`);
      const exited = exits(r.events);
      expect(exited.length === 1 && exited[0]!.reason === "idle", `关闭的方式不对：${JSON.stringify(exited)}`);
      // 关闭发生在后台跑完、自己开的那一轮结束之后，并且又闲够了 idleCloseMs
      const wait = exited[0]!.at - ended[1]!.at;
      expect(wait >= IDLE_MS - 500, `自己开的那一轮结束后 ${wait} ms 就关了，没闲够 ${IDLE_MS} ms`);
      expect(r.claudePids.size === 1, `claude 进程换过：${[...r.claudePids]}`);
      return `claude ${[...r.claudePids]} 全程在，后台 sleep 跑完，自己开的一轮回了“${t.at(-1)}”，之后闲 ${(wait / 1000).toFixed(1)} 秒才关`;
    });
  }
  if (only("S26b")) {
    await scenario(outcomes, "S26b 对照：没有后台任务保护（兜底压到最短）时，后台 sleep 被空闲关闭杀掉，拿不到结果", async () => {
      const r = await run(1);
      const exited = exits(r.events);
      expect(exited.length === 1 && exited[0]!.reason === "idle", `没有被空闲关闭：${JSON.stringify(exited)}`);
      expect(!texts(r.events).some((x) => x.includes("BG-DONE")), "不该拿到后台跑完的汇报");
      return `空闲 ${IDLE_MS / 1000} 秒后 claude 被关（reason idle），后台 sleep 没跑完、没有第二轮汇报`;
    });
  }
}
