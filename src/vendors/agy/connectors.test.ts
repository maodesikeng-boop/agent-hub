// agy 连接器清单：读 MCP 配置、向每个服务器问 tools/list（readOnlyHint）；问不到的整个当不可用；结果缓存。
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgyConnectorCatalog,
  createAgyConnectorResolver,
  createReadonlyProbeLauncher,
  listMcpTools,
  parseToolsList,
  readAgyCachedMcpServerNames,
  readAgyMcpServers,
  type ListMcpTools,
  type McpProbeLauncher,
} from "./connectors.ts";
import { buildReadonlyPolicy } from "../../shared/index.ts";

/** 测试用：不包沙箱、env 原样（真沙箱在 macOS CI 的 write-scope 用例里测）。 */
const passthrough: McpProbeLauncher = (base, extraEnv) => ({ ...base, env: { ...process.env, ...extraEnv } as Record<string, string>, cleanup: () => {} });

describe("parseToolsList", () => {
  it("只留 readOnlyHint、destructiveHint 两个布尔；没有 annotations 是 null；没名字的丢掉；带翻页游标", () => {
    const { tools, nextCursor } = parseToolsList({
      tools: [
        { name: "a", annotations: { readOnlyHint: true, title: "x", destructiveHint: "yes" } },
        { name: "b" },
        { name: "c", annotations: { readOnlyHint: false, destructiveHint: true } },
        { annotations: {} },
        "junk",
      ],
      nextCursor: "p2",
    });
    expect(tools).toEqual([
      { name: "a", annotations: { readOnlyHint: true } },
      { name: "b", annotations: null },
      { name: "c", annotations: { readOnlyHint: false, destructiveHint: true } },
    ]);
    expect(nextCursor).toBe("p2");
    expect(parseToolsList(null)).toEqual({ tools: [], nextCursor: null });
  });
});

describe("readAgyMcpServers / readAgyCachedMcpServerNames", () => {
  it("读 mcpServers；读不了、格式不对当空", () => {
    expect(readAgyMcpServers("/h", () => JSON.stringify({ mcpServers: { a: { command: "x" }, b: 3 } }))).toEqual({ a: { command: "x" } });
    expect(readAgyMcpServers("/h", () => "not json")).toEqual({});
    expect(readAgyMcpServers("/h", () => { throw new Error("ENOENT"); })).toEqual({});
    expect(readAgyCachedMcpServerNames("/h", () => ["a", "b"])).toEqual(["a", "b"]);
    expect(readAgyCachedMcpServerNames("/h", () => { throw new Error("ENOENT"); })).toEqual([]);
  });
});

describe("buildAgyConnectorCatalog", () => {
  it("问得到的有清单；问不到的（抛错）、配置里没有只在缓存里出现的，都进 unlistable；不抛错", async () => {
    const list: ListMcpTools = async (name) => {
      if (name === "bad") throw new Error("起不来");
      return [{ name: "t", annotations: { readOnlyHint: true } }, { name: "u" }];
    };
    const catalog = await buildAgyConnectorCatalog({ good: { command: "x" }, bad: { command: "y" } }, ["good", "plugin-only"], list, 1000);
    expect(catalog).toEqual({ servers: { good: { t: { readOnlyHint: true }, u: null } }, unlistable: ["bad", "plugin-only"] });
  });
});

