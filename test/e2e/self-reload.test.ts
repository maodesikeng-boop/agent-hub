// 热重启等全库空闲有上限（端到端）：真守护进程（外壳监管模式，上限调成几秒）+ 假 claude。
// 有一轮一直卡着（全库空闲永远不出现）时项目经理登记热重启：到上限守护进程照常以 reloadExitCode 退出；再起来后被打断的轮次自动重发、接着做完。
// - Worker 一轮卡着：要起 Worker 的 OS 沙箱，在已经包了 sandbox-exec 的 Worker 里不能嵌套，跳过（同 src/daemon/multi-vendor.test.ts）；
// - 项目经理处理系统消息（定时任务）时卡着：不用沙箱，哪里都能跑。
// 项目经理正在回用户的消息（重启后不会重发）：过了上限也不重启，等它回完再重启，用户的那条照常回完。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_DB_SHARED_ACCESS, HUB_COMMAND, REPORT_END, REPORT_START, RESEND_NOTE, RESTART_RECOVERY_NOTE, systemEventOf, workerEventOf } from "../../src/shared/index.ts";
import { DESKTOP_CONTRACT } from "../../src/daemon/entry.ts";
import { osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import type { FakeScript, FakeTurn } from "../fake-claude/fake-claude.ts";
import { Client, makeEnv, messagesOf, sleep, waitUntil, type E2eEnv } from "./harness.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";

const RELOAD_MAIN = fileURLToPath(new URL("./self-reload-daemon.ts", import.meta.url));
const DRAIN_MAX_MS = 4_000;
const hub = HUB_COMMAND;
const SUPERVISED_ENV = { [DESKTOP_CONTRACT.supervisedEnv]: "test", E2E_SELF_RELOAD_DRAIN_MAX_MS: String(DRAIN_MAX_MS) };

const canNestOsSandbox =
  process.platform === "darwin"
    ? sandboxAllowsNestedSandbox()
    : osSandboxAvailable();

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

const say = (text: string): FakeTurn => ({ steps: [{ text }] });
const report = (summary: string) => `${summary}。\n\n${REPORT_START}\n状态: 做完了\n摘要: ${summary}\n提交: 无\n测试: 无\n问题: 无\n${REPORT_END}`;
const startCmd = (title: string, task: string) => `${hub} worker start --title "${title}" --stdin <<'EOF'\n${task}\nEOF`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

function repo(name: string): string {
  const dir = join(env.dir, "code", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return realpathSync.native(dir);
}

function query<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return db.all<T>(sql, ...params);
  } finally {
    db.close();
  }
}

const argValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

describe("hot restart with the exclusive ledger lock", () => {
  it("after hub self-reload exits with reloadExitCode, the daemon the shell starts next takes the ledger and serves the same conversations", { timeout: 60_000 }, async () => {
    env = makeEnv();
    env.setScript({ turns: [{ steps: [{ bash: `${hub} self-reload` }, { text: "registered" }] }], defaultTurn: say("back after the restart") });
    const installed = { ...SUPERVISED_ENV, [ENV_DB_SHARED_ACCESS]: "0" };
    const first = await env.start({ main: RELOAD_MAIN, env: installed });
    const client = await Client.login(first);
    const { conversationId } = await client.createPm({ name: "Reload PM", mode: "manage_only", persona: "" });
    await client.post(conversationId, "restart the daemon");

    const exit = await first.exited;
    expect(exit.code).toBe(DESKTOP_CONTRACT.reloadExitCode);
    expect(env.bashRuns().map((run) => run.output)).toEqual([expect.stringContaining("已登记热重启")]);
    const restartedAt = Date.now();
    const second = await env.start({ main: RELOAD_MAIN, env: installed });
    const readyMs = Date.now() - restartedAt;
    const client2 = client.withPort(second.port);
    const asked = await client2.post(conversationId, "still there?");
    const replied = async () => messagesOf(await client2.state(), conversationId).find((m) => m.id === asked)?.status === "replied";
    await waitUntil("reply after the restart", async () => ((await replied()) ? true : undefined), 20_000);
    const texts = messagesOf(await client2.state(), conversationId).filter((m) => m.sender === "agent" && m.kind === "text").map((m) => m.text);
    expect(texts).toEqual(["registered", "back after the restart"]);
    console.log(
      `[self-reload e2e, exclusive lock] first daemon exited with ${exit.code}; second daemon ready ${readyMs} ms after that; replies ${JSON.stringify(texts)}; ` +
        `first daemon log: ${first.stderr().split("\n").filter((l) => l.includes("热重启")).join(" | ")}`,
    );
    expect(await second.terminate()).toEqual({ code: 0, signal: null });
  });
});

