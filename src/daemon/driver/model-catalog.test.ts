import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_CATALOG_FRESH_MS, MODEL_CATALOG_RETRY_MS, bundledModelCatalog, type ModelCatalog } from "../../shared/index.ts";
import {
  createModelCatalogs,
  parseAgyModels,
  parseCodexModels,
  parseInitializeModels,
  queryAgyModels,
  queryClaudeModels,
  queryCodexModels,
} from "./model-catalog.ts";
import { isAlive } from "./process.ts";

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

  it("“默认”实际用的模型：default 那项的 resolvedModel 对上名单里哪个就用它的名字；对不上用 resolvedModel 原样；没有 resolvedModel 是 null", () => {
    const def = (resolvedModel?: string) => ({ value: "default", ...(resolvedModel ? { resolvedModel } : {}) });
    const opus = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" };
    expect(parseInitializeModels([def("claude-opus-5-5"), opus])?.defaultModel).toBe("Opus 5.5");
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

  it("currently_selected 的那项记成默认模型，名字不带档位", () => {
    const catalog = parseAgyModels([
      { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
      { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", currently_selected: true },
    ]);
    expect(catalog?.defaultModel).toBe("Gemini 4 Argon");
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
  it("跳过 hidden === true，提取 supportedReasoningEfforts 和 isDefault", () => {
    const catalog = parseCodexModels({ data: REAL_CODEX_MODELS });
    expect(catalog).toEqual({
      ...bundledModelCatalog("codex"),
      source: "vendor",
      defaultModel: "GPT-5.4",
      defaultModelId: "gpt-5.4",
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

  it("全部 hidden 或无效时返回 null", () => {
    expect(parseCodexModels([{ id: "gpt-5.4", hidden: true }])).toBeNull();
    expect(parseCodexModels(null)).toBeNull();
    expect(parseCodexModels({})).toBeNull();
  });
});

describe("queryClaudeModels / queryAgyModels / queryCodexModels", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 写一个假 claude：读一行标准输入，交给 body 处理（body 里能用 req、out(obj)、argv）。 */
  function fakeClaude(body: string): string {
    const path = join(dir, "claude");
    writeFileSync(
      path,
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
    chmodSync(path, 0o755);
    return path;
  }

  function fakeAgy(body: string): string {
    const path = join(dir, "agy");
    writeFileSync(
      path,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "agy-argv.json"))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(join(dir, "agy-pid"))}, String(process.pid));
${body}
`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  function fakeCodex(body: string): string {
    const path = join(dir, "codex");
    writeFileSync(
      path,
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
    chmodSync(path, 0o755);
    return path;
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

  it("queryCodexModels：RPC 返回错误或超时时失败并清理进程", async () => {
    const errPath = fakeCodex(`
      if (msg.id === 2) out({ jsonrpc: "2.0", id: 2, error: { message: "model list unavailable" } });
    `);
    await expect(queryCodexModels({ codexPath: errPath, cwd: dir })).rejects.toThrow(/model list unavailable/);
    await expectGone("codex-pid");
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
      queryClaude: async () => {
        calls.push(now);
        if (gated) await new Promise<void>((resolve) => pending.push(resolve));
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
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
    for (const answer of [new Error("spawn claude ENOENT"), new Error("超时"), [{ value: "a b" }], "garbage"]) {
      const t = setup([answer]);
      expect(claudeOf(await t.catalogs.list())).toEqual(bundledModelCatalog("claude"));
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
      queryClaude: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
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
      queryClaude: async () => REAL_MODELS,
      queryAgy: async () => ({ command: { data: { models: REAL_AGY_MODELS.map((m) => ({ ...m, currently_selected: m.id === "gemini-4-argon-medium" })) } } }),
      queryCodex: async () => {
        codexCalls++;
        const next = codexAnswers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => now,
      log: (line) => logs.push(line),
    });

    const first = await catalogs.list();
    expect(claudeOf(first).source).toBe("vendor");
    expect(agyOf(first).source).toBe("vendor");
    expect(agyOf(first).defaultModel).toBe("Gemini 4 Argon");
    expect(codexOf(first)).toEqual(bundledModelCatalog("codex"));
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
});
