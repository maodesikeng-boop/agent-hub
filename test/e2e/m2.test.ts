// M2 W6 端到端（m2-plan 第 4 节“W6 组装 + 端到端”的测试表，外加交接后旧令牌 401、重启后旧 hub.sock 被替换、hub 请求 15 秒超时）：
// 真守护进程 + 假 claude（剧本里的 bash 步骤真的跑 run/bin/hub），临时数据目录。
// 慢测（hub 请求 15 秒超时，要等 15 秒以上）默认不跑：AGENT_HUB_SLOW_TESTS=1 pnpm vitest run test/e2e/m2.test.ts
import { request } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELAUNCH_NOTE, SYSTEM_MESSAGE_PREFIX, type Message, type StateSnapshot } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import {
  Client,
  agentTexts,
  isAlive,
  makeEnv,
  messageById,
  messagesOf,
  waitForStatus,
  waitUntil,
  type E2eEnv,
  type RunningDaemon,
} from "./harness.ts";

const quick = (text = "好的") => ({ steps: [{ text }] });
const SLOW = process.env.AGENT_HUB_SLOW_TESTS === "1";

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function boot(options?: Parameters<E2eEnv["start"]>[0]) {
  const daemon = await env.start(options);
  const client = await Client.login(daemon);
  const state = await client.state();
  const privateId = state.conversations[0]!.conversation.id;
  const pmId = state.pms[0]!.id;
  return { daemon, client, state, privateId, pmId };
}

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

/** 临时目录里建一个文件夹，返回字面路径（macOS 上 /var 是 /private/var 的软链接，真实路径另算）。 */
function folder(name: string): string {
  const dir = join(env.dir, "code", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const real = (path: string) => realpathSync.native(path);
const hubSock = () => join(env.home, "run", "hub.sock");

function groupOf(state: StateSnapshot, projectName: string): number {
  const project = state.projects.find((p) => p.name === projectName);
  if (!project) throw new Error(`no project ${projectName}`);
  return project.conversationId;
}

/** 这个对话的会话，按代从小到大。 */
function sessionsOf(state: StateSnapshot, conversationId: number) {
  return state.sessions.filter((s) => s.conversationId === conversationId).sort((a, b) => a.generation - b.generation);
}

const argValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const promptOf = (argv: string[]) => readFileSync(argValue(argv, "--append-system-prompt-file")!, "utf8");
const addDirsOf = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "--add-dir" ? [a] : []));

/** 某个会话起过的假 claude（按启动先后）：提示词文件在 launch/<会话编号>/ 下。 */
function procsOf(sessionId: number) {
  return env.argvs().filter((a) => basename(dirname(argValue(a.argv, "--append-system-prompt-file") ?? "")) === String(sessionId));
}

function lastProcOf(sessionId: number) {
  const procs = procsOf(sessionId);
  if (procs.length === 0) throw new Error(`session ${sessionId} has no process`);
  return procs.at(-1)!;
}

/** 只读打开库查一下（守护进程开着也行，WAL）。 */
function query<T>(sql: string): T[] {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return db.all<T>(sql);
  } finally {
    db.close();
  }
}

/** 在私聊里聊一句，让它起一个进程（拿到这个会话的 HUB_TOKEN，后面用 env.runHub 替它敲 hub）。 */
async function warmUp(client: Client, conversationId: number, text = "在吗"): Promise<number> {
  const id = await client.post(conversationId, text);
  await waitForStatus(client, id, "replied");
  return id;
}

