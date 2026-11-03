import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACTION_RETRY,
  DEFAULT_PM_MODE,
  DRIVER_ERROR_CODES,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  HANDOFF_REASONS,
  HUB_COMMANDS,
  HUB_ERROR_HTTP_STATUS,
  HUB_EXIT,
  LEDGER_ERROR_CODES,
  LEDGER_ERROR_HTTP_STATUS,
  LedgerRequestError,
  MAX_NAME_CHARS,
  MAX_PERSONA_BYTES,
  PERSONA_ACTORS,
  PM_MODES,
  PM_MODE_LABELS,
  PM_PERSONA_TEMPLATE,
  PROJECT_STATUSES,
  SYSTEM_EVENTS,
  SYSTEM_MESSAGE_PREFIX,
  buildHubSettings,
  hubPath,
  isQuotaExhausted,
  normalizeName,
  stripSystemPrefix,
  systemEventOf,
  utf8Bytes,
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
  Driver,
  HubData,
  HubResponse,
  LaunchFiles,
  Project,
  ProjectFolder,
  RateLimitInfo,
  SessionId,
  StateSnapshot,
  SystemMessageMeta,
  AnyActionRow,
  DriverSendResult,
  Ledger,
  Message,
  SessionEndParams,
  SessionSendParams,
  SessionStartParams,
} from "./index.ts";
import { handoffFilePath, personaFilePath, resolveHubPaths } from "./paths.ts";

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
      if (row.type === "session.end") {
        expectTypeOf(row.params).toEqualTypeOf<SessionEndParams>();
        return -row.params.generation;
      }
      expectTypeOf(row.params).toEqualTypeOf<SessionSendParams>();
      return row.params.messageId;
    };
    const base = { id: 1, dedupeKey: "x", status: "failed", attempts: 3, nextAttemptAt: 0, lastError: "e", createdAt: 0, updatedAt: 0 } as const;
    expect(narrow({ ...base, type: "session.start", params: { sessionId: 1, generation: 4 } })).toBe(4);
    expect(narrow({ ...base, type: "session.end", params: { sessionId: 1, generation: 2 } })).toBe(-2);
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
    expect(CHANGE_TYPES.slice(0, 4)).toEqual(["message.created", "message.updated", "session.status", "health.updated"]);
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

// ---- M2：项目经理、项目、交接、性格设定、agent 接口 ----

describe("M2：额度", () => {
  it("只有 rejected 算用完；allowed_warning 只是快到了", () => {
    const info = (status: string): RateLimitInfo => ({ status, resetsAt: null, windows: {} });
    expect(isQuotaExhausted(info("allowed"))).toBe(false);
    expect(isQuotaExhausted(info("allowed_warning"))).toBe(false);
    expect(isQuotaExhausted(info("rejected"))).toBe(true);
    expect(isQuotaExhausted(null)).toBe(false);
    expect(isQuotaExhausted(undefined)).toBe(false);
  });
});

describe("M2：枚举", () => {
  it("两种模式，默认只管理", () => {
    expect(PM_MODES).toEqual(["manage_only", "hands_on"]);
    expect(DEFAULT_PM_MODE).toBe("manage_only");
    expect(PM_MODE_LABELS.manage_only).toBe("只管理");
    expect(PM_MODE_LABELS.hands_on).toBe("自己也干活");
    expect(isOneOf(PM_MODES, "default")).toBe(false);
  });

  it("项目状态、交接原因、改性格设定的人", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "archived", "deleted"]);
    expect(HANDOFF_REASONS).toEqual(["reassign"]);
    expect(PERSONA_ACTORS).toEqual(["user", "pm", "file"]);
  });

  it("新建项目经理的性格设定模板不是空的", () => {
    expect(PM_PERSONA_TEMPLATE.trim().length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(PM_PERSONA_TEMPLATE).length).toBeLessThan(MAX_PERSONA_BYTES);
  });
});

