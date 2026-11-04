import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_CATALOG_FRESH_MS, MODEL_CATALOG_RETRY_MS, bundledModelCatalog, type ModelCatalog } from "../../shared/index.ts";
import { createModelCatalogs, parseInitializeModels, queryClaudeModels } from "./model-catalog.ts";
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

describe("parseInitializeModels：claude 报的模型名单", () => {
  it("正常：value 当 id、displayName 当名字；default 那项不进名单，它的思考程度给“默认”用；每个模型带自己的思考程度", () => {
    const catalog = parseInitializeModels(REAL_MODELS);
    expect(catalog).toEqual({
      vendor: "claude",
      source: "vendor",
      defaultEfforts: ["low", "medium", "high", "xhigh", "max"],
      models: [
        { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", efforts: null },
        { id: "claude-opus-4-6", label: "Opus 4.6", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high", "max"] },
      ],
    } satisfies ModelCatalog);
  });

  it("字段缺失：没有 displayName 用 value；没有 description 是 null；没给思考程度是 null，明说不支持是空的；没有 default 那项时“默认”的思考程度是 null", () => {
    const catalog = parseInitializeModels([{ value: "opus" }, { value: "haiku", displayName: "", supportsEffort: false }]);
    expect(catalog).toEqual({
      vendor: "claude",
      source: "vendor",
      defaultEfforts: null,
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

describe("queryClaudeModels：起一个 claude，发 initialize，拿 models", () => {
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
    ]);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
  });

  it("claude 回错误：带着原因失败", async () => {
    const claudePath = fakeClaude(`out({ type: "control_response", response: { subtype: "error", request_id: req.request_id, error: "Unsupported control request subtype: initialize" } });`);
    await expect(queryClaudeModels({ claudePath, cwd: dir })).rejects.toThrow(/Unsupported control request/);
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
});

describe("createModelCatalogs：问一次、缓存、过期再问、问不到用打包的", () => {
  const claudeOf = (catalogs: ModelCatalog[]) => catalogs.find((c) => c.vendor === "claude")!;

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
});
