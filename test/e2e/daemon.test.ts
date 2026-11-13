// W5 端到端（m1-plan 第 4 节“W5 组装 + 端到端”）：真守护进程 + 假 claude，临时数据目录。
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, CRASH_RECOVERY_NOTE, RESEND_NOTE, RESTART_RECOVERY_NOTE, isDeviceId, type Attachment } from "../../src/shared/index.ts";
import { AGENTS_NOTE, DEFAULT_PM_NAME, HUB_USAGE_PROMPT, buildPmModePrompt } from "../../src/daemon/prompt.ts";
import { taskGraphSkillMarkdown } from "../../src/shared/task-graph-skill.ts";
import {
  Client,
  agentTexts,
  isAlive,
  makeEnv,
  messageById,
  messagesOf,
  sleep,
  waitForStatus,
  waitUntil,
  type E2eEnv,
  type RunningDaemon,
} from "./harness.ts";

const slow = (ms: number, text = "慢慢写完了") => ({ steps: [{ sleepMs: ms }, { text }] });
const quick = (text = "好的") => ({ steps: [{ text }] });

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function boot(options?: Parameters<E2eEnv["start"]>[0]) {
  const daemon = await env.start(options);
  const client = await Client.login(daemon);
  const state = await client.state();
  const conversationId = state.conversations[0]!.conversation.id;
  return { daemon, client, state, conversationId };
}

async function terminate(daemon: RunningDaemon) {
  return daemon.terminate();
}

const fakePids = () => env.argvs().map((a) => a.pid);

