import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_RETRY_MS,
  bundledModelCatalog,
  type AgentVendor,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import { parseAgyModels, queryAgyModels } from "../../vendors/agy/catalog.ts";
import { parseInitializeModels, queryClaudeAuthStatus, queryClaudeModels } from "../../vendors/claude/catalog.ts";
import { parseCodexModels, queryCodexCatalog, queryCodexModels } from "../../vendors/codex/catalog.ts";
import { createVendorCatalogSources } from "../vendors/index.ts";
import { createModelCatalogs, type VendorCatalogSource } from "./model-catalog.ts";
import { isAlive } from "./process.ts";
import { AGY_SIGNED_OUT_STDOUT } from "./test-helpers.ts";

/** 本机 claude 2.1.314 对 initialize 的回应里 models 的前几项（原样，没有账号信息）。 */
const REAL_MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers", supportsThinkingOff: true },
  {
    value: "claude-opus-4-6",
    resolvedModel: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
];

/** 本机 agy 1.5.1 `agy --output-format json models` 的 command.data.models（2026-11-06 原样，思考程度写在 ID 末尾）。 */
const REAL_AGY_MODELS = [
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

const REAL_AGY_OUTPUT = { command: { name: "models", data: { models: REAL_AGY_MODELS } } };

const REAL_CODEX_MODELS = [
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Latest frontier agentic coding model.",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
    isDefault: true,
    hidden: false,
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Fast model.",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
    isDefault: false,
    hidden: false,
  },
  {
    id: "gpt-internal-hidden",
    model: "gpt-internal-hidden",
    displayName: "Hidden Model",
    hidden: true,
  },
];

