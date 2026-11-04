// M2 端到端（11-03 起一个项目经理就是一个会话；外加重启后旧 hub.sock 被替换、老库升级、hub 请求 15 秒超时）：
// 真守护进程 + 假 claude（剧本里的 bash 步骤真的跑 run/bin/hub），临时数据目录。
// 慢测（hub 请求 15 秒超时，要等 15 秒以上）默认不跑：AGENT_HUB_SLOW_TESTS=1 pnpm vitest run test/e2e/m2.test.ts
import { request } from "node:http";
import { connect } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, ENV_DEFAULT_MODEL, HUB_COMMAND, HUB_REQUEST_TIMEOUT_MS, PRODUCT_NAME, RELAUNCH_NOTE, type EditPersonaResponse, type Message, type StateSnapshot } from "../../src/shared/index.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate, openDatabase } from "../../src/daemon/store/index.ts";
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
  // 第一次启动自动建的项目经理（还没有项目）和它唯一的对话
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

/** 建一个带主文件夹的项目经理，返回它的编号、对话、会话。 */
async function pmWithProject(client: Client, name: string, dir: string) {
  const { pmId, conversationId } = await client.createPm({ name, mode: "hands_on", persona: `${name}的习惯`, folder: dir });
  const sessionId = sessionsOf(await client.state(), conversationId)[0]!.sessionId;
  return { pmId, conversationId, sessionId };
}

/**
 * 在数据目录里放一个 M2 开发时的库（user_version 2）：默认项目经理（对话 1、会话 1，cwd 是它的空目录），
 * 一个项目群 foo（对话 2、会话 2，cwd 是 foo）和群里的两条消息：一条已回复，一条还在排队（动作没执行）。
 */
function seedM2DevDatabase(foo: string): void {
  const stateDir = join(env.home, "state");
  mkdirSync(stateDir, { recursive: true });
  const pmHome = join(env.home, "pm-home", "1");
  mkdirSync(pmHome, { recursive: true });
  const upTo2 = mkdtempSync(join(tmpdir(), "agent-hub-m2-migrations-"));
  for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (/^000[12]_.*\.sql$/.test(name)) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(upTo2, name));
  }
  const db = openDatabase(join(stateDir, "hub.sqlite"));
  try {
    migrate(db, upTo2);
    db.exec(`
      INSERT INTO pms (id, name, mode, created_at) VALUES (1, '项目经理', 'manage_only', 10);
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, '项目经理', 10);
      INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, created_at, updated_at)
        VALUES (1, 'pm', 1, 1, 'aaaaaaaa-0000-4000-8000-000000000001', '${pmHome}', 10, 10);
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (2, 'project_group', 1, 'foo', 20);
      INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'foo', 1, 2, 20, 20);
      UPDATE conversations SET project_id = 1 WHERE id = 2;
      INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '${foo}', 1, 20);
      INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, created_at, updated_at)
        VALUES (2, 'pm', 2, 1, 'aaaaaaaa-0000-4000-8000-000000000002', '${foo}', 20, 20);
      INSERT INTO messages (id, conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
        VALUES (1, 2, 2, 'user', 'text', '群里说过的话', 'client:2:a', 'replied', 21, 21);
      INSERT INTO messages (id, conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
        VALUES (2, 2, 2, 'user', 'text', '群里还没发的', 'client:2:b', 'queued', 22, 22);
      INSERT INTO actions (type, dedupe_key, params, status, next_attempt_at, created_at, updated_at)
        VALUES ('session.send', '2', '{"sessionId":2,"messageId":2,"source":"user"}', 'pending', 22, 22, 22);
    `);
  } finally {
    db.close();
  }
}

