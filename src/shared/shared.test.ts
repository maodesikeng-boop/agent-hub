import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACTION_RETRY,
  DEFAULT_PM_MODE,
  DRIVER_ERROR_CODES,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
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
  PROJECT_STATUSES,
  SYSTEM_EVENTS,
  SYSTEM_MESSAGE_PREFIX,
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
  HEALTH_MODULES,
  HUB_CALL_FIELD_MAX_BYTES,
  RELAUNCH_NOTE,
  systemMessageDedupeKey,
  retryDelayMs,
  userMessageDedupeKey,
  MAX_ACTIVE_GRAPHS_PER_PROJECT,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
  emptyRouterSlice,
  pendingDecisionsOf,
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
  PmId,
  SessionEndParams,
  SessionSendParams,
  SessionStartParams,
  SessionState,
  SessionTokens,
  PersonaView,
  LaunchContext,
  WorkerRecord,
  WorkerMessageMeta,
  WorktreeCreateParams,
  WorktreeTask,
  SetupOutcome,
} from "./index.ts";
import {
  ASK_MAX_OPTION_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  CONVERSATION_KINDS,
  HUB_COMMAND_ROLES,
  MAX_TASK_BYTES,
  MAX_WORKER_TITLE_CHARS,
  WORKER_STATUSES,
  WORKER_WORKSPACES,
  WORKER_BRANCH_SLUG_CHARS,
  WORKER_EVENTS,
  WORKER_MESSAGE_KIND,
  MAX_MESSAGE_BYTES,
  askOf,
  extractAskCard,
  hubCommandAllowed,
  normalizeWorkerTitle,
  truncateChars,
  validateAskOptions,
  workerEventOf,
  workerMessageDedupeKey,
} from "./index.ts";
import { launchFingerprint } from "./launch.ts";
import { parseLocalHref, sentFileMime } from "./sent-files.ts";
import { DATA_DIR_NAME } from "./names.ts";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  assertSocketPathFits,
  personaFilePath,
  projectWorktreesDir,
  resolveHubPaths,
  workerWorktreePath,
} from "./paths.ts";

describe("动作", () => {
  it("去重键：启动按（会话，第几代），发消息按消息编号", () => {
    expect(actionDedupeKey({ type: "session.start", params: { sessionId: 7, generation: 2 } })).toBe("7:2");
    expect(actionDedupeKey({ type: "session.send", params: { sessionId: 7, messageId: 42, source: "user" } })).toBe("42");
  });

  it("恢复和重发的标记不进去重键：同一个动作重新登记会重置那一行", () => {
    expect(
      actionDedupeKey({ type: "session.send", params: { sessionId: 7, messageId: 42, source: "user", resend: true, recovery: true } }),
    ).toBe("42");
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
      if (row.type === "worktree.create") {
        expectTypeOf(row.params).toEqualTypeOf<WorktreeCreateParams>();
        return row.params.workerId * 100;
      }
      expectTypeOf(row.params).toEqualTypeOf<SessionSendParams>();
      return row.params.messageId;
    };
    const base = { id: 1, dedupeKey: "x", status: "failed", attempts: 3, nextAttemptAt: 0, lastError: "e", createdAt: 0, updatedAt: 0 } as const;
    expect(narrow({ ...base, type: "session.start", params: { sessionId: 1, generation: 4 } })).toBe(4);
    expect(narrow({ ...base, type: "session.end", params: { sessionId: 1, generation: 2 } })).toBe(-2);
    expect(narrow({ ...base, type: "session.send", params: { sessionId: 1, messageId: 9, source: "user" } })).toBe(9);
    expect(narrow({ ...base, type: "worktree.create", params: { workerId: 3 } })).toBe(300);
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

  it("状态只能按规定的方向走；failed 能回到 queued（用户点重试）或 delivered（重启后重发写进去了）", () => {
    const ok: [string, string][] = [
      ["queued", "delivered"],
      ["delivered", "processing"],
      ["processing", "replied"],
      ["processing", "stopped"],
      ["processing", "failed"],
      ["queued", "failed"],
      ["queued", "stopped"],
      ["delivered", "stopped"],
      ["delivered", "failed"],
      ["failed", "delivered"],
      ["failed", "queued"],
      // 一轮中途写给 agent、它还没取走：停止 → 已取消；进程没了 → 收回排队
      ["delivered", "cancelled"],
      ["queued", "cancelled"],
      ["delivered", "queued"],
    ];
    for (const [from, to] of ok) expect(canTransitionMessage(from as never, to as never), `${from}→${to}`).toBe(true);
    const bad: [string, string][] = [
      ["processing", "queued"],
      ["processing", "cancelled"],
      ["cancelled", "queued"],
      ["cancelled", "delivered"],
      ["processing", "delivered"],
      ["replied", "delivered"],
      ["stopped", "delivered"],
      ["replied", "failed"],
      ["queued", "replied"],
      ["replied", "queued"],
      ["stopped", "queued"],
      ["processing", "processing"],
    ];
    for (const [from, to] of bad) expect(canTransitionMessage(from as never, to as never), `${from}→${to}`).toBe(false);
  });

  it("会扩展的枚举在代码里校验", () => {
    expect(isOneOf(MESSAGE_KINDS, "tool")).toBe(true);
    expect(isOneOf(MESSAGE_KINDS, "card")).toBe(false);
    expect(isOneOf(MESSAGE_SENDERS, "agent")).toBe(true);
    expect(isOneOf(ACTION_TYPES, "session.send")).toBe(true);
    expect(isOneOf(ACTION_TYPES, "worktree.remove")).toBe(false);
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

  it("send 的结果只有四种", () => {
    expectTypeOf<DriverSendResult["kind"]>().toEqualTypeOf<"written" | "queued" | "cancelled" | "rejected">();
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
    expect(MESSAGE_STATUSES).toEqual(["queued", "delivered", "processing", "replied", "stopped", "failed", "cancelled"]);
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
    expect(resolveHubPaths({}, "/home/u").home).toBe(`/home/u/${DATA_DIR_NAME}`);
    const paths = resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u");
    expect(paths.home).toBe("/tmp/x");
    expect(paths.dbFile).toBe("/tmp/x/state/hub.sqlite");
    expect(paths.lockFile).toBe("/tmp/x/state/lock");
    expect(paths.uiTokenFile).toBe("/tmp/x/state/ui-token");
    expect(paths.launchDir).toBe("/tmp/x/state/launch");
    expect(paths.pmHomeDir).toBe("/tmp/x/pm-home");
  });

  it("聊天框上传的文件放在 uploads/，不放进项目文件夹", () => {
    expect(resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u").uploadsDir).toBe("/tmp/x/uploads");
    expect(resolveHubPaths({}, "/home/u").uploadsDir).toBe(`/home/u/${DATA_DIR_NAME}/uploads`);
  });

  it("agent 发给用户的文件的副本放在 sent-files/", () => {
    expect(resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u").sentFilesDir).toBe("/tmp/x/sent-files");
  });

  it("claude 的路径用 AGENT_HUB_CLAUDE 改，默认找 PATH 里的 claude", () => {
    expect(resolveHubPaths({}, "/home/u").vendorPaths.claude).toBe("claude");
    expect(resolveHubPaths({ AGENT_HUB_CLAUDE: "/tmp/fake" }, "/home/u").vendorPaths.claude).toBe("/tmp/fake");
  });
});

// ---- M2：项目经理、项目、性格设定、agent 接口 ----

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

  it("项目状态、改性格设定的人", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "archived", "deleted"]);
    expect(PERSONA_ACTORS).toEqual(["user", "pm", "file"]);
  });
});

