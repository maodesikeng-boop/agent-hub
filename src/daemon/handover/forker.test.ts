import { describe, expect, it } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import type { AgentSessionRow } from "../../shared/domain.ts";
import { ForkUnsupportedError, findForker, forkSourceOf, withoutHubEnv } from "./forker.ts";
import type { ForkerRegistry, SessionForker } from "./forker.ts";
import { FORKERS } from "./forkers.ts";

const fake = (id: string): SessionForker => ({
  id,
  kind: "native",
  fork: async () => ({ forkId: "f" }),
  write: async () => ({ text: "", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } }),
  remove: async () => {},
});

describe("FORKERS：每家厂商一份办法清单", () => {
  it("键正好是 AGENT_VENDORS；每家清单里的 id 不重复", () => {
    expect(Object.keys(FORKERS).sort()).toEqual([...AGENT_VENDORS].sort());
    for (const vendor of AGENT_VENDORS) {
      const ids = FORKERS[vendor].map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("漏一家厂商编译不过", () => {
    // @ts-expect-error 少了 agy
    const missing: ForkerRegistry = { claude: [], codex: [] };
    expect(missing).toBeDefined();
  });
});

describe("findForker：按 fork_ref 里记的 id 找回当初复制的那个办法（重启后清理用）", () => {
  it("找得到返回它；厂商不认识、id 不在清单里返回 null", () => {
    const a = fake("claude-native");
    const emptyRegistry = Object.fromEntries(AGENT_VENDORS.map((v) => [v, [] as SessionForker[]])) as unknown as ForkerRegistry;
    const registry: ForkerRegistry = { ...emptyRegistry, claude: [a] };
    expect(findForker(registry, "claude", "claude-native")).toBe(a);
    expect(findForker(registry, "claude", "gone")).toBeNull();
    expect(findForker(registry, "codex", "claude-native")).toBeNull();
    expect(findForker(registry, "someone-new", "claude-native")).toBeNull();
  });
});

describe("withoutHubEnv：复制那份拿不到 hub 凭证", () => {
  it("去掉 HUB_TOKEN、HUB_SOCK，别的照留，原对象不改", () => {
    const launch: LaunchFiles = {
      promptFile: "/p.md",
      settingsFile: "/s.json",
      env: { [ENV_HUB_TOKEN]: "t", [ENV_HUB_SOCK]: "/run/hub.sock", PATH: "/run/bin:/usr/bin", FOO: "1" },
      fingerprint: "fp",
    };
    const stripped = withoutHubEnv(launch);
    expect(stripped).toEqual({ ...launch, env: { PATH: "/run/bin:/usr/bin", FOO: "1" } });
    expect(launch.env[ENV_HUB_TOKEN]).toBe("t");
  });
});

describe("ForkUnsupportedError", () => {
  it("是 Error，name 对，能用 instanceof 认出来", () => {
    const e: unknown = new ForkUnsupportedError("agy 库里没有 trajectory_meta");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ForkUnsupportedError);
    expect((e as Error).name).toBe("ForkUnsupportedError");
    expect((e as Error).message).toBe("agy 库里没有 trajectory_meta");
  });
});

describe("forkSourceOf：账本给的会话 + prepareLaunch 的结果", () => {
  const session: AgentSessionRow = {
    id: 7,
    role: "pm",
    conversationId: 1,
    pmId: 1,
    workerId: null,
    vendor: "codex",
    vendorSessionId: "v-7",
    cwd: "/code/foo",
    addDirs: ["/code/bar"],
    generation: 2,
    model: "gpt-5.5",
    effort: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: true,
    lastEventAt: null,
    rateLimit: null,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 210_000 },
    createdAt: 0,
    updatedAt: 0,
  };
  const launch: LaunchFiles = { promptFile: "/p.md", env: { [ENV_HUB_TOKEN]: "t", PATH: "/bin" }, fingerprint: "fp" };

  it("照抄会话的编号、目录、模型、思考程度，凭证去掉；addDirs 是新数组", () => {
    const src = forkSourceOf(session, launch, "/bin/codex");
    expect(src).toEqual({
      sessionId: 7,
      vendor: "codex",
      vendorSessionId: "v-7",
      executablePath: "/bin/codex",
      cwd: "/code/foo",
      addDirs: ["/code/bar"],
      model: "gpt-5.5",
      effort: null,
      launch: { promptFile: "/p.md", env: { PATH: "/bin" }, fingerprint: "fp" },
    });
    expect(src.addDirs).not.toBe(session.addDirs);
  });

  it("厂商不认识 → ForkUnsupportedError", () => {
    expect(() => forkSourceOf({ ...session, vendor: "someone-new" }, launch, "/bin/x")).toThrow(ForkUnsupportedError);
  });
});
