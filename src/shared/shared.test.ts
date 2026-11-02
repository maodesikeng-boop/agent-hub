import { describe, expect, it } from "vitest";
import {
  ACTION_RETRY,
  API_PATHS,
  CHANGE_TYPES,
  MESSAGE_STATUSES,
  actionDedupeKey,
  retryDelayMs,
} from "./index.ts";
import { resolveHubPaths } from "./paths.ts";

describe("动作", () => {
  it("去重键：启动按（会话，第几代），发消息按消息编号", () => {
    expect(actionDedupeKey({ type: "session.start", params: { sessionId: 7, generation: 2 } })).toBe("7:2");
    expect(actionDedupeKey({ type: "session.send", params: { sessionId: 7, messageId: 42, source: "user" } })).toBe("42");
  });

  it("启动动作：5 秒起翻倍，封顶 5 分钟，共试 3 次", () => {
    const policy = ACTION_RETRY["session.start"];
    expect(policy.maxAttempts).toBe(3);
    expect(retryDelayMs(policy, 1)).toBe(5_000);
    expect(retryDelayMs(policy, 2)).toBe(10_000);
    expect(retryDelayMs(policy, 10)).toBe(300_000);
  });
});

describe("约定好的名字", () => {
  it("消息状态和变化类型", () => {
    expect(MESSAGE_STATUSES).toEqual(["queued", "delivered", "processing", "replied", "stopped", "failed"]);
    expect(CHANGE_TYPES).toEqual(["message.created", "message.updated", "session.status"]);
  });

  it("接口路径", () => {
    expect(API_PATHS.state).toBe("/api/state");
    expect(API_PATHS.messages(3)).toBe("/api/conversations/3/messages");
    expect(API_PATHS.stop(3)).toBe("/api/conversations/3/stop");
    expect(API_PATHS.ws).toBe("/api/ws");
    expect(API_PATHS.auth).toBe("/auth");
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
