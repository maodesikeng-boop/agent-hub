import { describe, expect, it } from "vitest";
import { ENV_AGY, ENV_CLAUDE, ENV_CODEX, ENV_HOME } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  assertSocketPathFits,
  personaFilePath,
  projectWorktreesDir,
  resolveHubPaths,
  resolvePaths,
  workerSetupLogPath,
  workerWorktreePath,
} from "./paths.ts";

describe("paths：可执行文件与数据目录解析", () => {
  it("环境变量名常量：AGENT_HUB_CLAUDE / AGENT_HUB_AGY / AGENT_HUB_CODEX", () => {
    expect(ENV_CLAUDE).toBe("AGENT_HUB_CLAUDE");
    expect(ENV_AGY).toBe("AGENT_HUB_AGY");
    expect(ENV_CODEX).toBe("AGENT_HUB_CODEX");
  });

  it("默认在用户目录下的 .agent-hub，claude/agy/codex 默认找 PATH 里的同名可执行文件", () => {
    const paths = resolveHubPaths({}, "/Users/u");
    expect(paths.home).toBe(`/Users/u/${DATA_DIR_NAME}`);
    expect(paths.claudePath).toBe("claude");
    expect(paths.agyPath).toBe("agy");
    expect(paths.codexPath).toBe("codex");
  });

  it("环境变量 AGENT_HUB_CLAUDE / AGENT_HUB_AGY / AGENT_HUB_CODEX 覆盖默认值，支持 ~ 展开", () => {
    const paths = resolveHubPaths(
      {
        [ENV_HOME]: "~/custom-hub",
        [ENV_CLAUDE]: "~/bin/claude",
        [ENV_AGY]: "~/bin/agy",
        [ENV_CODEX]: "/opt/homebrew/bin/codex",
      },
      "/Users/u",
    );
    expect(paths.home).toBe("/Users/u/custom-hub");
    expect(paths.claudePath).toBe("/Users/u/bin/claude");
    expect(paths.agyPath).toBe("/Users/u/bin/agy");
    expect(paths.codexPath).toBe("/opt/homebrew/bin/codex");
  });

  it("resolvePaths：支持 ResolvePathsInput，input.agy / input.codex 优先于环境变量，且同样展开 ~", () => {
    const paths = resolvePaths({
      env: {
        [ENV_CLAUDE]: "/env/claude",
        [ENV_AGY]: "/env/agy",
        [ENV_CODEX]: "/env/codex",
      },
      userHome: "/Users/u",
      claude: "~/local/claude",
      agy: "~/local/agy",
      codex: "~/local/codex",
    });
    expect(paths.claudePath).toBe("/Users/u/local/claude");
    expect(paths.agyPath).toBe("/Users/u/local/agy");
    expect(paths.codexPath).toBe("/Users/u/local/codex");

    const fromEnv = resolvePaths({
      env: {
        [ENV_AGY]: "/env/agy",
        [ENV_CODEX]: "~/env/codex",
      },
      userHome: "/Users/u",
    });
    expect(fromEnv.agyPath).toBe("/env/agy");
    expect(fromEnv.codexPath).toBe("/Users/u/env/codex");
  });

  it("辅助路径函数与 socket 长度检查", () => {
    expect(personaFilePath("/s/personas", 3)).toBe("/s/personas/pm-3.md");
    expect(projectWorktreesDir("/w", 2)).toBe("/w/2");
    expect(workerWorktreePath("/w", 2, 7)).toBe("/w/2/7");
    expect(workerSetupLogPath("/l", 7)).toBe("/l/worker-7.log");
    expect(() => assertSocketPathFits("/" + "a".repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1))).not.toThrow();
    expect(() => assertSocketPathFits("/" + "a".repeat(MAX_UNIX_SOCKET_PATH_BYTES))).toThrow(/AGENT_HUB_HOME/);
  });
});
