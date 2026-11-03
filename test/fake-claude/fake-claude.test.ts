// 假 claude 自己的行为（照 M0 实测），驱动层测试碰不到的那几条直接测。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FAKE = new URL("./fake-claude.ts", import.meta.url).pathname;
const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 起一个假 claude，按顺序写这些行（每行之间隔 gapMs），关掉标准输入，收集输出。 */
function run(
  args: string[],
  lines: string[],
  gapMs = 0,
  stateless = false,
): Promise<{ code: number | null; events: Array<Record<string, unknown>>; stderr: string }> {
  dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"));
  const env: Record<string, string | undefined> = { ...process.env, FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_LOG: join(dir, "log") };
  if (stateless) {
    delete env.FAKE_CLAUDE_STATE;
    delete env.FAKE_CLAUDE_LOG;
  }
  const child = spawn(FAKE, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {});
  void (async () => {
    for (const line of lines) {
      child.stdin.write(line + "\n");
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    child.stdin.end();
  })();
  return new Promise((resolve) =>
    child.on("close", (code) =>
      resolve({ code, stderr, events: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }),
    ),
  );
}

describe("假 claude", () => {
  it("坏的输入行：标准错误写一行，退出码 1", async () => {
    const notJson = await run(["--session-id", "a"], ["not json"]);
    expect(notJson.code).toBe(1);
    expect(notJson.stderr).toMatch(/Error parsing streaming input line/);
    const badRole = await run(["--session-id", "b"], [JSON.stringify({ type: "user", message: { content: "x" } })]);
    expect(badRole.code).toBe(1);
    expect(badRole.stderr).toMatch(/Expected message role 'user', got 'undefined'/);
  });

  it("一轮：init → 回显 → assistant → rate_limit_event → result；标准输入关掉后退出码 0", async () => {
    const r = await run(["--session-id", "c"], [userLine("hi")]);
    expect(r.code).toBe(0);
    expect(r.events.map((e) => (e.type === "system" ? `system/${String(e.subtype)}` : e.type))).toEqual([
      "system/init",
      "user",
      "assistant",
      "rate_limit_event",
      "result",
    ]);
    expect(r.events[0]).toMatchObject({ session_id: "c", model: "claude-haiku-5-5" });
    expect(r.events[1]).toMatchObject({ isReplay: true });
    expect(r.events[4]).toMatchObject({ subtype: "success", is_error: false });
  });

  it("同一个 --session-id 第二次用：报 already in use；--resume 不存在的：No conversation found + result", async () => {
    await run(["--session-id", "d"], [userLine("hi")]);
    const again = await run(["--session-id", "d"], []);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Session ID d is already in use");
    const resumed = await run(["--resume", "d"], [userLine("hi")]);
    expect(resumed.code).toBe(0);
    const missing = await run(["--resume", "nope"], []);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No conversation found with session ID: nope");
    expect(missing.events).toEqual([expect.objectContaining({ type: "result", subtype: "error_during_execution" })]);
  });

  it("忙时收到的几条合并成下一轮的一条：回显里是几段 text", async () => {
    const script = join((dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"))), "script.json");
    writeFileSync(script, JSON.stringify({ turns: [{ steps: [{ sleepMs: 300 }, { text: "first" }] }] }));
    process.env.FAKE_CLAUDE_SCRIPT = script;
    try {
      const r = await run(["--session-id", "e"], [userLine("one"), userLine("two"), userLine("three")], 20);
      const replays = r.events.filter((e) => e.isReplay === true) as Array<{ message: { content: Array<{ text: string }> } }>;
      expect(replays.map((e) => e.message.content.map((c) => c.text))).toEqual([["one"], ["two", "three"]]);
      expect(r.events.filter((e) => e.type === "system")).toHaveLength(2);
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
    }
  });

  it("没有状态目录：会话记在进程内存里，一个进程里跑两轮照常", async () => {
    const r = await run(["--session-id", "f"], [userLine("one"), userLine("two")], 200, true);
    expect(r.code).toBe(0);
    expect(r.events.filter((e) => e.type === "result")).toHaveLength(2);
    expect(r.stderr).toBe("");
  });

  const withScript = async <T>(script: unknown, body: () => Promise<T>): Promise<T> => {
    const file = join((dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"))), "script.json");
    writeFileSync(file, JSON.stringify(script));
    process.env.FAKE_CLAUDE_SCRIPT = file;
    try {
      return await body();
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
    }
  };

  it("lateReplay：回显推迟到第一个不是 sleepMs 的步骤之前", async () => {
    const r = await withScript({ lateReplay: true, defaultTurn: { steps: [{ sleepMs: 50 }, { text: "hi" }] } }, () =>
      run(["--session-id", "g"], [userLine("x")]),
    );
    expect(r.events.map((e) => e.type)).toEqual(["system", "user", "assistant", "rate_limit_event", "result"]);
  });

  it("api_retry 步骤：发一条 system/api_retry", async () => {
    const r = await withScript({ defaultTurn: { steps: [{ apiRetry: { attempt: 2 } }, { text: "ok" }] } }, () =>
      run(["--session-id", "h"], [userLine("x")]),
    );
    expect(r.events.find((e) => e.subtype === "api_retry")).toMatchObject({ type: "system", attempt: 2 });
  });

  it("工具调用中被打断：标记是 “for tool use” 那种", async () => {
    const interrupt = JSON.stringify({ type: "control_request", request_id: "i1", request: { subtype: "interrupt" } });
    const r = await withScript({ defaultTurn: { steps: [{ tool: { name: "Bash", input: {}, durationMs: 1_000 } }] } }, () =>
      run(["--session-id", "i"], [userLine("x"), interrupt], 200),
    );
    const markers = r.events.filter((e) => e.type === "user" && e.isReplay !== true) as Array<{ message: { content: Array<{ text?: string }> } }>;
    expect(markers.map((e) => e.message.content[0]!.text)).toContain("[Request interrupted by user for tool use]");
  });
});

