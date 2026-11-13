import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, MAX_VENDOR_SYNC_BACKUPS } from "../../shared/index.ts";
import { loadDeepSeekAcpMcpServers } from "../../vendors/deepseek/sync.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { createUiServer } from "../ui-server/server.ts";
import { testLogin } from "../ui-server/test-login.ts";
import { createVendorSyncService } from "./index.ts";

describe("vendor-sync：6 家厂商连接器、MCP 与 Skill 并集同步、脱敏预览与轮转备份", () => {
  let rootDir: string;
  let userHome: string;
  let backupsDir: string;
  let projectDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "agent-hub-vendor-sync-"));
    userHome = join(rootDir, "home");
    backupsDir = join(rootDir, "data", "backups", "sync");
    projectDir = join(rootDir, "repo-alpha");
    mkdirSync(userHome, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("JSONC 局部补丁与 TOML 局部更新：完整保留各家原有注释、缩进与登录态字段", () => {
    const claudePath = join(userHome, ".claude.json");
    writeFileSync(
      claudePath,
      `{
  // 用户账号与 OAuth 登录态（绝不能丢）
  "oauthAccount": {
    "accountUuid": "acc-123",
    "emailAddress": "dev@example.com"
  },
  /* 现有 MCP 块注释 */
  "mcpServers": {
    // 保留原有注释
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {
        "CONTEXT7_API_KEY": "ctx_secret_987654"
      }
    }
  }
}
`,
      "utf8",
    );

    const agyPath = join(userHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(userHome, ".gemini", "config"), { recursive: true });
    writeFileSync(
      agyPath,
      `{
  // Antigravity MCP 自定义注释
  "customFlag": true,
  "mcpServers": {}
}
`,
      "utf8",
    );

    const codexDir = join(userHome, ".codex");
    const codexPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      codexPath,
      `# Codex 顶层注释
model = "gpt-5.4"

[features]
multi_agent = true # 行尾注释也保留

# 既有本地 MCP
[mcp_servers.git_local]
command = "uvx"
args = ["mcp-server-git"]
`,
      "utf8",
    );

    const service = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });

    const preview = service.preview();
    expect(preview.mcpServers.map((m) => m.name)).toEqual(["context7", "git_local"]);

    const res = service.apply({
      selectedMcpKeys: preview.mcpServers.map((m) => m.key),
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    expect(res.syncedMcpCount).toBe(2);
    expect(res.backupId).not.toBeNull();

    // 1. Claude JSONC 保留注释与登录态，同时补入 git_local
    const claudeAfter = readFileSync(claudePath, "utf8");
    expect(claudeAfter).toContain("// 用户账号与 OAuth 登录态（绝不能丢）");
    expect(claudeAfter).toContain("/* 现有 MCP 块注释 */");
    expect(claudeAfter).toContain("// 保留原有注释");
    const claudeParsed = parseJsonc(claudeAfter) as Record<string, unknown>;
    expect(claudeParsed.oauthAccount).toEqual({ accountUuid: "acc-123", emailAddress: "dev@example.com" });
    expect((claudeParsed.mcpServers as Record<string, unknown>).git_local).toMatchObject({
      command: "uvx",
      args: ["mcp-server-git"],
    });

    // 2. AGY JSONC 保留注释与 customFlag，同时补入两项
    const agyAfter = readFileSync(agyPath, "utf8");
    expect(agyAfter).toContain("// Antigravity MCP 自定义注释");
    const agyParsed = parseJsonc(agyAfter) as Record<string, unknown>;
    expect(agyParsed.customFlag).toBe(true);
    expect(Object.keys(agyParsed.mcpServers as Record<string, unknown>).sort()).toEqual(["context7", "git_local"]);

    // 3. Codex TOML 保留全部注释、model、[features]，并补入 context7
    const codexAfter = readFileSync(codexPath, "utf8");
    expect(codexAfter).toContain("# Codex 顶层注释");
    expect(codexAfter).toContain("# 行尾注释也保留");
    expect(codexAfter).toContain("# 既有本地 MCP");
    const codexParsed = parseToml(codexAfter) as Record<string, unknown>;
    expect(codexParsed.model).toBe("gpt-5.4");
    expect(codexParsed.features).toEqual({ multi_agent: true });
    expect((codexParsed.mcp_servers as Record<string, unknown>).context7).toMatchObject({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "ctx_secret_987654" },
    });

    // 4. Pi、Cursor 与 DeepSeek 均同步到位
    const piParsed = parseJsonc(readFileSync(join(userHome, ".pi", "agent", "mcp.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(piParsed.mcpServers as Record<string, unknown>).sort()).toEqual(["context7", "git_local"]);

    const cursorParsed = parseJsonc(readFileSync(join(userHome, ".cursor", "mcp.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(cursorParsed.mcpServers as Record<string, unknown>).sort()).toEqual(["context7", "git_local"]);

    const deepseekAcp = loadDeepSeekAcpMcpServers(join(userHome, ".dsh"));
    expect(deepseekAcp.map((s) => s.name).sort()).toEqual(["context7", "git_local"]);
    const ctxServer = deepseekAcp.find((s) => s.name === "context7");
    expect(ctxServer).toEqual({
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [{ name: "CONTEXT7_API_KEY", value: "ctx_secret_987654" }],
    });
  });

  it("旧版 /sse 远程 MCP：Claude/Cursor 保持原生 SSE，同步到 AGY/Codex/Pi/DeepSeek 自动转 npx -y mcp-remote <url>，二次扫描幂等不重复包裹", () => {
    mkdirSync(join(userHome, ".cursor"), { recursive: true });
    writeFileSync(
      join(userHome, ".cursor", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            linear_sse: {
              url: "https://mcp.linear.app/sse",
            },
            docs_http: {
              url: "https://docs.example.com/mcp",
              headers: {
                Authorization: "Bearer super_secret_token_12345",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });

    const preview1 = service.preview();
    const sseItem = preview1.mcpServers.find((m) => m.name === "linear_sse")!;
    expect(sseItem.transport).toBe("sse");
    expect(sseItem.usesMcpRemoteBridge).toBe(true);
    expect(sseItem.vendors.find((v) => v.vendor === "agy")?.status).toBe("mcp_remote");
    expect(sseItem.vendors.find((v) => v.vendor === "codex")?.status).toBe("mcp_remote");
    expect(sseItem.vendors.find((v) => v.vendor === "claude")?.status).toBe("will_add");
    expect(sseItem.vendors.find((v) => v.vendor === "cursor")?.status).toBe("present");

    service.apply({
      selectedMcpKeys: preview1.mcpServers.map((m) => m.key),
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });

    // AGY 与 Codex 落盘为 npx -y mcp-remote https://mcp.linear.app/sse
    const agyMcp = (parseJsonc(readFileSync(join(userHome, ".gemini", "config", "mcp_config.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(agyMcp.linear_sse).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
    });

    const codexMcp = (parseToml(readFileSync(join(userHome, ".codex", "config.toml"), "utf8")) as { mcp_servers: Record<string, unknown> }).mcp_servers;
    expect(codexMcp.linear_sse).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
    });

    // Claude 落盘保留原生 type: "sse"
    const claudeMcp = (parseJsonc(readFileSync(join(userHome, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(claudeMcp.linear_sse).toEqual({
      type: "sse",
      url: "https://mcp.linear.app/sse",
    });

    // DeepSeek ACP 启动参数中：HTTP 保持 type: "http"，SSE 自动转 stdio mcp-remote（dsh 仅支持 http/stdio）
    const dshServers = loadDeepSeekAcpMcpServers(join(userHome, ".dsh"));
    expect(dshServers).toContainEqual({
      name: "linear_sse",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
      env: [],
    });
    expect(dshServers).toContainEqual({
      type: "http",
      name: "docs_http",
      url: "https://docs.example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer super_secret_token_12345" }],
    });

    // 二次扫描完全幂等：识别出 mcp-remote 桥接与原生 SSE 等价，再次 apply 零文件写入
    const preview2 = service.preview();
    const sseItem2 = preview2.mcpServers.find((m) => m.name === "linear_sse")!;
    for (const badge of sseItem2.vendors) {
      expect(["present", "mcp_remote"]).toContain(badge.status);
    }
    const res2 = service.apply({
      selectedMcpKeys: preview2.mcpServers.map((m) => m.key),
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    expect(res2.updatedFiles).toBe(0);
    expect(res2.backupId).toBeNull();
  });

  it("密钥脱敏预览与取消勾选主动全局移除：预览绝不泄露明文密钥，落盘保留真实凭据，取消勾选可跨 6 家删除", () => {
    const rawApiKey = "sk-live-99887766554433221100secret";
    const rawBearer = "Bearer ghp_verySecretTokenValue999";
    const rawUrlToken = "url_query_secret_token_abc123";

    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            secret_stdio: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: {
                OPENAI_API_KEY: rawApiKey,
                NODE_ENV: "production",
              },
            },
            secret_http: {
              type: "http",
              url: `https://mcp.internal.example/mcp?api_key=${rawUrlToken}&region=us`,
              headers: {
                Authorization: rawBearer,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });

    const preview = service.preview();
    const serializedPreview = JSON.stringify(preview);
    expect(serializedPreview).not.toContain(rawApiKey);
    expect(serializedPreview).not.toContain("ghp_verySecretTokenValue999");
    expect(serializedPreview).not.toContain(rawUrlToken);
    // 查询参数只留参数名便于辨识，值一律打码（按名字猜敏感会漏 `?key=<hex>` 这类）
    expect(serializedPreview).toContain("region=••••");
    expect(serializedPreview).not.toContain("region=us");
    expect(serializedPreview).toContain("OPENAI_API_KEY");

    // 第一次全部同步后，验证磁盘写入的是未打码的真实密钥
    service.apply({
      selectedMcpKeys: ["secret_stdio", "secret_http"],
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    const agyMcp = (parseJsonc(readFileSync(join(userHome, ".gemini", "config", "mcp_config.json"), "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
    }).mcpServers;
    expect(agyMcp.secret_stdio?.env?.OPENAI_API_KEY).toBe(rawApiKey);
    expect(agyMcp.secret_http?.url).toContain(rawUrlToken);
    expect(agyMcp.secret_http?.headers?.Authorization).toBe(rawBearer);

    // 用户在预览窗手动取消勾选 secret_stdio → 从全部 6 家移除
    const removeRes = service.apply({
      selectedMcpKeys: ["secret_http"],
      removeMcpKeys: ["secret_stdio"],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    expect(removeRes.removedMcpCount).toBe(1);

    for (const p of [
      join(userHome, ".claude.json"),
      join(userHome, ".gemini", "config", "mcp_config.json"),
      join(userHome, ".pi", "agent", "mcp.json"),
      join(userHome, ".cursor", "mcp.json"),
    ]) {
      const parsed = parseJsonc(readFileSync(p, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers.secret_stdio).toBeUndefined();
      expect(parsed.mcpServers.secret_http).toBeDefined();
    }
    const codexParsed = parseToml(readFileSync(join(userHome, ".codex", "config.toml"), "utf8")) as { mcp_servers: Record<string, unknown> };
    expect(codexParsed.mcp_servers.secret_stdio).toBeUndefined();
    expect(codexParsed.mcp_servers.secret_http).toBeDefined();
    expect(loadDeepSeekAcpMcpServers(join(userHome, ".dsh")).map((s) => s.name)).toEqual(["secret_http"]);
  });

  it("原厂私有云端连接器与 OAuth 绑定项：扫描标为不可跨厂同步并给清晰说明，绝不硬拷 OAuth 令牌", () => {
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify(
        {
          claudeAiMcp: {
            slack: { enabled: true, accessToken: "xoxp-private-oauth-token" },
            gmail: { enabled: true, refreshToken: "1//private-google-refresh" },
          },
          mcpOAuth: {
            "notion|abc": { accessToken: "secret_notion_oauth", serverUrl: "https://mcp.notion.com/mcp" },
          },
          mcpServers: {
            slack_oauth_mcp: {
              type: "http",
              url: "https://mcp.slack.com/mcp",
              oauth: { clientId: "slack-client", accessToken: "xoxe-secret" },
            },
            portable_fetch: {
              command: "uvx",
              args: ["mcp-server-fetch"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    mkdirSync(join(userHome, ".codex"), { recursive: true });
    writeFileSync(
      join(userHome, ".codex", "config.toml"),
      `[features]
codex_apps = true

[apps._default]
enabled = true

[apps.google_drive]
enabled = true

[apps.slack]
enabled = true
`,
      "utf8",
    );

    const service = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });

    const preview = service.preview();
    expect(preview.mcpServers.map((m) => m.name)).toEqual(["portable_fetch"]);

    const nonSyncNames = preview.nonSyncable.map((item) => `${item.vendor}:${item.name}`);
    expect(nonSyncNames).toContain("claude:slack");
    expect(nonSyncNames).toContain("claude:gmail");
    expect(nonSyncNames).toContain("claude:slack_oauth_mcp");
    expect(nonSyncNames).toContain("codex:google_drive");
    expect(nonSyncNames).toContain("codex:slack");
    for (const item of preview.nonSyncable) {
      expect(item.reason.length).toBeGreaterThan(10);
    }
    expect(JSON.stringify(preview)).not.toContain("xoxp-private-oauth-token");
    expect(JSON.stringify(preview)).not.toContain("1//private-google-refresh");
    expect(JSON.stringify(preview)).not.toContain("secret_notion_oauth");

    // 执行同步后，OAuth / 云端连接器绝不被复制到其他家，且原文件里的连接器也完好保留
    service.apply({
      selectedMcpKeys: ["portable_fetch"],
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });

    const agyRaw = readFileSync(join(userHome, ".gemini", "config", "mcp_config.json"), "utf8");
    expect(agyRaw).not.toContain("slack");
    expect(agyRaw).not.toContain("xoxp-private-oauth-token");
    const claudeAfter = parseJsonc(readFileSync(join(userHome, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(claudeAfter.claudeAiMcp).toBeDefined();
    expect((claudeAfter.mcpServers as Record<string, unknown>).slack_oauth_mcp).toBeDefined();
  });

  it("Skill 同步：全局与项目 .agents/skills 基准、原生厂商零冗余、claude/agy/pi 逐项软链、保留用户私有技能与目录级软链", () => {
    // 1. 全局 ~/.agents/skills：包含 2 个有效技能 + 1 个许可证普通文件（不应被当作技能）
    const globalCanonical = join(userHome, ".agents", "skills");
    mkdirSync(join(globalCanonical, "code-review"), { recursive: true });
    writeFileSync(join(globalCanonical, "code-review", "SKILL.md"), "---\nname: code-review\n---\n", "utf8");
    mkdirSync(join(globalCanonical, "shared-clash"), { recursive: true });
    writeFileSync(join(globalCanonical, "shared-clash", "SKILL.md"), "---\nname: shared-clash\n---\n", "utf8");
    writeFileSync(join(globalCanonical, "PSTACK-LICENSE"), "MIT License", "utf8");

    // Claude 下已有用户私有技能（真目录）：一个独立名字 user-private，一个同名冲突 shared-clash
    const claudeGlobalSkills = join(userHome, ".claude", "skills");
    mkdirSync(join(claudeGlobalSkills, "user-private"), { recursive: true });
    writeFileSync(join(claudeGlobalSkills, "user-private", "SKILL.md"), "private content", "utf8");
    mkdirSync(join(claudeGlobalSkills, "shared-clash"), { recursive: true });
    writeFileSync(join(claudeGlobalSkills, "shared-clash", "SKILL.md"), "user custom override", "utf8");

    // 2. 项目 A：普通目录，含项目技能 repo-lint
    const projectCanonical = join(projectDir, ".agents", "skills");
    mkdirSync(join(projectCanonical, "repo-lint"), { recursive: true });
    writeFileSync(join(projectCanonical, "repo-lint", "SKILL.md"), "---\nname: repo-lint\n---\n", "utf8");

    // 3. 项目 B：类似本仓库，`.claude/skills` 已经是指向 `../.agents/skills` 的整目录软链
    const linkedRepo = join(rootDir, "repo-linked");
    mkdirSync(join(linkedRepo, ".agents", "skills", "setup-pstack"), { recursive: true });
    writeFileSync(join(linkedRepo, ".agents", "skills", "setup-pstack", "SKILL.md"), "---\nname: setup-pstack\n---\n", "utf8");
    mkdirSync(join(linkedRepo, ".claude"), { recursive: true });
    symlinkSync("../.agents/skills", join(linkedRepo, ".claude", "skills"));

    const service = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [
        { path: projectDir, projectName: "Alpha" },
        { path: linkedRepo, projectName: "LinkedRepo" },
      ],
    });

    const preview = service.preview();
    expect(preview.skills.map((s) => s.name)).toEqual(["code-review", "shared-clash", "repo-lint", "setup-pstack"]);
    const clashItem = preview.skills.find((s) => s.name === "shared-clash")!;
    expect(clashItem.vendors.find((v) => v.vendor === "claude")?.status).toBe("conflict");
    expect(clashItem.vendors.find((v) => v.vendor === "codex")?.status).toBe("native");
    expect(clashItem.vendors.find((v) => v.vendor === "cursor")?.status).toBe("native");
    expect(clashItem.vendors.find((v) => v.vendor === "deepseek")?.status).toBe("native");

    // LinkedRepo 的 .claude/skills 整目录软链被识别为已就绪 symlink，不会破坏
    const linkedItem = preview.skills.find((s) => s.name === "setup-pstack")!;
    expect(linkedItem.vendors.find((v) => v.vendor === "claude")?.status).toBe("symlink");

    const applyRes = service.apply({
      selectedMcpKeys: [],
      removeMcpKeys: [],
      selectedSkillKeys: preview.skills.map((s) => s.key),
      removeSkillKeys: [],
    });
    expect(applyRes.preservedPrivateSkillCount).toBe(1);

    // Claude / AGY / Pi 全局技能逐项软链建立，PSTACK-LICENSE 没被链过去
    expect(lstatSync(join(claudeGlobalSkills, "code-review")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(userHome, ".gemini", "config", "skills", "code-review")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(userHome, ".pi", "agent", "skills", "code-review")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(claudeGlobalSkills, "PSTACK-LICENSE"))).toBe(false);

    // 用户私有真目录毫发无损！
    expect(lstatSync(join(claudeGlobalSkills, "user-private")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(claudeGlobalSkills, "user-private", "SKILL.md"), "utf8")).toBe("private content");
    expect(lstatSync(join(claudeGlobalSkills, "shared-clash")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(claudeGlobalSkills, "shared-clash", "SKILL.md"), "utf8")).toBe("user custom override");

    // 原生支持 .agents/skills 的厂商绝不建冗余软链目录
    expect(existsSync(join(userHome, ".codex", "skills"))).toBe(false);
    expect(existsSync(join(userHome, ".cursor", "skills"))).toBe(false);
    expect(existsSync(join(userHome, ".dsh", "skills"))).toBe(false);

    // 项目 A 的 .claude/skills/repo-lint 建了软链，项目 B 的整目录软链保持原样
    expect(lstatSync(join(projectDir, ".claude", "skills", "repo-lint")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(linkedRepo, ".claude", "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(linkedRepo, ".claude", "skills")).replace(/\\/g, "/")).toBe("../.agents/skills");

    // 取消勾选 code-review：只移除受管软链，绝不碰 user-private
    const codeReviewKey = preview.skills.find((s) => s.name === "code-review")!.key;
    const unlinkRes = service.apply({
      selectedMcpKeys: [],
      removeMcpKeys: [],
      selectedSkillKeys: preview.skills.filter((s) => s.key !== codeReviewKey).map((s) => s.key),
      removeSkillKeys: [codeReviewKey],
    });
    expect(unlinkRes.unlinkedSkillCount).toBe(3);
    expect(existsSync(join(claudeGlobalSkills, "code-review"))).toBe(false);
    expect(existsSync(join(userHome, ".gemini", "config", "skills", "code-review"))).toBe(false);
    expect(existsSync(join(userHome, ".pi", "agent", "skills", "code-review"))).toBe(false);
    expect(readFileSync(join(claudeGlobalSkills, "user-private", "SKILL.md"), "utf8")).toBe("private content");
  });

  it("轮转备份上限与异常原子回滚：超 MAX_VENDOR_SYNC_BACKUPS 自动淘汰最老快照，半途写盘报错时全量回滚已改文件与新建文件", () => {
    const claudePath = join(userHome, ".claude.json");
    const originalClaude = `{\n  // 原始状态\n  "mcpServers": {\n    "alpha": { "command": "echo", "args": ["1"] }\n  }\n}\n`;
    writeFileSync(claudePath, originalClaude, "utf8");

    // 预填充 MAX_VENDOR_SYNC_BACKUPS + 2 个旧备份目录，验证轮转淘汰
    mkdirSync(backupsDir, { recursive: true });
    for (let i = 0; i < MAX_VENDOR_SYNC_BACKUPS + 2; i++) {
      const name = `20260101-0000${String(i).padStart(2, "0")}-old`;
      mkdirSync(join(backupsDir, name), { recursive: true });
      writeFileSync(join(backupsDir, name, "manifest.json"), "{}", "utf8");
    }

    // 注入第 3 次原子写失败，验证事务性回滚（前两家已改的文件恢复原状、新建的文件删掉）
    let writeCount = 0;
    const failingService = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
      writeFileAtomicHook: (targetPath, content, mode) => {
        writeCount += 1;
        if (writeCount === 3) {
          throw new Error("simulated disk full during atomic replace");
        }
        mkdirSync(join(targetPath, ".."), { recursive: true });
        writeFileSync(targetPath, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
      },
    });

    expect(() =>
      failingService.apply({
        selectedMcpKeys: ["alpha"],
        removeMcpKeys: [],
        selectedSkillKeys: [],
        removeSkillKeys: [],
      }),
    ).toThrow(/simulated disk full/);

    // 回滚验证：.claude.json 原样未变，其他家临时新建的配置文件均已被干净清理
    expect(readFileSync(claudePath, "utf8")).toBe(originalClaude);
    expect(existsSync(join(userHome, ".gemini", "config", "mcp_config.json"))).toBe(false);
    expect(existsSync(join(userHome, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(userHome, ".pi", "agent", "mcp.json"))).toBe(false);
    expect(existsSync(join(userHome, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(userHome, ".dsh", "mcp.json"))).toBe(false);

    // 正常执行一次同步：备份目录总数严格不超过 MAX_VENDOR_SYNC_BACKUPS，且淘汰了最老的 000000/000001/000002
    const normalService = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });
    const okRes = normalService.apply({
      selectedMcpKeys: ["alpha"],
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    expect(okRes.backupId).not.toBeNull();
    const entries = readdirSync(backupsDir).sort();
    expect(entries.length).toBeLessThanOrEqual(MAX_VENDOR_SYNC_BACKUPS);
    expect(entries).not.toContain("20260101-000000-old");
  });

  it("UI Server HTTP 接口：鉴权拦截、Zod 请求体严格校验及 preview/apply 端到端闭环", async () => {
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-mcp"], env: { API_KEY: "sk-1234567890" } },
        },
      }),
      "utf8",
    );
    const vendorSync = createVendorSyncService({
      userHome,
      env: {},
      backupsDir,
      listProjectFolders: () => [],
    });

    const port = 4321;
    const host = `127.0.0.1:${port}`;
    const origin = `http://127.0.0.1:${port}`;
    const db = openTestDb();
    const cookie = testLogin(db, port).cookie();
    const staticDir = join(rootDir, "static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html>", "utf8");
    const app = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: "test-token-0123456789abcdef",
      staticDir,
      uploadsDir: join(rootDir, "uploads"),
      sentFilesDir: join(rootDir, "sent-files"),
      port,
      db,
      vendorSync,
    });
    await app.ready();
    try {
      // 未登录请求被 401 拒绝
      const unauthRes = await app.inject({
        method: "GET",
        url: API_PATHS.vendorSyncPreview,
        headers: { host },
      });
      expect(unauthRes.statusCode).toBe(401);

      // 已登录预览返回脱敏后的 MCP 列表
      const previewRes = await app.inject({
        method: "GET",
        url: API_PATHS.vendorSyncPreview,
        headers: { host, cookie },
      });
      expect(previewRes.statusCode).toBe(200);
      const previewBody = previewRes.json();
      expect(previewBody.mcpServers).toHaveLength(1);
      expect(previewBody.mcpServers[0].name).toBe("demo");
      expect(JSON.stringify(previewBody)).not.toContain("sk-1234567890");

      // 非法字段被 Zod strict 拦截回 400
      const badRes = await app.inject({
        method: "POST",
        url: API_PATHS.vendorSyncApply,
        headers: { host, origin, cookie, "content-type": "application/json" },
        payload: JSON.stringify({
          selectedMcpKeys: ["demo"],
          removeMcpKeys: [],
          selectedSkillKeys: [],
          removeSkillKeys: [],
          unexpectedField: true,
        }),
      });
      expect(badRes.statusCode).toBe(400);

      // 合法请求执行同步并返回统计
      const applyRes = await app.inject({
        method: "POST",
        url: API_PATHS.vendorSyncApply,
        headers: { host, origin, cookie, "content-type": "application/json" },
        payload: JSON.stringify({
          selectedMcpKeys: ["demo"],
          removeMcpKeys: [],
          selectedSkillKeys: [],
          removeSkillKeys: [],
        }),
      });
      expect(applyRes.statusCode).toBe(200);
      expect(applyRes.json().syncedMcpCount).toBe(1);
      expect(existsSync(join(userHome, ".codex", "config.toml"))).toBe(true);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("vendor-sync 审查补测（PR #271）：只增补不覆盖、彻底脱敏、受管软链边界、原子写与备份轮转", () => {
  let rootDir: string;
  let userHome: string;
  let backupsDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "agent-hub-vendor-sync-review-"));
    userHome = join(rootDir, "home");
    backupsDir = join(rootDir, "data", "backups", "sync");
    mkdirSync(userHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const service = (extra: Partial<Parameters<typeof createVendorSyncService>[0]> = {}) =>
    createVendorSyncService({ userHome, env: {}, backupsDir, listProjectFolders: () => [], ...extra });

  it("并集只增补：各家已有同名配置（内容不同、带本家独有字段、被禁用）一律原样保留，只给缺的厂商补", () => {
    const claudeRaw = `{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "gh-mcp"], "cwd": "/work", "timeout": 30000 }
  }
}
`;
    writeFileSync(join(userHome, ".claude.json"), claudeRaw, "utf8");
    mkdirSync(join(userHome, ".cursor"), { recursive: true });
    const cursorRaw = `{
  "mcpServers": {
    "github": { "command": "docker", "args": ["run", "ghcr.io/github/github-mcp-server"], "env": { "GITHUB_TOKEN": "cursor-own-token" } }
  }
}
`;
    writeFileSync(join(userHome, ".cursor", "mcp.json"), cursorRaw, "utf8");
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    const codexRaw = `[mcp_servers.github]
command = "uvx"
args = ["codex-own-github"]
enabled = false
startup_timeout_sec = 20
`;
    writeFileSync(join(userHome, ".codex", "config.toml"), codexRaw, "utf8");

    const svc = service();
    const preview = svc.preview();
    const github = preview.mcpServers.find((m) => m.name === "github")!;
    expect(github.vendors.find((v) => v.vendor === "claude")?.status).toBe("present");
    expect(github.vendors.find((v) => v.vendor === "cursor")?.status).toBe("kept");
    expect(github.vendors.find((v) => v.vendor === "agy")?.status).toBe("will_add");

    svc.apply({ selectedMcpKeys: ["github"], removeMcpKeys: [], selectedSkillKeys: [], removeSkillKeys: [] });

    // 已有同名配置的三家一个字节都不动（claude 自己的 cwd/timeout 也不被“规范化”丢掉）
    expect(readFileSync(join(userHome, ".claude.json"), "utf8")).toBe(claudeRaw);
    expect(readFileSync(join(userHome, ".cursor", "mcp.json"), "utf8")).toBe(cursorRaw);
    expect(readFileSync(join(userHome, ".codex", "config.toml"), "utf8")).toBe(codexRaw);
    // 缺的厂商补上
    const agy = parseJsonc(readFileSync(join(userHome, ".gemini", "config", "mcp_config.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(agy.mcpServers.github).toEqual({ command: "npx", args: ["-y", "gh-mcp"] });
  });

  it("预览彻底脱敏：env/Header 值、任意协议 URL 的用户名密码、查询参数值、路径令牌、敏感开关后的值、裸长令牌都不出现", () => {
    const secrets = {
      dbPass: "pgP4ssw0rdValue",
      envDb: "envDbSecretPw77",
      plainKey: "plainkeyvalue1234abcd",
      pathToken: "zpk9f8e7d6c5b4a3210zz",
      queryKey: "deadbeefcafebabe00",
      accessToken: "acc_tok_value_123",
      bare: "Q1w2E3r4T5y6U7i8O9p0zz",
      header: "custom-header-secret-1",
    };
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          pg: {
            command: "npx",
            args: [
              "-y",
              "@modelcontextprotocol/server-postgres",
              `postgresql://admin:${secrets.dbPass}@db.internal:5432/app`,
              "--access-token",
              secrets.accessToken,
              secrets.bare,
            ],
            env: { DATABASE_URL: `postgres://u:${secrets.envDb}@h/db`, SERVICE_KEY: secrets.plainKey, NODE_ENV: "production" },
          },
          zap: {
            type: "http",
            url: `https://mcp.zapier.example/api/mcp/s/${secrets.pathToken}/mcp?key=${secrets.queryKey}`,
            headers: { "X-Custom": secrets.header },
          },
        },
      }),
      "utf8",
    );

    const json = JSON.stringify(service().preview());
    for (const value of Object.values(secrets)) expect(json).not.toContain(value);
    // 辨识用的结构还在
    expect(json).toContain("@modelcontextprotocol/server-postgres");
    expect(json).toContain("db.internal:5432");
    expect(json).toContain("https://mcp.zapier.example/api/mcp/s/••••/mcp?key=••••");
    expect(json).toContain("DATABASE_URL=••••");
    expect(json).toContain("X-Custom=••••");
  });

  it("TOML 解析报错不带出错行原文（守护进程日志会记未知错误），只给文件与行列号", () => {
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    writeFileSync(join(userHome, ".codex", "config.toml"), `[mcp_servers.x]\ntoken = "sk-toml-leak-secret-999" oops\n`, "utf8");
    let message = "";
    try {
      service().preview();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("config.toml");
    expect(message).toMatch(/第 2 行/);
    expect(message).not.toContain("sk-toml-leak-secret-999");
  });

  it("移除只认这次扫描里真有的键：伪造的 MCP 名字、伪造的 project:<任意目录> 技能键都不动磁盘", () => {
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    const codexRaw = `[mcp_servers.legacy]\ncommand = "old"\nenabled = false\n`;
    writeFileSync(join(userHome, ".codex", "config.toml"), codexRaw, "utf8");

    const victim = join(rootDir, "victim");
    mkdirSync(join(victim, ".agents", "skills", "s1"), { recursive: true });
    writeFileSync(join(victim, ".agents", "skills", "s1", "SKILL.md"), "x", "utf8");
    mkdirSync(join(victim, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/s1", join(victim, ".claude", "skills", "s1"));

    const res = service().apply({
      selectedMcpKeys: [],
      removeMcpKeys: ["legacy"],
      selectedSkillKeys: [],
      removeSkillKeys: [`project:${victim}:s1`],
    });
    expect(res.removedMcpCount).toBe(0);
    expect(res.unlinkedSkillCount).toBe(0);
    expect(readFileSync(join(userHome, ".codex", "config.toml"), "utf8")).toBe(codexRaw);
    expect(lstatSync(join(victim, ".claude", "skills", "s1")).isSymbolicLink()).toBe(true);
  });

  it("用户自己指向别的 .agents/skills 的私有软链不算受管：同步同名全局技能时保留，取消勾选时也不删", () => {
    const globalCanonical = join(userHome, ".agents", "skills");
    mkdirSync(join(globalCanonical, "foo"), { recursive: true });
    writeFileSync(join(globalCanonical, "foo", "SKILL.md"), "global", "utf8");
    const otherRepo = join(rootDir, "other-repo");
    mkdirSync(join(otherRepo, ".agents", "skills", "foo"), { recursive: true });
    writeFileSync(join(otherRepo, ".agents", "skills", "foo", "SKILL.md"), "mine", "utf8");
    const claudeSkills = join(userHome, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    const privateTarget = join(otherRepo, ".agents", "skills", "foo");
    symlinkSync(privateTarget, join(claudeSkills, "foo"));

    const svc = service();
    const preview = svc.preview();
    const foo = preview.skills.find((s) => s.key === "global:foo")!;
    expect(foo.vendors.find((v) => v.vendor === "claude")?.status).toBe("conflict");

    const linkRes = svc.apply({ selectedMcpKeys: [], removeMcpKeys: [], selectedSkillKeys: ["global:foo"], removeSkillKeys: [] });
    expect(linkRes.preservedPrivateSkillCount).toBe(1);
    expect(readlinkSync(join(claudeSkills, "foo"))).toBe(privateTarget);

    const unlinkRes = svc.apply({ selectedMcpKeys: [], removeMcpKeys: [], selectedSkillKeys: [], removeSkillKeys: ["global:foo"] });
    expect(readlinkSync(join(claudeSkills, "foo"))).toBe(privateTarget);
    // agy、pi 的受管软链照常移除
    expect(unlinkRes.unlinkedSkillCount).toBe(2);
    expect(existsSync(join(userHome, ".gemini", "config", "skills", "foo"))).toBe(false);
  });

  it("原子写：配置文件是指向 dotfiles 的软链时替换真实文件、软链保留、原权限不变；不留临时文件", () => {
    const dotfiles = join(rootDir, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const realClaude = join(dotfiles, "claude.json");
    writeFileSync(realClaude, `{ "mcpServers": { "a": { "command": "echo" } } }\n`, { encoding: "utf8", mode: 0o644 });
    symlinkSync(realClaude, join(userHome, ".claude.json"));
    mkdirSync(join(userHome, ".cursor"), { recursive: true });
    writeFileSync(join(userHome, ".cursor", "mcp.json"), `{ "mcpServers": { "b": { "command": "echo" } } }\n`, "utf8");

    service().apply({ selectedMcpKeys: ["a", "b"], removeMcpKeys: [], selectedSkillKeys: [], removeSkillKeys: [] });

    expect(lstatSync(join(userHome, ".claude.json")).isSymbolicLink()).toBe(true);
    const parsed = parseJsonc(readFileSync(realClaude, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["a", "b"]);
    if (process.platform !== "win32") {
      expect(lstatSync(realClaude).mode & 0o777).toBe(0o644);
      expect(lstatSync(join(userHome, ".pi", "agent", "mcp.json")).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dotfiles)).toEqual(["claude.json"]);
    expect(readdirSync(join(userHome, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("备份轮转不删本次快照：时钟回拨（本次名字排最前）时也保留，失败回滚还有原文可恢复", () => {
    writeFileSync(join(userHome, ".claude.json"), `{ "mcpServers": { "a": { "command": "echo" } } }\n`, "utf8");
    mkdirSync(backupsDir, { recursive: true });
    for (let i = 0; i < MAX_VENDOR_SYNC_BACKUPS + 3; i++) {
      mkdirSync(join(backupsDir, `29991231-0000${String(i).padStart(2, "0")}-future`), { recursive: true });
    }
    const res = service({ now: () => Date.UTC(2026, 0, 1) }).apply({
      selectedMcpKeys: ["a"],
      removeMcpKeys: [],
      selectedSkillKeys: [],
      removeSkillKeys: [],
    });
    const entries = readdirSync(backupsDir);
    expect(entries).toContain(res.backupId);
    expect(entries.length).toBe(MAX_VENDOR_SYNC_BACKUPS);
    expect(existsSync(join(backupsDir, res.backupId!, "manifest.json"))).toBe(true);
  });
});
