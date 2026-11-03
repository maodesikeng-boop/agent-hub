import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACTION_RETRY,
  ACTION_TYPES,
  API_PATHS,
  CHANGE_TYPES,
  ConversationNotFoundError,
  DriverError,
  MESSAGE_KINDS,
  MESSAGE_SENDERS,
  MESSAGE_STATUSES,
  RETRYABLE_DRIVER_ERRORS,
  UI_TOKEN_FILE_MODE,
  actionDedupeKey,
  agentMessageDedupeKey,
  canTransitionMessage,
  isOneOf,
  retryDelayMs,
  userMessageDedupeKey,
} from "./index.ts";
import type {
  AnyActionRow,
  DriverSendResult,
  Ledger,
  SessionSendParams,
  SessionStartParams,
} from "./index.ts";
import { resolveHubPaths } from "./paths.ts";

describe("动作", () => {
  it("去重键：启动按（会话，第几代），发消息按消息编号", () => {
    expect(actionDedupeKey({ type: "session.start", params: { sessionId: 7, generation: 2 } })).toBe("7:2");
    expect(actionDedupeKey({ type: "session.send", params: { sessionId: 7, messageId: 42, source: "user" } })).toBe("42");
  });

  it("恢复和重发的标记不进去重键：同一个动作重新登记会重置那一行", () => {
    expect(
      actionDedupeKey({ type: "session.start", params: { sessionId: 7, generation: 2, recovery: true } }),
    ).toBe("7:2");
    expect(
      actionDedupeKey({ type: "session.send", params: { sessionId: 7, messageId: 42, source: "user", resend: true } }),
    ).toBe("42");
  });

  it("启动动作：5 秒起翻倍，封顶 5 分钟，共试 3 次", () => {
    const policy = ACTION_RETRY["session.start"];
    expect(policy.maxAttempts).toBe(3);
    expect(retryDelayMs(policy, 1)).toBe(5_000);
    expect(retryDelayMs(policy, 2)).toBe(10_000);
    expect(retryDelayMs(policy, 10)).toBe(300_000);
  });

  it("AnyActionRow 按 type 收窄到对应的参数", () => {
    const narrow = (row: AnyActionRow) => {
      if (row.type === "session.start") {
        expectTypeOf(row.params).toEqualTypeOf<SessionStartParams>();
        return row.params.generation;
      }
      expectTypeOf(row.params).toEqualTypeOf<SessionSendParams>();
      return row.params.messageId;
    };
    const base = { id: 1, dedupeKey: "x", status: "failed", attempts: 3, nextAttemptAt: 0, lastError: "e", createdAt: 0, updatedAt: 0 } as const;
    expect(narrow({ ...base, type: "session.start", params: { sessionId: 1, generation: 4 } })).toBe(4);
    expect(narrow({ ...base, type: "session.send", params: { sessionId: 1, messageId: 9, source: "user" } })).toBe(9);
    // @ts-expect-error 类型和参数对不上
    const bad: AnyActionRow = { ...base, type: "session.start", params: { sessionId: 1, messageId: 9, source: "user" } };
    expect(bad).toBeDefined();
    expectTypeOf<Parameters<Ledger["onActionFailed"]>[0]>().toEqualTypeOf<AnyActionRow>();
  });
});

