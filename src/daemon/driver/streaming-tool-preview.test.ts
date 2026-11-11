import { describe, expect, it } from "vitest";
import { MAX_STEP_ARG_CHARS, MAX_STREAMING_TOOL_BLOCKS, MAX_STREAMING_TOOL_JSON_CHARS } from "../../shared/index.ts";
import { StreamingToolPreviewTracker, extractStreamingToolStepInput, toolStepSignature } from "./protocol.ts";

describe("extractStreamingToolStepInput：从半截 JSON 里挑已闭合的顶层状态字段", () => {
  it("只取引号已闭合的值；转义引号、反斜杠、\\u 转义按 JSON 还原", () => {
    expect(extractStreamingToolStepInput('{"file_path": "/src/fo')).toEqual({});
    expect(extractStreamingToolStepInput('{"file_path": "/src/fo\\')).toEqual({});
    expect(extractStreamingToolStepInput('{"file_path": "/src/fo\\u00')).toEqual({});
    expect(extractStreamingToolStepInput('{"file_path": "/a/\\"q\\"\\\\b\\u00e9.ts", "content": "x')).toEqual({ file_path: '/a/"q"\\bé.ts' });
  });

  it("连接器的服务名、动作名（agy ServerName / ToolName、codex server / tool）也取", () => {
    expect(extractStreamingToolStepInput('{"ServerName":"linear","ToolName":"list_issues","Arguments":{"q":"x')).toEqual({
      ServerName: "linear",
      ToolName: "list_issues",
    });
  });

  it("嵌套对象、数组里的同名字段不算（只认顶层），里面的引号、括号不打乱层级", () => {
    const json = '{"edits":[{"path":"/nested.ts","s":"}]{["}],"meta":{"file_path":"/x"},"path":"/top.ts"}';
    expect(extractStreamingToolStepInput(json)).toEqual({ path: "/top.ts" });
    // 嵌套还没闭合：停在那里，不越界
    expect(extractStreamingToolStepInput('{"skill":"a","edits":[{"path":"/n')).toEqual({ skill: "a" });
  });

  it("不是对象开头、脏数据、非法转义：返回空，不抛错", () => {
    for (const input of ["", "   ", "[", "null", '"x"', "{", '{"', '{"a"', '{"a":', '{"a":}', '{"a":,"path":"/p"}', '{"path":"\\x"}', '{"path":"\\uZZZZ"}', '{1:"x"}']) {
      expect(() => extractStreamingToolStepInput(input)).not.toThrow();
    }
    expect(extractStreamingToolStepInput('{"path":"\\uZZZZ"}')).toEqual({});
  });

  it("非状态字段的超长字符串不解码；状态字段截到 MAX_STEP_ARG_CHARS", () => {
    const big = "z".repeat(200_000);
    expect(extractStreamingToolStepInput(`{"content":"${big}","path":"/p.ts"}`)).toEqual({ path: "/p.ts" });
    const long = extractStreamingToolStepInput(`{"file_path":"/${"a".repeat(1000)}"}`);
    expect([...(long.file_path ?? "")]).toHaveLength(MAX_STEP_ARG_CHARS);
  });

  it("随机前缀（固定种子）20 万次：不抛错、不卡死；完整 JSON 的每个前缀都只出已闭合字段", () => {
    const alphabet = ["{", "}", "[", "]", '"', "\\", "u", "0", "a", ":", ",", " ", "\n", '"file_path"', '"path"', '\\"', "\\u00", "\\uD83D"];
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 200_000; n++) {
      let s = "{";
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(typeof extractStreamingToolStepInput(s)).toBe("object");
    }
    const full = JSON.stringify({ a: { b: [1, 'x"y', { c: "}" }] }, file_path: '/a/"q".ts', content: "z".repeat(5000), path: "p" });
    for (let i = 0; i <= full.length; i += 7) {
      const got = extractStreamingToolStepInput(full.slice(0, i));
      if (got.file_path !== undefined) expect(got.file_path).toBe('/a/"q".ts');
      if (got.path !== undefined) expect(got.path).toBe("p");
    }
    expect(extractStreamingToolStepInput(full)).toEqual({ file_path: '/a/"q".ts', path: "p" });
  });
});