describe("W5 组装 + 端到端", () => {
  it("首次启动：打印登录链接，自动建一个项目经理和它的私聊；再启动不重复建", async () => {
    env = makeEnv();
    const { daemon, client, state } = await boot();
    expect(daemon.stdout()).toMatch(/http:\/\/127\.0\.0\.1:\d+\/auth\?token=/);
    expect(state.pms.map((p) => p.name)).toEqual([DEFAULT_PM_NAME]);
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]!.conversation).toMatchObject({ kind: "pm", pmId: state.pms[0]!.id });
    expect(state.conversations[0]!.messages).toEqual([]);
    expect(state.sessions).toHaveLength(1);
    // 新建的项目经理没有默认性格设定，文件是空的
    expect(readFileSync(join(env.home, "state", "personas", `pm-${state.pms[0]!.id}.md`), "utf8")).toBe("");

    // 联机：设备身份第一次生成；Linux 上另听给 tailscale serve 的 socket（0600），关掉后删掉
    const device = JSON.parse(readFileSync(join(env.home, "state", "device.json"), "utf8")) as { id: string; name: string };
    expect(isDeviceId(device.id)).toBe(true);
    const uiSock = join(env.home, "run", "ui.sock");
    if (process.platform === "linux") expect(statSync(uiSock).mode & 0o777).toBe(0o600);
    else expect(existsSync(uiSock)).toBe(false);

    expect(await terminate(daemon)).toEqual({ code: 0, signal: null });
    expect(existsSync(uiSock)).toBe(false);
    const again = await env.start();
    const s2 = await client.withPort(again.port).state();
    expect(s2.pms).toHaveLength(1);
    expect(s2.conversations).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(env.home, "state", "device.json"), "utf8"))).toEqual(device);
    await terminate(again);
  });

  it("聊一轮：WebSocket 收到回复；假 claude 的工作目录是 pm-home/<编号>/；提示词有角色说明、模式、hub 用法和性格设定", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("你好，我是项目经理") });
    const { daemon, client, state, conversationId } = await boot();
    const ws = await client.ws(state.seq);
    const id = await client.post(conversationId, "你好");
    await waitForStatus(client, id, "replied");
    await waitUntil("agent text over ws", () =>
      ws.messages.some((m) => m.type === "message.created" && m.data.message.text === "你好，我是项目经理")
        ? true
        : undefined,
    );
    // 状态按顺序走过已送达、处理中、已回复
    const statuses = ws.messages.flatMap((m) =>
      m.type === "message.updated" && m.data.message.id === id ? [m.data.message.status] : [],
    );
    expect(statuses).toEqual(["delivered", "processing", "replied"]);
    ws.close();

    const pmId = state.pms[0]!.id;
    const [launch] = env.argvs();
    expect(launch!.cwd).toBe(realpathSync(join(env.home, "pm-home", String(pmId))));
    const argv = launch!.argv;
    const promptFile = argv[argv.indexOf("--append-system-prompt-file") + 1]!;
    expect(promptFile).toBe(join(env.home, "state", "launch", String(state.sessions[0]!.sessionId), "prompt.md"));
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain(`你是用户的项目经理“${DEFAULT_PM_NAME}”`);
    // 模式那一节：第 2 步“建图”那条写着这个会话启动目录里的任务图手册路径（launch.ts 给的）
    const skillFile = join(env.home, "state", "launch", String(state.sessions[0]!.sessionId), "skills", "fusa-task-graph", "SKILL.md");
    expect(prompt).toContain(buildPmModePrompt("manage_only", "claude", skillFile));
    expect(readFileSync(skillFile, "utf8")).toBe(taskGraphSkillMarkdown());
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(join(env.home, "state", "launch", String(state.sessions[0]!.sessionId), "claude-plugin"));
    // hub 用法里 --vendor 只列这台设备上能用的厂商（看机器装了哪些），比到那里为止
    expect(prompt).toContain(HUB_USAGE_PROMPT.slice(0, HUB_USAGE_PROMPT.indexOf("[--vendor ")));
    expect(prompt).not.toContain("# 性格设定");
    // pm-home 里没有 CLAUDE.md：不加“先读 AGENTS.md”
    expect(prompt).not.toContain(AGENTS_NOTE);
    // 不限制 MCP：不带这两个参数，claude 按默认方式加载用户的连接器
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    // 用户的消息原样写进去，不加标签
    expect(env.stdinTexts()).toEqual(["你好"]);
    await terminate(daemon);
  });

  it("停止：控制消息打断这一轮，消息标已停止，进程还在，再发照常回复", async () => {
    env = makeEnv();
    env.setScript({ turns: [slow(20_000)], defaultTurn: quick("你好呀") });
    const { daemon, client, conversationId } = await boot();
    const id = await client.post(conversationId, "写一篇 1500 字的文章");
    await waitForStatus(client, id, "processing");
    expect(await client.stop(conversationId)).toBe(202);
    await waitForStatus(client, id, "stopped");
    const next = await client.post(conversationId, "你好");
    await waitForStatus(client, next, "replied");
    expect(agentTexts(await client.state(), conversationId)).toContain("你好呀");
    // 同一个进程：只起过一次，没收到 SIGINT，标准输入里有 interrupt 控制消息
    expect(env.argvs()).toHaveLength(1);
    expect(env.log().some((e) => e.kind === "signal")).toBe(false);
    expect(env.log().some((e) => e.kind === "stdin" && e.line.includes('"interrupt"'))).toBe(true);
    await terminate(daemon);
  });

  it("断网重试：session.status 带重试信息（最新一次），重试中点停止能停，停完信息清掉", async () => {
    env = makeEnv();
    env.setScript({
      turns: [
        {
          steps: [
            { apiRetry: { attempt: 1, maxRetries: 10, retryDelayMs: 1_000, errorStatus: null, error: "unknown" } },
            { apiRetry: { attempt: 2, maxRetries: 10, retryDelayMs: 2_000, errorStatus: null, error: "unknown" } },
            { sleepMs: 20_000 },
          ],
        },
      ],
    });
    const { daemon, client, state, conversationId } = await boot();
    const ws = await client.ws(state.seq);
    const id = await client.post(conversationId, "查一下");
    const sessionStates = () => ws.messages.flatMap((m) => (m.type === "session.status" ? [m.data.session] : []));
    await waitUntil("retry 2 pushed", () => (sessionStates().some((x) => x.apiRetry?.attempt === 2) ? true : undefined));
    expect(sessionStates().at(-1)).toMatchObject({
      activity: "working",
      apiRetry: { attempt: 2, maxRetries: 10, errorStatus: null, error: "unknown" },
    });
    expect((await client.state()).sessions[0]?.apiRetry).toMatchObject({ attempt: 2 });
    expect(await client.stop(conversationId)).toBe(202);
    await waitForStatus(client, id, "stopped");
    await waitUntil("retry cleared", async () => ((await client.state()).sessions[0]?.apiRetry === null ? true : undefined));
    expect((await client.state()).sessions[0]).toMatchObject({ activity: "idle", apiRetry: null });
    ws.close();
    await terminate(daemon);
  });

  it("断网重试用完（result 是 is_error）：消息标失败、原因是 claude 给的话；重试信息清掉；再发照常", async () => {
    env = makeEnv();
    env.setScript({
      turns: [
        {
          steps: [{ apiRetry: { attempt: 10, maxRetries: 10, errorStatus: null, error: "unknown" } }],
          result: { subtype: "success", isError: true, result: "API Error: Unable to connect to API (ConnectionRefused)" },
        },
      ],
      defaultTurn: quick("网通了"),
    });
    const { daemon, client, conversationId } = await boot();
    const id = await client.post(conversationId, "查一下");
    const failed = await waitForStatus(client, id, "failed");
    expect(failed.failureReason).toBe("API Error: Unable to connect to API (ConnectionRefused)");
    expect((await client.state()).sessions[0]).toMatchObject({ activity: "idle", apiRetry: null });
    const next = await client.post(conversationId, "再来");
    await waitForStatus(client, next, "replied");
    await terminate(daemon);
  });

  it("停止：没有在跑的会话时什么也不做，仍回 202；对话不存在回 404", async () => {
    env = makeEnv();
    const { daemon, client, conversationId } = await boot();
    expect(await client.stop(conversationId)).toBe(202);
    expect(await client.stop(9999)).toBe(404);
    expect(env.argvs()).toHaveLength(0);
    await terminate(daemon);
  });

  it("忙时连发：一轮还没完时发的两条，下一轮拼成一条写进去，两条都标已回复", async () => {
    env = makeEnv();
    // 第一轮卡在 gate 上，两条补充都发出去了再放行（不用睡固定时间：机器忙时补充发得慢，一轮可能已经跑完）
    const gate = join(env.dir, "gate");
    env.setScript({ turns: [{ steps: [{ waitFile: gate }, { text: "第一轮" }] }, quick("两条补充都收到")] });
    const { daemon, client, conversationId } = await boot();
    const first = await client.post(conversationId, "写一个很长的东西");
    await waitForStatus(client, first, "processing");
    const a = await client.post(conversationId, "补充一");
    const b = await client.post(conversationId, "补充二");
    // HTTP 返回只证明消息已入库；执行器稍后才会交给驱动层。
    // 两个 session.send 都执行过并安排了忙时重查，才能保证下一轮合并。
    const db = new DatabaseSync(join(env.home, "state", "hub.sqlite"), { readOnly: true });
    try {
      await waitUntil("两条补充都已进入驱动队列", () => {
        const rows = db.prepare("SELECT json_extract(params, '$.messageId') AS id FROM actions WHERE type = 'session.send' AND status = 'pending' AND next_attempt_at > updated_at").all();
        return rows.some((r) => r.id === a) && rows.some((r) => r.id === b) ? true : undefined;
      });
    } finally {
      db.close();
    }
    writeFileSync(gate, "");
    await waitForStatus(client, first, "replied");
    await waitForStatus(client, a, "replied");
    await waitForStatus(client, b, "replied");
    // “【用户连发了 N 条】”和每一条各占一个 text 块（docs/composer-commands.md 的 T4）
    expect(env.stdinBlocks()).toEqual([["写一个很长的东西"], ["【用户连发了 2 条】", "1. 补充一", "2. 补充二"]]);
    expect(agentTexts(await client.state(), conversationId)).toEqual(["第一轮", "两条补充都收到"]);
    await terminate(daemon);
  });

  it("正常重启：SIGTERM 退出码 0、不留进程；再启动令牌和 cookie 仍然有效，历史都在，用 --resume 同一个会话", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("记住了") });
    const first = await boot();
    const id = await first.client.post(first.conversationId, "记住暗号：蓝鲸");
    await waitForStatus(first.client, id, "replied");
    expect(await terminate(first.daemon)).toEqual({ code: 0, signal: null });
    expect(fakePids().filter(isAlive)).toEqual([]);
    expect(existsSync(join(env.home, "state", "lock"))).toBe(false);

    const daemon = await env.start();
    expect(daemon.token).toBe(first.daemon.token);
    const client = first.client.withPort(daemon.port);
    const before = await client.state();
    expect(messagesOf(before, first.conversationId).map((m) => m.text)).toEqual(["记住暗号：蓝鲸", "记住了"]);
    const next = await client.post(first.conversationId, "暗号是什么");
    await waitForStatus(client, next, "replied");
    const [a, b] = env.argvs().map((x) => x.argv);
    const sessionId = a![a!.indexOf("--session-id") + 1];
    expect(b![b!.indexOf("--resume") + 1]).toBe(sessionId);
    // 正常重启不补发：没有恢复说明、重发说明
    expect(env.stdinTexts()).toEqual(["记住暗号：蓝鲸", "暗号是什么"]);
    expect(await terminate(daemon)).toEqual({ code: 0, signal: null });
    expect(fakePids().filter(isAlive)).toEqual([]);
  });

  it("关机：一轮中 SIGTERM，假 claude 收到 SIGINT，10 秒内全部退出，消息标已停止", async () => {
    env = makeEnv();
    env.setScript({ turns: [slow(30_000)] });
    const { daemon, client, conversationId } = await boot();
    const id = await client.post(conversationId, "写很久");
    await waitForStatus(client, id, "processing");
    const t0 = Date.now();
    expect(await terminate(daemon)).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(env.log().filter((e) => e.kind === "signal").map((e) => (e as { signal: string }).signal)).toEqual(["SIGINT"]);
    expect(fakePids().filter(isAlive)).toEqual([]);

    const again = await env.start();
    const state = await client.withPort(again.port).state();
    expect(messageById(state, id)?.status).toBe("stopped");
    // 已停止的不补发
    await sleep(300);
    expect(env.argvs()).toHaveLength(1);
    await terminate(again);
  });

  it("守护进程崩溃：一轮中 SIGKILL，再启动结束留下的假 claude，带恢复说明重发，消息不重复、不丢", async () => {
    env = makeEnv();
    env.setScript({ turns: [slow(30_000)], defaultTurn: quick("接着做完了") });
    const first = await boot();
    const id = await first.client.post(first.conversationId, "做一件长的事");
    await waitForStatus(first.client, id, "processing");
    first.daemon.child.kill("SIGKILL");
    await first.daemon.exited;
    const [orphan] = fakePids();
    if (process.platform !== "win32") expect(isAlive(orphan!)).toBe(true);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await waitUntil("stale claude killed", () => (isAlive(orphan!) ? undefined : true));
    await waitForStatus(client, id, "replied");
    // 按行：重启后只写了一行，恢复说明、重发说明和原文在同一行
    expect(env.stdinTexts()).toEqual(["做一件长的事", `${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n做一件长的事`]);
    const users = messagesOf(await client.state(), first.conversationId).filter((m) => m.sender === "user");
    expect(users.map((m) => m.id)).toEqual([id]);
    // 留下的进程被结束，之后起的进程用 --resume
    const argvs = env.argvs();
    expect(argvs.length).toBeGreaterThanOrEqual(2);
    expect(argvs.at(-1)!.argv).toContain("--resume");
    await terminate(daemon);
    expect(fakePids().filter(isAlive)).toEqual([]);
  });

  it("claude 崩溃：这一轮的消息标失败带原因；下一条带崩溃说明，照常回复", async () => {
    env = makeEnv();
    env.setScript({ turns: [{ steps: [{ exit: 1 }] }], defaultTurn: quick("我回来了") });
    const { daemon, client, conversationId } = await boot();
    const id = await client.post(conversationId, "第一条");
    const failed = await waitForStatus(client, id, "failed");
    expect(failed.failureReason).toMatch(/^crash/);
    const next = await client.post(conversationId, "第二条");
    await waitForStatus(client, next, "replied");
    // 按行：崩溃说明和下一条写在同一行；崩溃那一轮的消息标了失败，不再重发
    expect(env.stdinTexts()).toEqual(["第一条", `${CRASH_RECOVERY_NOTE}\n\n第二条`]);
    expect(isAlive(daemon.child.pid!)).toBe(true);
    await terminate(daemon);
  });

  it("找不到 claude：守护进程不崩，界面实时看到“找不到 claude”，重试用完消息标失败", { timeout: 40_000 }, async () => {
    env = makeEnv();
    const { daemon, client, state, conversationId } = await boot({ vendorPath: join(env.dir, "no-such-claude") });
    const ws = await client.ws(state.seq);
    const id = await client.post(conversationId, "你好");
    const health = await waitUntil("health.updated over ws", () =>
      ws.messages.flatMap((m) => (m.type === "health.updated" ? [m.data.health] : [])).find((h) => h.module === "driver"),
    );
    expect(health.lastError).toMatch(/^claude_not_found: /);
    ws.close();
    const failed = await waitForStatus(client, id, "failed", 30_000);
    expect(failed.failureReason).toMatch(/^claude_not_found: /);
    const s = await client.state();
    expect(s.health.find((h) => h.module === "driver")).toMatchObject({ consecutiveFailures: 3 });
    expect(isAlive(daemon.child.pid!)).toBe(true);
    expect(await terminate(daemon)).toEqual({ code: 0, signal: null });
  });

  it("开两个：已有一个在跑时再启动，第二个报“已有守护进程在跑”并退出，第一个不受影响", async () => {
    env = makeEnv();
    const { daemon, client } = await boot();
    const second = await env.runToExit();
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("已有守护进程在跑");
    expect(second.stdout).not.toMatch(/auth\?token=/);
    expect((await client.state()).pms).toHaveLength(1);
    expect(await terminate(daemon)).toEqual({ code: 0, signal: null });
  });
});

