// worktree 准备命令端到端（方案测试表 32～39）：真守护进程 + 假 claude + 临时 git 仓库 + 真 shell。
// 项目经理的剧本用 hub project setup 配准备命令，再 hub worker start 派活；Worker 的剧本第一步看准备命令的产物在不在。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_COMMAND, REPORT_END, REPORT_START, workerEventOf, type StateSnapshot, type WorkerMessageMeta } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { SETUP_RECEIPT_NOTE } from "../../src/daemon/prompt.ts";
import type { FakeScript, FakeTurn } from "../fake-claude/fake-claude.ts";
import { Client, isAlive, makeEnv, messagesOf, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

const hub = HUB_COMMAND;

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

const say = (text: string): FakeTurn => ({ steps: [{ text }] });
const report = (summary: string) => `${summary}。\n\n${REPORT_START}\n状态: 做完了\n摘要: ${summary}\n提交: 无\n测试: 无\n问题: 无\n${REPORT_END}`;
const setupCmd = (command: string) => `${hub} project setup --stdin <<'EOF'\n${command}\nEOF`;
const startCmd = (title: string, task: string, flags = "") => `${hub} worker start --title "${title}"${flags} --stdin <<'EOF'\n${task}\nEOF`;
const scripts = (pm: FakeScript, worker: FakeScript): FakeScript => ({ sessions: [{ role: "pm", script: pm }, { role: "worker", script: worker }] });

const real = (path: string) => realpathSync.native(path);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

function repo(name: string): string {
  const dir = join(env.dir, "code", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return real(dir);
}

async function boot() {
  const daemon = await env.start();
  const client = await Client.login(daemon);
  return { daemon, client };
}

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

async function pmWithProject(client: Client, dir: string) {
  const { pmId, conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯", folder: dir });
  const project = (await client.state()).projects.find((p) => p.pmId === pmId)!;
  return { pmId, conversationId, projectId: project.id };
}

function query<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return db.all<T>(sql, ...params);
  } finally {
    db.close();
  }
}

type WorkerRow = { id: number; worker_conversation_id: number; status: string; worktree_path: string | null };
const workerRows = () => query<WorkerRow>("SELECT * FROM workers ORDER BY id");

function workerLines(state: StateSnapshot, pmConversationId: number): WorkerMessageMeta[] {
  return messagesOf(state, pmConversationId).flatMap((m) => {
    const meta = workerEventOf(m);
    return meta === null ? [] : [meta];
  });
}

function waitLines(client: Client, pmConversationId: number, event: WorkerMessageMeta["event"], n = 1, timeoutMs = 20_000) {
  return waitUntil(
    `${n} 行 ${event}`,
    async () => {
      const lines = workerLines(await client.state(), pmConversationId).filter((l) => l.event === event);
      return lines.length >= n ? lines : undefined;
    },
    timeoutMs,
  );
}

const argValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
function procsOf(sessionId: number) {
  return env.argvs().filter((a) => basename(dirname(argValue(a.argv, "--append-system-prompt-file") ?? "")) === String(sessionId));
}
const sessionOf = (state: StateSnapshot, conversationId: number) => state.sessions.find((s) => s.conversationId === conversationId)!;
const workerSessionOf = async (client: Client, worker: WorkerRow) => sessionOf(await client.state(), worker.worker_conversation_id);
/** 某个 Worker 起过的假 claude 第一次收到的话。 */
const firstTextOf = async (client: Client, worker: WorkerRow) => env.stdinTextsOf(procsOf((await workerSessionOf(client, worker)).sessionId)[0]!.pid)[0];
const setupLog = (workerId: number) => join(env.home, "state", "logs", "setup", `worker-${workerId}.log`);

/** 等某个文件出现，读出里面的 pid。 */
const waitPid = (path: string) => waitUntil(`pid in ${path}`, () => (existsSync(path) && readFileSync(path, "utf8").trim() !== "" ? Number(readFileSync(path, "utf8").trim()) : undefined), 15_000);

describe("worktree 准备命令端到端", { timeout: 60_000 }, () => {
  it("32 没配准备命令：和以前一样，Worker 收到的就是任务原文，不写日志", async () => {
    env = makeEnv();
    const dir = repo("plain");
    env.setScript(scripts({ turns: [{ steps: [{ bash: startCmd("修 X", "把 X 修好") }, { text: "派了" }] }], defaultTurn: say("收到") }, { defaultTurn: say(report("好了")) }));
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派活");
    await waitLines(client, pm.conversationId, "report");
    const [worker] = workerRows();
    expect(await firstTextOf(client, worker!)).toBe("把 X 修好");
    expect(env.bashRuns()[0]!.output).not.toContain(SETUP_RECEIPT_NOTE);
    expect(existsSync(setupLog(1))).toBe(false);
    await terminate(daemon);
  });

  it("33 配了 touch ready：Worker 起来时 ready 已经在 worktree 里，任务前面一行“已经跑过”，日志里有输出；回执有那一句", async () => {
    env = makeEnv();
    const dir = repo("ok");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: setupCmd('touch ready && echo "prepared in $AGENT_HUB_WORKTREE_PATH from $AGENT_HUB_ROOT_PATH"') }, { bash: startCmd("修 X", "把 X 修好") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: { steps: [{ bash: "test -f ready" }, { text: report("好了") }] } },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派活");
    await waitLines(client, pm.conversationId, "report");
    const [setRun, startRun, readyRun] = env.bashRuns();
    expect(setRun).toMatchObject({ exitCode: 0 });
    expect(startRun!.output).toContain(SETUP_RECEIPT_NOTE);
    expect(readyRun).toMatchObject({ exitCode: 0 });
    const [worker] = workerRows();
    const text = await firstTextOf(client, worker!);
    expect(text).toMatch(/^【系统】已经在这个 worktree 里跑过项目的准备命令（用时 \d+ 秒，日志：.*worker-1\.log）。\n\n把 X 修好$/);
    const log = readFileSync(setupLog(1), "utf8");
    expect(log).toContain(`prepared in ${worker!.worktree_path} from ${dir}`);
    // worktree 里多了 ready，主文件夹没有
    expect(existsSync(join(worker!.worktree_path!, "ready"))).toBe(true);
    expect(existsSync(join(dir, "ready"))).toBe(false);
    await terminate(daemon);
  });

  it("34 准备命令失败（exit 2）：Worker 照常开工，第一条话里有退出码和输出", async () => {
    env = makeEnv();
    const dir = repo("fail");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: setupCmd("echo boom-lockfile >&2; exit 2") }, { bash: startCmd("修 X", "把 X 修好") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: say(report("自己装了依赖，好了")) },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派活");
    await waitLines(client, pm.conversationId, "report");
    const text = (await firstTextOf(client, workerRows()[0]!))!;
    expect(text).toContain("准备命令没成功（退出码 2");
    expect(text).toContain("boom-lockfile");
    expect(text.endsWith("下面是任务说明。\n\n把 X 修好")).toBe(true);
    await terminate(daemon);
  });

  it("35 --no-worktree：配了准备命令也不跑", async () => {
    env = makeEnv();
    const dir = repo("nowt");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: setupCmd("touch setup-ran") }, { bash: startCmd("修 X", "把 X 修好", " --no-worktree") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: say(report("好了")) },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派活");
    await waitLines(client, pm.conversationId, "report");
    expect(env.bashRuns()[1]!.output).not.toContain(SETUP_RECEIPT_NOTE);
    expect(await firstTextOf(client, workerRows()[0]!)).toBe("把 X 修好");
    expect(existsSync(join(dir, "setup-ran"))).toBe(false);
    expect(existsSync(setupLog(1))).toBe(false);
    await terminate(daemon);
  });

  it("36 准备中收工（hub worker end）：准备命令被结束，Worker 不开工；准备中时 hub worker list 写“准备中”", async () => {
    env = makeEnv();
    const dir = repo("end");
    const pidFile = join(env.dir, "setup.pid");
    env.setScript(
      scripts(
        {
          turns: [
            { steps: [{ bash: setupCmd(`echo $$ > '${pidFile}'; sleep 300`) }, { bash: startCmd("修 X", "把 X 修好") }, { text: "派了" }] },
            { steps: [{ bash: `${hub} worker list` }, { bash: `${hub} worker end 1` }, { text: "收工了" }] },
          ],
          defaultTurn: say("收到"),
        },
        { defaultTurn: say(report("不该开工")) },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await waitForStatus(client, await client.post(pm.conversationId, "派活"), "replied");
    const pid = await waitPid(pidFile);
    const [worker] = workerRows();
    await waitUntil("preparing", async () => ((await workerSessionOf(client, worker!)).activity === "preparing" ? true : undefined));
    await waitForStatus(client, await client.post(pm.conversationId, "不要了，收工"), "replied");
    expect(env.bashRuns()[2]!.output).toContain("#1 修 X · 准备中");
    await waitUntil("setup killed", () => (isAlive(pid) ? undefined : true));
    await waitUntil("idle", async () => ((await workerSessionOf(client, worker!)).activity === "idle" ? true : undefined));
    expect(procsOf((await workerSessionOf(client, worker!)).sessionId)).toEqual([]);
    expect(query<{ status: string }>("SELECT status FROM messages WHERE conversation_id = ? AND sender = 'pm'", worker!.worker_conversation_id)).toEqual([
      { status: "stopped" },
    ]);
    await terminate(daemon);
  });

  it("37、38 准备中关机：很快关完、准备命令没了；改好命令重启后从头再跑，Worker 开工", async () => {
    env = makeEnv();
    const dir = repo("restart");
    const pidFile = join(env.dir, "setup.pid");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: setupCmd(`echo $$ > '${pidFile}'; sleep 300`) }, { bash: startCmd("修 X", "把 X 修好") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: { steps: [{ bash: "test -f ready" }, { text: report("好了") }] } },
      ),
    );
    const first = await boot();
    const pm = await pmWithProject(first.client, dir);
    await first.client.post(pm.conversationId, "派活");
    const pid = await waitPid(pidFile);
    const started = Date.now();
    expect(await terminate(first.daemon)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(isAlive(pid)).toBe(false);
    const [worker] = workerRows();
    expect(query("SELECT base_commit FROM workers")).toEqual([{ base_commit: null }]);

    const db = openDatabase(join(env.home, "state", "hub.sqlite"));
    try {
      db.run("UPDATE projects SET setup_command = 'touch ready'");
    } finally {
      db.close();
    }
    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await waitLines(client, pm.conversationId, "report", 1, 30_000);
    expect(env.bashRuns().at(-1)).toMatchObject({ command: "test -f ready", exitCode: 0 });
    expect(await firstTextOf(client, worker!)).toMatch(/^【系统】已经在这个 worktree 里跑过/);
    // 日志里两段：被关机打断的那次和重启后的那次
    expect(readFileSync(setupLog(1), "utf8").match(/跑准备命令 ===/g)).toHaveLength(2);
    await terminate(daemon);
  });

  it("39 同时派 5 个（比执行器的并发数多）：准备命令都在跑时项目经理照常回话；放行后 5 个都开工", { timeout: 90_000 }, async () => {
    env = makeEnv();
    const dir = repo("many");
    const gate = join(env.dir, "gate");
    const loop = `for i in 1 2 3 4 5; do\n${hub} worker start --title "活 $i" --stdin <<EOF || exit 1\n做第 $i 件事\nEOF\ndone`;
    env.setScript(
      scripts(
        {
          turns: [{ steps: [{ bash: setupCmd(`touch started; while [ ! -f '${gate}' ]; do sleep 0.1; done; touch ready`) }, { bash: loop }, { text: "五个都派了" }] }],
          defaultTurn: say("收到"),
        },
        { defaultTurn: { steps: [{ bash: "test -f ready" }, { text: report("好了") }] } },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await waitForStatus(client, await client.post(pm.conversationId, "派五个"), "replied");
    await waitUntil("5 preparing", async () => {
      const s = await client.state();
      const rows = workerRows();
      return rows.length === 5 && rows.every((r) => sessionOf(s, r.worker_conversation_id).activity === "preparing") ? true : undefined;
    }, 30_000);
    expect(workerRows().every((r) => existsSync(join(r.worktree_path!, "started")))).toBe(true);
    // 5 个准备命令占着的话执行器就满了：项目经理这条要能照常回
    await waitForStatus(client, await client.post(pm.conversationId, "还在吗"), "replied", 15_000);
    writeFileSync(gate, "");
    await waitLines(client, pm.conversationId, "report", 5, 45_000);
    expect(env.bashRuns().filter((r) => r.command === "test -f ready").map((r) => r.exitCode)).toEqual([0, 0, 0, 0, 0]);
    await terminate(daemon);
  });
});