// 每条要起一两次真守护进程，CI 上比本地慢：默认的 5 秒不够
describe("M2 端到端（一个项目经理就是一个会话）", { timeout: 20_000 }, () => {
  it("一句话建项目：会话里剧本跑 hub project create，推 project.created，对话里“项目已建好”，hub_calls 一行；下一条消息前按主文件夹重启", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ turns: [{ steps: [{ bash: `${HUB_COMMAND} project create --folder ${foo}` }, { text: "建好了" }] }], defaultTurn: quick("foo 里有一个 README") });
    const { daemon, client, state, privateId, pmId } = await boot();
    const ws = await client.ws(state.seq);
    const id = await client.post(privateId, `在 ${foo} 建项目`);
    await waitForStatus(client, id, "replied");

    const [run] = env.bashRuns();
    expect(run).toMatchObject({ exitCode: 0 });
    expect(run!.output).toContain("已建好项目“foo”");
    const created = await waitUntil("project.created over ws", () =>
      ws.messages.flatMap((m) => (m.type === "project.created" ? [m.data.project] : [])).at(0),
    );
    expect(created).toMatchObject({ name: "foo", pmId, conversationId: privateId });
    // 不另开对话、不另开会话
    expect(ws.messages.some((m) => m.type === "conversation.created" || m.type === "session.created")).toBe(false);
    ws.close();
    const s = await client.state();
    expect(s.conversations.map((c) => c.conversation.id)).toEqual([privateId]);
    const notice = messagesOf(s, privateId).find((m) => m.sender === "system")!;
    expect(notice).toMatchObject({ status: null, meta: expect.objectContaining({ event: "project.created", projectId: created.id }) });
    expect(notice.text).toMatch(/^项目已建好/);
    expect(s.folders).toEqual([expect.objectContaining({ projectId: created.id, path: real(foo), isMain: true })]);
    const sessionId = sessionsOf(s, privateId)[0]!.sessionId;
    expect(query<{ session_id: number; command: string; ok: number }>("SELECT session_id, command, ok FROM hub_calls")).toEqual([
      { session_id: sessionId, command: "project.create", ok: 1 },
    ]);

    const ask = await client.post(privateId, "这个文件夹里有什么");
    await waitForStatus(client, ask, "replied");
    const procs = procsOf(sessionId);
    expect(procs).toHaveLength(2);
    expect(procs[0]!.cwd).toBe(real(join(env.home, "pm-home", String(pmId))));
    expect(procs[1]!.cwd).toBe(real(foo));
    expect(procs[1]!.argv).toContain("--resume");
    expect(env.stdinTextsOf(procs[1]!.pid)).toEqual([`${RELAUNCH_NOTE}\n\n这个文件夹里有什么`]);
    // 提示词文件每次启动都重写（launch/<会话>/prompt.md），现在是有项目的那一份
    expect(promptOf(procs[1]!.argv)).toContain(`主文件夹（工作目录）：${real(foo)}`);
    await terminate(daemon);
  });

  it("建项目经理时选主文件夹：第一条消息起就在主文件夹里跑，提示词里有项目；HUB_SOCK、设置文件、PATH 都对", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ defaultTurn: quick("foo 里有一个 README") });
    const { daemon, client } = await boot();
    const zhou = await pmWithProject(client, "阿周", foo);
    const s0 = await client.state();
    expect(s0.projects).toEqual([expect.objectContaining({ name: "foo", pmId: zhou.pmId, conversationId: zhou.conversationId })]);
    expect(messagesOf(s0, zhou.conversationId).map((m) => m.text)).toEqual([expect.stringMatching(/^项目已建好/)]);
    const id = await client.post(zhou.conversationId, "这个文件夹里有什么");
    await waitForStatus(client, id, "replied");
    expect(agentTexts(await client.state(), zhou.conversationId)).toEqual(["foo 里有一个 README"]);

    const [proc] = procsOf(zhou.sessionId);
    expect(proc!.cwd).toBe(real(foo));
    expect(proc!.argv).toContain("--session-id");
    const prompt = promptOf(proc!.argv);
    expect(prompt).toContain("名字叫“阿周”");
    expect(prompt).toContain("- 项目：foo");
    expect(prompt).toContain(`主文件夹（工作目录）：${real(foo)}`);
    // agent 接口：HUB_SOCK 是真实路径；设置文件放行 hub 和这个 socket；run/bin 在 PATH 最前面
    const sock = real(hubSock());
    const childEnv = env.envs().find((e) => e.pid === proc!.pid)!.env;
    expect(childEnv.HUB_SOCK).toBe(sock);
    expect(childEnv.HUB_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(childEnv.PATH!.split(":")[0]).toBe(join(env.home, "run", "bin"));
    const settings = JSON.parse(readFileSync(argValue(proc!.argv, "--settings")!, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(settings)).toContain(`Bash(${HUB_COMMAND}:*)`);
    expect(JSON.stringify(settings)).toContain(JSON.stringify(sock));
    // 令牌只在环境变量里，不落盘
    expect(readFileSync(argValue(proc!.argv, "--settings")!, "utf8")).not.toContain(childEnv.HUB_TOKEN!);
    expect(statSync(join(env.home, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(hubSock()).mode & 0o777).toBe(0o600);
    await terminate(daemon);
  });

  it("已经有项目又要建：hub 退出码 1，“一个项目经理只管一个项目，请新建一个项目经理”；文件夹不存在：退出码 1，什么也没建", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ defaultTurn: quick("在") });
    const { daemon, client, privateId } = await boot();
    const zhou = await pmWithProject(client, "阿周", foo);
    await warmUp(client, zhou.conversationId);
    await warmUp(client, privateId);
    const before = await client.state();

    const again = await env.runHub(lastProcOf(zhou.sessionId).pid, ["project", "create", "--folder", folder("bar")]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("一个项目经理只管一个项目，请新建一个项目经理");
    const missing = await env.runHub(lastProcOf(sessionsOf(before, privateId)[0]!.sessionId).pid, ["project", "create", "--folder", join(env.dir, "nope")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("文件夹不存在，请先建好");
    const after = await client.state();
    expect(after.projects).toEqual(before.projects);
    expect(after.folders).toEqual(before.folders);
    await terminate(daemon);
  });

  it("同一个文件夹可以有多个项目经理：网页新建弹窗选别人的主文件夹照样建好；hub project create、attach 别人的主文件夹也不报占用", async () => {
    env = makeEnv();
    const foo = folder("foo");
    env.setScript({ defaultTurn: quick("在") });
    const { daemon, client, privateId } = await boot();
    // 网页新建项目经理（POST /api/pms）：阿周、老王都用 foo 当主文件夹
    const zhou = await pmWithProject(client, "阿周", foo);
    const wang = await pmWithProject(client, "老王", foo);
    // 第一次启动自动建的项目经理在会话里 hub project create 同一个文件夹
    await warmUp(client, privateId);
    const created = await env.runHub(lastProcOf(sessionsOf(await client.state(), privateId)[0]!.sessionId).pid, ["project", "create", "--folder", foo]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("已建好项目“foo”");
    // 别的项目挂着的附加文件夹也能挂
    const shared = folder("shared");
    await warmUp(client, zhou.conversationId);
    await warmUp(client, wang.conversationId);
    for (const pm of [zhou, wang]) expect((await env.runHub(lastProcOf(pm.sessionId).pid, ["project", "attach", shared])).code).toBe(0);
    const s = await client.state();
    expect(s.projects.map((p) => p.name)).toEqual(["foo", "foo", "foo"]);
    expect(new Set(s.projects.map((p) => p.pmId)).size).toBe(3);
    expect(s.folders.filter((f) => f.isMain).map((f) => f.path)).toEqual([real(foo), real(foo), real(foo)]);
    expect(s.folders.filter((f) => !f.isMain).map((f) => f.path)).toEqual([real(shared), real(shared)]);
    await terminate(daemon);
  });

  it("同时跑：两个项目经理各自的会话同时回答，两个进程同时在跑，回复各进各的对话", async () => {
    env = makeEnv();
    const foo = folder("foo");
    const bar = folder("bar");
    // 两个进程都卡在这一步，直到下面确认两条都在处理、再放行（不用睡固定时间：机器忙时第二个进程晚起几秒也错不过窗口）
    const gate = join(env.dir, "gate");
    env.setScript({ defaultTurn: { steps: [{ waitFile: gate }, { text: "看完了" }] } });
    const { daemon, client } = await boot();
    const lin = await pmWithProject(client, "小林", foo);
    const zhou = await pmWithProject(client, "阿周", bar);
    const [a, b] = await Promise.all([client.post(lin.conversationId, "这个文件夹里有什么"), client.post(zhou.conversationId, "这个文件夹里有什么")]);
    // 两条同时在处理
    await waitUntil("both processing", async () => {
      const s = await client.state();
      return messageById(s, a)?.status === "processing" && messageById(s, b)?.status === "processing" ? true : undefined;
    });
    writeFileSync(gate, "");
    await waitForStatus(client, a, "replied");
    await waitForStatus(client, b, "replied");
    const s = await client.state();
    expect(agentTexts(s, lin.conversationId)).toEqual(["看完了"]);
    expect(agentTexts(s, zhou.conversationId)).toEqual(["看完了"]);
    expect(procsOf(lin.sessionId).map((p) => p.cwd)).toEqual([real(foo)]);
    expect(procsOf(zhou.sessionId).map((p) => p.cwd)).toEqual([real(bar)]);
    // 各自的消息进各自的进程
    expect(env.stdinTextsOf(procsOf(lin.sessionId)[0]!.pid)).toEqual(["这个文件夹里有什么"]);
    expect(env.stdinTextsOf(procsOf(zhou.sessionId)[0]!.pid)).toEqual(["这个文件夹里有什么"]);
    await terminate(daemon);
  });

  it("第一次启动：AGENT_HUB_DEFAULT_MODEL 不合规就忽略、记一行日志，项目经理按默认建；合规的照用", async () => {
    env = makeEnv();
    const bad = await boot({ env: { [ENV_DEFAULT_MODEL]: "claude opus" } });
    expect(bad.state.pms[0]).toMatchObject({ vendor: "claude", defaultModel: null, effort: null });
    expect(bad.daemon.stderr()).toContain(`${ENV_DEFAULT_MODEL}="claude opus" 不能用`);
    await terminate(bad.daemon);
    await env.cleanup();
    env = makeEnv();
    const good = await boot({ env: { [ENV_DEFAULT_MODEL]: "haiku" } });
    expect(good.state.pms[0]).toMatchObject({ defaultModel: "haiku" });
    expect(good.daemon.stderr()).not.toContain("不能用");
    await terminate(good.daemon);
  });

  it("资料页改模型、思考程度：下一条消息前 --resume 同一个会话重启，带 --model haiku --effort low；改回默认就不带", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("好的") });
    const { daemon, client } = await boot();
    const zhou = await pmWithProject(client, "阿周", folder("foo"));
    await warmUp(client, zhou.conversationId);
    const put = (body: unknown) => client.putJson(API_PATHS.persona(zhou.pmId), body);
    const res = await put({ model: "haiku", effort: "low" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EditPersonaResponse).persona).toMatchObject({ vendor: "claude", model: "haiku", effort: "low" });
    expect(query("SELECT model, effort FROM agent_sessions WHERE id = " + zhou.sessionId)).toEqual([{ model: "haiku", effort: "low" }]);
    await warmUp(client, zhou.conversationId, "第二条");
    expect((await put({ model: null, effort: null })).status).toBe(200);
    await warmUp(client, zhou.conversationId, "第三条");
    // 值不对：400 带原因，什么也没改
    const bad = await put({ effort: "ultra" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("思考程度只能是");

    const [first, second, third] = procsOf(zhou.sessionId);
    expect(argValue(first!.argv, "--model")).toBeUndefined();
    expect(argValue(first!.argv, "--effort")).toBeUndefined();
    const vendorSessionId = argValue(first!.argv, "--session-id");
    expect(argValue(second!.argv, "--resume")).toBe(vendorSessionId);
    expect([argValue(second!.argv, "--model"), argValue(second!.argv, "--effort")]).toEqual(["haiku", "low"]);
    expect(env.stdinTextsOf(second!.pid)).toEqual([`${RELAUNCH_NOTE}\n\n第二条`]);
    expect(argValue(third!.argv, "--resume")).toBe(vendorSessionId);
    expect(third!.argv).not.toContain("--model");
    expect(third!.argv).not.toContain("--effort");
    await terminate(daemon);
  });

  it("挂文件夹：剧本跑 hub project attach，再发一条：先按新参数重启（多一个 --add-dir），这条前面带 RELAUNCH_NOTE", async () => {
    env = makeEnv();
    const foo = folder("foo");
    const extra = folder("foo-docs");
    env.setScript({ turns: [{ steps: [{ bash: `${HUB_COMMAND} project attach ${extra}` }, { text: "挂上了" }] }], defaultTurn: quick("看到了") });
    const { daemon, client } = await boot();
    const zhou = await pmWithProject(client, "阿周", foo);
    const first = await client.post(zhou.conversationId, `把 ${extra} 也挂上`);
    await waitForStatus(client, first, "replied");
    expect(env.bashRuns()).toEqual([expect.objectContaining({ exitCode: 0 })]);
    const s1 = await client.state();
    expect(messagesOf(s1, zhou.conversationId).find((m) => m.sender === "system" && m.meta?.event === "folder.attached")?.text).toContain(real(extra));
    const second = await client.post(zhou.conversationId, "看看里面有什么");
    await waitForStatus(client, second, "replied");

    const procs = procsOf(zhou.sessionId);
    expect(procs).toHaveLength(2);
    expect(addDirsOf(procs[0]!.argv)).toEqual([]);
    expect(addDirsOf(procs[1]!.argv)).toEqual([real(extra)]);
    expect(procs[1]!.argv).toContain("--resume");
    expect(procs[1]!.cwd).toBe(real(foo));
    expect(env.stdinTextsOf(procs[1]!.pid)).toEqual([`${RELAUNCH_NOTE}\n\n看看里面有什么`]);
    // 是它自己挂的：不再单独给它发一条【系统】消息
    expect(env.stdinTexts().some((t) => t.includes("已挂上文件夹"))).toBe(false);
    await terminate(daemon);
  });

  it("重启不丢：SIGTERM 再启动，项目、文件夹、聊天记录都在；会话用 --resume 在主文件夹里跑；旧 hub.sock 被替换，旧令牌作废", { timeout: 30_000 }, async () => {
    env = makeEnv();
    const foo = folder("foo");
    const extra = folder("foo-docs");
    env.setScript({ defaultTurn: quick("在") });
    const { daemon: first, client } = await boot();
    const zhou = await pmWithProject(client, "阿周", foo);
    await warmUp(client, zhou.conversationId);
    const oldPid = lastProcOf(zhou.sessionId).pid;
    expect(await env.runHub(oldPid, ["project", "attach", extra])).toMatchObject({ code: 0, stderr: "" });
    const before = await client.state();
    const vendor = argValue(lastProcOf(zhou.sessionId).argv, "--session-id");
    const sockIno = statSync(hubSock()).ino;

    expect(await terminate(first)).toEqual({ code: 0, signal: null });
    expect(existsSync(hubSock())).toBe(false);
    const daemon = await env.start();
    const c2 = client.withPort(daemon.port);
    const after = await c2.state();
    expect(after.projects).toEqual(before.projects);
    expect(after.folders).toEqual(before.folders);
    expect(after.folders.map((f) => f.path)).toEqual([real(foo), real(extra)]);
    expect(messagesOf(after, zhou.conversationId).map((m: Message) => m.id)).toEqual(messagesOf(before, zhou.conversationId).map((m) => m.id));
    expect(statSync(hubSock()).ino).not.toBe(sockIno);
    // 上次的令牌全部作废
    expect((await env.runHub(oldPid, ["status"])).code).toBe(1);
    expect(await rawHub(tokenOf(oldPid), "status", {})).toEqual({ status: 401, body: expect.objectContaining({ ok: false, code: "unauthorized" }) });

    const again = await c2.post(zhou.conversationId, "接着聊");
    await waitForStatus(c2, again, "replied");
    const proc = lastProcOf(zhou.sessionId);
    expect(argValue(proc.argv, "--resume")).toBe(vendor);
    expect(proc.cwd).toBe(real(foo));
    expect(addDirsOf(proc.argv)).toEqual([real(extra)]);
    const status = await env.runHub(proc.pid, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(real(extra));
    await terminate(daemon);
  });

  it("老库升级：M2 开发时建过项目群的库，启动后自动备份、迁移；网页上没有群，数据还在；项目经理的会话照常能聊，群里排队的那条不会再发", async () => {
    env = makeEnv();
    const foo = real(folder("foo"));
    seedM2DevDatabase(foo);
    env.setScript({ defaultTurn: quick("我在") });
    const { daemon, client, state } = await boot();
    expect(readdirSync(join(env.home, "state")).filter((f) => f.startsWith("hub.sqlite.bak-2-"))).toHaveLength(1);
    expect(state.conversations.map((c) => c.conversation.id)).toEqual([1]);
    expect(state.projects).toEqual([]);
    expect(state.sessions.map((s) => s.sessionId)).toEqual([1]);
    expect(query<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 2")).toEqual([{ n: 2 }]);
    expect(query<{ status: string }>("SELECT status FROM projects")).toEqual([{ status: "archived" }]);
    // 对外一律当老群不存在：翻更早的消息、发消息、停止都是 404
    expect((await client.get(`${API_PATHS.messages(2)}?before=99`)).status).toBe(404);
    expect((await client.postJson(API_PATHS.messages(2), { clientId: "c", text: "还在吗" })).status).toBe(404);
    expect(await client.stop(2)).toBe(404);

    const id = await client.post(1, "你好");
    await waitForStatus(client, id, "replied");
    expect(agentTexts(await client.state(), 1)).toEqual(["我在"]);
    // 群里那条：会话已结束，标失败，没有为它起 claude
    await waitUntil("queued group message settled", () =>
      query<{ status: string }>("SELECT status FROM messages WHERE id = 2")[0]?.status === "failed" ? true : undefined,
    );
    expect(procsOf(2)).toEqual([]);
    expect(env.stdinTexts()).toEqual(["你好"]);
    // 同一个文件夹能在项目经理的会话里拿来建项目（老群的主文件夹不占路径）
    const created = await env.runHub(lastProcOf(1).pid, ["project", "create", "--folder", foo]);
    expect(created.code).toBe(0);
    await terminate(daemon);
  });

  it("结束会话（session.end，留给 M3 结束 Worker 会话）：这一轮回完才退出，令牌作废成 401，health 里没有 session_ended", async () => {
    env = makeEnv();
    // 第一个回合（默认项目经理的）卡在 gate 上；之后的回合（阿周的）马上回
    const gate = join(env.dir, "gate");
    env.setScript({ turns: [{ steps: [{ waitFile: gate }, { text: "这一轮说完了" }] }], defaultTurn: quick("在") });
    const { daemon, client, privateId } = await boot();
    const zhou = await client.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯" });
    const id = await client.post(privateId, "说一段长的");
    await waitForStatus(client, id, "processing");
    const session = sessionsOf(await client.state(), privateId)[0]!;
    const pid = lastProcOf(session.sessionId).pid;
    const token = tokenOf(pid);
    // 账本现在没有登记 session.end 的地方：直接写进动作表，再让阿周那边的一条消息把执行器叫醒
    const db = openDatabase(join(env.home, "state", "hub.sqlite"));
    try {
      const t = Date.now();
      db.run(
        "INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES ('session.end', ?, ?, ?, ?, ?)",
        `${session.sessionId}:${session.generation}`,
        JSON.stringify({ sessionId: session.sessionId, generation: session.generation }),
        t,
        t,
        t,
      );
    } finally {
      db.close();
    }
    await waitForStatus(client, await client.post(zhou.conversationId, "在吗"), "replied");
    await waitUntil("session.end running", () =>
      query<{ status: string }>("SELECT status FROM actions WHERE type = 'session.end'")[0]?.status === "running" ? true : undefined,
    );
    // 不打断这一轮：进程还在、消息还在处理中，令牌还能用
    expect(isAlive(pid)).toBe(true);
    expect(messageById(await client.state(), id)!.status).toBe("processing");
    expect((await rawHub(token, "status", {})).status).toBe(200);

    writeFileSync(gate, "");
    await waitForStatus(client, id, "replied");
    await waitUntil("session ended", async () => (sessionsOf(await client.state(), privateId)[0]!.status === "ended" ? true : undefined));
    await waitUntil("claude exited", () => (isAlive(pid) ? undefined : true));
    expect(env.log().filter((e) => e.pid === pid).map((e) => e.kind)).toContain("stdin_closed");
    expect(agentTexts(await client.state(), privateId)).toEqual(["这一轮说完了"]);
    expect(await rawHub(token, "status", {})).toEqual({ status: 401, body: expect.objectContaining({ ok: false, code: "unauthorized" }) });
    expect((await env.runHub(pid, ["status"])).code).toBe(1);
    for (const h of (await client.state()).health) expect(h.lastError ?? "").not.toMatch(/session_ended/);
    expect(query<{ type: string; status: string }>("SELECT type, status FROM actions").filter((a) => a.status !== "done")).toEqual([]);
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
    expect(result.stderr).toContain(`连不上 ${PRODUCT_NAME}`);
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
    // 不读的话收不到 end，也就等不到 close
    socket.resume();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(HUB_REQUEST_TIMEOUT_MS - 1_000);
    expect(elapsed).toBeLessThan(HUB_REQUEST_TIMEOUT_MS + 5_000);
    await terminate(daemon);
  });
});