describe("M2：名字", () => {
  it("去掉首尾空白；空的、太长的、带换行或控制字符的不行", () => {
    expect(normalizeName("  foo  ")).toBe("foo");
    expect(normalizeName("小林")).toBe("小林");
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeName("a\nb")).toBeNull();
    expect(normalizeName("a\u0007b")).toBeNull();
    // 行分隔符、段分隔符、C1 控制字符也不行（会把提示词、日志里的一行拆开）
    expect(normalizeName("a\u2028b")).toBeNull();
    expect(normalizeName("a\u2029b")).toBeNull();
    expect(normalizeName("a\u0085b")).toBeNull();
    expect(normalizeName("a\u009fb")).toBeNull();
    expect(normalizeName("a\u00a0b")).toBe("a\u00a0b");
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
    workerId: null,
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

  it("所有系统消息事件都列出来了；11-03 拿掉的 project.reassigned 认不出（老数据当普通系统消息显示）", () => {
    expect(SYSTEM_EVENTS).toEqual([
      "project.created",
      "folder.attached",
      "folder.detached",
      "persona.changed",
      "schedule.created",
      "schedule.removed",
      "schedule.run",
      "schedule.failed",
      "handover.requested",
      "session.renewed",
      "handover.failed",
      "context.compacted",
      "driver.warning",
      "worker.max_time_exceeded",
    ]);
    expect(systemEventOf(msg({ sender: "system", text: "x", meta: { event: "project.reassigned", projectId: 1, handoffId: 1 } }))).toBeNull();
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
    expect(LEDGER_ERROR_CODES).toEqual(["invalid", "not_found", "forbidden", "conflict", "git_failed"]);
    expect(LEDGER_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409, git_failed: 409 });
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
      const r = ledger.hubCall(1, "project.create", { folder: "/x" });
      expectTypeOf(r.data).toEqualTypeOf<HubData<"project.create">>();
      // @ts-expect-error 11-03 拿掉了交接
      ledger.hubCall(1, "project.assign", { project: "foo", to: "阿周", handoff: "x" });
    };
    expect(typed).toBeTypeOf("function");
  });
});