describe("parseInitializeModels：claude 报的模型名单", () => {
  it("正常：value 当 id、displayName 当名字；default 那项不进名单，它的思考程度给“默认”用；每个模型带自己的思考程度", () => {
    const catalog = parseInitializeModels(REAL_MODELS);
    expect(catalog).toEqual({
      ...bundledModelCatalog("claude"),
      source: "vendor",
      defaultEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultModel: "Opus 5.5",
      models: [
        { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", efforts: null },
        { id: "claude-opus-4-6", label: "Opus 4.6", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high", "max"] },
      ],
    } satisfies ModelCatalog);
  });

  it("“默认”实际用的模型：default 那项的 resolvedModel 对上名单里哪个就用它的名字；若 default 未单列思考程度则沿用 resolvedModel 对应模型的思考程度", () => {
    const def = (resolvedModel?: string) => ({ value: "default", ...(resolvedModel ? { resolvedModel } : {}) });
    const opus = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: ["low", "high", "max"] };
    expect(parseInitializeModels([def("claude-opus-5-5"), opus])?.defaultModel).toBe("Opus 5.5");
    expect(parseInitializeModels([def("claude-opus-5-5"), opus])?.defaultEfforts).toEqual(["low", "high", "max"]);
    expect(parseInitializeModels([opus, def("claude-opus-5-5")])?.defaultModel).toBe("Opus 5.5");
    expect(parseInitializeModels([def("claude-sonnet-9"), opus])?.defaultModel).toBe("claude-sonnet-9");
    expect(parseInitializeModels([def(), opus])?.defaultModel).toBeNull();
  });

  it("字段缺失：没有 displayName 用 value；没有 description 是 null；没给思考程度是 null，明说不支持是空的；没有 default 那项时“默认”的思考程度是 null", () => {
    const catalog = parseInitializeModels([{ value: "opus" }, { value: "haiku", displayName: "", supportsEffort: false }]);
    expect(catalog).toEqual({
      ...bundledModelCatalog("claude"),
      source: "vendor",
      defaultEfforts: null,
      defaultModel: null,
      models: [
        { id: "opus", label: "opus", description: null, efforts: null },
        { id: "haiku", label: "haiku", description: null, efforts: [] },
      ],
    });
  });

  it("脏数据：不是对象、没有 value、value 不是合规模型名（空格、横线开头、太长）的跳过；重复的只留第一个；思考程度里不是字符串的去掉；名字太长截断", () => {
    const catalog = parseInitializeModels([
      null,
      "opus",
      42,
      { displayName: "没有 value" },
      { value: 7 },
      { value: "claude opus" },
      { value: "--model" },
      { value: "m".repeat(101) },
      { value: "sonnet", displayName: "Sonnet 5.5", supportedEffortLevels: ["low", 3, null, "high", "low"] },
      { value: "sonnet", displayName: "第二个 sonnet" },
      { value: "fable", displayName: "F".repeat(200), description: 12 },
    ]);
    expect(catalog?.models.map((m) => m.id)).toEqual(["sonnet", "fable"]);
    expect(catalog?.models[0]?.efforts).toEqual(["low", "high"]);
    expect(catalog?.models[1]?.label).toHaveLength(80);
    expect(catalog?.models[1]?.description).toBeNull();
  });

  it("不是数组、空的、全是坏的：null（调用方用打包的名单）", () => {
    for (const raw of [undefined, null, {}, "opus", [], [null, { value: "a b" }], [{ value: "default" }]]) expect(parseInitializeModels(raw)).toBeNull();
  });

  it("太多：只取前 50 个", () => {
    const catalog = parseInitializeModels(Array.from({ length: 80 }, (_, i) => ({ value: `model-${i}` })));
    expect(catalog?.models).toHaveLength(50);
  });
});

describe("parseAgyModels：agy 报的模型名单（按 Antigravity 软件的做法拆成 模型 + 思考程度）", () => {
  const entry = (id: string, label: string, efforts: string[]) => ({ id, label, description: null, efforts });

  it("真名单：十三个带档位的 ID 拆成五个不带档位的模型，各自的档位按 low、medium、high 排，GPT-OSS 只有 medium", () => {
    const catalog = parseAgyModels(REAL_AGY_OUTPUT);
    expect(catalog).toEqual({
      ...bundledModelCatalog("agy"),
      source: "vendor",
      defaultModel: null,
      models: [
        entry("gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]),
        entry("gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]),
        entry("claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]),
        entry("claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]),
        entry("gpt-oss-120b", "GPT-OSS 120B", ["medium"]),
      ],
    } satisfies ModelCatalog);
    // 直接传数组也行
    expect(parseAgyModels(REAL_AGY_MODELS)).toEqual(catalog);
  });

  it("打包的名单就是真名单拆完的样子（拿不到名单时兜底，和真的一致）", () => {
    expect(bundledModelCatalog("agy").models).toEqual(parseAgyModels(REAL_AGY_MODELS)!.models);
  });

  it("没见过的新模型照样拆：按“ID 末尾 -档位、名字末尾 (档位)”认，不看模型名", () => {
    const catalog = parseAgyModels([
      { id: "gemini-9-nova-high", label: "Gemini 9 Nova (High)" },
      { id: "gemini-9-nova-low", label: "Gemini 9 Nova (Low)" },
      { id: "mystery-7b-medium", label: "Mystery 7B (Medium)" },
    ]);
    expect(catalog?.models).toEqual([entry("gemini-9-nova", "Gemini 9 Nova", ["low", "high"]), entry("mystery-7b", "Mystery 7B", ["medium"])]);
  });

  it("不带档位的（ID 或名字对不上档位）原样留着，明说没有思考程度（界面不出下拉）", () => {
    const catalog = parseAgyModels([
      { id: "plain-model", label: "Plain Model" },
      { id: "foo-thinking", label: "Foo (Thinking)" },
      { id: "bar-high", label: "Bar" },
      { id: "baz-high", label: "Baz (Low)" },
      { id: "no-label" },
    ]);
    expect(catalog?.models).toEqual([
      entry("plain-model", "Plain Model", []),
      entry("foo-thinking", "Foo (Thinking)", []),
      entry("bar-high", "Bar", []),
      entry("baz-high", "Baz (Low)", []),
      entry("no-label", "no-label", []),
    ]);
  });

  it("currently_selected 的那项记成默认模型（名字不带档位），并把该模型支持的档位赋给 defaultEfforts；后续档位带的 description 能补上", () => {
    const catalog = parseAgyModels([
      { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
      { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", description: "Balanced reasoning", currently_selected: true },
    ]);
    expect(catalog?.defaultModel).toBe("Gemini 4 Argon");
    expect(catalog?.defaultEfforts).toEqual(["low", "medium"]);
    expect(catalog?.models[0]?.description).toBe("Balanced reasoning");
  });

  it("过滤非法模型名和重复项；无效或空返回 null", () => {
    const catalog = parseAgyModels([
      { id: "bad model" },
      { id: "--flag" },
      { id: "gemini-4-argon-high", label: "Argon (High)" },
      { id: "gemini-4-argon-high", label: "Duplicate (High)" },
    ]);
    expect(catalog?.models.map((m) => [m.id, m.efforts])).toEqual([["gemini-4-argon", ["high"]]]);
    for (const bad of [null, undefined, "str", {}, { command: { data: { models: [] } } }, [{ id: "a b" }]]) {
      expect(parseAgyModels(bad)).toBeNull();
    }
  });
});

describe("parseCodexModels：codex 报的模型名单", () => {
  it("跳过 hidden === true，提取 supportedReasoningEfforts（含 max、ultra）和 isDefault（含 defaultEfforts）", () => {
    const catalog = parseCodexModels({ data: REAL_CODEX_MODELS });
    expect(catalog).toEqual({
      ...bundledModelCatalog("codex"),
      source: "vendor",
      defaultModel: "GPT-5.4",
      defaultModelId: "gpt-5.4",
      defaultEfforts: ["low", "medium", "high", "xhigh"],
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          description: "Latest frontier agentic coding model.",
          efforts: ["low", "medium", "high", "xhigh"],
        },
        {
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
          description: "Fast model.",
          efforts: ["low", "medium"],
        },
      ],
    } satisfies ModelCatalog);
  });

  it("兼容 models_cache.json 原始字段（slug、display_name、visibility === 'hide'、supported_reasoning_levels）并保留 max/ultra 档位", () => {
    const catalog = parseCodexModels({
      models: [
        {
          slug: "gpt-6.1-sol",
          display_name: "GPT-6.1-Sol",
          description: "Flagship model",
          visibility: "list",
          isDefault: true,
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
            { effort: "max" },
            { effort: "ultra" },
          ],
        },
        {
          slug: "gpt-hidden",
          display_name: "Hidden",
          visibility: "hide",
        },
      ],
    });
    expect(catalog?.defaultModel).toBe("GPT-6.1-Sol");
    expect(catalog?.defaultModelId).toBe("gpt-6.1-sol");
    expect(catalog?.defaultEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(catalog?.models).toEqual([
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1-Sol",
        description: "Flagship model",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    ]);
  });

  it("全部 hidden 或无效时返回 null", () => {
    expect(parseCodexModels([{ id: "gpt-5.4", hidden: true }])).toBeNull();
    expect(parseCodexModels([{ slug: "gpt-5.4", visibility: "hide" }])).toBeNull();
    expect(parseCodexModels(null)).toBeNull();
    expect(parseCodexModels({})).toBeNull();
  });
});

describe("queryClaudeModels / queryAgyModels / queryCodexModels", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
  });
  afterEach(async () => {
    await removeTreeWithRetry(dir);
  });

  /** 写一个假 claude：读一行标准输入，交给 body 处理（body 里能用 req、out(obj)、argv）。 */
  function fakeClaude(body: string): string {
    return writeExecutableNodeScript(
      join(dir, "claude"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const i = buf.indexOf("\\n");
  if (i < 0) return;
  const req = JSON.parse(buf.slice(0, i));
  ${body}
});
`,
    );
  }

  function fakeAgy(body: string): string {
    return writeExecutableNodeScript(
      join(dir, "agy"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "agy-argv.json"))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(join(dir, "agy-pid"))}, String(process.pid));
${body}
`,
    );
  }

  function fakeCodex(body: string): string {
    return writeExecutableNodeScript(
      join(dir, "codex"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(join(dir, "codex-argv.json"))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(join(dir, "codex-pid"))}, String(process.pid));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const lines = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  lines.push(msg);
  ${body}
});
`,
    );
  }

  /**
   * 等假进程（写了进程号文件的话）真的没了。失败路径上 model-catalog 是 `void forceKill(child)`（SIGSTOP 住再 SIGKILL，中间隔着异步的 ps），
   * 用例不等的话测试进程收尾时 SIGKILL 还没发出去，假进程就停在 SIGSTOP 状态孤儿化（留在机器上，CI 上留到作业结束被清理）。
   */
  async function expectGone(pidFile: string): Promise<void> {
    if (!existsSync(join(dir, pidFile))) return; // 机器忙时可能还没来得及写进程号就被结束了
    const pid = Number(readFileSync(join(dir, pidFile), "utf8"));
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
  }

  it("正常：参数是 -p + stream-json 进出 + 不存会话；回 control_response 里的 models；之后 claude 退出", async () => {
    const claudePath = fakeClaude(`
      out({ type: "system", subtype: "hook_started" });
      out({ type: "control_response", response: { subtype: "success", request_id: "other", response: { models: [] } } });
      process.stdout.write("不是 JSON\\n");
      out({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { models: [{ value: "opus" }], account: { email: "x" } } } });
      process.stdin.on("end", () => process.exit(0));
    `);
    const models = await queryClaudeModels({ claudePath, cwd: dir });
    expect(models).toEqual([{ value: "opus" }]);
    expect(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      // 不跑钩子、不连 MCP（docs/composer-commands.md 的 T10）
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
    ]);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
  });

  it("claude 回错误：带着原因失败", async () => {
    const claudePath = fakeClaude(`out({ type: "control_response", response: { subtype: "error", request_id: req.request_id, error: "Unsupported control request subtype: initialize" } });`);
    await expect(queryClaudeModels({ claudePath, cwd: dir })).rejects.toThrow(/Unsupported control request/);
    await expectGone("pid");
  });

  it("没回就退出：失败，带上标准错误", async () => {
    const claudePath = fakeClaude(`process.stderr.write("Not logged in"); process.exit(1);`);
    await expect(queryClaudeModels({ claudePath, cwd: dir })).rejects.toThrow(/Not logged in/);
  });

  it("超时：失败，claude 被结束", async () => {
    const claudePath = fakeClaude(`setInterval(() => {}, 1000);`);
    const started = Date.now();
    await expect(queryClaudeModels({ claudePath, cwd: dir, timeoutMs: 2_000 })).rejects.toThrow(/超时|timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // 机器忙时假 claude 可能还没来得及写下进程号就被结束了；写了的话它一定已经不在
    if (existsSync(join(dir, "pid"))) {
      const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
      await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
    }
  });

  it("claude 不存在：失败", async () => {
    await expect(queryClaudeModels({ claudePath: join(dir, "nope"), cwd: dir })).rejects.toThrow(/nope/);
  });

  it("中途取消（关机）：失败，claude 被结束", async () => {
    const claudePath = fakeClaude(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const query = queryClaudeModels({ claudePath, cwd: dir, signal: controller.signal });
    await expect.poll(() => readFileSync(join(dir, "pid"), "utf8").length > 0, { timeout: 15_000 }).toBe(true);
    controller.abort();
    await expect(query).rejects.toThrow();
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
  });

  it("queryAgyModels：起 agy --output-format json models，返回解析后的 JSON", async () => {
    const agyPath = fakeAgy(`
      process.stdout.write(JSON.stringify(${JSON.stringify(REAL_AGY_OUTPUT)}) + "\\n");
      process.exit(0);
    `);
    const raw = await queryAgyModels({ agyPath, cwd: dir });
    expect(raw).toEqual(REAL_AGY_OUTPUT);
    expect(JSON.parse(readFileSync(join(dir, "agy-argv.json"), "utf8"))).toEqual(["--output-format", "json", "models"]);
  });

  it("queryAgyModels：超时或非零退出时失败并清理进程", async () => {
    const failPath = fakeAgy(`process.stderr.write("agy error"); process.exit(1);`);
    await expect(queryAgyModels({ agyPath: failPath, cwd: dir })).rejects.toThrow(/agy error/);

    const hangPath = fakeAgy(`setInterval(() => {}, 1000);`);
    await expect(queryAgyModels({ agyPath: hangPath, cwd: dir, timeoutMs: 500 })).rejects.toThrow(/超时/);
    if (existsSync(join(dir, "agy-pid"))) {
      const pid = Number(readFileSync(join(dir, "agy-pid"), "utf8"));
      await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
    }
  });

  it("queryCodexModels：起 codex app-server --listen stdio://，发 initialize → initialized → model/list，返回模型列表", async () => {
    const codexPath = fakeCodex(`
      if (msg.id === 1 && msg.method === "initialize") {
        out({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } });
      }
      if (msg.id === 2 && msg.method === "model/list") {
        fs.writeFileSync(${JSON.stringify(join(dir, "codex-lines.json"))}, JSON.stringify(lines));
        out({ jsonrpc: "2.0", id: 2, result: { data: ${JSON.stringify(REAL_CODEX_MODELS)} } });
      }
    `);
    const data = await queryCodexModels({ codexPath, cwd: dir });
    expect(data).toEqual(REAL_CODEX_MODELS);
    expect(JSON.parse(readFileSync(join(dir, "codex-argv.json"), "utf8"))).toEqual(["app-server", "--listen", "stdio://"]);
    const sent = JSON.parse(readFileSync(join(dir, "codex-lines.json"), "utf8")) as Array<{ method?: string }>;
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "model/list"]);
  });

  it("queryAgyModels：agy 没登录（退出码 0、打印的不是 JSON）：失败，原因里带上它打印的话", async () => {
    const agyPath = fakeAgy(`process.stdout.write(${JSON.stringify(AGY_SIGNED_OUT_STDOUT)}); process.exit(0);`);
    await expect(queryAgyModels({ agyPath, cwd: dir })).rejects.toThrow(/Please sign in to view available models/);
  });

  it("queryCodexCatalog：同一个 app-server 里问 model/list 和 account/read；account/read 出错不影响名单", async () => {
    const account = { account: null, requiresOpenaiAuth: true };
    const okPath = fakeCodex(`
      if (msg.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });
      if (msg.method === "model/list") out({ jsonrpc: "2.0", id: msg.id, result: { data: ${JSON.stringify(REAL_CODEX_MODELS)} } });
      if (msg.method === "account/read") {
        fs.writeFileSync(${JSON.stringify(join(dir, "codex-lines.json"))}, JSON.stringify(lines));
        out({ jsonrpc: "2.0", id: msg.id, result: ${JSON.stringify(account)} });
      }
    `);
    expect(await queryCodexCatalog({ codexPath: okPath, cwd: dir })).toEqual({ models: REAL_CODEX_MODELS, account });
    const sent = JSON.parse(readFileSync(join(dir, "codex-lines.json"), "utf8")) as Array<{ method?: string }>;
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "model/list", "account/read"]);

    const noAccountPath = fakeCodex(`
      if (msg.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });
      if (msg.method === "model/list") out({ jsonrpc: "2.0", id: msg.id, result: { data: ${JSON.stringify(REAL_CODEX_MODELS)} } });
      if (msg.method === "account/read") out({ jsonrpc: "2.0", id: msg.id, error: { message: "unknown method" } });
    `);
    expect(await queryCodexCatalog({ codexPath: noAccountPath, cwd: dir })).toEqual({ models: REAL_CODEX_MODELS, account: undefined });

    // 老版本对不认识的方法根本不回：名单照样拿到，不等到整个查询超时
    const silentPath = fakeCodex(`
      if (msg.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });
      if (msg.method === "model/list") out({ jsonrpc: "2.0", id: msg.id, result: { data: ${JSON.stringify(REAL_CODEX_MODELS)} } });
    `);
    const started = Date.now();
    expect(await queryCodexCatalog({ codexPath: silentPath, cwd: dir, timeoutMs: 10_000 })).toEqual({ models: REAL_CODEX_MODELS, account: undefined });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("queryClaudeAuthStatus：跑 claude auth status --json，loggedIn 真假对应能用 / 没登录，认不出是 unknown", async () => {
    const write = (body: string) => {
      return writeExecutableNodeScript(
        join(dir, "claude-auth"),
        `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "auth-argv.json"))}, JSON.stringify(process.argv.slice(2)));\n${body}\n`,
      );
    };
    expect(await queryClaudeAuthStatus({ claudePath: write(`console.log(JSON.stringify({ loggedIn: true })); process.exit(0);`), cwd: dir })).toBe("available");
    expect(JSON.parse(readFileSync(join(dir, "auth-argv.json"), "utf8"))).toEqual(["auth", "status", "--json"]);
    expect(await queryClaudeAuthStatus({ claudePath: write(`console.log(JSON.stringify({ loggedIn: false })); process.exit(1);`), cwd: dir })).toBe("signed_out");
    expect(await queryClaudeAuthStatus({ claudePath: write(`console.log("??"); process.exit(2);`), cwd: dir })).toBe("unknown");
    expect(await queryClaudeAuthStatus({ claudePath: join(dir, "nope"), cwd: dir })).toBe("not_installed");
  });

  it("queryCodexModels：RPC 返回错误或超时时失败并清理进程", async () => {
    const errPath = fakeCodex(`
      if (msg.id === 2) out({ jsonrpc: "2.0", id: 2, error: { message: "model list unavailable" } });
    `);
    await expect(queryCodexModels({ codexPath: errPath, cwd: dir })).rejects.toThrow(/model list unavailable/);
    await expectGone("codex-pid");
  });

  it("queryCodexModels：错误对象没有 message 时，失败原因里不出现整个 JSON", async () => {
    const errPath = fakeCodex(`
      if (msg.id === 2) out({ jsonrpc: "2.0", id: 2, error: { code: -32601 } });
    `);
    const failure = await queryCodexModels({ codexPath: errPath, cwd: dir }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("codex 回了错误：未知错误（错误码 -32601）");
    expect((failure as Error).message).not.toContain("{");
  });
});

describe("createModelCatalogs：问一次、缓存、过期再问、问不到用打包的", () => {
  const claudeOf = (catalogs: ModelCatalog[]) => catalogs.find((c) => c.vendor === "claude")!;
  const agyOf = (catalogs: ModelCatalog[]) => catalogs.find((c) => c.vendor === "agy")!;
  const codexOf = (catalogs: ModelCatalog[]) => catalogs.find((c) => c.vendor === "codex")!;

  function setup(answers: Array<unknown | Error>) {
    let now = 1_000_000;
    const calls: number[] = [];
    const logs: string[] = [];
    const pending: Array<() => void> = [];
    let gated = false;
    const catalogs = createModelCatalogs({
      sources: {
        claude: {
          parse: parseInitializeModels,
          query: async () => {
            calls.push(now);
            if (gated) await new Promise<void>((resolve) => pending.push(resolve));
            const answer = answers.shift();
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      },
      now: () => now,
      log: (line) => logs.push(line),
    });
    return {
      catalogs,
      calls,
      logs,
      advance: (ms: number) => (now += ms),
      gate: () => (gated = true),
      release: () => {
        gated = false;
        for (const r of pending.splice(0)) r();
      },
    };
  }

  it("第一次要时问 claude，之后用缓存，不再问", async () => {
    const t = setup([REAL_MODELS]);
    expect(t.calls).toHaveLength(0);
    const first = claudeOf(await t.catalogs.list());
    expect(first.source).toBe("vendor");
    expect(first.models.map((m) => m.label)).toEqual(["Opus 5.5", "Haiku 4.5", "Opus 4.6"]);
    await t.catalogs.list();
    expect(t.calls).toHaveLength(1);
  });

  it("current：不问 claude，给缓存着的那份；还没问到是 null，问到了是 claude 的", async () => {
    const t = setup([REAL_MODELS]);
    expect(t.catalogs.current("claude")).toBeNull();
    expect(t.calls).toHaveLength(0);
    await t.catalogs.list();
    expect(t.catalogs.current("claude")?.models[0]?.label).toBe("Opus 5.5");
  });

  it("同时要好几次：只问一次", async () => {
    const t = setup([REAL_MODELS]);
    t.gate();
    const a = t.catalogs.list();
    const b = t.catalogs.list();
    t.release();
    expect(claudeOf(await a).source).toBe("vendor");
    expect(claudeOf(await b).source).toBe("vendor");
    expect(t.calls).toHaveLength(1);
  });

  it("问不到（claude 不存在、超时、报错）、回的是脏数据：用打包的名单，不报错；记一行日志", async () => {
    for (const answer of [new Error("超时"), [{ value: "a b" }], "garbage"]) {
      const t = setup([answer]);
      expect({ ...claudeOf(await t.catalogs.list()), availability: "unknown" }).toEqual(bundledModelCatalog("claude"));
      expect(t.logs).toHaveLength(1);
    }
  });

  it("没问到：过一会儿（MODEL_CATALOG_RETRY_MS）才再问，再问到了就换成 claude 的", async () => {
    const t = setup([new Error("boom"), REAL_MODELS]);
    await t.catalogs.list();
    await t.catalogs.list();
    expect(t.calls).toHaveLength(1);
    t.advance(MODEL_CATALOG_RETRY_MS);
    expect(claudeOf(await t.catalogs.list()).source).toBe("vendor");
    expect(t.calls).toHaveLength(2);
  });

  it("过期了（MODEL_CATALOG_FRESH_MS）：先给旧的，后台再问；问到新的下次就是新的；没问到继续用旧的", async () => {
    const t = setup([REAL_MODELS, [{ value: "opus", displayName: "Opus 6" }], new Error("boom")]);
    await t.catalogs.list();
    t.advance(MODEL_CATALOG_FRESH_MS);
    expect(claudeOf(await t.catalogs.list()).models).toHaveLength(3);
    expect(t.calls).toHaveLength(2);
    await expect.poll(async () => claudeOf(await t.catalogs.list()).models.map((m) => m.label)).toEqual(["Opus 6"]);
    t.advance(MODEL_CATALOG_FRESH_MS);
    await t.catalogs.list();
    expect(t.calls).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claudeOf(await t.catalogs.list()).models.map((m) => m.label)).toEqual(["Opus 6"]);
  });

  it("refresh：不管新不新都重新问，等问完再回", async () => {
    const t = setup([REAL_MODELS, [{ value: "haiku", displayName: "Haiku 6" }]]);
    await t.catalogs.list();
    expect(claudeOf(await t.catalogs.list({ refresh: true })).models.map((m) => m.label)).toEqual(["Haiku 6"]);
    expect(t.calls).toHaveLength(2);
  });

  it("close：在问的那次取消，之后不再问", async () => {
    let aborted = false;
    const catalogs = createModelCatalogs({
      sources: {
        claude: {
          parse: parseInitializeModels,
          query: (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        },
      },
      log: () => {},
    });
    const listing = catalogs.list();
    catalogs.close();
    expect(claudeOf(await listing)).toEqual(bundledModelCatalog("claude"));
    expect(aborted).toBe(true);
  });

  it("三家厂商并行查询、各自独立缓存与失败重试；没传查询函数的厂商直接回打包名单", async () => {
    let now = 2_000_000;
    let codexCalls = 0;
    const codexAnswers: Array<unknown | Error> = [new Error("codex not ready"), REAL_CODEX_MODELS];
    const logs: string[] = [];
    const catalogs = createModelCatalogs({
      sources: {
        claude: { parse: parseInitializeModels, query: async () => REAL_MODELS },
        agy: {
          parse: parseAgyModels,
          query: async () => ({ command: { data: { models: REAL_AGY_MODELS.map((m) => ({ ...m, currently_selected: m.id === "gemini-4-argon-medium" })) } } }),
        },
        codex: {
          parse: parseCodexModels,
          query: async () => {
            codexCalls++;
            const next = codexAnswers.shift();
            if (next instanceof Error) throw next;
            return next;
          },
        },
      },
      now: () => now,
      log: (line) => logs.push(line),
    });

    const first = await catalogs.list();
    expect(claudeOf(first).source).toBe("vendor");
    expect(agyOf(first).source).toBe("vendor");
    expect(agyOf(first).defaultModel).toBe("Gemini 4 Argon");
    expect(codexOf(first)).toEqual(bundledModelCatalog("codex"));
    expect(claudeOf(first).availability).toBe("available");
    expect(catalogs.current("claude")?.source).toBe("vendor");
    expect(catalogs.current("agy")?.source).toBe("vendor");
    expect(catalogs.current("codex")).toBeNull();
    expect(logs).toHaveLength(1);

    // 没到重试窗口，codex 不再问
    await catalogs.list();
    expect(codexCalls).toBe(1);

    // 到了 MODEL_CATALOG_RETRY_MS，只有失败过的 codex 重问，claude/agy 还在新鲜期内不重问
    now += MODEL_CATALOG_RETRY_MS;
    const second = await catalogs.list();
    expect(codexCalls).toBe(2);
    expect(codexOf(second).source).toBe("vendor");
    expect(codexOf(second).defaultModel).toBe("GPT-5.4");
    expect(catalogs.current("codex")?.defaultModel).toBe("GPT-5.4");
  });

  it("fingerprint 变化（本机凭据或 models_cache.json 更新）：不必等 6 小时，过了指纹冷却期下次 list() 立即重问并回新模型", async () => {
    let now = 3_000_000;
    let fp = "v1";
    let calls = 0;
    const answers = [
      [{ id: "gpt-6-luna", displayName: "GPT-6-Luna", isDefault: true, supportedReasoningEfforts: ["low", "high", "max"] }],
      [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, supportedReasoningEfforts: ["low", "high", "max", "ultra"] }],
    ];
    const catalogs = createModelCatalogs({
      sources: {
        codex: {
          parse: parseCodexModels,
          fingerprint: () => fp,
          query: async () => {
            calls++;
            return answers.shift();
          },
        },
      },
      now: () => now,
    });

    const first = codexOf(await catalogs.list());
    expect(first.models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
    expect(first.defaultEfforts).toEqual(["low", "high", "max"]);
    expect(calls).toBe(1);

    // 指纹没变、时间没过：直接给缓存，不重问
    await catalogs.list();
    expect(calls).toBe(1);

    // 本机 ~/.codex/models_cache.json 或凭据更新导致指纹变化：过了冷却期（几秒，远不到 6 小时）就立即重问并拿到新列表
    fp = "v2";
    now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
    const second = codexOf(await catalogs.list());
    expect(calls).toBe(2);
    expect(second.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(second.defaultEfforts).toEqual(["low", "high", "max", "ultra"]);
  });

  it("list({ vendor, refresh }) 只查并返回指定厂商，不重查其他厂商", async () => {
    let claudeCalls = 0;
    let codexCalls = 0;
    const catalogs = createModelCatalogs({
      sources: {
        claude: { parse: parseInitializeModels, query: async () => (claudeCalls++, REAL_MODELS) },
        codex: { parse: parseCodexModels, query: async () => (codexCalls++, REAL_CODEX_MODELS) },
      },
      log: () => {},
    });
    const onlyClaude = await catalogs.list({ vendor: "claude" });
    expect(onlyClaude.map((c) => c.vendor)).toEqual(["claude"]);
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(0);

    const refreshedClaude = await catalogs.list({ vendor: "claude", refresh: true });
    expect(refreshedClaude.map((c) => c.vendor)).toEqual(["claude"]);
    expect(claudeCalls).toBe(2);
    expect(codexCalls).toBe(0);
  });

  it("指纹冷却：命中缓存时 MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS 内 list()/ensureUsable() 再多次也不重算指纹（不碰磁盘）；过了冷却期只算一次", async () => {
    let now = 4_000_000;
    let fp = "v1";
    let fingerprintCalls = 0;
    let calls = 0;
    const catalogs = createModelCatalogs({
      sources: {
        codex: {
          parse: parseCodexModels,
          fingerprint: () => {
            fingerprintCalls++;
            return fp;
          },
          query: async () => {
            calls++;
            return REAL_CODEX_MODELS;
          },
        },
      },
      now: () => now,
    });

    await catalogs.list();
    expect(calls).toBe(1);
    // 问完记一次指纹
    expect(fingerprintCalls).toBe(1);

    // 冷却期内：高频调用全部命中缓存，指纹一次都不算；文件变了也要等冷却期过了才看到
    fp = "v2";
    for (let i = 0; i < 50; i++) {
      await catalogs.list();
      expect(await catalogs.ensureUsable("codex")).toBe("available");
      now += Math.floor((MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS - 1) / 50);
    }
    expect(fingerprintCalls).toBe(1);
    expect(calls).toBe(1);

    // 过了冷却期：算一次，发现变了就重问（重问完再记一次）
    now = 4_000_000 + MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
    await catalogs.list();
    expect(calls).toBe(2);
    expect(fingerprintCalls).toBe(3);

    // 刚重问完又进冷却期：接着调不再算
    await catalogs.list();
    await catalogs.ensureUsable("codex");
    expect(fingerprintCalls).toBe(3);

    // 冷却期过了、指纹没变：只算一次、不重问
    now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
    await catalogs.list();
    await catalogs.list();
    expect(fingerprintCalls).toBe(4);
    expect(calls).toBe(2);
  });

  it("codex 自定义 CODEX_HOME：其下 auth.json / models_cache.json 变了，缓存自动失效重问（指纹跟认证判断看同一处）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-catalog-codex-home-"));
    try {
      const home = join(dir, "home");
      const codexHome = join(dir, "custom-codex");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      const bin = join(dir, "codex");
      writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      let now = 6_000_000;
      let calls = 0;
      // 经守护进程的装配（createVendorCatalogSources）拿：指纹由它按通用规则补（spec 的 home.configHome）
      const options = { path: bin, cwd: home, installed: () => true, env: { PATH: "", CODEX_HOME: codexHome } };
      const allOptions = Object.fromEntries(AGENT_VENDORS.map((v) => [v, options])) as Record<AgentVendor, typeof options>;
      const source = createVendorCatalogSources(allOptions).codex!;
      const catalogs = createModelCatalogs({
        sources: {
          codex: {
            ...source,
            query: async () => {
              calls++;
              return REAL_CODEX_MODELS;
            },
          },
        },
        now: () => now,
      });

      await catalogs.list();
      expect(calls).toBe(1);
      // 认证判断看的也是 CODEX_HOME：还没有 auth.json → 没登录
      expect(await source.confirm!(new AbortController().signal)).toBe("signed_out");

      // 默认 ~/.codex 下的变化不算
      writeFileSync(join(home, ".codex", "auth.json"), "{}");
      now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
      await catalogs.list();
      expect(calls).toBe(1);

      // CODEX_HOME 下登录（写 auth.json）：重问
      writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"a\"}");
      expect(await source.confirm!(new AbortController().signal)).toBe("available");
      now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
      await catalogs.list();
      expect(calls).toBe(2);

      // CODEX_HOME 下 models_cache.json 更新：再重问
      writeFileSync(join(codexHome, "models_cache.json"), "{\"models\":[]}");
      now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
      await catalogs.list();
      expect(calls).toBe(3);
    } finally {
      await removeTreeWithRetry(dir);
    }
  });
});

describe("createModelCatalogs：厂商在这台设备上的状态（跟名单一起问、一起缓存）", () => {
  const of = (catalogs: ModelCatalog[], vendor: string) => catalogs.find((c) => c.vendor === vendor)!;

  function setup(source: Partial<VendorCatalogSource> & { answers?: Array<unknown | Error> }) {
    let now = 5_000_000;
    let calls = 0;
    const answers = source.answers ?? [];
    const catalogs = createModelCatalogs({
      sources: {
        claude: { parse: parseInitializeModels, query: async () => REAL_MODELS },
        codex: {
          parse: (raw) => parseCodexModels((raw as { models?: unknown })?.models),
          query: async () => {
            calls++;
            const answer = answers.length > 1 ? answers.shift() : answers[0];
            if (answer instanceof Error) throw answer;
            return answer;
          },
          ...source,
        },
      },
      now: () => now,
      log: () => {},
    });
    return { catalogs, calls: () => calls, advance: (ms: number) => (now += ms) };
  }
  const signedOut = { models: REAL_CODEX_MODELS, account: null };
  const signedIn = { models: REAL_CODEX_MODELS, account: { type: "chatgpt" } };
  const codexAvailability = (raw: unknown): VendorAvailability => ((raw as { account?: unknown }).account === null ? "signed_out" : "available");

  it("没装（只查文件，不起进程）：not_installed，用打包的名单；装上以后下次要时就问", async () => {
    let installed = false;
    const t = setup({ answers: [signedIn], installed: () => installed });
    const first = of(await t.catalogs.list(), "codex");
    expect(first.availability).toBe("not_installed");
    expect(t.calls()).toBe(0);
    expect(t.catalogs.availability("codex")).toBe("not_installed");
    installed = true;
    expect(t.catalogs.availability("codex")).toBe("unknown");
    expect(of(await t.catalogs.list(), "codex").availability).toBe("available");
    expect(t.calls()).toBe(1);
  });

  it("起进程报 ENOENT：not_installed", async () => {
    const t = setup({ answers: [new Error("/x/codex: spawn /x/codex ENOENT")] });
    expect(of(await t.catalogs.list(), "codex").availability).toBe("not_installed");
  });

  it("查询失败、报错里是认证的话：signed_out（默认按 VENDOR_FAILURE_SIGNS 的 auth 认）；别的错是 unknown", async () => {
    expect(of(await setup({ answers: [new Error("Please sign in to view available models")] }).catalogs.list(), "codex").availability).toBe("signed_out");
    expect(of(await setup({ answers: [new Error("超时")] }).catalogs.list(), "codex").availability).toBe("unknown");
  });

  it("名单问到了、回应里说没登录：名单照用厂商的，状态 signed_out；5 分钟内不再问，之后有人要时在后台再问", async () => {
    const t = setup({ answers: [signedOut, signedIn], availabilityOf: codexAvailability });
    const first = of(await t.catalogs.list(), "codex");
    expect(first.source).toBe("vendor");
    expect(first.availability).toBe("signed_out");
    await t.catalogs.list();
    expect(t.calls()).toBe(1);
    t.advance(MODEL_CATALOG_RETRY_MS);
    await t.catalogs.list();
    expect(t.calls()).toBe(2);
    await expect.poll(async () => of(await t.catalogs.list(), "codex").availability).toBe("available");
  });

  it("refresh: \"unusable\"：只重问不能用的那几家，等问完再回；能用的不问", async () => {
    let claudeCalls = 0;
    const answers = [signedOut, signedIn];
    const catalogs = createModelCatalogs({
      sources: {
        claude: { parse: parseInitializeModels, query: async () => (claudeCalls++, REAL_MODELS) },
        codex: { parse: (raw) => parseCodexModels((raw as { models?: unknown }).models), query: async () => answers.shift(), availabilityOf: codexAvailability },
      },
      log: () => {},
    });
    expect(of(await catalogs.list(), "codex").availability).toBe("signed_out");
    expect(of(await catalogs.list({ refresh: "unusable" }), "codex").availability).toBe("available");
    expect(claudeCalls).toBe(1);
    expect(answers).toHaveLength(0);
  });

  it("回应说不清（unknown）时才用补充判断（confirm）", async () => {
    let confirms = 0;
    const t = setup({ answers: [signedIn], availabilityOf: () => "unknown", confirm: async () => (confirms++, "signed_out") });
    expect(of(await t.catalogs.list(), "codex").availability).toBe("signed_out");
    expect(confirms).toBe(1);
    const sure = setup({ answers: [signedIn], availabilityOf: () => "available", confirm: async () => (confirms++, "signed_out") });
    expect(of(await sure.catalogs.list(), "codex").availability).toBe("available");
    expect(confirms).toBe(1);
  });

  it("ensureUsable：不能用的先重问这一家一次再给结果；能用的不问；没装的不问", async () => {
    const t = setup({ answers: [signedOut, signedIn], availabilityOf: codexAvailability });
    await t.catalogs.list();
    expect(await t.catalogs.ensureUsable("codex")).toBe("available");
    expect(t.calls()).toBe(2);
    expect(await t.catalogs.ensureUsable("codex")).toBe("available");
    expect(t.calls()).toBe(2);
    const gone = setup({ answers: [signedIn], installed: () => false });
    expect(await gone.catalogs.ensureUsable("codex")).toBe("not_installed");
    expect(gone.calls()).toBe(0);
  });

  it("ensureUsable 的重问有时间预算：预算内没问完就按现在的状态回，重问在后台接着跑，下一次看得到新结果；同一家同时只跑一个", async () => {
    let calls = 0;
    let finish: (raw: unknown) => void = () => {};
    const catalogs = createModelCatalogs({
      sources: {
        codex: {
          parse: (raw) => parseCodexModels((raw as { models?: unknown })?.models),
          query: () => {
            calls++;
            return calls === 1 ? Promise.resolve(signedOut) : new Promise((resolve) => (finish = resolve));
          },
          availabilityOf: codexAvailability,
        },
      },
      ensureUsableBudgetMs: 30,
      log: () => {},
    });
    await catalogs.list();
    expect(catalogs.availability("codex")).toBe("signed_out");
    const started = Date.now();
    expect(await catalogs.ensureUsable("codex")).toBe("signed_out");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await catalogs.ensureUsable("codex")).toBe("signed_out");
    expect(calls).toBe(2);
    finish(signedIn);
    await expect.poll(() => catalogs.availability("codex")).toBe("available");
    expect(await catalogs.ensureUsable("codex")).toBe("available");
    expect(calls).toBe(2);
  });

  it("report：真跑的结果直接更新状态（不用等缓存过期）", async () => {
    const t = setup({ answers: [signedIn], availabilityOf: codexAvailability });
    await t.catalogs.list();
    t.catalogs.report("codex", "signed_out");
    expect(t.catalogs.availability("codex")).toBe("signed_out");
    expect(of(await t.catalogs.list(), "codex").availability).toBe("signed_out");
  });

  it("没配查询的厂商：打包的名单，状态 unknown（当能用）", async () => {
    const t = setup({ answers: [signedIn] });
    expect(of(await t.catalogs.list(), "agy").availability).toBe("unknown");
    expect(t.catalogs.availability("agy")).toBe("unknown");
  });
});
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