describe("消息", () => {
  it("去重键：用户消息带对话编号，agent 输出按（会话，uuid），工具再带 toolUseId", () => {
    expect(userMessageDedupeKey(3, "abc")).toBe("client:3:abc");
    expect(agentMessageDedupeKey(7, "u-1")).toBe("session:7:u-1");
    expect(agentMessageDedupeKey(7, "u-1", "toolu_1")).toBe("session:7:u-1:toolu_1");
  });

  it("状态只能按规定的方向走，只有 failed 能回到 delivered", () => {
    const ok: [string, string][] = [
      ["queued", "delivered"],
      ["delivered", "processing"],
      ["processing", "replied"],
      ["processing", "stopped"],
      ["processing", "failed"],
      ["queued", "failed"],
      ["delivered", "stopped"],
      ["delivered", "failed"],
      ["failed", "delivered"],
    ];
    for (const [from, to] of ok) expect(canTransitionMessage(from as never, to as never), `${from}→${to}`).toBe(true);
    const bad: [string, string][] = [
      ["delivered", "queued"],
      ["processing", "delivered"],
      ["replied", "delivered"],
      ["stopped", "delivered"],
      ["replied", "failed"],
      ["queued", "replied"],
      ["failed", "queued"],
      ["processing", "processing"],
    ];
    for (const [from, to] of bad) expect(canTransitionMessage(from as never, to as never), `${from}→${to}`).toBe(false);
  });

  it("会扩展的枚举在代码里校验", () => {
    expect(isOneOf(MESSAGE_KINDS, "tool")).toBe(true);
    expect(isOneOf(MESSAGE_KINDS, "card")).toBe(false);
    expect(isOneOf(MESSAGE_SENDERS, "agent")).toBe(true);
    expect(isOneOf(ACTION_TYPES, "session.send")).toBe(true);
    expect(isOneOf(ACTION_TYPES, "worktree.create")).toBe(false);
    expect(isOneOf(ACTION_TYPES, 42)).toBe(false);
  });
});

describe("驱动层错误", () => {
  it("起不来、找不到 claude 抛错交给执行器重试；写入校验没过不重试", () => {
    expect(RETRYABLE_DRIVER_ERRORS).toEqual(
      expect.arrayContaining(["spawn_failed", "claude_not_found", "start_timeout", "start_args_conflict"]),
    );
    expect(RETRYABLE_DRIVER_ERRORS).not.toContain("invalid_input");
    const e = new DriverError("claude_not_found", "no such file: /x/claude");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("claude_not_found");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("claude_not_found: no such file: /x/claude");
    expect(new DriverError("invalid_input", "bad role").retryable).toBe(false);
  });

  it("send 的结果只有三种", () => {
    expectTypeOf<DriverSendResult["kind"]>().toEqualTypeOf<"written" | "queued" | "rejected">();
  });
});

describe("账本错误", () => {
  it("对话不存在：带类型的错误，界面服务映射成 404", () => {
    const e = new ConversationNotFoundError(5);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("conversation_not_found");
    expect(e.conversationId).toBe(5);
  });
});

describe("约定好的名字", () => {
  it("消息状态和变化类型", () => {
    expect(MESSAGE_STATUSES).toEqual(["queued", "delivered", "processing", "replied", "stopped", "failed"]);
    expect(CHANGE_TYPES).toEqual(["message.created", "message.updated", "session.status", "health.updated"]);
  });

  it("接口路径", () => {
    expect(API_PATHS.state).toBe("/api/state");
    expect(API_PATHS.messages(3)).toBe("/api/conversations/3/messages");
    expect(API_PATHS.stop(3)).toBe("/api/conversations/3/stop");
    expect(API_PATHS.ws).toBe("/api/ws");
    expect(API_PATHS.auth).toBe("/auth");
  });

  it("界面令牌文件只有自己能读写", () => {
    expect(UI_TOKEN_FILE_MODE).toBe(0o600);
  });
});

describe("数据目录", () => {
  it("默认在用户目录下的 .agent-hub，AGENT_HUB_HOME 可改", () => {
    expect(resolveHubPaths({}, "/home/u").home).toBe("/home/u/.agent-hub");
    const paths = resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u");
    expect(paths.home).toBe("/tmp/x");
    expect(paths.dbFile).toBe("/tmp/x/state/hub.sqlite");
    expect(paths.lockFile).toBe("/tmp/x/state/lock");
    expect(paths.uiTokenFile).toBe("/tmp/x/state/ui-token");
    expect(paths.sessionLogsDir).toBe("/tmp/x/state/logs/sessions");
    expect(paths.launchDir).toBe("/tmp/x/state/launch");
    expect(paths.pmHomeDir).toBe("/tmp/x/pm-home");
  });

  it("claude 的路径用 AGENT_HUB_CLAUDE 改，默认找 PATH 里的 claude", () => {
    expect(resolveHubPaths({}, "/home/u").claudePath).toBe("claude");
    expect(resolveHubPaths({ AGENT_HUB_CLAUDE: "/tmp/fake" }, "/home/u").claudePath).toBe("/tmp/fake");
  });
});