describe("M2：界面接口", () => {
  it("新路径", () => {
    expect(API_PATHS.pms).toBe("/api/pms");
    expect("projects" in API_PATHS).toBe(false);
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
      "pm.removed",
      "project.created",
      "folders.updated",
      "conversation.created",
      "conversation.purged",
      "session.created",
      "schedule.updated",
      "schedule.removed",
      "router.settings.updated",
      "router.item.created",
      "router.item.updated",
      "router.reports.archived_all",
      "router.note.updated",
      "router.command.created",
      "router.command.updated",
      "task_graph.created",
      "task_graph.updated",
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
      "project.create",
      "project.attach",
      "project.detach",
      "project.setup",
      "persona.show",
      "persona.edit",
      "worker.start",
      "worker.send",
      "worker.max-time",
      "worker.end",
      "worker.list",
      "worker.show",
      "worker.log",
      "worker.search",
      "models",
      "ask",
      "schedule.add",
      "schedule.list",
      "schedule.pause",
      "schedule.resume",
      "schedule.remove",
      "router.ask",
      "router.report",
      "router.note",
      "graph.create",
      "graph.show",
      "graph.list",
      "graph.ask",
      "graph.patch",
      "graph.done",
      "graph.decide",
      "graph.skip",
      "graph.cancel",
    ]);
    expect(hubPath("project.create")).toBe("/v1/project.create");
    expect(ENV_HUB_TOKEN).toBe("HUB_TOKEN");
    expect(ENV_HUB_SOCK).toBe("HUB_SOCK");
  });

  it("退出码：0 成功，1 系统拒绝，2 用法不对，3 连不上", () => {
    expect(HUB_EXIT).toEqual({ ok: 0, rejected: 1, usage: 2, unreachable: 3, internal: 4 });
  });

  it("错误码到 HTTP 状态：账本的五种 + 令牌不对 + 守护进程自己出错", () => {
    expect(HUB_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409, git_failed: 409, unauthorized: 401, internal: 500 });
  });

  it("应答按 ok 收窄", () => {
    const read = (r: HubResponse<"status">) => (r.ok ? r.data.pm.name : r.code);
    expect(read({ ok: true, text: "", data: { role: "worker", pm: { id: 1, name: "小林" }, sessionId: 9, conversationId: 10, worker: {} as never, project: {} as never } })).toBe("小林");
    expect(read({ ok: false, code: "unauthorized", message: "令牌无效" })).toBe("unauthorized");
  });
});

describe("M2：数据目录", () => {
  it("run/、hub.sock、hub 外壳目录、性格设定", () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u");
    expect(paths.runDir).toBe("/tmp/x/run");
    expect(paths.hubSock).toBe("/tmp/x/run/hub.sock");
    expect(paths.hubBinDir).toBe("/tmp/x/run/bin");
    expect(paths.personasDir).toBe("/tmp/x/state/personas");
    expect("handoffsDir" in paths).toBe(false);
  });

  it("性格设定文件的位置", () => {
    expect(personaFilePath("/s/personas", 3)).toBe("/s/personas/pm-3.md");
  });
});

// ---- M2 W0 审查后补的 ----

describe("M2：会话状态带第几代", () => {
  it("SessionState 有 generation；网页、账本要“当前会话”时取最大的那一代", () => {
    expectTypeOf<SessionState["generation"]>().toEqualTypeOf<number>();
  });

  it("SessionState 带 pmId（总助、Worker 是 null）", () => {
    expectTypeOf<SessionState["pmId"]>().toEqualTypeOf<PmId | null>();
  });
});

describe("M2：令牌和性格设定的接口形状", () => {
  it("SessionTokens：issue、resolve、revoke", () => {
    expectTypeOf<SessionTokens["issue"]>().toEqualTypeOf<(sessionId: SessionId) => string>();
    expectTypeOf<SessionTokens["resolve"]>().toEqualTypeOf<(token: string) => SessionId | null>();
    expectTypeOf<SessionTokens["revoke"]>().toEqualTypeOf<(sessionId: SessionId) => void>();
  });

  it("PersonaView 带能撤销的那一条的编号", () => {
    expectTypeOf<PersonaView["revertableChangeId"]>().toEqualTypeOf<number | null>();
  });
});

describe("M2：健康状态", () => {
  it("agent 接口有自己的一行", () => {
    expect(HEALTH_MODULES).toContain("agent-api");
  });
});

describe("M2：系统消息的去重键", () => {
  it("按（对话，事件，相关编号）", () => {
    expect(systemMessageDedupeKey(2, { event: "project.created", projectId: 1 })).toBe("system:2:project.created:1");
    expect(systemMessageDedupeKey(2, { event: "folder.attached", projectId: 1, folderId: 5, path: "/x" })).toBe("system:2:folder.attached:5");
    expect(systemMessageDedupeKey(2, { event: "folder.detached", projectId: 1, folderId: 5, path: "/x" })).toBe("system:2:folder.detached:5");
    expect(systemMessageDedupeKey(2, { event: "schedule.created", scheduleId: 3, name: "日报" })).toBe("system:2:schedule.created:3");
    expect(systemMessageDedupeKey(2, { event: "schedule.removed", scheduleId: 3, name: "日报" })).toBe("system:2:schedule.removed:3");
    expect(systemMessageDedupeKey(2, { event: "schedule.run", scheduleId: 3, name: "日报", scheduledAt: 1000, catchUp: false })).toBe("system:2:schedule.run:3:1000");
    expect(systemMessageDedupeKey(2, { event: "schedule.failed", scheduleId: 3, name: "日报", messageId: 41 })).toBe("system:2:schedule.failed:41");
    expect(systemMessageDedupeKey(7, { event: "project.created", projectId: 1 })).not.toBe(systemMessageDedupeKey(2, { event: "project.created", projectId: 1 }));
    expect(systemMessageDedupeKey(1, { event: "persona.changed", pmId: 1, personaChangeId: 9, revertOf: null })).toBe(
      "system:1:persona.changed:9",
    );
    // 开新会话：每一代会话最多一条交接请求、一条换代
    expect(systemMessageDedupeKey(1, { event: "handover.requested", sessionId: 4 })).toBe("system:1:handover.requested:4");
    expect(systemMessageDedupeKey(1, { event: "session.renewed", sessionId: 5, fromSessionId: 4 })).toBe("system:1:session.renewed:5");
    expect(systemMessageDedupeKey(1, { event: "handover.failed", messageId: 8, attempt: 2 })).toBe("system:1:handover.failed:8.2");
  });
});