/** 用 hub.sock 直接发一个请求，返回状态码和响应体。 */
function rawHub(token: string, command: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath: hubSock(),
        method: "POST",
        path: `/v1/${command}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8").on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const tokenOf = (pid: number) => env.envs().find((e) => e.pid === pid)!.env.HUB_TOKEN!;

/** 交接（小林 → 阿周）前后的场景：foo 群里一轮里跑 hub project assign，交接正文从 heredoc 进来。 */
async function handoffScene(extraTurns: object[] = [], leadingTurns: object[] = []) {
  env = makeEnv();
  const foo = folder("foo");
  env.setScript({
    turns: [
      ...leadingTurns,
      {
        steps: [{ bash: "hub project assign foo --to 阿周 --stdin <<'EOF'\n发布日期定在周五。$HOME `x`\nEOF" }, { sleepMs: 300 }, { text: "交接好了" }],
      },
      ...extraTurns,
    ],
    defaultTurn: quick("发布日期是周五"),
  });
  const booted = await boot();
  const { client, pmId } = booted;
  const zhou = await client.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯" });
  const created = await client.createProject({ name: "foo", folder: foo, pmId });
  const before = await client.state();
  const [oldSession] = sessionsOf(before, created.conversationId);
  const ws = await client.ws(before.seq);
  return { ...booted, foo, zhou, groupId: created.conversationId, oldSessionId: oldSession!.sessionId, ws };
}

// 每条要起一两次真守护进程，CI 上比本地慢：默认的 5 秒不够
describe("M2 W6 组装 + 端到端", { timeout: 20_000 }, () => {
  it("一句话建项目：私聊里剧本跑 hub project create，WebSocket 收到 project.created，群里“项目已建好”，hub_calls 一行", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ turns: [{ steps: [{ bash: `hub project create --name foo --folder ${foo}` }, { text: "建好了" }] }] });
    const { daemon, client, state, privateId, pmId } = await boot();
    const ws = await client.ws(state.seq);
    const id = await client.post(privateId, `在 ${foo} 建一个叫 foo 的项目`);
    await waitForStatus(client, id, "replied");

    const [run] = env.bashRuns();
    expect(run).toMatchObject({ exitCode: 0 });
    expect(run!.output).toContain("foo");
    const created = await waitUntil("project.created over ws", () =>
      ws.messages.flatMap((m) => (m.type === "project.created" ? [m.data.project] : [])).at(0),
    );
    expect(created).toMatchObject({ name: "foo", pmId });
    ws.close();
    const s = await client.state();
    const group = s.conversations.find((c) => c.conversation.projectId === created.id)!;
    expect(group.conversation.kind).toBe("project_group");
    expect(group.messages).toEqual([
      expect.objectContaining({ sender: "system", status: null, meta: expect.objectContaining({ event: "project.created", projectId: created.id }) }),
    ]);
    expect(group.messages[0]!.text).toMatch(/^项目已建好/);
    expect(s.folders).toEqual([expect.objectContaining({ projectId: created.id, path: real(foo), isMain: true })]);
    // hub_calls：调用者是私聊的会话
    const privateSession = sessionsOf(s, privateId)[0]!.sessionId;
    expect(query<{ session_id: number; command: string; ok: number }>("SELECT session_id, command, ok FROM hub_calls")).toEqual([
      { session_id: privateSession, command: "project.create", ok: 1 },
    ]);
    await terminate(daemon);
  });

  it("群里聊：起的假 claude 工作目录是主文件夹的真实路径，提示词里有 foo；HUB_SOCK、设置文件、PATH 都对", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ defaultTurn: quick("foo 里有一个 README") });
    const { daemon, client, pmId } = await boot();
    const { conversationId: groupId } = await client.createProject({ name: "foo", folder: foo, pmId, description: "记账小工具" });
    const id = await client.post(groupId, "这个文件夹里有什么");
    await waitForStatus(client, id, "replied");
    expect(agentTexts(await client.state(), groupId)).toEqual(["foo 里有一个 README"]);

    const [proc] = env.argvs();
    expect(proc!.cwd).toBe(real(foo));
    const prompt = promptOf(proc!.argv);
    expect(prompt).toContain("项目“foo”的项目群");
    expect(prompt).toContain(`主文件夹（工作目录）：${real(foo)}`);
    expect(prompt).toContain("记账小工具");
    // agent 接口：HUB_SOCK 是真实路径；设置文件放行 hub 和这个 socket；run/bin 在 PATH 最前面
    const sock = real(hubSock());
    const childEnv = env.envs()[0]!.env;
    expect(childEnv!.HUB_SOCK).toBe(sock);
    expect(childEnv!.HUB_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(childEnv!.PATH!.split(":")[0]).toBe(join(env.home, "run", "bin"));
    const settings = JSON.parse(readFileSync(argValue(proc!.argv, "--settings")!, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(settings)).toContain("Bash(hub:*)");
    expect(JSON.stringify(settings)).toContain(JSON.stringify(sock));
    // 令牌只在环境变量里，不落盘
    expect(readFileSync(argValue(proc!.argv, "--settings")!, "utf8")).not.toContain(childEnv!.HUB_TOKEN!);
    expect(statSync(join(env.home, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(hubSock()).mode & 0o777).toBe(0o600);
    await terminate(daemon);
  });

  it("同时跑：同一个项目经理的两个群同时发，两个进程同时在跑，回复各进各的群", async () => {
    env = makeEnv();
    const foo = folder("foo");
    const bar = folder("bar");
    env.setScript({ defaultTurn: { steps: [{ sleepMs: 1_500 }, { text: "看完了" }] } });
    const { daemon, client, pmId } = await boot();
    const fooGroup = (await client.createProject({ name: "foo", folder: foo, pmId })).conversationId;
    const barGroup = (await client.createProject({ name: "bar", folder: bar, pmId })).conversationId;
    const [a, b] = await Promise.all([client.post(fooGroup, "这个文件夹里有什么"), client.post(barGroup, "这个文件夹里有什么")]);
    // 两条同时在处理
    await waitUntil("both processing", async () => {
      const s = await client.state();
      return messageById(s, a)?.status === "processing" && messageById(s, b)?.status === "processing" ? true : undefined;
    });
    await waitForStatus(client, a, "replied");
    await waitForStatus(client, b, "replied");
    const s = await client.state();
    expect(agentTexts(s, fooGroup)).toEqual(["看完了"]);
    expect(agentTexts(s, barGroup)).toEqual(["看完了"]);
    const fooSession = sessionsOf(s, fooGroup)[0]!.sessionId;
    const barSession = sessionsOf(s, barGroup)[0]!.sessionId;
    expect(procsOf(fooSession).map((p) => p.cwd)).toEqual([real(foo)]);
    expect(procsOf(barSession).map((p) => p.cwd)).toEqual([real(bar)]);
    // 各自的消息进各自的进程
    expect(env.stdinTextsOf(procsOf(fooSession)[0]!.pid)).toEqual(["这个文件夹里有什么"]);
    expect(env.stdinTextsOf(procsOf(barSession)[0]!.pid)).toEqual(["这个文件夹里有什么"]);
    await terminate(daemon);
  });

  it("挂文件夹（群里自己挂）：剧本跑 hub project attach，再发一条：先按新参数重启（多一个 --add-dir），这条前面带 RELAUNCH_NOTE", async () => {
    env = makeEnv();
    const foo = folder("foo");
    const extra = folder("foo-docs");
    env.setScript({ turns: [{ steps: [{ bash: `hub project attach foo ${extra}` }, { text: "挂上了" }] }], defaultTurn: quick("看到了") });
    const { daemon, client, pmId } = await boot();
    const groupId = (await client.createProject({ name: "foo", folder: foo, pmId })).conversationId;
    const first = await client.post(groupId, `把 ${extra} 也挂上`);
    await waitForStatus(client, first, "replied");
    expect(env.bashRuns()).toEqual([expect.objectContaining({ exitCode: 0 })]);
    const s1 = await client.state();
    expect(messagesOf(s1, groupId).find((m) => m.sender === "system" && m.meta?.event === "folder.attached")?.text).toContain(real(extra));
    const second = await client.post(groupId, "看看里面有什么");
    await waitForStatus(client, second, "replied");

    const sessionId = sessionsOf(await client.state(), groupId)[0]!.sessionId;
    const procs = procsOf(sessionId);
    expect(procs).toHaveLength(2);
    expect(addDirsOf(procs[0]!.argv)).toEqual([]);
    expect(addDirsOf(procs[1]!.argv)).toEqual([real(extra)]);
    expect(procs[1]!.argv).toContain("--resume");
    expect(env.stdinTextsOf(procs[1]!.pid)).toEqual([`${RELAUNCH_NOTE}\n\n看看里面有什么`]);
    // 自己挂的：不再单独给它发一条【系统】消息
    expect(env.stdinTexts().some((t) => t.includes("已挂上文件夹"))).toBe(false);
    await terminate(daemon);
  });

  it("挂文件夹（在私聊里挂）：群里的 agent 收到“【系统】…文件夹…”，收之前按新参数重启；再发一条不再重启", async () => {
    env = makeEnv();
    const foo = folder("foo");
    const extra = folder("foo-docs");
    env.setScript({ turns: [quick("在"), { steps: [{ bash: `hub project attach foo ${extra}` }, { text: "挂上了" }] }], defaultTurn: quick("收到") });
    const { daemon, client, pmId, privateId } = await boot();
    const groupId = (await client.createProject({ name: "foo", folder: foo, pmId })).conversationId;
    await warmUp(client, groupId);
    await warmUp(client, privateId, `给 foo 挂上 ${extra}`);
    const sessionId = sessionsOf(await client.state(), groupId)[0]!.sessionId;
    await waitUntil("group relaunched with the system message", () =>
      procsOf(sessionId).length === 2 && env.stdinTextsOf(procsOf(sessionId)[1]!.pid).length === 1 ? true : undefined,
    );
    const [, relaunched] = procsOf(sessionId);
    expect(addDirsOf(relaunched!.argv)).toEqual([real(extra)]);
    const [systemText] = env.stdinTextsOf(relaunched!.pid);
    expect(systemText).toContain(SYSTEM_MESSAGE_PREFIX);
    expect(systemText).toContain(real(extra));
    const next = await client.post(groupId, "看看里面有什么");
    await waitForStatus(client, next, "replied");
    expect(procsOf(sessionId)).toHaveLength(2);
    await terminate(daemon);
  });

  it("交接：旧进程这一轮回完后退出、会话 ended（推给网页）；群里再发起的是新一代，提示词里有交接正文；阿周私聊里有一条", async () => {
    const { daemon, client, ws, groupId, oldSessionId, zhou } = await handoffScene();
    const id = await client.post(groupId, "记住发布日期定在周五，然后把 foo 交给阿周");
    await waitForStatus(client, id, "replied");
    expect(env.bashRuns()).toEqual([expect.objectContaining({ exitCode: 0 })]);
    const oldPid = lastProcOf(oldSessionId).pid;
    // session.end：这一轮回完才关，状态 ended 推到网页
    await waitUntil("old session ended over ws", () =>
      ws.messages.some((m) => m.type === "session.status" && m.data.session.sessionId === oldSessionId && m.data.session.status === "ended")
        ? true
        : undefined,
    );
    await waitUntil("old claude exited", () => (isAlive(oldPid) ? undefined : true));
    expect(env.log().filter((e) => e.pid === oldPid).map((e) => e.kind)).toContain("stdin_closed");
    ws.close();

    const s = await client.state();
    const [old, next] = sessionsOf(s, groupId);
    expect(old).toMatchObject({ status: "ended" });
    expect(next).toMatchObject({ generation: 2 });
    expect(s.projects.find((p) => p.name === "foo")!.pmId).toBe(zhou.pmId);
    expect(messagesOf(s, groupId).find((m) => m.meta?.event === "project.reassigned")?.text).toMatch(/项目经理由项目经理换成阿周/);
    expect(messagesOf(s, zhou.conversationId).find((m) => m.meta?.event === "project.reassigned")?.text).toMatch(/把 foo 交给了你/);

    const ask = await client.post(groupId, "发布日期是哪天");
    await waitForStatus(client, ask, "replied");
    const proc = lastProcOf(next!.sessionId);
    expect(proc.argv).toContain("--session-id");
    expect(env.stdinTextsOf(proc.pid)).toEqual(["发布日期是哪天"]);
    const prompt = promptOf(proc.argv);
    expect(prompt).toContain("名字叫“阿周”");
    expect(prompt).toContain("发布日期定在周五。$HOME `x`");
    await terminate(daemon);
  });

  it("令牌作废：交接后用旧会话的令牌跑 hub status，退出码 1，HTTP 401；新一代的令牌照常能用", async () => {
    const { daemon, client, groupId, oldSessionId } = await handoffScene();
    const id = await client.post(groupId, "把 foo 交给阿周");
    await waitForStatus(client, id, "replied");
    await waitUntil("old session ended", async () =>
      sessionsOf(await client.state(), groupId)[0]!.status === "ended" ? true : undefined,
    );
    const oldPid = lastProcOf(oldSessionId).pid;
    const denied = await env.runHub(oldPid, ["status"]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("令牌");
    expect(await rawHub(tokenOf(oldPid), "status", {})).toEqual({ status: 401, body: expect.objectContaining({ ok: false, code: "unauthorized" }) });

    const ask = await client.post(groupId, "你是谁");
    await waitForStatus(client, ask, "replied");
    const newSession = sessionsOf(await client.state(), groupId)[1]!.sessionId;
    const ok = await env.runHub(lastProcOf(newSession).pid, ["status"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("阿周");
    await terminate(daemon);
  });

  it("重启不丢：SIGTERM 再启动，项目、群、文件夹、交接都在；群会话用 --resume；旧 hub.sock 被替换，旧令牌作废", { timeout: 30_000 }, async () => {
    // 剧本按顺序给各进程派回合：第一个回合留给私聊里的 warmUp，交接那个回合给群里
    const scene = await handoffScene([], [quick("在")]);
    const { client, groupId, privateId } = scene;
    const extra = folder("foo-docs");
    // 私聊里挂一个文件夹（替私聊的 agent 敲 hub）
    await warmUp(client, privateId);
    const privatePid = lastProcOf(sessionsOf(await client.state(), privateId)[0]!.sessionId).pid;
    const attached = await env.runHub(privatePid, ["project", "attach", "foo", extra]);
    expect(attached).toMatchObject({ code: 0, stderr: "" });
    const assign = await client.post(groupId, "把 foo 交给阿周");
    await waitForStatus(client, assign, "replied");
    const ask = await client.post(groupId, "发布日期是哪天");
    await waitForStatus(client, ask, "replied");
    const before = await client.state();
    const newSession = sessionsOf(before, groupId)[1]!;
    const vendorBefore = argValue(lastProcOf(newSession.sessionId).argv, "--session-id");
    const sockIno = statSync(hubSock()).ino;

    expect(await terminate(scene.daemon)).toEqual({ code: 0, signal: null });
    expect(existsSync(hubSock())).toBe(false);
    const daemon = await env.start();
    const c2 = client.withPort(daemon.port);
    const after = await c2.state();
    expect(after.projects).toEqual(before.projects);
    expect(after.folders).toEqual(before.folders);
    expect(after.folders.map((f) => f.path)).toEqual([real(scene.foo), real(extra)]);
    expect(messagesOf(after, groupId).map((m: Message) => m.id)).toEqual(messagesOf(before, groupId).map((m) => m.id));
    expect(query<{ n: number }>("SELECT COUNT(*) AS n FROM handoffs")).toEqual([{ n: 1 }]);
    expect(statSync(hubSock()).ino).not.toBe(sockIno);
    // 上次的令牌全部作废
    expect((await env.runHub(privatePid, ["status"])).code).toBe(1);

    const again = await c2.post(groupId, "接着聊");
    await waitForStatus(c2, again, "replied");
    const proc = lastProcOf(newSession.sessionId);
    expect(argValue(proc.argv, "--resume")).toBe(vendorBefore);
    expect(addDirsOf(proc.argv)).toEqual([real(extra)]);
    expect(promptOf(proc.argv)).toContain("发布日期定在周五");
    expect((await env.runHub(proc.pid, ["status"])).code).toBe(0);
    await terminate(daemon);
  });

  it("守护进程没开：关掉守护进程后用同样的环境变量跑 hub status，退出码 3，提示连不上 agent-hub", async () => {
    env = makeEnv();
    const { daemon, client, privateId } = await boot();
    await warmUp(client, privateId);
    const [proc] = env.argvs();
    expect((await env.runHub(proc!.pid, ["status"])).code).toBe(0);
    await terminate(daemon);
    const result = await env.runHub(proc!.pid, ["status"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("连不上 agent-hub");
  });

  it("重试：找不到 claude 导致消息失败；修好路径重启后点重试，排队中 → 已送达 → 已回复，不多出消息", { timeout: 60_000 }, async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("这次好了") });
    const first = await boot({ claudePath: join(env.dir, "no-such-claude") });
    const id = await first.client.post(first.privateId, "你好");
    const failed = await waitForStatus(first.client, id, "failed", 40_000);
    expect(failed.failureReason).toMatch(/^claude_not_found/);
    await terminate(first.daemon);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    const ws = await client.ws((await client.state()).seq);
    expect(await client.retry(id)).toBe(202);
    await waitForStatus(client, id, "replied");
    const statuses = ws.messages.flatMap((m) => (m.type === "message.updated" && m.data.message.id === id ? [m.data.message.status] : []));
    expect(statuses).toEqual(["queued", "delivered", "processing", "replied"]);
    ws.close();
    const users = messagesOf(await client.state(), first.privateId).filter((m) => m.sender === "user");
    expect(users.map((m) => m.id)).toEqual([id]);
    expect(env.stdinTexts()).toEqual(["你好"]);
    // 不能重试的：已回复的 409
    expect(await client.retry(id)).toBe(409);
    await terminate(daemon);
  });

  it("交接时撞上 session_ended：群里排队的那条发给新一代，不进旧进程；driver 的 health 没记 session_ended", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({
      turns: [
        {
          steps: [
            { sleepMs: 1_500 },
            { bash: "hub project assign foo --to 阿周 --text '交接：发布日期定在周五'" },
            { sleepMs: 1_000 },
            { text: "交接好了" },
          ],
        },
      ],
      defaultTurn: quick("我是阿周，收到"),
    });
    const { daemon, client, pmId } = await boot();
    await client.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯" });
    const groupId = (await client.createProject({ name: "foo", folder: foo, pmId })).conversationId;
    const oldSessionId = sessionsOf(await client.state(), groupId)[0]!.sessionId;
    const first = await client.post(groupId, "把 foo 交给阿周");
    await waitForStatus(client, first, "processing");
    // 旧一代正忙：这条在排队，交接时改指新一代
    const queued = await client.post(groupId, "顺便看看 README");
    await waitForStatus(client, first, "replied");
    await waitForStatus(client, queued, "replied");

    const s = await client.state();
    const [old, next] = sessionsOf(s, groupId);
    expect(old!.status).toBe("ended");
    expect(messageById(s, queued)!.sessionId).toBe(next!.sessionId);
    expect(env.stdinTextsOf(lastProcOf(oldSessionId).pid)).toEqual(["把 foo 交给阿周"]);
    expect(env.stdinTextsOf(lastProcOf(next!.sessionId).pid)).toEqual(["顺便看看 README"]);
    // 新一代不等旧一代把这一轮说完：两条回复谁先谁后不定
    expect([...agentTexts(s, groupId)].sort()).toEqual(["交接好了", "我是阿周，收到"].sort());
    for (const h of s.health) expect(h.lastError ?? "").not.toMatch(/session_ended/);
    const actions = query<{ type: string; status: string; last_error: string | null }>("SELECT type, status, last_error FROM actions");
    expect(actions.filter((a) => a.status !== "done")).toEqual([]);
    expect(actions.some((a) => (a.last_error ?? "").includes("session_ended"))).toBe(false);
    await terminate(daemon);
  });

  it("重启后旧 hub.sock 被替换：守护进程被 SIGKILL 留下 socket 文件，再启动删掉重建，hub 照常能用", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("在") });
    const first = await boot();
    await warmUp(first.client, first.privateId);
    const sockIno = statSync(hubSock()).ino;
    first.daemon.child.kill("SIGKILL");
    await first.daemon.exited;
    // 残留的 socket 文件还在，但没人监听
    expect(statSync(hubSock()).isSocket()).toBe(true);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    expect(statSync(hubSock()).ino).not.toBe(sockIno);
    expect(statSync(hubSock()).mode & 0o777).toBe(0o600);
    await warmUp(client, first.privateId, "还在吗");
    const proc = env.argvs().at(-1)!;
    const result = await env.runHub(proc.pid, ["status"]);
    expect(result.code).toBe(0);
    await terminate(daemon);
  });

  it.skipIf(!SLOW)("hub 请求 15 秒超时：只发了一半的请求，守护进程 15 秒左右断开（慢测）", { timeout: 60_000 }, async () => {
    env = makeEnv();
    const { daemon, client, privateId } = await boot();
    await warmUp(client, privateId);
    const token = tokenOf(env.argvs()[0]!.pid);
    const socket = connect(hubSock());
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const t0 = Date.now();
    // 头发完、体只发一半
    socket.write(`POST /v1/status HTTP/1.1\r\nHost: hub\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(25_000);
    await terminate(daemon);
  });
});