describe("聊天框上传文件", () => {
  it("先上传、再发消息：文件存在数据目录的 uploads/，claude 收到的正文带着文件的完整绝对路径；老消息和普通消息不受影响", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: quick("看到了") });
    const { daemon, client, conversationId } = await boot();
    const res = await fetch(client.base + `${API_PATHS.uploads}?name=${encodeURIComponent("../便签.txt")}`, {
      method: "POST",
      headers: client.headers({ "content-type": "application/octet-stream" }),
      body: Buffer.from("暗号：蓝鲸"),
    });
    expect(res.status).toBe(200);
    const attachment = (await res.json()) as Attachment;
    expect(attachment.name).toBe("便签.txt");
    expect(attachment.path.startsWith(`${realpathSync.native(join(env.home, "uploads"))}${sep}`)).toBe(true);
    expect(readFileSync(attachment.path, "utf8")).toBe("暗号：蓝鲸");

    const posted = await fetch(client.base + API_PATHS.messages(conversationId), {
      method: "POST",
      headers: client.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId: "f1", text: "看看这个", attachmentIds: [attachment.id] }),
    });
    expect(posted.status).toBe(200);
    const { messageId } = (await posted.json()) as { messageId: number };
    await waitForStatus(client, messageId, "replied");

    const sent = env.stdinTexts().at(-1)!;
    expect(sent.startsWith("看看这个")).toBe(true);
    expect(sent).toContain(attachment.path);
    // 界面看到的还是用户写的原文，附件在 meta 里
    const shown = messageById(await client.state(), messageId);
    expect(shown?.text).toBe("看看这个");
    // 服务端确认送达后还带送达回执（这一条是 replied，网页只在 failed 时读它）
    expect(shown?.meta).toEqual({ attachments: [attachment], deliveryConfirmed: true });

    // 只有文件没有文字
    const only = await fetch(client.base + API_PATHS.messages(conversationId), {
      method: "POST",
      headers: client.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId: "f2", text: "", attachmentIds: [attachment.id] }),
    });
    expect(only.status).toBe(200);
    await waitForStatus(client, ((await only.json()) as { messageId: number }).messageId, "replied");
    expect(env.stdinTexts().at(-1)).toContain(attachment.path);
    await terminate(daemon);
  });
});