describe("M2：两轮之间自动重启", () => {
  it("重启后下一条消息前加的说明以【系统】开头", () => {
    expect(RELAUNCH_NOTE.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
  });

  it("重启说明说得通用：设置刚更新过、已经按新设置重新启动，不只列文件夹", () => {
    expect(RELAUNCH_NOTE).toContain("刚更新过");
    expect(RELAUNCH_NOTE).toContain("已经按新设置重新启动");
    for (const what of ["文件夹", "管着的项目", "模型", "思考程度"]) expect(RELAUNCH_NOTE).toContain(what);
    // 性格设定、模式变了不重启（下一条前面加说明，见 driver.ts）
    for (const gone of ["性格设定", "模式"]) expect(RELAUNCH_NOTE).not.toContain(gone);
  });

  it("指纹只看内容：同样的输入两次算出来一样，任何一样变了就不一样", () => {
    const input = { prompt: "你是项目经理", settings: '{"a":1}' };
    expect(launchFingerprint(input)).toBe(launchFingerprint({ ...input }));
    expect(launchFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(launchFingerprint({ ...input, prompt: "你是项目经理。" })).not.toBe(launchFingerprint(input));
    expect(launchFingerprint({ ...input, settings: null })).not.toBe(launchFingerprint(input));
    // 拼接边界不会撞：内容挪到另一段算不一样
    expect(launchFingerprint({ prompt: "ab", settings: "c" })).not.toBe(
      launchFingerprint({ prompt: "a", settings: "bc" }),
    );
  });
});

describe("M2：hub 调用记录", () => {
  it("args、result 里的长字段超过 2 KB 截断", () => {
    expect(HUB_CALL_FIELD_MAX_BYTES).toBe(2 * 1024);
  });
});

describe("M2：socket 路径长度", () => {
  it("macOS 上 Unix socket 路径最多 103 字节，超了报清楚的错", () => {
    expect(MAX_UNIX_SOCKET_PATH_BYTES).toBe(103);
    expect(() => assertSocketPathFits("/tmp/x/run/hub.sock")).not.toThrow();
    expect(() => assertSocketPathFits("/" + "a".repeat(102))).not.toThrow();
    expect(() => assertSocketPathFits("/" + "a".repeat(103))).toThrow(/104 字节.*103.*AGENT_HUB_HOME/);
    // 按 UTF-8 字节算
    expect(() => assertSocketPathFits("/" + "交".repeat(35))).toThrow(/106 字节/);
  });
});

// ---- M3 W0：Worker ----

describe("M3：对话和消息", () => {
  it("对话多一种 worker；消息多一种 kind worker、发送方多一种 pm", () => {
    expect(CONVERSATION_KINDS).toEqual(["assistant", "pm", "project_group", "worker"]);
    expect(MESSAGE_KINDS).toEqual(["text", "tool", "worker"]);
    expect(WORKER_MESSAGE_KIND).toBe("worker");
    expect(MESSAGE_SENDERS).toEqual(["user", "agent", "system", "pm"]);
  });

  it("那一行的事件", () => {
    expect(WORKER_EVENTS).toEqual(["started", "report", "turn_failed", "worktree_failed", "ended", "user_message"]);
  });

  it("workerEventOf：只认 kind worker 的消息", () => {
    const meta: WorkerMessageMeta = {
      workerId: 3,
      workerConversationId: 10,
      title: "修 X",
      readonly: false,
      event: "report",
      status: "done",
      summary: "好了",
    };
    expect(workerEventOf({ kind: "worker", meta })).toEqual(meta);
    expect(workerEventOf({ kind: "text", meta })).toBeNull();
    expect(workerEventOf({ kind: "worker", meta: null })).toBeNull();
    expect(workerEventOf({ kind: "worker", meta: { ...meta, event: "merged" } })).toBeNull();
  });

  it("那一行的去重键：派出、收工、建 worktree 失败每个 Worker 一条；汇报和出错按（事件，这一轮的消息）", () => {
    expect(workerMessageDedupeKey(3, "started", null)).toBe("worker:3:started");
    expect(workerMessageDedupeKey(3, "ended", null)).toBe("worker:3:ended");
    expect(workerMessageDedupeKey(3, "worktree_failed", null)).toBe("worker:3:worktree_failed");
    expect(workerMessageDedupeKey(3, "report", 41)).toBe("worker:3:report:41");
    expect(workerMessageDedupeKey(3, "turn_failed", 41)).toBe("worker:3:turn_failed:41");
    // 同一条消息先失败、重发后又跑出结果：后来的汇报不会因为键重复被吞掉
    expect(workerMessageDedupeKey(3, "report", 41)).not.toBe(workerMessageDedupeKey(3, "turn_failed", 41));
    expect(workerMessageDedupeKey(3, "report", 42)).not.toBe(workerMessageDedupeKey(3, "report", 41));
    expect(() => workerMessageDedupeKey(3, "report", null)).toThrow();
    // 用户直接对 Worker 说的话：每条用户消息一行
    expect(workerMessageDedupeKey(3, "user_message", 43)).toBe("worker:3:user_message:43");
    expect(() => workerMessageDedupeKey(3, "user_message", null)).toThrow();
  });
});

describe("M3：Worker 的记录", () => {
  it("状态、在哪干活", () => {
    expect(WORKER_STATUSES).toEqual(["open", "ended"]);
    expect(WORKER_WORKSPACES).toEqual(["worktree", "main"]);
  });

  it("形状和 workers 表的列一一对应", () => {
    expectTypeOf<keyof WorkerRecord>().toEqualTypeOf<
      | "id"
      | "projectId"
      | "pmId"
      | "pmConversationId"
      | "workerConversationId"
      | "title"
      | "task"
      | "model"
      | "effort"
      | "readonly"
      | "workspace"
      | "branch"
      | "worktreePath"
      | "baseCommit"
      | "status"
      | "createdAt"
      | "updatedAt"
    >();
    expectTypeOf<WorkerRecord["readonly"]>().toEqualTypeOf<boolean>();
    expectTypeOf<WorkerRecord["branch"]>().toEqualTypeOf<string | null>();
  });

  it("标题：去首尾空白，空的、带控制字符的不行；太长不报错，截断到 MAX_WORKER_TITLE_CHARS 个字符", () => {
    expect(normalizeWorkerTitle("  修 X  ")).toBe("修 X");
    expect(normalizeWorkerTitle("")).toBeNull();
    expect(normalizeWorkerTitle("   ")).toBeNull();
    expect(normalizeWorkerTitle("a\nb")).toBeNull();
    expect(normalizeWorkerTitle("字".repeat(MAX_WORKER_TITLE_CHARS))).toBe("字".repeat(MAX_WORKER_TITLE_CHARS));
    expect(normalizeWorkerTitle("字".repeat(MAX_WORKER_TITLE_CHARS + 1))).toBe(`${"字".repeat(MAX_WORKER_TITLE_CHARS - 1)}…`);
    // 按 Unicode 字符截，不切开代理对
    expect([...normalizeWorkerTitle("😀".repeat(MAX_WORKER_TITLE_CHARS + 5))!]).toHaveLength(MAX_WORKER_TITLE_CHARS);
  });

  it("truncateChars：按字符截断，超了末尾换成…", () => {
    expect(truncateChars("abc", 3)).toBe("abc");
    expect(truncateChars("abcd", 3)).toBe("ab…");
    expect(truncateChars("😀😀😀😀", 2)).toBe("😀…");
  });

  it("可调的数", () => {
    expect(MAX_WORKER_TITLE_CHARS).toBe(80);
    expect(MAX_TASK_BYTES).toBe(MAX_MESSAGE_BYTES);
    expect(WORKER_BRANCH_SLUG_CHARS).toBe(30);
  });
});

describe("M3：动作", () => {
  it("建 worktree：按 Worker 编号去重，重试 3 次", () => {
    expect(ACTION_TYPES).toContain("worktree.create");
    expect(actionDedupeKey({ type: "worktree.create", params: { workerId: 3 } })).toBe("3");
    expect(ACTION_RETRY["worktree.create"].maxAttempts).toBe(3);
    expectTypeOf<WorktreeCreateParams>().toEqualTypeOf<{ workerId: number }>();
  });

  it("账本给处理函数的“要建什么”", () => {
    expectTypeOf<WorktreeTask>().toEqualTypeOf<{
      workerId: number;
      sessionId: number;
      repo: string;
      branch: string;
      worktreePath: string;
      status: "open" | "ended";
      setupCommand: string | null;
    }>();
    expectTypeOf<Ledger["getWorktreeTask"]>().toEqualTypeOf<(workerId: number) => WorktreeTask | null>();
    expectTypeOf<Ledger["onSetupStarted"]>().toEqualTypeOf<(workerId: number) => boolean>();
    expectTypeOf<Ledger["waitsForFirstTurn"]>().toEqualTypeOf<(sessionId: number, messageId: number) => boolean>();
    expectTypeOf<Ledger["renewSession"]>().toEqualTypeOf<(pmId: number) => { handoverId: number }>();
    expectTypeOf<Ledger["waitsForHandover"]>().toEqualTypeOf<(messageId: number) => boolean>();
    expectTypeOf<Ledger["onWorktreeCreated"]>().toEqualTypeOf<(workerId: number, baseCommit: string, setup?: SetupOutcome) => void>();
  });
});

describe("M3：hub 命令按角色放行", () => {
  it("Worker 只能用 status；其他全是项目经理的", () => {
    expect(HUB_COMMAND_ROLES).toEqual({
      status: ["pm", "worker"],
      "project.create": ["pm"],
      "project.attach": ["pm"],
      "project.detach": ["pm"],
      "project.setup": ["pm"],
      "persona.show": ["pm"],
      "persona.edit": ["pm"],
      "worker.start": ["pm"],
      "worker.send": ["pm"],
      "worker.max-time": ["pm"],
      "worker.end": ["pm"],
      "worker.list": ["pm"],
      "worker.show": ["pm"],
      "worker.log": ["pm"],
      "worker.search": ["pm"],
      models: ["pm"],
      ask: ["pm"],
      "schedule.add": ["pm"],
      "schedule.list": ["pm"],
      "schedule.pause": ["pm"],
      "schedule.resume": ["pm"],
      "schedule.remove": ["pm"],
      "router.ask": ["pm"],
      "router.report": ["pm"],
      "router.note": ["pm"],
      "graph.create": ["pm"],
      "graph.show": ["pm"],
      "graph.list": ["pm"],
      "graph.ask": ["pm"],
      "graph.patch": ["pm"],
      "graph.done": ["pm"],
      "graph.decide": ["pm"],
      "graph.skip": ["pm"],
      "graph.cancel": ["pm"],
    });
    expect(hubCommandAllowed("worker", "status")).toBe(true);
    expect(hubCommandAllowed("worker", "persona.edit")).toBe(false);
    expect(hubCommandAllowed("worker", "worker.start")).toBe(false);
    expect(hubCommandAllowed("worker", "schedule.add")).toBe(false);
    expect(hubCommandAllowed("pm", "schedule.add")).toBe(true);
    expect(hubCommandAllowed("pm", "worker.start")).toBe(true);
    expect(hubCommandAllowed("assistant", "status")).toBe(false);
  });

  it("worker.* 的参数", () => {
    expectTypeOf<HubData<"worker.start">>().toEqualTypeOf<{ worker: WorkerRecord }>();
    expectTypeOf<HubData<"worker.list">>().toEqualTypeOf<{ workers: WorkerRecord[] }>();
  });
});

describe("M3：启动上下文", () => {
  it("带 worker：项目经理是 null，Worker 是它的记录", () => {
    expectTypeOf<LaunchContext["worker"]>().toEqualTypeOf<WorkerRecord | null>();
  });
});

describe("M3：数据目录", () => {
  it("worktrees/<项目编号>/<Worker 编号>", () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: "/tmp/x" }, "/home/u");
    expect(paths.worktreesDir).toBe("/tmp/x/worktrees");
    expect(projectWorktreesDir(paths.worktreesDir, 2)).toBe("/tmp/x/worktrees/2");
    expect(workerWorktreePath(paths.worktreesDir, 2, 7)).toBe("/tmp/x/worktrees/2/7");
  });
});

