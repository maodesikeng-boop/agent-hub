import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENV_HOME } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
import { AGENT_VENDORS, vendorSpec } from "./vendors.ts";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL } from "../vendors/agy/spec.ts";
import { MAX_UNIX_SOCKET_PATH_BYTES, assertSocketPathFits, VENDOR_FALLBACK_PATHS, linuxInstallDirs, personaFilePath, projectWorktreesDir, findExecutable, resolveExecutable, resolveHubPaths, resolvePaths, resolveVendorExecutables, vendorCatalogFingerprint, vendorCatalogWatchFiles, vendorConfigHome, workerSetupLogPath, workerWorktreePath } from "./paths.ts";
import { agyCliDataDir, agyDataPaths, agyHomePaths } from "../vendors/agy/paths.ts";

// 原样转给真的 node:fs，只为数一数指纹算的时候碰了几次磁盘（existsSync / statSync）
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) };
});

describe("paths：可执行文件与数据目录解析", () => {
  it("环境变量名不再是公共常量：各家的 envVar 在 spec 里，约定 AGENT_HUB_<大写编号>（契约 S3 逐家查）", () => {
    for (const vendor of AGENT_VENDORS) {
      expect(vendorSpec(vendor).cli.envVar).toBe(`AGENT_HUB_${vendor.toUpperCase()}`);
    }
  });

  it("默认在用户目录下的 .agent-hub，各家默认找 PATH 里的同名可执行文件（spec 的 cli.command），按名单一家一项", () => {
    const paths = resolveHubPaths({}, "/Users/u");
    expect(paths.home).toBe(`/Users/u/${DATA_DIR_NAME}`);
    expect(paths.vendorPaths).toEqual(Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).cli.command])));
    expect(Object.keys(paths.vendorPaths)).toEqual([...AGENT_VENDORS]);
  });

  it("环境变量 AGENT_HUB_<VENDOR> 覆盖默认值，支持 ~ 展开", () => {
    const defaults = Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).cli.command]));
    const paths = resolveHubPaths(
      {
        [ENV_HOME]: "~/custom-hub",
        AGENT_HUB_CLAUDE: "~/bin/claude",
        AGENT_HUB_AGY: "~/bin/agy",
        AGENT_HUB_CODEX: "/opt/homebrew/bin/codex",
      },
      "/Users/u",
    );
    expect(paths.home).toBe("/Users/u/custom-hub");
    expect(paths.vendorPaths).toEqual({
      ...defaults,
      claude: "/Users/u/bin/claude",
      agy: "/Users/u/bin/agy",
      codex: "/opt/homebrew/bin/codex",
    });
  });

  it("resolvePaths：支持 ResolvePathsInput，input.vendorPaths 优先于环境变量，且同样展开 ~", () => {
    const defaults = Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).cli.command]));
    const paths = resolvePaths({
      env: {
        AGENT_HUB_CLAUDE: "/env/claude",
        AGENT_HUB_AGY: "/env/agy",
        AGENT_HUB_CODEX: "/env/codex",
      },
      userHome: "/Users/u",
      vendorPaths: { claude: "~/local/claude", agy: "~/local/agy", codex: "~/local/codex" },
    });
    expect(paths.vendorPaths).toEqual({
      ...defaults,
      claude: "/Users/u/local/claude",
      agy: "/Users/u/local/agy",
      codex: "/Users/u/local/codex",
    });

    const fromEnv = resolvePaths({
      env: {
        AGENT_HUB_AGY: "/env/agy",
        AGENT_HUB_CODEX: "~/env/codex",
      },
      userHome: "/Users/u",
    });
    expect(fromEnv.vendorPaths).toEqual({
      ...defaults,
      claude: "claude",
      agy: "/env/agy",
      codex: "/Users/u/env/codex",
    });
  });

  it("辅助路径函数与 socket 长度检查", () => {
    expect(personaFilePath("/s/personas", 3)).toBe("/s/personas/pm-3.md");
    expect(projectWorktreesDir("/w", 2)).toBe("/w/2");
    expect(workerWorktreePath("/w", 2, 7)).toBe("/w/2/7");
    expect(workerSetupLogPath("/l", 7)).toBe("/l/worker-7.log");
    expect(() => assertSocketPathFits("/" + "a".repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1))).not.toThrow();
    expect(() => assertSocketPathFits("/" + "a".repeat(MAX_UNIX_SOCKET_PATH_BYTES))).toThrow(/AGENT_HUB_HOME/);
  });

  it("agyDataPaths / agyHomePaths：AGY 数据目录与主目录路径只在 src/vendors/agy 拼，这里转出给守护进程", () => {
    expect(AGY_CLI_HOME_REL).toBe(".gemini/antigravity-cli");
    expect(AGY_LEGACY_HOME_REL).toBe(".gemini/antigravity");
    expect(AGY_MCP_CONFIG_REL).toBe(".gemini/config/mcp_config.json");

    expect(agyCliDataDir("/Users/u")).toBe("/Users/u/.gemini/antigravity-cli");
    expect(agyHomePaths("/Users/u")).toEqual({
      cliDir: "/Users/u/.gemini/antigravity-cli",
      legacyDir: "/Users/u/.gemini/antigravity",
      mcpConfigFile: "/Users/u/.gemini/config/mcp_config.json",
    });

    const dataPaths = agyDataPaths("/Users/u/.gemini/antigravity-cli");
    expect(dataPaths.root).toBe("/Users/u/.gemini/antigravity-cli");
    expect(dataPaths.conversationDb("conv-1")).toBe("/Users/u/.gemini/antigravity-cli/conversations/conv-1.db");
    expect(dataPaths.brainDir("conv-1")).toBe("/Users/u/.gemini/antigravity-cli/brain/conv-1");
    expect(dataPaths.mcpCacheDir).toBe("/Users/u/.gemini/antigravity-cli/mcp");
    expect(dataPaths.summaryDb).toBe("/Users/u/.gemini/antigravity-cli/conversation_summaries.db");
    expect(dataPaths.subDir("presence")).toBe("/Users/u/.gemini/antigravity-cli/presence");
  });

  it("Linux：每家厂商都在官方安装目录里找（~/.local/bin 排第一），ChatGPT.app 那条不出现", () => {
    expect(linuxInstallDirs("/home/u")).toEqual(["/home/u/.local/bin", "/home/u/.npm-global/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]);
    // 每家厂商都有兜底（VENDOR_FALLBACK_PATHS 的键就是 AGENT_VENDORS），找的是各家 spec.cli.command
    expect(Object.keys(VENDOR_FALLBACK_PATHS).toSorted()).toEqual([...AGENT_VENDORS].toSorted());
    for (const vendor of AGENT_VENDORS) {
      const cmd = vendorSpec(vendor).cli.command;
      const found = VENDOR_FALLBACK_PATHS[vendor]("/home/u", "linux");
      expect(found[0]).toBe(`/home/u/.local/bin/${cmd}`);
      for (const dir of linuxInstallDirs("/home/u")) expect(found).toContain(`${dir}/${cmd}`);
      expect(found.some((p) => p.includes(".app/"))).toBe(false);
    }
    expect(VENDOR_FALLBACK_PATHS.codex("/home/u", "linux").at(-1)).toBe("/home/u/.codex/plugins/.plugin-appserver/codex-cli/bin/codex");
  });

  it("findExecutable：找到返回路径（PATH 命中是命令名，候选路径命中是那个绝对路径），找不到返回 null；显式路径看文件在不在", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-paths-find-"));
    try {
      const pathDir = join(dir, "path-bin");
      const fallback = join(dir, "app", "codex");
      mkdirSync(pathDir, { recursive: true });
      mkdirSync(join(dir, "app"), { recursive: true });
      // PATH 里没有、候选路径里也没有：没装
      expect(findExecutable("codex", pathDir, [fallback])).toBeNull();
      // PATH 里没有、候选路径里有（macOS 上 ChatGPT.app 里带的 codex）：算装了
      writeFileSync(fallback, "");
      expect(findExecutable("codex", pathDir, [fallback])).toBe(fallback);
      // PATH 里有：命令名
      writeFileSync(join(pathDir, "codex"), "");
      expect(findExecutable("codex", pathDir, [fallback])).toBe("codex");
      // 显式路径
      expect(findExecutable(fallback, undefined, [])).toBe(fallback);
      expect(findExecutable(join(dir, "nope"), undefined, [])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

      expect(VENDOR_FALLBACK_PATHS.agy("/Users/u", "darwin")).toEqual(["/Users/u/.local/bin/agy"]);
      expect(VENDOR_FALLBACK_PATHS.claude("/Users/u", "darwin")).toEqual([]);
      expect(VENDOR_FALLBACK_PATHS.codex("/Users/u", "darwin")).toEqual([
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        // ChatGPT 装在用户目录的 ~/Applications 里也要找得到，不然判成没装
        "/Users/u/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Users/u/.codex/plugins/.plugin-appserver/codex-cli/bin/codex",
      ]);

      // resolveVendorExecutables：按 AGENT_VENDORS 循环解析各家厂商的 cmd 与 path
      const userHome = join(dir, "home");
      const localAgy = join(userHome, ".local", "bin", "agy");
      mkdirSync(join(userHome, ".local", "bin"), { recursive: true });
      writeFileSync(localAgy, "");
      writeFileSync(join(pathDir, "codex"), "");
      const defaultVendorPaths = Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).cli.command])) as Record<(typeof AGENT_VENDORS)[number], string>;
      const resolved = resolveVendorExecutables(
        { vendorPaths: { ...defaultVendorPaths, claude: "/explicit/claude", agy: "agy", codex: "codex" } },
        pathDir,
        userHome,
        "darwin",
      );
      expect(resolved).toMatchObject({
        claude: { cmd: "/explicit/claude", path: "/explicit/claude" },
        agy: { cmd: "agy", path: "agy" },
        codex: { cmd: "codex", path: "codex" },
      });
      expect(Object.keys(resolved)).toEqual([...AGENT_VENDORS]);
      // 当 PATH 里没有 agy 时，回退到 ~/.local/bin/agy
      const resolvedFallback = resolveVendorExecutables(
        { vendorPaths: defaultVendorPaths },
        "/empty-path",
        userHome,
        "darwin",
      );
      expect(resolvedFallback.agy).toEqual({ cmd: "agy", path: localAgy });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vendorCatalogFingerprint：模型目录缓存的 stat 指纹", () => {
  const exe = (dir: string, name: string, body = "#!/bin/sh\n") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, { mode: 0o755 });
    return join(dir, name);
  };

  it("codex 的盯防文件跟着 CODEX_HOME 走（认证判断用的同一处）；没设或空白回到 ~/.codex；别家不受影响", () => {
    expect(vendorConfigHome("codex", "/home/u", { CODEX_HOME: "/x/codex-home" })).toBe("/x/codex-home");
    expect(vendorConfigHome("codex", "/home/u", { CODEX_HOME: "  " })).toBe(join("/home/u", ".codex"));
    expect(vendorConfigHome("codex", "/home/u", {})).toBe(join("/home/u", ".codex"));
    expect(vendorConfigHome("claude", "/home/u", { CODEX_HOME: "/x/codex-home" })).toBeNull();
    const files = vendorCatalogWatchFiles("codex", "/home/u", { CODEX_HOME: "/x/codex-home" });
    expect(files).toContain(join("/x/codex-home", "auth.json"));
    expect(files).toContain(join("/x/codex-home", "models_cache.json"));
    expect(files.some((f) => f.startsWith(join("/home/u", ".codex")))).toBe(false);
    expect(vendorCatalogWatchFiles("codex", "/home/u", {})).toContain(join("/home/u", ".codex", "auth.json"));
    expect(vendorCatalogWatchFiles("claude", "/home/u", { CODEX_HOME: "/x/codex-home" })).toContain(join("/home/u", ".claude.json"));
  });

  it("自定义 CODEX_HOME 下的 auth.json / models_cache.json 变了：指纹跟着变；~/.codex 下的变化不影响", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-fp-codex-"));
    try {
      const home = join(dir, "home");
      const codexHome = join(dir, "custom-codex");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      const bin = exe(join(dir, "bin"), "codex");
      const env = { PATH: "", CODEX_HOME: codexHome };
      const fp = () => vendorCatalogFingerprint("codex", bin, env, home, "linux");

      const before = fp();
      expect(before).toContain(join(codexHome, "auth.json"));
      writeFileSync(join(home, ".codex", "auth.json"), "{\"default-home\":true}");
      expect(fp()).toBe(before);

      writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"a\"}");
      const loggedIn = fp();
      expect(loggedIn).not.toBe(before);

      writeFileSync(join(codexHome, "models_cache.json"), "{\"models\":[]}");
      const cached = fp();
      expect(cached).not.toBe(loggedIn);
      writeFileSync(join(codexHome, "models_cache.json"), "{\"models\":[{\"slug\":\"gpt-6.1-sol\"}]}");
      expect(fp()).not.toBe(cached);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("可执行文件找到一次就记住真实路径：之后只 stat 它、不再遍历 PATH（existsSync 0 次）；那个文件没了才重新找", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-fp-exe-"));
    try {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      const pathDirs = Array.from({ length: 20 }, (_, i) => join(dir, `p${i}`));
      const late = exe(pathDirs[19]!, "claude");
      const env = { PATH: pathDirs.join(delimiter) };
      const fp = () => vendorCatalogFingerprint("claude", "claude", env, home, "darwin");

      expect(fp()).toContain(late);
      const exists = vi.mocked(existsSync);
      const stat = vi.mocked(statSync);
      exists.mockClear();
      stat.mockClear();
      const again = fp();
      expect(again).toContain(late);
      expect(exists).not.toHaveBeenCalled();
      // 只 stat 可执行文件那一个 + 盯防文件各一次
      expect(stat).toHaveBeenCalledTimes(1 + vendorCatalogWatchFiles("claude", home, env).length);

      // PATH 前面又装了一份：记住的那份还在，就还用它（不重扫）
      const early = exe(pathDirs[0]!, "claude");
      expect(fp()).toContain(late);
      // 记住的那份没了：重新找，换成新的
      rmSync(late);
      expect(fp()).toContain(early);
      expect(fp()).not.toContain(late);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没找到可执行文件不记：装上以后下一次就能找到，指纹跟着变", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-fp-miss-"));
    try {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      const bin = join(dir, "bin");
      const env = { PATH: bin };
      const fp = () => vendorCatalogFingerprint("agy", "agy", env, home, "darwin");
      const missing = fp();
      expect(missing.startsWith("-|")).toBe(true);
      const installed = exe(bin, "agy");
      expect(fp()).toContain(installed);
      expect(fp()).not.toBe(missing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