describe("M2：名字", () => {
  it("去掉首尾空白；空的、太长的、带换行或控制字符的不行", () => {
    expect(normalizeName("  foo  ")).toBe("foo");
    expect(normalizeName("小林")).toBe("小林");
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeName("a\nb")).toBeNull();
    expect(normalizeName("a\u0007b")).toBeNull();
    expect(normalizeName("x".repeat(MAX_NAME_CHARS))).toBe("x".repeat(MAX_NAME_CHARS));
    expect(normalizeName("x".repeat(MAX_NAME_CHARS + 1))).toBeNull();
    // 按字符数算，不按 UTF-16 单元
    expect(normalizeName("😀".repeat(MAX_NAME_CHARS))).not.toBeNull();
  });

  it("文字长度按 UTF-8 字节算", () => {
    expect(utf8Bytes("ab")).toBe(2);
    expect(utf8Bytes("交接")).toBe(6);
  });
});

describe("M2：系统消息", () => {
  const base: Omit<Message, "sender" | "text" | "meta"> = {
    id: 1,
    conversationId: 1,
    sessionId: null,
    ticketId: null,
    kind: "text",
    collapsed: false,
    dedupeKey: "k",
    status: null,
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const msg = (m: Pick<Message, "sender" | "text" | "meta">): Message => ({ ...base, ...m });

  it("按 meta.event 认出是哪种系统消息", () => {
    const meta: SystemMessageMeta = { event: "persona.changed", pmId: 1, personaChangeId: 7, revertOf: null };
    const event = systemEventOf(msg({ sender: "system", text: "项目经理改了自己的做事习惯", meta: { ...meta } }));
    expect(event).toEqual(meta);
    if (event?.event === "persona.changed") expectTypeOf(event.personaChangeId).toEqualTypeOf<number>();
  });

  it("不是系统消息、没有 event、event 不认识的都是 null", () => {
    expect(systemEventOf(msg({ sender: "agent", text: "x", meta: { event: "project.created", projectId: 1 } }))).toBeNull();
    expect(systemEventOf(msg({ sender: "system", text: "x", meta: null }))).toBeNull();
    expect(systemEventOf(msg({ sender: "system", text: "x", meta: { event: "nope" } }))).toBeNull();
  });

  it("所有系统消息事件都列出来了", () => {
    expect(SYSTEM_EVENTS).toEqual(["project.created", "folder.attached", "folder.detached", "project.reassigned", "persona.changed"]);
  });

  it("给 agent 看的系统消息以【系统】开头，网页显示时去掉", () => {
    expect(SYSTEM_MESSAGE_PREFIX).toBe("【系统】");
    expect(stripSystemPrefix("【系统】已挂上文件夹 /x")).toBe("已挂上文件夹 /x");
    expect(stripSystemPrefix("项目已建好")).toBe("项目已建好");
  });
});

describe("M2：动作", () => {
  it("结束会话：去重键是（会话，第几代），和启动一样的重试节奏", () => {
    expect(ACTION_TYPES).toContain("session.end");
    expect(actionDedupeKey({ type: "session.end", params: { sessionId: 7, generation: 1 } })).toBe("7:1");
    expect(ACTION_RETRY["session.end"]).toEqual(ACTION_RETRY["session.start"]);
  });

  it("会话已结束：不可重试的驱动层错误", () => {
    expect(DRIVER_ERROR_CODES).toContain("session_ended");
    expect(new DriverError("session_ended", "session 3").retryable).toBe(false);
  });

  it("LaunchFiles 带每次启动的环境变量和指纹", () => {
    expectTypeOf<LaunchFiles["env"]>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<LaunchFiles["fingerprint"]>().toEqualTypeOf<string>();
    expectTypeOf<Driver["end"]>().toEqualTypeOf<(sessionId: SessionId) => Promise<void>>();
  });
});

describe("M2：账本错误", () => {
  it("四种错误码，两个服务都映射成同样的 HTTP 状态", () => {
    expect(LEDGER_ERROR_CODES).toEqual(["invalid", "not_found", "forbidden", "conflict"]);
    expect(LEDGER_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409 });
    const e = new LedgerRequestError("conflict", "项目名 foo 已经有了");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LedgerRequestError");
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("项目名 foo 已经有了");
  });

  it("hubCall 的参数和返回跟着命令走", () => {
    type Call = Ledger["hubCall"];
    expectTypeOf<Parameters<Call>[0]>().toEqualTypeOf<SessionId>();
    const typed = (ledger: Ledger) => {
      const r = ledger.hubCall(1, "project.create", { name: "foo", folder: "/x" });
      expectTypeOf(r.data).toEqualTypeOf<HubData<"project.create">>();
      // @ts-expect-error project.assign 必须带交接正文
      ledger.hubCall(1, "project.assign", { project: "foo", to: "阿周" });
    };
    expect(typed).toBeTypeOf("function");
  });
});

