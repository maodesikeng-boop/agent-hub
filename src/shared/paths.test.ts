import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGY, ENV_CLAUDE, ENV_CODEX, ENV_HOME } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
import { AGENT_VENDORS } from "./vendors.ts";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  assertSocketPathFits,
  VENDOR_FALLBACK_PATHS,
  defaultAgyFallbackPaths,
  defaultClaudeFallbackPaths,
  defaultCodexFallbackPaths,
  linuxInstallDirs,
  personaFilePath,
  projectWorktreesDir,
  resolveExecutable,
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

  it("Linux：每家厂商都在官方安装目录里找（~/.local/bin 排第一），ChatGPT.app 那条不出现", () => {
    expect(linuxInstallDirs("/home/u")).toEqual(["/home/u/.local/bin", "/home/u/.npm-global/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]);
    // 每家厂商都有兜底（VENDOR_FALLBACK_PATHS 的键就是 AGENT_VENDORS），命令名就是厂商编号
    expect(Object.keys(VENDOR_FALLBACK_PATHS).toSorted()).toEqual([...AGENT_VENDORS].toSorted());
    for (const vendor of AGENT_VENDORS) {
      const found = VENDOR_FALLBACK_PATHS[vendor]("/home/u", "linux");
      expect(found[0]).toBe(`/home/u/.local/bin/${vendor}`);
      for (const dir of linuxInstallDirs("/home/u")) expect(found).toContain(`${dir}/${vendor}`);
      expect(found.some((p) => p.includes(".app/"))).toBe(false);
    }
    expect(defaultCodexFallbackPaths("/home/u", "linux").at(-1)).toBe("/home/u/.codex/plugins/.plugin-appserver/codex-cli/bin/codex");
  });

  it("resolveExecutable：显式路径原样返回；PATH 命中保持原样；否则按顺序回退候选路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-paths-exec-"));
    try {
      const pathDir = join(dir, "path-bin");
      const fallback1 = join(dir, "fallback-1", "agy");
      const fallback2 = join(dir, "fallback-2", "agy");
      mkdirSync(pathDir, { recursive: true });
      mkdirSync(join(dir, "fallback-2"), { recursive: true });
      writeFileSync(fallback2, "");

      // 显式路径（含 /）直接返回
      expect(resolveExecutable("/custom/bin/agy", pathDir, [fallback2])).toBe("/custom/bin/agy");

      // PATH 中不存在，回退到第一个存在的 candidate
      expect(resolveExecutable("agy", pathDir, [fallback1, fallback2])).toBe(fallback2);

      // PATH 中存在，保持命令名 "agy"
      writeFileSync(join(pathDir, "agy"), "");
      expect(resolveExecutable("agy", `/nope${delimiter}${pathDir}`, [fallback2])).toBe("agy");

      // 都不存在，保持原样
      expect(resolveExecutable("codex", pathDir, [fallback1])).toBe("codex");

      expect(defaultAgyFallbackPaths("/Users/u", "darwin")).toEqual(["/Users/u/.local/bin/agy"]);
      expect(defaultClaudeFallbackPaths("/Users/u", "darwin")).toEqual([]);
      expect(defaultCodexFallbackPaths("/Users/u", "darwin")).toEqual([
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Users/u/.codex/plugins/.plugin-appserver/codex-cli/bin/codex",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