describe("agent 发给用户的文件：认本机路径（sent-files.ts）", () => {
  it.each([
    ["/tmp/a.png", { kind: "absolute", path: "/tmp/a.png" }],
    ["/tmp/%E5%9B%BE%20a.png", { kind: "absolute", path: "/tmp/图 a.png" }],
    ["/tmp/100%.txt", { kind: "absolute", path: "/tmp/100%.txt" }],
    ["/tmp/a#b.md", { kind: "absolute", path: "/tmp/a#b.md" }],
    ["file:///tmp/a%20b.png", { kind: "absolute", path: "/tmp/a b.png" }],
    ["FILE://localhost/tmp/a.png", { kind: "absolute", path: "/tmp/a.png" }],
    ["~/a.md", { kind: "home", path: "/a.md" }],
    ["docs/a.md", { kind: "relative", path: "docs/a.md" }],
    ["./a.md", { kind: "relative", path: "./a.md" }],
  ])("%j 是本机路径", (href, expected) => {
    expect(parseLocalHref(href)).toEqual(expected);
  });

  it.each(["https://x.y/a.png", "http://x", "mailto:a@b.c", "javascript:alert(1)", "//host/a", "#top", "?q", "", "file://host/a", "/a%00b"])(
    "%j 不是",
    (href) => {
      expect(parseLocalHref(href)).toBeNull();
    },
  );

  it("类型：位图、svg 是图片；pdf、md、csv、html 有类型但不内联；别的 octet-stream", () => {
    expect(sentFileMime("a.PNG")).toBe("image/png");
    expect(sentFileMime("a.svg")).toBe("image/svg+xml");
    expect(sentFileMime("a.pdf")).toBe("application/pdf");
    expect(sentFileMime("a.html")).toBe("text/html");
    expect(sentFileMime("a.exe")).toBe("application/octet-stream");
  });
});