describe("M2：界面接口", () => {
  it("新路径", () => {
    expect(API_PATHS.pms).toBe("/api/pms");
    expect(API_PATHS.projects).toBe("/api/projects");
    expect(API_PATHS.persona(3)).toBe("/api/pms/3/persona");
    expect(API_PATHS.revertPersonaChange(9)).toBe("/api/persona-changes/9/revert");
    expect(API_PATHS.retryMessage(42)).toBe("/api/messages/42/retry");
  });

  it("新变化类型", () => {
    expect(CHANGE_TYPES).toEqual([
      "message.created",
      "message.updated",
      "session.status",
      "health.updated",
      "pm.created",
      "pm.updated",
      "project.created",
      "project.updated",
      "folders.updated",
      "conversation.created",
      "session.created",
    ]);
  });

  it("快照里有项目和文件夹", () => {
    expectTypeOf<StateSnapshot["projects"]>().toEqualTypeOf<Project[]>();
    expectTypeOf<StateSnapshot["folders"]>().toEqualTypeOf<ProjectFolder[]>();
  });
});

describe("M2：agent 接口", () => {
  it("命令、路径、环境变量", () => {
    expect(HUB_COMMANDS).toEqual([
      "status",
      "pm.list",
      "project.create",
      "project.attach",
      "project.detach",
      "project.assign",
      "persona.show",
      "persona.edit",
    ]);
    expect(hubPath("project.create")).toBe("/v1/project.create");
    expect(ENV_HUB_TOKEN).toBe("HUB_TOKEN");
    expect(ENV_HUB_SOCK).toBe("HUB_SOCK");
  });

  it("退出码：0 成功，1 系统拒绝，2 用法不对，3 连不上", () => {
    expect(HUB_EXIT).toEqual({ ok: 0, rejected: 1, usage: 2, unreachable: 3 });
  });

  it("错误码到 HTTP 状态：账本的四种 + 令牌不对 + 守护进程自己出错", () => {
    expect(HUB_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409, unauthorized: 401, internal: 500 });
  });

  it("设置文件：放行 hub 命令和 socket 的真实路径", () => {
    expect(buildHubSettings("/private/tmp/x/run/hub.sock")).toEqual({
      permissions: { allow: ["Bash(hub:*)"] },
      sandbox: { network: { allowUnixSockets: ["/private/tmp/x/run/hub.sock"] } },
    });
  });

  it("应答按 ok 收窄", () => {
    const read = (r: HubResponse<"status">) => (r.ok ? r.data.pm.name : r.code);
    expect(read({ ok: false, code: "unauthorized", message: "令牌无效" })).toBe("unauthorized");
  });
});

describe("M2：数据目录", () => {
  it("run/、hub.sock、hub 外壳目录、性格设定、交接", () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u");
    expect(paths.runDir).toBe("/tmp/x/run");
    expect(paths.hubSock).toBe("/tmp/x/run/hub.sock");
    expect(paths.hubBinDir).toBe("/tmp/x/run/bin");
    expect(paths.personasDir).toBe("/tmp/x/state/personas");
    expect(paths.handoffsDir).toBe("/tmp/x/state/handoffs");
  });

  it("性格设定和交接文件的位置", () => {
    expect(personaFilePath("/s/personas", 3)).toBe("/s/personas/pm-3.md");
    expect(handoffFilePath("/s/handoffs", 5, Date.UTC(2026, 10, 3, 9, 8, 7, 6))).toBe("/s/handoffs/5/2026-11-03T09-08-07-006Z.md");
  });
});
