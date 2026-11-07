// Worker 有后台命令时这一轮不算汇报（ledger/workers.ts 的 awaitingBackground）：真账本 + 真 claude 驱动 + 网页服务，不起守护进程
// （和 S26 一样直接用驱动层：守护进程的 Worker 会话要包 sandbox-exec，在已经被 OS 沙箱包着的 Worker 里跑冒烟时套不上；
// 要整条路走守护进程的是 m3.ts 的 S21、S21b）。Worker 的提示词用真的（buildLaunchPrompt，含“长命令放后台”那条）。
// S33 任务里放一个后台 sleep 90：第一轮结束时还有后台命令，不出汇报、会话显示在等后台命令（网页同时开着，可以截图）；
//     跑完 claude 自己开一轮，项目经理那边只出一行汇报，带 BG-DONE。
// S33b 等后台命令时项目经理收工：后台的 sleep 跟着停，不出汇报。
// 数据都在临时目录；只按 PID 关自己起的进程。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerEventOf, type SessionId, type WorkerMessageMeta } from "../../src/shared/index.ts";
import { DEFAULT_STATIC_DIR } from "../../src/daemon/daemon.ts";
import { createClaudeDriver } from "../../src/daemon/driver/index.ts";
import { createLedger } from "../../src/daemon/ledger/index.ts";
import { buildLaunchPrompt } from "../../src/daemon/prompt.ts";
import { createSessionStore } from "../../src/daemon/store/index.ts";
import { openTestDb } from "../../src/daemon/store/test-helpers.ts";
import { startUiServer } from "../../src/daemon/ui-server/server.ts";
import { loginUrl } from "../../src/daemon/ui-server/token.ts";
import { sleep, waitUntil } from "../e2e/harness.ts";
import { CLAUDE, MODEL, TURN_MS, expect, removeOwnClaudeProjects, scenario, writeClaudeWrapper, type Outcome } from "./kit.ts";

const S33_SLEEP_SEC = 90;
const S33B_SLEEP_SEC = 94;

const task = (sec: number) =>
  `第一步必须真的调用 Bash 工具（不调用就算没做）运行 \`sleep ${sec} && echo BG-DONE\`，必须设 run_in_background 为 true（后台运行）。启动后不要等、不要轮询、不要读输出，立刻只回复一句“后台已启动”。` +
  "后台命令跑完你会收到完成通知，那时再回复一句“后台完成 BG-DONE”。这两句话都直接回复这几个字就行，不用别的内容，也不用写汇报格式。";

