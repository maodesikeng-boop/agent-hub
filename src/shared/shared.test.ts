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
  PM_PERSONA_TEMPLATE,
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
  personaOrTemplate,
  systemMessageDedupeKey,
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
} from "./index.ts";
import {
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
  hubCommandAllowed,
  normalizeWorkerTitle,
  truncateChars,
  workerEventOf,
  workerMessageDedupeKey,
} from "./index.ts";
import { launchFingerprint } from "./launch.ts";
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
    ];
    for (const [from, to] of ok) expect(canTransitionMessage(from as never, to as never), `${from}→${to}`).toBe(true);
    const bad: [string, string][] = [
      ["delivered", "queued"],
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
    expect(resolveHubPaths({}, "/home/u").home).toBe(`/home/u/${DATA_DIR_NAME}`);
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

  it("新建项目经理的性格设定模板不是空的", () => {
    expect(PM_PERSONA_TEMPLATE.trim().length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(PM_PERSONA_TEMPLATE).length).toBeLessThan(MAX_PERSONA_BYTES);
  });

  it("性格设定模板不替模式做主：不叫它“动手或给建议”，把怎么推进交给默认做法", () => {
    expect(PM_PERSONA_TEMPLATE).not.toContain("再动手或给建议");
    expect(PM_PERSONA_TEMPLATE).toContain("默认做法");
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
    expect(SYSTEM_EVENTS).toEqual(["project.created", "folder.attached", "folder.detached", "persona.changed"]);
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
      "project.created",
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
      "project.create",
      "project.attach",
      "project.detach",
      "persona.show",
      "persona.edit",
      "worker.start",
      "worker.send",
      "worker.end",
      "worker.list",
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

  it("性格设定正文是 NULL（M1 升上来还没同步）时用模板兜底", () => {
    expect(personaOrTemplate(null)).toBe(PM_PERSONA_TEMPLATE);
    expect(personaOrTemplate("")).toBe("");
    expect(personaOrTemplate("我的习惯")).toBe("我的习惯");
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
    expect(systemMessageDedupeKey(7, { event: "project.created", projectId: 1 })).not.toBe(systemMessageDedupeKey(2, { event: "project.created", projectId: 1 }));
    expect(systemMessageDedupeKey(1, { event: "persona.changed", pmId: 1, personaChangeId: 9, revertOf: null })).toBe(
      "system:1:persona.changed:9",
    );
  });
});

describe("M2：两轮之间自动重启", () => {
  it("重启后下一条消息前加的说明以【系统】开头", () => {
    expect(RELAUNCH_NOTE.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
  });

  it("重启说明说得通用：设置刚更新过、已经按新设置重新启动，不只列文件夹", () => {
    expect(RELAUNCH_NOTE).toContain("刚更新过");
    expect(RELAUNCH_NOTE).toContain("已经按新设置重新启动");
    for (const what of ["性格设定", "模式", "文件夹", "管着的项目"]) expect(RELAUNCH_NOTE).toContain(what);
  });

  it("指纹只看内容：同样的输入两次算出来一样，任何一样变了就不一样", () => {
    const input = { prompt: "你是项目经理", settings: '{"a":1}', mcpConfig: "{}" };
    expect(launchFingerprint(input)).toBe(launchFingerprint({ ...input }));
    expect(launchFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(launchFingerprint({ ...input, prompt: "你是项目经理。" })).not.toBe(launchFingerprint(input));
    expect(launchFingerprint({ ...input, settings: null })).not.toBe(launchFingerprint(input));
    expect(launchFingerprint({ ...input, mcpConfig: "{ }" })).not.toBe(launchFingerprint(input));
    // 拼接边界不会撞：内容挪到另一段算不一样
    expect(launchFingerprint({ prompt: "ab", settings: "c", mcpConfig: "" })).not.toBe(
      launchFingerprint({ prompt: "a", settings: "bc", mcpConfig: "" }),
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
    expect(WORKER_EVENTS).toEqual(["started", "report", "turn_failed", "worktree_failed", "ended"]);
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
      repo: string;
      branch: string;
      worktreePath: string;
      status: "open" | "ended";
    }>();
    expectTypeOf<Ledger["getWorktreeTask"]>().toEqualTypeOf<(workerId: number) => WorktreeTask | null>();
    expectTypeOf<Ledger["onWorktreeCreated"]>().toEqualTypeOf<(workerId: number, baseCommit: string) => void>();
  });
});

describe("M3：hub 命令按角色放行", () => {
  it("Worker 只能用 status；其他全是项目经理的", () => {
    expect(HUB_COMMAND_ROLES).toEqual({
      status: ["pm", "worker"],
      "project.create": ["pm"],
      "project.attach": ["pm"],
      "project.detach": ["pm"],
      "persona.show": ["pm"],
      "persona.edit": ["pm"],
      "worker.start": ["pm"],
      "worker.send": ["pm"],
      "worker.end": ["pm"],
      "worker.list": ["pm"],
    });
    expect(hubCommandAllowed("worker", "status")).toBe(true);
    expect(hubCommandAllowed("worker", "persona.edit")).toBe(false);
    expect(hubCommandAllowed("worker", "worker.start")).toBe(false);
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