describe("createAgyConnectorResolver：缓存", () => {
  it("配置没变、没过期：只问一次（并发的共用）；配置变了、过期了重新问", async () => {
    let calls = 0;
    let servers: Record<string, { command: string }> = { a: { command: "x" } };
    let t = 0;
    const resolve = createAgyConnectorResolver({
      homeDir: "/h",
      cacheMs: 1000,
      now: () => t,
      readServers: () => servers,
      cachedServerNames: () => [],
      listTools: async () => {
        calls++;
        return [{ name: "t" }];
      },
    });
    await Promise.all([resolve(), resolve()]);
    await resolve();
    expect(calls).toBe(1);
    t = 2000;
    await resolve();
    expect(calls).toBe(2);
    servers = { a: { command: "x" }, b: { command: "y" } };
    await resolve();
    expect(calls).toBe(4); // 配置变了：a、b 各问一次
  });

  it("有服务器没问到（偶发超时）：清单只记 retryMs，过了重新问，问到了照常记 cacheMs", async () => {
    let calls = 0;
    let t = 0;
    const resolve = createAgyConnectorResolver({
      homeDir: "/h",
      cacheMs: 10_000,
      retryMs: 1_000,
      now: () => t,
      readServers: () => ({ a: { command: "x" } }),
      cachedServerNames: () => [],
      listTools: async () => {
        if (calls++ === 0) throw new Error("timeout");
        return [{ name: "t" }];
      },
    });
    expect((await resolve()).unlistable).toEqual(["a"]);
    t = 999;
    await resolve();
    expect(calls).toBe(1);
    t = 1_000;
    expect((await resolve()).servers).toEqual({ a: { t: null } });
    expect(calls).toBe(2);
    t = 1_000 + 9_999;
    await resolve();
    expect(calls).toBe(2);
  });

  it("只是 agy 缓存过、配置里没有的服务器进 unlistable：不算没问到，照常记 cacheMs", async () => {
    let calls = 0;
    let t = 0;
    const resolve = createAgyConnectorResolver({
      homeDir: "/h",
      cacheMs: 10_000,
      retryMs: 1_000,
      now: () => t,
      readServers: () => ({ a: { command: "x" } }),
      cachedServerNames: () => ["plugin-only"],
      listTools: async () => {
        calls++;
        return [{ name: "t" }];
      },
    });
    expect((await resolve()).unlistable).toEqual(["plugin-only"]);
    t = 5_000;
    await resolve();
    expect(calls).toBe(1);
  });
});