describe("hub ask 选项卡片（askOf、validateAskOptions、extractAskCard）", () => {
  it("askOf：保留非空字符串数组 options，忽略非字符串或空数组", () => {
    expect(askOf({ sender: "agent", meta: { needsUser: true } })).toEqual({ needsUser: true });
    expect(askOf({ sender: "agent", meta: { needsUser: true, answered: true, options: ["甲", "乙"] } })).toEqual({
      needsUser: true,
      answered: true,
      options: ["甲", "乙"],
    });
    expect(askOf({ sender: "agent", meta: { needsUser: true, options: [] } })).toEqual({ needsUser: true });
    expect(askOf({ sender: "agent", meta: { needsUser: true, options: ["甲", 123] } })).toEqual({ needsUser: true });
  });

  it("validateAskOptions：2～10 个，去首尾空白，非空、无换行或控制字符、不超过 200 字符", () => {
    expect(validateAskOptions(["只有一个"])).toEqual({ ok: false, error: `选项至少要给 ${ASK_MIN_OPTIONS} 个` });
    expect(validateAskOptions(Array.from({ length: ASK_MAX_OPTIONS + 1 }, (_, i) => `选项 ${i}`))).toEqual({
      ok: false,
      error: `选项最多 ${ASK_MAX_OPTIONS} 个`,
    });
    expect(validateAskOptions(["  甲  ", "乙"])).toEqual({ ok: true, options: ["甲", "乙"] });
    expect(validateAskOptions(["甲", "   "])).toEqual({ ok: false, error: expect.stringContaining("不能为空") });
    expect(validateAskOptions(["甲", "乙\n丙"])).toEqual({ ok: false, error: expect.stringContaining("换行或控制字符") });
    expect(validateAskOptions(["甲", "x".repeat(ASK_MAX_OPTION_CHARS + 1)])).toEqual({
      ok: false,
      error: expect.stringContaining(`${ASK_MAX_OPTION_CHARS}`),
    });
  });

  it("extractAskCard：支持显式 meta.options 与 Markdown 列表自动提取，顺序 A/B/C 前缀自动去掉", () => {
    expect(
      extractAskCard({
        sender: "agent",
        meta: { needsUser: true, options: ["审一个 PR / 分支", "审本地代码路径"] },
        text: "  你想审什么？  ",
      }),
    ).toEqual({
      question: "你想审什么？",
      options: ["审一个 PR / 分支", "审本地代码路径"],
      answered: false,
    });

    expect(
      extractAskCard({
        sender: "agent",
        meta: { needsUser: true, answered: true },
        text: "用 **方案 A** 还是方案 B？\n\n- A：保留三栏\n- B：单栏信息流",
      }),
    ).toEqual({
      question: "用 **方案 A** 还是方案 B？",
      options: ["保留三栏", "单栏信息流"],
      answered: true,
    });

    expect(
      extractAskCard({
        sender: "agent",
        meta: { needsUser: true },
        text: "请选择环境：\n1. A. 预发环境\n2. B: 生产环境",
      }),
    ).toEqual({
      question: "请选择环境：",
      options: ["预发环境", "生产环境"],
      answered: false,
    });

    // 纯文本提问、只有 1 项列表、列表后还有段落、非 ask 消息 → null
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "再问一个" })).toBeNull();
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\n- 只有一项" })).toBeNull();
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\n- 选项一\n- 选项二\n\n补充说明" })).toBeNull();
    expect(extractAskCard({ sender: "agent", meta: null, text: "问题\n- 选项一\n- 选项二" })).toBeNull();
    // 普通列表（没有 A/B 前缀）只是列出几项请用户确认，不当单选题
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\n- 选项一\n- 选项二" })).toBeNull();
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\n1. 选项一\n2. 选项二" })).toBeNull();
    expect(
      extractAskCard({
        sender: "agent",
        meta: { needsUser: true },
        text: "准备部署 LibreTV，请确认以下配置：\n- **代码存放目录**: 默认 `~/LibreTV`\n- **部署方式**: 默认 **Docker Compose**\n- **访问密码 (`PASSWORD`)**: 默认设为 `libretv`",
      }),
    ).toBeNull();
    // 字母不从 A 开始或不连续 → null
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\n- B. 一\n- C. 二" })).toBeNull();
    // 不带列表符号的 A. / B. 行也算
    expect(extractAskCard({ sender: "agent", meta: { needsUser: true }, text: "问题\nA. 一\nB. 二" })).toEqual({
      question: "问题",
      options: ["一", "二"],
      answered: false,
    });
  });

  it("askOf：保留 gateRef 与 chosenOption", () => {
    expect(
      askOf({
        sender: "agent",
        meta: {
          needsUser: true,
          options: ["数组", "游标分页"],
          gateRef: { graphId: 7, nodeKey: "gate-api" },
          chosenOption: "游标分页",
          answered: true,
        },
      }),
    ).toEqual({
      needsUser: true,
      answered: true,
      options: ["数组", "游标分页"],
      gateRef: { graphId: 7, nodeKey: "gate-api" },
      chosenOption: "游标分页",
    });
  });
});

