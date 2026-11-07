// agy 连接器清单：读 MCP 配置、向每个服务器问 tools/list（readOnlyHint）；问不到的整个当不可用；结果缓存。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgyConnectorCatalog,
  createAgyConnectorResolver,
  listMcpTools,
  parseToolsList,
  readAgyCachedMcpServerNames,
  readAgyMcpServers,
  type ListMcpTools,
} from "./agy-connectors.ts";

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
});

describe("listMcpTools：真的起 stdio 服务器问 tools/list", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const writeServer = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), "agy-mcp-"));
    const file = join(dir, "server.mjs");
    writeFileSync(file, body);
    chmodSync(file, 0o755);
    return file;
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
    const tools = await listMcpTools("s", { command: process.execPath, args: [file] }, 10_000);
    expect(tools).toEqual([
      { name: "ro", annotations: { readOnlyHint: true } },
      { name: "plain", annotations: null },
      { name: "rw", annotations: { readOnlyHint: false } },
    ]);
  });

  it("服务器不回应：超时抛错（调用方当不可用）；起不来：抛错", async () => {
    const file = writeServer(`setInterval(() => {}, 1000);`);
    await expect(listMcpTools("s", { command: process.execPath, args: [file] }, 300)).rejects.toThrow(/没回应/);
    await expect(listMcpTools("s", { command: "/nonexistent/xyz" }, 1000)).rejects.toThrow();
    await expect(listMcpTools("s", {}, 1000)).rejects.toThrow(/没有 url/);
  });
});