describe("热重启等全库空闲有上限", () => {
  it.skipIf(!canNestOsSandbox)("Worker 一轮一直在跑：登记后到上限照常重启（退出码 reloadExitCode）；重启后这一轮自动重发、做完、汇报回来", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("busy");
    const never = join(env.dir, "never");
    const pm: FakeScript = { turns: [{ steps: [{ bash: startCmd("一直忙", "慢慢做") }, { text: "派了" }] }], defaultTurn: say("收到") };
    const worker: FakeScript = {
      turns: [{ steps: [{ bash: "printf 'half\\n' > half.txt" }, { waitFile: never }, { text: report("不该出现") }] }],
      defaultTurn: say(report("接着做完了")),
    };
    env.setScript({ sessions: [{ role: "pm", script: pm }, { role: "worker", script: worker }] });

    const first = await env.start({ main: RELOAD_MAIN, env: SUPERVISED_ENV });
    const client = await Client.login(first);
    const { pmId, conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯", folder: dir });
    await client.post(conversationId, "派个一直忙的 Worker");
    const { workerConversationId, taskId, worktree } = await waitUntil(
      "worker turn running",
      () => {
        const [row] = query<{ worker_conversation_id: number; worktree_path: string | null }>("SELECT * FROM workers ORDER BY id");
        if (row?.worktree_path == null || !existsSync(join(row.worktree_path, "half.txt"))) return undefined;
        const [msg] = query<{ id: number; status: string }>("SELECT id, status FROM messages WHERE conversation_id = ? AND sender = 'pm'", row.worker_conversation_id);
        return msg?.status === "processing" ? { workerConversationId: row.worker_conversation_id, taskId: msg.id, worktree: row.worktree_path } : undefined;
      },
      20_000,
    );
    const pmSessionId = query<{ id: number }>("SELECT id FROM agent_sessions WHERE pm_id = ? AND role = 'pm'", pmId)[0]!.id;
    const pmPid = env.procsOf(pmSessionId)[0]!.pid;

    const reload = await env.runHub(pmPid, ["self-reload"]);
    expect(reload.code).toBe(0);
    expect(reload.stdout).toContain("已登记热重启");
    expect(reload.stdout).toMatch(/热重启：\d\d:\d\d:\d\d 开始等全库空闲，最晚 \d\d:\d\d:\d\d 起不再等 Worker 轮次和系统消息（重启后自动重发）；项目经理、总助正在回用户的那一轮等它回完再重启。现在还在忙：/);
    const status = await env.runHub(pmPid, ["status"]);
    expect(status.stdout).toMatch(/热重启：\d\d:\d\d:\d\d 开始等全库空闲，最晚 \d\d:\d\d:\d\d/);

    const exit = await first.exited;
    expect(exit.code).toBe(DESKTOP_CONTRACT.reloadExitCode);
    expect(first.stderr()).toContain("等全库空闲过了上限");
    // 被打断的 Worker 轮次留着“处理中”，等重启恢复重发
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", taskId)).toEqual([{ status: "processing" }]);

    // 外壳拉起新进程
    const second = await env.start();
    const client2 = client.withPort(second.port);
    const reportLine = await waitUntil(
      "report after reload",
      async () => messagesOf(await client2.state(), conversationId).map((m) => workerEventOf(m)).find((meta) => meta?.event === "report"),
      20_000,
    );
    expect(reportLine).toMatchObject({ summary: "接着做完了" });
    const workerSessionId = (await client2.state()).sessions.find((s) => s.conversationId === workerConversationId)!.sessionId;
    const procs = env.procsOf(workerSessionId);
    expect(procs).toHaveLength(2);
    expect(argValue(procs[1]!.argv, "--resume")).toBe(argValue(procs[0]!.argv, "--session-id"));
    expect(procs[1]!.cwd).toBe(worktree);
    const firstText = env.stdinTextsOf(procs[0]!.pid)[0]!;
    expect(env.stdinTextsOf(procs[1]!.pid)).toEqual([`${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n${firstText}`]);
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", taskId)).toEqual([{ status: "replied" }]);
    console.log(
      `[self-reload e2e] 退出码 ${exit.code}；日志：${first.stderr().split("\n").filter((l) => l.includes("热重启")).join(" | ")}；` +
        `重启后 Worker 会话 ${workerSessionId} 以 --resume 重发任务，汇报“${reportLine!.summary}”`,
    );
    await second.terminate();
  });

  it("到上限时项目经理正在回用户的消息：不重启，等它回完才重启，那条照常回完", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const release = join(env.dir, "release");
    // 用户让项目经理重启后台：项目经理登记热重启后接着干活，这一轮一直到测试放行才回完
    env.setScript({
      turns: [{ steps: [{ bash: `${hub} self-reload` }, { text: "登记了，接着回你" }, { waitFile: release }, { text: "回完了" }] }],
      defaultTurn: say("收到"),
    });
    const first = await env.start({ main: RELOAD_MAIN, env: SUPERVISED_ENV });
    const client = await Client.login(first);
    const { pmId, conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
    const asked = await client.post(conversationId, "代码合进去了，重启一下后台");
    const registered = await waitUntil("self-reload registered", () => env.bashRuns().find((r) => r.command === `${hub} self-reload`), 20_000);
    const registeredAt = Date.now();
    expect(registered.output).toContain("已登记热重启");

    await sleep(DRAIN_MAX_MS + 3_000);
    expect(first.child.exitCode).toBeNull();
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", asked)).toEqual([{ status: "processing" }]);
    const pmSessionId = query<{ id: number }>("SELECT id FROM agent_sessions WHERE pm_id = ? AND role = 'pm'", pmId)[0]!.id;
    const status = await env.runHub(env.procsOf(pmSessionId)[0]!.pid, ["status"]);
    expect(status.stdout).toContain("已过最晚时间");

    writeFileSync(release, "");
    const exit = await first.exited;
    const waitedMs = Date.now() - registeredAt;
    expect(exit.code).toBe(DESKTOP_CONTRACT.reloadExitCode);
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", asked)).toEqual([{ status: "replied" }]);

    const second = await env.start();
    const client2 = client.withPort(second.port);
    const texts = messagesOf(await client2.state(), conversationId).filter((m) => m.sender === "agent" && m.kind === "text").map((m) => m.text);
    expect(texts).toEqual(["登记了，接着回你", "回完了"]);
    console.log(
      `[self-reload e2e] 上限 ${DRAIN_MAX_MS} ms；登记后 ${DRAIN_MAX_MS + 3_000} ms 守护进程还在（项目经理在回用户）；hub status 末行：${status.stdout.trim().split("\n").at(-1)}；` +
        `放行后退出码 ${exit.code}（登记后共 ${waitedMs} ms）；用户那条 replied，回复 ${JSON.stringify(texts)}；` +
        `守护进程日志：${first.stderr().split("\n").filter((l) => l.includes("热重启")).join(" | ")}`,
    );
    await second.terminate();
  });

  it("项目经理处理定时任务（系统消息）时一直在跑：到上限照常重启；重启后这条重发给同一个会话、回完", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const never = join(env.dir, "never");
    env.setScript({
      turns: [
        { steps: [{ bash: `${hub} schedule add --name "日报" --every 15m --stdin <<'EOF'\n汇报进展\nEOF` }, { text: "建好了" }] },
        { steps: [{ text: "开始写日报" }, { waitFile: never }, { text: "不该出现" }] },
      ],
      defaultTurn: say("接着写完了日报"),
    });
    const setup = await env.start();
    const client = await Client.login(setup);
    const { pmId, conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
    const created = await client.post(conversationId, "每 15 分钟汇报一次");
    await waitUntil("schedule created", () => (query<{ status: string }>("SELECT status FROM messages WHERE id = ?", created)[0]?.status === "replied" ? true : undefined));
    expect(await setup.terminate()).toEqual({ code: 0, signal: null });
    // 停着的时候错过了一次：下次启动补跑，项目经理处理它时卡住
    query("UPDATE schedules SET next_run_at = ? WHERE id = 1", Date.now() - 60 * 60_000);

    const first = await env.start({ main: RELOAD_MAIN, env: SUPERVISED_ENV });
    const client1 = client.withPort(first.port);
    const run = await waitUntil(
      "schedule run processing",
      async () => messagesOf(await client1.state(), conversationId).find((m) => systemEventOf(m)?.event === "schedule.run" && m.status === "processing"),
      20_000,
    );
    const pmSessionId = query<{ id: number }>("SELECT id FROM agent_sessions WHERE pm_id = ? AND role = 'pm'", pmId)[0]!.id;
    const pmPid = env.procsOf(pmSessionId).at(-1)!.pid;
    const reload = await env.runHub(pmPid, ["self-reload"]);
    expect(reload.stdout).toMatch(/最晚 \d\d:\d\d:\d\d 起不再等 Worker 轮次和系统消息（重启后自动重发）；项目经理、总助正在回用户的那一轮等它回完再重启。现在还在忙：项目经理「小林」/);
    const status = await env.runHub(pmPid, ["status"]);
    expect(status.stdout).toMatch(/热重启：\d\d:\d\d:\d\d 开始等全库空闲，最晚 \d\d:\d\d:\d\d/);

    const exit = await first.exited;
    expect(exit.code).toBe(DESKTOP_CONTRACT.reloadExitCode);
    expect(first.stderr()).toContain("等全库空闲过了上限");
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", run.id)).toEqual([{ status: "processing" }]);

    const second = await env.start();
    const client2 = client.withPort(second.port);
    await waitUntil("schedule run replied", () => (query<{ status: string }>("SELECT status FROM messages WHERE id = ?", run.id)[0]?.status === "replied" ? true : undefined), 20_000);
    const procs = env.procsOf(pmSessionId);
    const last = procs.at(-1)!;
    expect(argValue(last.argv, "--resume")).toBe(argValue(procs[0]!.argv, "--session-id"));
    expect(env.stdinTextsOf(last.pid)).toEqual([`${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n${run.text}`]);
    expect(messagesOf(await client2.state(), conversationId).some((m) => m.sender === "agent" && m.text === "接着写完了日报")).toBe(true);
    console.log(
      `[self-reload e2e] 退出码 ${exit.code}；回执：${reload.stdout.trim()}；hub status 末行：${status.stdout.trim().split("\n").at(-1)}；` +
        `守护进程日志：${first.stderr().split("\n").filter((l) => l.includes("热重启")).join(" | ")}；` +
        `重启后项目经理会话 ${pmSessionId} 以 --resume 收到重发的定时任务，回复“接着写完了日报”`,
    );
    await second.terminate();
  });
});
