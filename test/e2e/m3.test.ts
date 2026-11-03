// M3 端到端（m3-plan 第 3 节测试表 W5）：真守护进程 + 假 claude + 临时 git 仓库。
// 假 claude 按会话选剧本（sessions 里 role: "pm" / "worker"），剧本里的 bash 步骤真的跑 run/bin/hub 和 git。
// 派活到汇报（worktree、主文件夹两种）、越权、打回、收工后令牌作废、连派 10 个、建 worktree 失败、
// 重启（worktree 还没建好、Worker 正在跑）、关机不发“这一轮没做完”、Worker 的对话能翻页、能停。
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_PATHS,
  HUB_COMMAND,
  REPORT_END,
  REPORT_START,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  workerBranchName,
  workerEventOf,
  type MessagesPage,
  type StateSnapshot,
  type WorkerMessageMeta,
} from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import type { FakeScript, FakeTurn } from "../fake-claude/fake-claude.ts";
import { Client, isAlive, makeEnv, messagesOf, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

/** 命令名（names.ts）：改名只改那一处，剧本和断言跟着变。 */
const hub = HUB_COMMAND;

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

// ---- 剧本 ----

const say = (text: string): FakeTurn => ({ steps: [{ text }] });
const report = (summary: string, status = "做完了") =>
  `${summary}。\n\n${REPORT_START}\n状态: ${status}\n摘要: ${summary}\n提交: 无\n测试: 无\n问题: 无\n${REPORT_END}`;
/** 项目经理在 shell 里派活（任务说明走 heredoc，和提示词里教的写法一样）。 */
const startCmd = (title: string, task: string, flags = "") => `${hub} worker start --title "${title}"${flags} --stdin <<'EOF'\n${task}\nEOF`;
/** 在 worktree 里提交（不依赖机器上的 git 用户配置）。 */
const commit = (message: string) => `git -c user.name=worker -c user.email=worker@example.com commit -qam "${message}"`;

/** 项目经理和 Worker 各用各的剧本；每个会话从自己的第 0 轮数起。 */
function scripts(pm: FakeScript, worker: FakeScript): FakeScript {
  return { sessions: [{ role: "pm", script: pm }, { role: "worker", script: worker }] };
}

// ---- 起停、查东西 ----

async function boot() {
  const daemon = await env.start();
  const client = await Client.login(daemon);
  return { daemon, client };
}

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

const real = (path: string) => realpathSync.native(path);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

/** 临时目录里的文件夹（真实路径）。 */
function folder(name: string): string {
  const dir = join(env.dir, "code", name);
  mkdirSync(dir, { recursive: true });
  return real(dir);
}

/** 有一次提交的 git 仓库，README.md 一行。 */
function repo(name: string): string {
  const dir = folder(name);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** 带主文件夹的项目经理。 */
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

type WorkerRow = { id: number; worker_conversation_id: number; status: string; workspace: string; branch: string | null; worktree_path: string | null };
const workerRows = () => query<WorkerRow>("SELECT * FROM workers ORDER BY id");

/** 项目经理对话里那几行（kind worker）。 */
function workerLines(state: StateSnapshot, pmConversationId: number): Array<WorkerMessageMeta & { text: string }> {
  return messagesOf(state, pmConversationId).flatMap((m) => {
    const meta = workerEventOf(m);
    return meta === null ? [] : [{ ...meta, text: m.text }];
  });
}

/** 等那几行里出现 n 行某个事件。 */
function waitLines(client: Client, pmConversationId: number, event: WorkerMessageMeta["event"], n = 1, timeoutMs = 15_000) {
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

/** 某个会话起过的假 claude（按启动先后）：提示词文件在 launch/<会话编号>/ 下。 */
function procsOf(sessionId: number) {
  return env.argvs().filter((a) => basename(dirname(argValue(a.argv, "--append-system-prompt-file") ?? "")) === String(sessionId));
}

function sessionOf(state: StateSnapshot, conversationId: number) {
  return state.sessions.find((s) => s.conversationId === conversationId)!;
}

/** 用 hub.sock 直接发一个请求，返回状态码。 */
function rawHubStatus(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(env.home, "run", "hub.sock"),
        method: "POST",
        path: "/v1/status",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": 2 },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

const tokenOf = (pid: number) => env.envs().find((e) => e.pid === pid)!.env.HUB_TOKEN!;

// 每条要起一两次真守护进程、跑好几个假 claude 和真 git
describe("M3 端到端：Worker", { timeout: 40_000 }, () => {
  it("整条路（worktree）：派活 → 汇报 → 打回 → 再汇报 → 收工；Worker 越权被拒；收工后令牌 401", async () => {
    env = makeEnv();
    const dir = repo("foo");
    const gate = join(env.dir, "gate-end");
    env.setScript(
      scripts(
        {
          turns: [
            { steps: [{ bash: startCmd("加 hello", "在 README.md 末尾加一行 hello，提交") }, { text: "派出去了" }] },
            { steps: [{ bash: `${hub} worker send 1 --stdin <<'EOF'\n把 hello 改成 hi\nEOF` }, { text: "打回了" }] },
            // 先等测试看完 Worker 还活着，再收工
            { steps: [{ waitFile: gate }, { bash: `${hub} worker end 1` }, { text: "收工了" }] },
          ],
          defaultTurn: say("收到"),
        },
        {
          turns: [
            {
              steps: [
                { bash: `${hub} persona edit --reason 试试 --stdin <<'EOF'\n我想改\nEOF` },
                { bash: `${hub} status` },
                { bash: `printf 'hello\\n' >> README.md && ${commit("hello")}` },
                { text: report("加好了") },
              ],
            },
            { steps: [{ bash: `printf '# demo\\nhi\\n' > README.md && ${commit("hi")}` }, { text: report("改成 hi 了") }] },
          ],
          defaultTurn: say(report("没事做")),
        },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await waitForStatus(client, await client.post(pm.conversationId, "派个 Worker 在 README 末尾加一行 hello"), "replied");

    // 第一轮汇报回来
    await waitLines(client, pm.conversationId, "report", 1);
    const [worker] = workerRows();
    const worktree = join(env.home, "worktrees", String(pm.projectId), "1");
    expect(worker).toMatchObject({ id: 1, workspace: "worktree", branch: workerBranchName(1, "加 hello"), worktree_path: real(worktree), status: "open" });
    const s1 = await client.state();
    const workerSession = sessionOf(s1, worker!.worker_conversation_id);
    const [proc] = procsOf(workerSession.sessionId);
    expect(proc!.cwd).toBe(real(worktree));
    // 越权：退出码 1、forbidden；hub status 能用
    const runs = env.bashRuns().filter((r) => r.pid === proc!.pid);
    expect(runs[0]).toMatchObject({ exitCode: 1 });
    expect(runs[0]!.output).toContain(`Worker 只能用 ${hub} status`);
    expect(runs[1]).toMatchObject({ exitCode: 0 });
    expect(runs[1]!.output).toContain("你是 Worker #1“加 hello”");
    expect(runs[2]).toMatchObject({ exitCode: 0 });
    // 前三条是派活和 Worker 这一轮敲的；之后项目经理收到汇报还会打回
    expect(query<{ command: string; ok: number; error_code: string | null }>("SELECT command, ok, error_code FROM hub_calls ORDER BY id").slice(0, 3)).toEqual([
      { command: "worker.start", ok: 1, error_code: null },
      { command: "persona.edit", ok: 0, error_code: "forbidden" },
      { command: "status", ok: 1, error_code: null },
    ]);

    // 打回以后同一个 Worker 接着改，再来一行汇报
    await waitLines(client, pm.conversationId, "report", 2);
    const s2 = await client.state();
    expect(workerLines(s2, pm.conversationId).map((l) => [l.event, l.status, l.summary])).toEqual([
      ["started", null, null],
      ["report", "done", "加好了"],
      ["report", "done", "改成 hi 了"],
    ]);
    expect(workerLines(s2, pm.conversationId)[0]!.text).toBe("Worker · 加 hello · 已派出");
    // 项目经理收到了两份汇报原文
    const delivered = await waitUntil("pm got both reports", () => {
      const texts = env.stdinTexts().filter((t) => t.includes("【Worker #1 · 加 hello 的汇报】"));
      return texts.length === 2 ? texts : undefined;
    });
    expect(delivered[0]).toContain(report("加好了"));
    // 只有一个 Worker 会话；任务说明和打回都进了它（同一个 Claude 会话，另起进程的话是 --resume）
    expect(s2.sessions.filter((s) => s.conversationId === worker!.worker_conversation_id)).toHaveLength(1);
    const workerProcs = procsOf(workerSession.sessionId);
    const vendor = argValue(workerProcs[0]!.argv, "--session-id");
    for (const p of workerProcs.slice(1)) expect(argValue(p.argv, "--resume")).toBe(vendor);
    const toWorker = workerProcs.flatMap((p) => env.stdinTextsOf(p.pid));
    expect(toWorker.at(0)).toContain("在 README.md 末尾加一行 hello");
    expect(toWorker.at(-1)).toContain("把 hello 改成 hi");
    // Worker 的对话：项目经理的两句（sender pm）、它的回复和操作
    const conversation = messagesOf(s2, worker!.worker_conversation_id);
    expect(conversation.filter((m) => m.sender === "pm").map((m) => m.status)).toEqual(["replied", "replied"]);
    expect(conversation.some((m) => m.sender === "agent" && m.kind === "tool")).toBe(true);
    // 分支上有两次提交，主文件夹没动
    expect(git(dir, "log", "--format=%s", worker!.branch!)).toBe("hi\nhello\ninit");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# demo\n");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("# demo\nhi\n");
    // 项目经理的会话带上了 worktrees/<项目编号>/（真实路径）
    const pmProc = procsOf(sessionOf(s2, pm.conversationId).sessionId).at(-1)!;
    expect(pmProc.argv.flatMap((a, i) => (pmProc.argv[i - 1] === "--add-dir" ? [a] : []))).toEqual([real(join(env.home, "worktrees", String(pm.projectId)))]);

    // 收工：Worker 会话 ended、令牌 401、会话里一行“已收工”
    const workerPid = workerProcs.at(-1)!.pid;
    const token = tokenOf(workerPid);
    expect(await rawHubStatus(token)).toBe(200);
    writeFileSync(gate, "");
    await waitLines(client, pm.conversationId, "ended", 1);
    await waitUntil("worker session ended", async () => (sessionOf(await client.state(), worker!.worker_conversation_id).status === "ended" ? true : undefined));
    await waitUntil("worker claude exited", () => (isAlive(workerPid) ? undefined : true));
    expect(await rawHubStatus(token)).toBe(401);
    expect(workerRows()[0]!.status).toBe("ended");
    // worktree 和分支还在（由项目经理合并后自己删）
    expect(existsSync(worktree)).toBe(true);
    // 收工之后动作都做完（机器忙时有的还在 1 秒的复查等待里，等一下再看）
    await waitUntil("all actions done", () => (query("SELECT 1 FROM actions WHERE status != 'done'").length === 0 ? true : undefined));
    await terminate(daemon);
  });

  it("不是 git 仓库：照样能派，Worker 在主文件夹里干；--no-worktree 在仓库里也一样", async () => {
    env = makeEnv();
    const plain = folder("plain");
    const gitDir = repo("withgit");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: startCmd("写笔记", "写一个 notes.txt") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: { steps: [{ bash: "printf 'note\\n' > notes.txt" }, { text: report("写好了") }] } },
      ),
    );
    const { daemon, client } = await boot();
    const a = await pmWithProject(client, plain);
    await client.post(a.conversationId, "派个 Worker 写笔记");
    await waitLines(client, a.conversationId, "report", 1);
    const [first] = workerRows();
    expect(first).toMatchObject({ workspace: "main", branch: null, worktree_path: null });
    const s = await client.state();
    const [proc] = procsOf(sessionOf(s, first!.worker_conversation_id).sessionId);
    expect(proc!.cwd).toBe(plain);
    expect(readFileSync(join(plain, "notes.txt"), "utf8")).toBe("note\n");
    expect(query("SELECT * FROM actions WHERE type = 'worktree.create'")).toEqual([]);

    // 第二个项目经理：主文件夹是仓库，但派活时说 --no-worktree
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: startCmd("写笔记", "写一个 notes.txt", " --no-worktree") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { defaultTurn: { steps: [{ bash: "printf 'note\\n' > notes.txt" }, { text: report("写好了") }] } },
      ),
    );
    const b = await client.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯", folder: gitDir });
    await client.post(b.conversationId, "派个 Worker 写笔记，就在主文件夹里");
    await waitLines(client, b.conversationId, "report", 1);
    const second = workerRows()[1]!;
    expect(second).toMatchObject({ workspace: "main", worktree_path: null });
    const [proc2] = procsOf(sessionOf(await client.state(), second.worker_conversation_id).sessionId);
    expect(proc2!.cwd).toBe(gitDir);
    expect(readFileSync(join(gitDir, "notes.txt"), "utf8")).toBe("note\n");
    await terminate(daemon);
  });

  it("连派 10 个：都成功，各在各的 worktree 里，10 行汇报", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("many");
    const loop = `for i in 1 2 3 4 5 6 7 8 9 10; do\n${hub} worker start --title "活 $i" --stdin <<EOF || exit 1\n做第 $i 件事\nEOF\ndone`;
    env.setScript(scripts({ turns: [{ steps: [{ bash: loop }, { text: "十个都派了" }] }], defaultTurn: say("收到") }, { defaultTurn: say(report("做好了")) }));
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派十个 Worker");
    await waitLines(client, pm.conversationId, "report", 10, 45_000);
    const [run] = env.bashRuns();
    expect(run).toMatchObject({ exitCode: 0 });
    const rows = workerRows();
    expect(rows.map((r) => [r.id, r.workspace, r.status])).toEqual(Array.from({ length: 10 }, (_, i) => [i + 1, "worktree", "open"]));
    const s = await client.state();
    const cwds = rows.map((r) => procsOf(sessionOf(s, r.worker_conversation_id).sessionId)[0]!.cwd);
    expect(cwds).toEqual(rows.map((r) => r.worktree_path));
    expect(new Set(cwds).size).toBe(10);
    // git 里也是 10 个 worktree（加上主文件夹自己）
    expect(git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(11);
    expect(workerLines(s, pm.conversationId).filter((l) => l.event === "worktree_failed")).toEqual([]);
    await terminate(daemon);
  });

  it("建 worktree 失败（分支名被占了）：重试 3 次后项目经理收到一行，Worker 标 ended，没起 Worker 会话", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("taken");
    git(dir, "branch", workerBranchName(1, "修 X"));
    env.setScript(scripts({ turns: [{ steps: [{ bash: startCmd("修 X", "修一下 X") }, { text: "派了" }] }], defaultTurn: say("收到，我看看") }, { defaultTurn: say(report("不该跑")) }));
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派个 Worker 修 X");
    const [line] = await waitLines(client, pm.conversationId, "worktree_failed", 1, 40_000);
    expect(line!.text).toContain("建 worktree 失败");
    expect(line!.summary).toContain("已经存在");
    // 原因交给了项目经理
    await waitUntil("pm got the failure", () => (env.stdinTexts().some((t) => t.includes("【Worker #1 · 修 X 的汇报】") && t.includes("建 worktree 失败")) ? true : undefined));
    expect(workerRows()[0]!.status).toBe("ended");
    expect(query<{ attempts: number; status: string }>("SELECT attempts, status FROM actions WHERE type = 'worktree.create'")).toEqual([{ attempts: 3, status: "failed" }]);
    const s = await client.state();
    expect(procsOf(sessionOf(s, workerRows()[0]!.worker_conversation_id).sessionId)).toEqual([]);
    await terminate(daemon);
  });

  it("重启：worktree 还没建好就关机，再启动后接着建，Worker 照常开工、汇报", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("later");
    const branch = workerBranchName(1, "修 X");
    // 第一次建会失败（分支被占），关机时动作还在等重试
    git(dir, "branch", branch);
    env.setScript(scripts({ turns: [{ steps: [{ bash: startCmd("修 X", "修一下 X") }, { text: "派了" }] }], defaultTurn: say("收到") }, { defaultTurn: say(report("修好了")) }));
    const first = await boot();
    const pm = await pmWithProject(first.client, dir);
    await first.client.post(pm.conversationId, "派个 Worker 修 X");
    await waitUntil("first worktree attempt failed", () =>
      query<{ attempts: number }>("SELECT attempts FROM actions WHERE type = 'worktree.create' AND status = 'pending'")[0]?.attempts === 1 ? true : undefined,
    );
    expect(await terminate(first.daemon)).toEqual({ code: 0, signal: null });
    git(dir, "branch", "-D", branch);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await waitLines(client, pm.conversationId, "report", 1, 30_000);
    const [worker] = workerRows();
    expect(worker).toMatchObject({ status: "open", workspace: "worktree" });
    const s = await client.state();
    expect(procsOf(sessionOf(s, worker!.worker_conversation_id).sessionId).map((p) => p.cwd)).toEqual([worker!.worktree_path]);
    expect(workerLines(s, pm.conversationId).map((l) => l.event)).toEqual(["started", "report"]);
    await terminate(daemon);
  });

  it("重启：Worker 跑到一半关机，不发“这一轮没做完”；再启动后 --resume 接着做完，汇报照样回来（验收第 11 条）", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("slow");
    const never = join(env.dir, "never");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: startCmd("慢活", "慢慢做") }, { text: "派了" }] }], defaultTurn: say("收到") },
        // 第 0 轮做到一半卡住（关机打断）；重启后的那一轮做完
        { turns: [{ steps: [{ bash: "printf 'half\\n' > half.txt" }, { waitFile: never }, { text: report("不该出现") }] }], defaultTurn: say(report("接着做完了")) },
      ),
    );
    const first = await boot();
    const pm = await pmWithProject(first.client, dir);
    await first.client.post(pm.conversationId, "派个慢的 Worker");
    const worker = await waitUntil("worker running", () => {
      const [row] = workerRows();
      if (row?.worktree_path == null || !existsSync(join(row.worktree_path, "half.txt"))) return undefined;
      return row;
    });
    const task = query<{ id: number; status: string }>("SELECT id, status FROM messages WHERE conversation_id = ? AND sender = 'pm'", worker.worker_conversation_id)[0]!;
    expect(task.status).toBe("processing");
    const workerSessionId = sessionOf(await first.client.state(), worker.worker_conversation_id).sessionId;
    const [before] = procsOf(workerSessionId);
    expect(await terminate(first.daemon)).toEqual({ code: 0, signal: null });
    expect(isAlive(before!.pid)).toBe(false);
    // 关机打断的这一轮：不发那一行，任务说明还是处理中
    expect(query<{ n: number }>("SELECT count(*) AS n FROM messages WHERE kind = 'worker' AND meta LIKE '%turn_failed%'")).toEqual([{ n: 0 }]);
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", task.id)).toEqual([{ status: "processing" }]);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    const [line] = await waitLines(client, pm.conversationId, "report", 1, 20_000);
    expect(line!.summary).toBe("接着做完了");
    const s = await client.state();
    expect(workerLines(s, pm.conversationId).map((l) => l.event)).toEqual(["started", "report"]);
    const procs = procsOf(workerSessionId);
    expect(procs).toHaveLength(2);
    expect(argValue(procs[1]!.argv, "--resume")).toBe(argValue(procs[0]!.argv, "--session-id"));
    expect(procs[1]!.cwd).toBe(worker.worktree_path);
    // 恢复说明、重发说明和任务原文写在同一行：这一轮对应任务说明，汇报才回得来（不单独占一轮）
    expect(env.stdinTextsOf(procs[0]!.pid)).toEqual(["慢慢做"]);
    expect(env.stdinTextsOf(procs[1]!.pid)).toEqual([`${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n慢慢做`]);
    expect(existsSync(join(worker.worktree_path!, "half.txt"))).toBe(true);
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", task.id)).toEqual([{ status: "replied" }]);
    await terminate(daemon);
  });

  it("重启：项目经理处理 Worker 的汇报时关机，汇报不标已停止；再启动后重发给项目经理的同一个会话", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const dir = repo("pm-slow");
    const never = join(env.dir, "never");
    env.setScript(
      scripts(
        // 第 0 轮派活；第 1 轮处理汇报时卡住（关机打断）；重启后的那一轮照常回
        { turns: [{ steps: [{ bash: startCmd("快活", "做一件小事") }, { text: "派了" }] }, { steps: [{ text: "我看看汇报" }, { waitFile: never }, { text: "不该出现" }] }], defaultTurn: say("汇报收到，验收通过") },
        { defaultTurn: say(report("做好了")) },
      ),
    );
    const first = await boot();
    const pm = await pmWithProject(first.client, dir);
    await first.client.post(pm.conversationId, "派个 Worker");
    const reportId = await waitUntil("pm processing the report", async () => {
      const s = await first.client.state();
      const line = messagesOf(s, pm.conversationId).find((m) => workerEventOf(m)?.event === "report");
      return line?.status === "processing" && messagesOf(s, pm.conversationId).some((m) => m.text === "我看看汇报") ? line.id : undefined;
    });
    const pmSessionId = sessionOf(await first.client.state(), pm.conversationId).sessionId;
    expect(await terminate(first.daemon)).toEqual({ code: 0, signal: null });
    // 关机打断的这一轮：系统交给它的汇报还是处理中，不标已停止
    expect(query<{ status: string }>("SELECT status FROM messages WHERE id = ?", reportId)).toEqual([{ status: "processing" }]);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await waitForStatus(client, reportId, "replied", 20_000);
    const procs = procsOf(pmSessionId);
    const last = procs.at(-1)!;
    expect(argValue(last.argv, "--resume")).toBe(argValue(procs[0]!.argv, "--session-id"));
    // 汇报原文前面是恢复说明和重发说明，同一行
    const reportText = query<{ text: string }>("SELECT text FROM messages WHERE id = ?", reportId)[0]!.text;
    expect(reportText.startsWith("【Worker #1 · 快活 的汇报】")).toBe(true);
    expect(env.stdinTextsOf(last.pid)).toEqual([`${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n${reportText}`]);
    const s = await client.state();
    expect(messagesOf(s, pm.conversationId).filter((m) => m.sender === "agent" && m.kind === "text").map((m) => m.text)).toContain("汇报收到，验收通过");
    // 只有一行汇报，没有多出 turn_failed
    expect(workerLines(s, pm.conversationId).map((l) => l.event)).toEqual(["started", "report"]);
    await terminate(daemon);
  });

  it("Worker 的对话：快照里有、能往前翻页、能点停止，项目经理收到“被停止了”", async () => {
    env = makeEnv();
    const dir = repo("stop");
    const never = join(env.dir, "never");
    env.setScript(
      scripts(
        { turns: [{ steps: [{ bash: startCmd("长活", "做很久") }, { text: "派了" }] }], defaultTurn: say("收到") },
        { turns: [{ steps: [{ text: "开始了" }, { waitFile: never }, { text: report("不该出现") }] }], defaultTurn: say(report("又好了")) },
      ),
    );
    const { daemon, client } = await boot();
    const pm = await pmWithProject(client, dir);
    await client.post(pm.conversationId, "派个 Worker");
    const worker = await waitUntil("worker processing", async () => {
      const [row] = workerRows();
      if (row === undefined) return undefined;
      const s = await client.state();
      return messagesOf(s, row.worker_conversation_id).some((m) => m.sender === "agent" && m.text === "开始了") ? row : undefined;
    });
    const s = await client.state();
    // 快照里有 Worker 的对话（kind worker）和它的会话
    const snapshot = s.conversations.find((c) => c.conversation.id === worker.worker_conversation_id)!;
    expect(snapshot.conversation).toMatchObject({ kind: "worker", pmId: pm.pmId, projectId: pm.projectId });
    expect(snapshot.messages.map((m) => [m.sender, m.text])).toEqual([
      ["pm", "做很久"],
      ["agent", "开始了"],
    ]);
    expect(sessionOf(s, worker.worker_conversation_id)).toMatchObject({ pmId: null, status: "running" });
    // 往前翻页
    const lastId = snapshot.messages.at(-1)!.id;
    const res = await client.get(`${API_PATHS.messages(worker.worker_conversation_id)}?before=${lastId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as MessagesPage).messages.map((m) => m.text)).toEqual(["做很久"]);
    // 停止：Worker 的这一轮停了，项目经理收到一行“被停止了”
    expect(await client.stop(worker.worker_conversation_id)).toBe(202);
    const [line] = await waitLines(client, pm.conversationId, "turn_failed", 1);
    expect(line!.summary).toBe("被停止了");
    await waitUntil("pm got the stop", () => (env.stdinTexts().some((t) => t.includes("【Worker #1 · 长活 的汇报】") && t.includes("被停止了")) ? true : undefined));
    expect(query<{ status: string }>("SELECT status FROM messages WHERE conversation_id = ? AND sender = 'pm'", worker.worker_conversation_id)).toEqual([
      { status: "stopped" },
    ]);
    await terminate(daemon);
  });
});
