// 输入框的“/”命令在驱动层的部分（docs/composer-commands.md 实测，composer-plan 第 5 节 23～26）：
// 问正在跑的会话要命令列表、会话中途推来的新名单、/compact 的 compact_boundary、conversation_reset，
// 以及写进去的格式：我们加的字各占一块在前，用户原文单独放最后一块；以 / 开头的不和别的拼。
import { afterEach, describe, expect, it } from "vitest";
import { RELAUNCH_NOTE, RESEND_NOTE, RESTART_RECOVERY_NOTE } from "../../shared/index.ts";
import { makeHarness, realSleep, type Harness, type HarnessOptions } from "./test-helpers.ts";

const TAG = "【用户直接对你说】";
// 形状照真 claude 的 initialize 回应（T1）
const COMMANDS = [
  { name: "x", description: "probe command x (project)", argumentHint: "word" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
  { name: "y", description: "probe skill y (project)", argumentHint: "" },
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const harness = (options: HarnessOptions = {}) => (h = makeHarness(options));
const user = (id: number, text: string, extra: { prefixes?: string[]; resend?: boolean; recovery?: boolean } = {}) => ({
  messageIds: [id],
  source: "user" as const,
  text,
  ...extra,
});
const slowTurn = (ms: number) => ({ steps: [{ sleepMs: ms }, { text: "好了" }] });

describe("问正在跑的会话要命令列表（Driver.queryCommands）", () => {
  it("没有进程：返回 null，不为它起进程", async () => {
    const t = harness({ script: { commands: COMMANDS } });
    const s = t.addSession();
    await expect(t.driver.queryCommands(s.id)).resolves.toBeNull();
    expect(t.argvs()).toHaveLength(0);
  });

  it("一轮结束后再问：往同一个进程写 initialize，回通用形状（没去掉隐藏的，argumentHint 空的不给）", async () => {
    const t = harness({ script: { commands: COMMANDS } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const commands = await t.driver.queryCommands(s.id);
    expect(commands).toEqual([
      { name: "x", description: "probe command x (project)", argumentHint: "word" },
      { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>" },
      { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]" },
      { name: "y", description: "probe skill y (project)" },
    ]);
    expect(t.argvs()).toHaveLength(1);
    const controls = t.log().flatMap((e) => (e.kind === "stdin" && JSON.parse(e.line).type === "control_request" ? [JSON.parse(e.line)] : []));
    expect(controls.map((c) => c.request.subtype)).toEqual(["initialize"]);
  });

  it("一轮进行中也能问，不影响这一轮", async () => {
    const t = harness({ script: { commands: COMMANDS, turns: [slowTurn(400)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写很久"));
    await t.waitFor("message.processing");
    expect((await t.driver.queryCommands(s.id))?.map((c) => c.name)).toEqual(["x", "compact", "clear", "y"]);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, messageIds: [1] });
  });

  it("回了错误、一直不回（超时）：null，会话照常", async () => {
    const t = harness({ script: { control: "error" } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    await expect(t.driver.queryCommands(s.id)).resolves.toBeNull();

    const t2 = makeHarness({ script: { ignoreControl: true }, driver: { commandsTimeoutMs: 200 } });
    try {
      const s2 = t2.addSession();
      await t2.driver.send(s2.id, user(1, "hi"));
      await t2.waitFor("turn.ended");
      await expect(t2.driver.queryCommands(s2.id)).resolves.toBeNull();
      await expect(t2.driver.send(s2.id, user(2, "还在吗"))).resolves.toEqual({ kind: "written" });
    } finally {
      await t2.cleanup();
    }
  });

  it("system/commands_changed（带完整名单）→ commands.changed，换成通用形状", async () => {
    const changed = { type: "system", subtype: "commands_changed", commands: [{ name: "newcmd", description: "new (project)", argumentHint: "" }, ...COMMANDS] };
    const t = harness({ script: { turns: [{ steps: [{ raw: JSON.stringify(changed) }, { text: "ok" }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const event = await t.waitFor("commands.changed");
    expect(event.commands.map((c) => c.name)).toEqual(["newcmd", "x", "compact", "clear", "y"]);
    expect(t.of("driver.error")).toEqual([]);
  });
});

describe("/compact（实测 T7）", () => {
  it("compact_boundary → context.compacted；摘要、local-command-stdout 那两条 user 事件不当消息；这一轮正常结束、没有文字", async () => {
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "s",
      uuid: "cb-1",
      compact_metadata: { trigger: "manual", pre_tokens: 29305, post_tokens: 10321, duration_ms: 4941 },
    };
    const summary = { type: "user", message: { role: "user", content: "This session is being continued from a previous conversation ..." } };
    const stdout = { type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } };
    const t = harness({
      script: {
        turns: [
          {
            steps: [
              { raw: JSON.stringify({ type: "system", subtype: "status", status: "compacting" }) },
              { raw: JSON.stringify(boundary) },
              { raw: JSON.stringify(summary) },
              { raw: JSON.stringify(stdout) },
            ],
            result: { result: "" },
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "/compact"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, interrupted: false, messageIds: [1] });
    expect(t.of("context.compacted")).toEqual([
      expect.objectContaining({ type: "context.compacted", uuid: "cb-1", trigger: "manual", preTokens: 29305, postTokens: 10321 }),
    ]);
    expect(t.of("agent.text")).toEqual([]);
    expect(t.of("agent.tool_result")).toEqual([]);
    expect(t.of("driver.error")).toEqual([]);
  });

  it("conversation_reset（/clear 才有，网页和账本都拦着）：只记日志，不出错、不改会话", async () => {
    const lines: string[] = [];
    const reset = { type: "conversation_reset", new_conversation_id: "a5bb", trigger: "clear", session_id: "old" };
    const t = harness({ script: { turns: [{ steps: [{ raw: JSON.stringify(reset) }], result: { result: "" } }] }, driver: { log: (l) => lines.push(l) } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(lines.some((l) => l.includes("conversation_reset"))).toBe(true);
    expect(t.of("driver.error")).toEqual([]);
    expect(t.store.get(s.id)!.vendorSessionId).toBe(s.vendorSessionId);
  });
});

describe("写进去的格式：加的字在前面的块，原文单独放最后一块（实测 T4）", () => {
  it("23：Worker 对话里用户发 /x 参数：标签一块，原文 /x 参数 是最后一块", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "/x 参数", { prefixes: [TAG] }));
    await t.waitFor("turn.ended");
    expect(t.stdinBlocks()).toEqual([[TAG, "/x 参数"]]);
  });

  it("没有标签的普通消息还是一块", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");
    expect(t.stdinBlocks()).toEqual([["你好"]]);
  });

  it("24：忙时连发，/ 开头的不和别的拼，按顺序单独写；不是命令的照旧拼成“【用户连发了 N 条】”", async () => {
    const t = harness({ script: { turns: [slowTurn(500)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    for (const [id, text] of [[2, "补充一"], [3, "补充二"], [4, "/x 一"], [5, "补充三"], [6, "/y 二"], [7, "/z 三"]] as const) {
      await expect(t.driver.send(s.id, user(id, text))).resolves.toEqual({ kind: "queued" });
    }
    await t.waitFor("turn.ended", undefined, 6);
    expect(t.stdinBlocks()).toEqual([["开始"], ["【用户连发了 2 条】", "1. 补充一", "2. 补充二"], ["/x 一"], ["补充三"], ["/y 二"], ["/z 三"]]);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2, 3], [4], [5], [6], [7]]);
  });

  it("连发拼一条时每一条的标签、重发说明和以前一样在那一条里（Worker 看每条带不带标签认是谁说的）", async () => {
    const t = harness({ script: { turns: [slowTurn(400)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.driver.send(s.id, user(2, "你好", { prefixes: [TAG], resend: true }));
    await t.driver.send(s.id, user(3, "再说一句", { prefixes: [TAG] }));
    await t.driver.send(s.id, user(4, "项目经理的话"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()[1]).toEqual([
      "【用户连发了 3 条】",
      `1. ${RESEND_NOTE}\n\n${TAG}\n你好`,
      `2. ${TAG}\n再说一句`,
      "3. 项目经理的话",
    ]);
  });

  it("25：重启恢复的第一条是 /x：恢复说明、重发说明、标签各一块，/x 仍在最后一块的开头", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "/x 参数", { prefixes: [TAG], resend: true, recovery: true }));
    await t.waitFor("turn.ended");
    expect(t.stdinBlocks()).toEqual([[RESTART_RECOVERY_NOTE, RESEND_NOTE, TAG, "/x 参数"]]);
  });

  it("25：两轮之间设置变了自动重启：重启说明一块在前，/x 在最后一块", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "changed";
    await t.driver.send(s.id, user(2, "/x 二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()).toEqual([["一"], [RELAUNCH_NOTE, "/x 二"]]);
    expect(t.argvs()).toHaveLength(2);
  });

  it("前面有空格的不算命令（实测 T4 的 F），照常和别的拼", async () => {
    const t = harness({ script: { turns: [slowTurn(300)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.driver.send(s.id, user(2, " /x 一"));
    await t.driver.send(s.id, user(3, "补充"));
    await t.waitFor("turn.ended", undefined, 2);
    await realSleep(50);
    expect(t.stdinBlocks()[1]).toEqual(["【用户连发了 2 条】", "1.  /x 一", "2. 补充"]);
  });
});