/** 起账本、驱动层、网页服务，派一个 Worker 跑 task，把任务说明写给它；fn 跑完收尾。 */
async function withWorker(sleepSec: number, fn: (w: {
  url: string;
  lines: () => WorkerMessageMeta[];
  activity: () => string | undefined;
  sleepPids: () => number[];
  end: () => Promise<void>;
  writtenToPm: () => string[];
}) => Promise<string>): Promise<string> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-wbg-")));
  const folder = join(dir, "work");
  mkdirSync(folder, { recursive: true });
  const db = openTestDb();
  const ledger = createLedger(db, { pmHomeRoot: join(dir, "pm-home"), dataHome: join(dir, "home"), worktreesDir: join(dir, "home", "worktrees") });
  const pm = ledger.createPm({ name: "小林", mode: "hands_on", persona: "", defaultModel: MODEL });
  ledger.hubCall(pm.sessionId, "project.create", { folder });
  const worker = ledger.hubCall(pm.sessionId, "worker.start", { title: "后台命令", task: task(sleepSec), noWorktree: true, model: MODEL }).data.worker;
  const sessionId = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id as SessionId;
  const store = createSessionStore(db);
  const launchDir = join(dir, "launch");
  mkdirSync(launchDir, { recursive: true });
  const driver = createClaudeDriver({
    claudePath: writeClaudeWrapper(dir, { claude: CLAUDE, persist: false }),
    store,
    prepareLaunch: async (row) => {
      const promptFile = join(launchDir, `${row.id}.md`);
      writeFileSync(promptFile, buildLaunchPrompt(ledger.getLaunchContext(row.id), row.cwd));
      return { promptFile, env: {}, fingerprint: "" };
    },
    log: (l) => console.log(`  [driver] ${l}`),
  });
  // 失败时打出来看：驱动层事件的类型（文字、工具名带上）
  const trace: string[] = [];
  driver.onEvent((id, event) => {
    trace.push(event.type === "agent.text" ? `text:${event.text.slice(0, 40)}` : event.type === "agent.tool" ? `tool:${event.name}` : event.type === "background.changed" ? `bg:${event.count}` : event.type);
    ledger.applyDriverEvent(id, event);
  });
  ledger.onStopRequested(({ sessionId: id }) => void driver.interrupt(id));
  const token = randomBytes(24).toString("hex");
  const ui = await startUiServer({ ledger, token, port: 0, staticDir: DEFAULT_STATIC_DIR, uploadsDir: join(dir, "uploads"), sentFilesDir: join(dir, "sent") });
  const seen = new Set<number>();
  const sleepPids = () => {
    // pgrep 不用 ps：在别的沙箱里（比如在 Worker 里跑）ps 可能不让用；没有匹配时 pgrep 退出码 1
    let out: number[] = [];
    try {
      out = execFileSync("pgrep", ["-f", `^sleep ${sleepSec}$`], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    } catch {
      out = [];
    }
    for (const pid of out) seen.add(pid);
    return out;
  };
  try {
    const taskMessage = db.get<{ id: number; text: string }>("SELECT id, text FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", worker.workerConversationId)!;
    await driver.send(sessionId, { messageIds: [taskMessage.id], source: "system", text: taskMessage.text });
    const pmConversation = pm.conversation.id;
    const pmTexts = () => db.all<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? AND kind = 'worker' ORDER BY id", pmConversation).map((r) => r.text);
    return await fn({
      url: `${loginUrl(ui.port, token)}`,
      lines: () =>
        db
          .all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND kind = 'worker' ORDER BY id", pmConversation)
          .flatMap((r) => {
            const meta = workerEventOf(ledger.getMessage(r.id)!);
            return meta === null ? [] : [meta];
          }),
      activity: () => ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity,
      sleepPids,
      end: async () => {
        ledger.hubCall(pm.sessionId, "worker.end", { workerId: worker.id });
        // 同 session.end 的处理函数
        await driver.end(sessionId);
      },
      writtenToPm: pmTexts,
    });
  } catch (error) {
    console.log(`  驱动层事件：${trace.join(" ")}`);
    throw error;
  } finally {
    await driver.shutdown();
    await ui.close();
    for (const pid of seen) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经没了
      }
    }
    db.close();
    removeOwnClaudeProjects(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

const finished = (lines: WorkerMessageMeta[]) => lines.filter((l) => l.event === "report" || l.event === "turn_failed");

export async function runWorkerBackground(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S33")) {
    await scenario(outcomes, `S33 Worker 放后台 sleep ${S33_SLEEP_SEC}：第一轮结束不汇报、显示在等后台命令，跑完只汇报一次`, () =>
      withWorker(S33_SLEEP_SEC, async (w) => {
        await waitUntil("Worker 在等后台命令", () => (w.activity() === "background" ? true : undefined), TURN_MS);
        const since = Date.now();
        console.log(`  S33 在等后台命令，网页：${w.url}`);
        while (Date.now() - since < (S33_SLEEP_SEC - 20) * 1000) {
          expect(finished(w.lines()).length === 0, `后台命令没跑完就汇报了：${JSON.stringify(w.lines())}`);
          expect(w.activity() === "background", `等后台命令时状态变成了 ${w.activity()}`);
          expect(w.sleepPids().length > 0, "后台 sleep 不在了");
          await sleep(5_000);
        }
        await waitUntil("汇报", () => (finished(w.lines()).length > 0 ? true : undefined), 20_000 + TURN_MS);
        await waitUntil("空闲", () => (w.activity() === "idle" ? true : undefined), TURN_MS);
        await sleep(10_000);
        const done = finished(w.lines());
        expect(done.length === 1 && done[0]!.event === "report" && /BG-DONE/.test(done[0]!.summary ?? ""), `应该只有一份带 BG-DONE 的汇报：${JSON.stringify(done)}`);
        const toPm = w.writtenToPm().filter((t) => t.includes("的汇报】"));
        expect(toPm.length === 1 && !toPm[0]!.includes("后台已启动"), `交给项目经理的汇报不对：${JSON.stringify(toPm)}`);
        return `等了约 ${Math.round((Date.now() - since) / 1000)} 秒：中途没有汇报、状态是在等后台命令；跑完只汇报一次“${done[0]!.summary}”`;
      }),
    );
  }
  if (only("S33b")) {
    await scenario(outcomes, `S33b 等后台命令时收工：后台 sleep ${S33B_SLEEP_SEC} 跟着停，不出汇报`, () =>
      withWorker(S33B_SLEEP_SEC, async (w) => {
        await waitUntil("Worker 在等后台命令", () => (w.activity() === "background" ? true : undefined), TURN_MS);
        const before = w.sleepPids();
        expect(before.length > 0, "没看到后台的 sleep 进程");
        await w.end();
        await waitUntil("后台 sleep 跟着停", () => (w.sleepPids().length === 0 ? true : undefined), 30_000);
        const events = w.lines().map((l) => l.event);
        expect(finished(w.lines()).length === 0, `收工后不该有汇报：${JSON.stringify(events)}`);
        return `收工后后台 sleep（pid ${before.join("、")}）停了，项目经理那边只有 ${events.join("、")}`;
      }),
    );
  }
}