describe("Router 与任务图同源待决模型（decisions.ts & limits.ts）", () => {
  it("宽松安全水位常量符合审定值（不设低阈值卡脖子）", () => {
    expect(ROUTER_PENDING_DECISIONS_PER_PM_MAX).toBe(30);
    expect(MAX_ACTIVE_GRAPHS_PER_PROJECT).toBe(20);
    expect(ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX).toBe(50);
    expect(MAX_GRAPH_NODES).toBe(32);
    expect(MAX_GRAPH_EDGES).toBe(64);
  });

  it("pendingDecisionsOf：汇聚 waiting_user 门禁与无 gateRef 的独立待决项，自动去重，且 WeakMap 保持引用稳定", () => {
    const snap: Parameters<typeof pendingDecisionsOf>[0] = {
      pms: [{ id: 1, name: "小林", avatarFile: null, mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1 }],
      projects: [{ id: 2, name: "导出模块", description: null, status: "active", pmId: 1, conversationId: 1, createdAt: 1, updatedAt: 1 }],
      conversations: [
        {
          conversation: { id: 1, kind: "pm", pmId: 1, projectId: null, title: "小林", createdAt: 1 },
          messages: [
            {
              id: 50,
              conversationId: 1,
              sessionId: 1,
              workerId: null,
              sender: "agent",
              kind: "text",
              text: "接口怎么定？",
              meta: { needsUser: true, gateRef: { graphId: 10, nodeKey: "gate-api" } },
              collapsed: false,
              dedupeKey: "k1",
              status: null,
              failureReason: null,
              createdAt: 100,
              updatedAt: 100,
            },
          ],
          hasMore: false,
        },
      ],
      router: {
        ...emptyRouterSlice(),
        items: [
          {
            id: 1,
            kind: "decision",
            status: "pending",
            pmId: 1,
            projectId: 2,
            conversationId: 1,
            question: "要不要顺便升 Node 24？",
            context: "CI 镜像已支持",
            options: ["升", "先不升"],
            askMessageId: 51,
            resolution: null,
            createdAt: 200,
            updatedAt: 200,
          },
          // 若意外存在指向同一门禁消息 50 的 router_item，自动去重不重复产出
          {
            id: 2,
            kind: "decision",
            status: "pending",
            pmId: 1,
            projectId: 2,
            conversationId: 1,
            question: "重复项",
            context: "",
            options: ["A", "B"],
            askMessageId: 50,
            resolution: null,
            createdAt: 150,
            updatedAt: 150,
          },
        ],
      },
      activeTaskGraphs: [
        {
          id: 10,
          projectId: 2,
          pmId: 1,
          conversationId: 1,
          title: "导出 CSV",
          status: "active",
          originMsgId: null,
          createdAt: 100,
          updatedAt: 100,
          completedAt: null,
          nodes: [
            {
              key: "gate-api",
              title: "确认接口契约",
              kind: "gate",
              status: "waiting_user",
              sortOrder: 0,
              activeWorkerId: null,
              workerIds: [],
              artifact: null,
              gateQuestion: "接口返回数组还是游标分页？",
              gateOptions: ["数组", "游标分页"],
              gateSummaryMd: "数据量预计 5 万行",
              gateRecommended: "游标分页",
              gateAskMessageId: 50,
              decision: null,
              createdAt: 120,
              updatedAt: 120,
            },
            {
              key: "impl-api",
              title: "实现后端接口",
              kind: "piece",
              status: "pending",
              sortOrder: 1,
              activeWorkerId: null,
              workerIds: [],
              artifact: null,
              gateQuestion: null,
              gateOptions: [],
              gateSummaryMd: null,
              gateRecommended: null,
              gateAskMessageId: null,
              decision: null,
              createdAt: 100,
              updatedAt: 100,
            },
            {
              key: "e2e",
              title: "联调测试",
              kind: "piece",
              status: "pending",
              sortOrder: 2,
              activeWorkerId: null,
              workerIds: [],
              artifact: null,
              gateQuestion: null,
              gateOptions: [],
              gateSummaryMd: null,
              gateRecommended: null,
              gateAskMessageId: null,
              decision: null,
              createdAt: 100,
              updatedAt: 100,
            },
          ],
          edges: [
            { fromKey: "gate-api", toKey: "impl-api" },
            { fromKey: "impl-api", toKey: "e2e" },
          ],
        },
      ],
    };

    const first = pendingDecisionsOf(snap, "mac");
    const second = pendingDecisionsOf(snap, "mac");
    expect(second).toBe(first);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      key: "item:mac:1",
      question: "要不要顺便升 Node 24？",
      source: { kind: "router_item", itemId: 1 },
    });
    expect(first[1]).toMatchObject({
      key: "gate:mac:10:gate-api",
      question: "接口返回数组还是游标分页？",
      context: "数据量预计 5 万行",
      options: ["数组", "游标分页"],
      source: {
        kind: "gate",
        graphId: 10,
        nodeKey: "gate-api",
        blockedNodeCount: 2,
        nextNodeTitles: ["实现后端接口"],
        recommended: "游标分页",
      },
    });
  });
});