describe("listMcpTools：真的起 stdio 服务器问 tools/list", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const writeServer = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), "agy-mcp-"));
    return writeExecutableNodeScript(join(dir, "server"), body);
  };

  it("initialize → tools/list（翻两页），拿到 readOnlyHint", async () => {
    const file = writeServer(`
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
  else if (m.method === "tools/list") {
    if (m.params?.cursor === "p2") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "rw", annotations: { readOnlyHint: false } }] } });
    else send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ro", annotations: { readOnlyHint: true } }, { name: "plain" }], nextCursor: "p2" } });
  }
});
`);
    const tools = await listMcpTools("s", { command: process.execPath, args: [file] }, 10_000, passthrough);
    expect(tools).toEqual([
      { name: "ro", annotations: { readOnlyHint: true } },
      { name: "plain", annotations: null },
      { name: "rw", annotations: { readOnlyHint: false } },
    ]);
  });

  it("服务器不回应：超时抛错（调用方当不可用）；起不来：抛错", async () => {
    const file = writeServer(`setInterval(() => {}, 1000);`);
    await expect(listMcpTools("s", { command: process.execPath, args: [file] }, 300, passthrough)).rejects.toThrow(/没回应/);
    await expect(listMcpTools("s", { command: "/nonexistent/xyz" }, 1000, passthrough)).rejects.toThrow();
    await expect(listMcpTools("s", {}, 1000)).rejects.toThrow(/没有 url/);
  });

  it("没有探测启动器、或启动器说没有 OS 沙箱（返回 null）：不起进程，直接抛错（该服务器整个当不可用）", async () => {
    const marker = join(tmpdir(), `agy-mcp-ran-${process.pid}-${Date.now()}`);
    const file = writeServer(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); setInterval(() => {}, 1000);`);
    const spec = { command: process.execPath, args: [file] };
    await expect(listMcpTools("s", spec, 500)).rejects.toThrow(/没有 OS 沙箱/);
    await expect(listMcpTools("s", spec, 500, () => null)).rejects.toThrow(/没有 OS 沙箱/);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
    // 整体：问不到的进 unlistable
    const catalog = await buildAgyConnectorCatalog({ s: spec }, [], listMcpTools, 500, () => null);
    expect(catalog.unlistable).toEqual(["s"]);
  });

  it("探测进程用启动器给的命令和环境（服务器自己配置里的 env 也传给启动器）", async () => {
    const out = join(tmpdir(), `agy-mcp-env-${process.pid}-${Date.now()}`);
    const file = writeServer(`
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ hub: process.env.HUB_TOKEN ?? null, tmp: process.env.TMPDIR ?? null, own: process.env.OWN ?? null }));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: {} });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "t" }] } });
});
`);
    const seen: Array<{ base: { command: string; args: string[] }; extraEnv: Record<string, string> }> = [];
    let cleaned = 0;
    const launcher: McpProbeLauncher = (base, extraEnv) => {
      seen.push({ base, extraEnv });
      return { ...base, env: { PATH: process.env.PATH ?? "", TMPDIR: "/probe-tmp", OWN: extraEnv.OWN ?? "" }, cleanup: () => void cleaned++ };
    };
    await listMcpTools("s", { command: process.execPath, args: [file], env: { OWN: "1" } }, 10_000, launcher);
    expect(seen).toEqual([{ base: { command: process.execPath, args: [file] }, extraEnv: { OWN: "1" } }]);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ hub: null, tmp: "/probe-tmp", own: "1" });
    expect(cleaned).toBe(1);
    rmSync(out, { force: true });
  });
});

describe("createReadonlyProbeLauncher：探测进程的沙箱和环境", () => {
  const policy = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state" });
  const home = tmpdir(); // 要真实存在（realpath）

  it("用 Worker 同一个 wrap 函数包只读 profile；env = 守护进程环境去掉 HUB_* 和父会话变量，TMPDIR 指到私有目录，服务器自己的 env 最后覆盖；没有 OS 沙箱返回 null 并删临时目录", () => {
    const wrapped: Array<{ command: string; args: string[]; tmpDir: string; writableDirs: string[] }> = [];
    const launcher = createReadonlyProbeLauncher({
      policy,
      homeDir: home,
      baseEnv: { PATH: "/bin", HOME: "/Users/u", HUB_TOKEN: "secret", HUB_SOCK: "/s", CLAUDECODE: "1", API_KEY_LIKE: "x" },
      extraEnv: { FROM_DRIVER: "d" },
      wrap: (base, input) => {
        wrapped.push({ ...base, tmpDir: input.tmpDir, writableDirs: input.writableDirs });
        return { command: "/usr/bin/sandbox-exec", args: ["-p", "profile", base.command, ...base.args], osSandboxed: true };
      },
    });
    const launch = launcher({ command: "npx", args: ["-y", "srv"] }, { OWN: "1" });
    expect(launch).not.toBeNull();
    expect(launch!.command).toBe("/usr/bin/sandbox-exec");
    expect(launch!.args).toEqual(["-p", "profile", "npx", "-y", "srv"]);
    expect(launch!.env).toMatchObject({ PATH: "/bin", HOME: "/Users/u", FROM_DRIVER: "d", API_KEY_LIKE: "x", OWN: "1", TMPDIR: wrapped[0]!.tmpDir });
    expect(Object.keys(launch!.env).some((k) => k.startsWith("HUB_") || k === "CLAUDECODE")).toBe(false);
    expect(wrapped[0]!.writableDirs.some((d) => d.includes("antigravity-cli"))).toBe(false);
    expect(existsSync(wrapped[0]!.tmpDir)).toBe(true);
    launch!.cleanup();
    expect(existsSync(wrapped[0]!.tmpDir)).toBe(false);

    let tmpSeen = "";
    const none = createReadonlyProbeLauncher({
      policy,
      homeDir: home,
      baseEnv: {},
      wrap: (base, input) => {
        tmpSeen = input.tmpDir;
        return { ...base, osSandboxed: false };
      },
    });
    expect(none({ command: "x", args: [] }, {})).toBeNull();
    expect(existsSync(tmpSeen)).toBe(false);
  });
});
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