describe("StreamingToolPreviewTracker：有界、去重", () => {
  it("起点发一次，拼出路径再发一次，之后正文分片不再发；end 清块", () => {
    const tr = new StreamingToolPreviewTracker();
    expect(tr.start(0, { toolUseId: "t1", name: "Write", at: 1 })).toMatchObject({ name: "Write", input: {} });
    expect(tr.appendJsonDelta(0, '{"file_path":"/a/', 2)).toBeNull();
    expect(tr.appendJsonDelta(0, 'b.ts","content":"', 3)).toEqual({ type: "agent.tool_preview", toolUseId: "t1", name: "Write", input: { file_path: "/a/b.ts" }, at: 3 });
    for (let i = 0; i < 100; i++) expect(tr.appendJsonDelta(0, "more text ", 4)).toBeNull();
    tr.end(0);
    expect(tr.size).toBe(0);
    expect(tr.appendJsonDelta(0, "x", 5)).toBeNull();
  });

  it("单块缓冲封顶 MAX_STREAMING_TOOL_JSON_CHARS：超出后的路径不再解析（不无界增长）", () => {
    const tr = new StreamingToolPreviewTracker();
    tr.start("k", { name: "Write", at: 0 });
    const head = `{"content":"${"z".repeat(MAX_STREAMING_TOOL_JSON_CHARS)}`;
    expect(tr.appendJsonDelta("k", head, 1)).toBeNull();
    expect(tr.appendJsonDelta("k", '","file_path":"/late.ts"}', 2)).toBeNull();
  });

  it("并发块数封顶 MAX_STREAMING_TOOL_BLOCKS：挤掉最早的", () => {
    const tr = new StreamingToolPreviewTracker();
    for (let i = 0; i < MAX_STREAMING_TOOL_BLOCKS * 3; i++) tr.start(i, { name: "Read", at: i });
    expect(tr.size).toBe(MAX_STREAMING_TOOL_BLOCKS);
    expect(tr.appendJsonDelta(0, '{"file_path":"/x"}', 1)).toBeNull();
    expect(tr.appendJsonDelta(MAX_STREAMING_TOOL_BLOCKS * 3 - 1, '{"file_path":"/x"}', 1)).toMatchObject({ input: { file_path: "/x" } });
    tr.clear();
    expect(tr.size).toBe(0);
  });

  it("工具名为空不建块；updateObject 合并结构化参数、签名不变不发", () => {
    const tr = new StreamingToolPreviewTracker();
    expect(tr.start(0, { name: "", at: 0 })).toBeNull();
    expect(tr.size).toBe(0);
    expect(tr.updateObject(1, { name: "call_mcp_tool", input: { ServerName: "linear" } }, 1)).toMatchObject({ input: { ServerName: "linear" } });
    expect(tr.updateObject(1, { input: { ServerName: "linear" } }, 2)).toBeNull();
    expect(tr.updateObject(1, { input: { ToolName: "list_issues" } }, 3)).toMatchObject({ input: { ServerName: "linear", ToolName: "list_issues" } });
  });

  it("签名只看工具名和状态字段", () => {
    expect(toolStepSignature("Read", { file_path: "/a", limit: 1 })).toBe(toolStepSignature("Read", { file_path: "/a", limit: 2 }));
    expect(toolStepSignature("Read", { file_path: "/a" })).not.toBe(toolStepSignature("Read", { file_path: "/b" }));
    expect(toolStepSignature("call_mcp_tool", { ServerName: "a" })).not.toBe(toolStepSignature("call_mcp_tool", { ServerName: "b" }));
  });
});
