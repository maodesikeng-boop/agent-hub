// 假 claude 自己的行为（照 M0 实测），驱动层测试碰不到的那几条直接测。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  extra: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number | null; events: Array<Record<string, unknown>>; stderr: string }> {
  dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"));
  const env: Record<string, string | undefined> = { ...process.env, FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_LOG: join(dir, "log"), ...extra.env };
  if (stateless) {
    delete env.FAKE_CLAUDE_STATE;
    delete env.FAKE_CLAUDE_LOG;
  }
  const child = spawn(FAKE, args, { env, cwd: extra.cwd });
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

  it("waitFile 步骤：文件没出现这一轮就停着，出现之后接着往下走", async () => {
    dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"));
    const gate = join(dir, "gate");
    let finished = false;
    const running = withScript({ defaultTurn: { steps: [{ waitFile: gate }, { text: "放行了" }] } }, () =>
      run(["--session-id", "gate"], [userLine("x")]),
    ).finally(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    writeFileSync(gate, "");
    const r = await running;
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(["system", "user", "assistant", "rate_limit_event", "result"]);
  });

  it("api_retry 步骤：发一条 system/api_retry", async () => {
    const r = await withScript({ defaultTurn: { steps: [{ apiRetry: { attempt: 2 } }, { text: "ok" }] } }, () =>
      run(["--session-id", "h"], [userLine("x")]),
    );
    expect(r.events.find((e) => e.subtype === "api_retry")).toMatchObject({ type: "system", attempt: 2 });
  });

  it("api_retry 步骤：字段可调，errorStatus 给 null 就是没有状态码", async () => {
    const step = { apiRetry: { attempt: 3, maxRetries: 9, retryDelayMs: 2062, errorStatus: null, error: "unknown" } };
    const r = await withScript({ defaultTurn: { steps: [step, { text: "ok" }] } }, () => run(["--session-id", "h2"], [userLine("x")]));
    expect(r.events.find((e) => e.subtype === "api_retry")).toMatchObject({
      attempt: 3,
      max_retries: 9,
      retry_delay_ms: 2062,
      error_status: null,
      error: "unknown",
    });
  });

  it("工具调用中被打断：标记是 “for tool use” 那种", async () => {
    const interrupt = JSON.stringify({ type: "control_request", request_id: "i1", request: { subtype: "interrupt" } });
    const r = await withScript({ defaultTurn: { steps: [{ tool: { name: "Bash", input: {}, durationMs: 1_000 } }] } }, () =>
      run(["--session-id", "i"], [userLine("x"), interrupt], 200),
    );
    const markers = r.events.filter((e) => e.type === "user" && e.isReplay !== true) as Array<{ message: { content: Array<{ text?: string }> } }>;
    expect(markers.map((e) => e.message.content[0]!.text)).toContain("[Request interrupted by user for tool use]");
  });
  // m2-plan 第 4 节 W3“假 claude 跑命令”
  type ToolResult = { tool_use_id: string; type: string; content: string; is_error: boolean };
  const toolUses = (events: Array<Record<string, unknown>>) =>
    events.flatMap((e) =>
      e.type === "assistant" ? (e.message as { content: Array<Record<string, unknown>> }).content.filter((c) => c.type === "tool_use") : [],
    );
  const toolResults = (events: Array<Record<string, unknown>>) =>
    events.flatMap((e) =>
      e.type === "user" && e.isReplay !== true
        ? (e.message as { content: Array<Record<string, unknown>> }).content.filter((c) => c.type === "tool_result")
        : [],
    ) as ToolResult[];

  it("bash 步骤：出一个 Bash 的 tool_use，再出带命令输出的 tool_result", async () => {
    const r = await withScript({ defaultTurn: { steps: [{ bash: "echo hi" }] } }, () => run(["--session-id", "j"], [userLine("x")]));
    const [use] = toolUses(r.events);
    expect(use).toMatchObject({ name: "Bash", input: { command: "echo hi" } });
    expect(toolResults(r.events)).toEqual([{ tool_use_id: use!.id, type: "tool_result", content: "hi", is_error: false }]);
    expect(r.events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("bash 用自己拿到的环境变量跑；退出码不是 0：is_error，内容开头 Exit code，带上标准错误", async () => {
    process.env.HUB_TOKEN = "fake-token-for-test";
    try {
      const r = await withScript({ defaultTurn: { steps: [{ bash: 'echo "t=$HUB_TOKEN"' }, { bash: "echo oops >&2; exit 3" }] } }, () =>
        run(["--session-id", "k"], [userLine("x")]),
      );
      const [ok, bad] = toolResults(r.events);
      expect(ok).toMatchObject({ content: "t=fake-token-for-test", is_error: false });
      expect(bad).toMatchObject({ content: "Exit code 3\noops", is_error: true });
    } finally {
      delete process.env.HUB_TOKEN;
    }
  });

  it("bash 里读标准输入：读到的是空（不会卡住）；heredoc 照常", async () => {
    const r = await withScript({ defaultTurn: { steps: [{ bash: "cat; echo end" }, { bash: "cat <<'EOF'\n$HOME `x`\nEOF" }] } }, () =>
      run(["--session-id", "l"], [userLine("x")]),
    );
    expect(toolResults(r.events).map((t) => t.content)).toEqual(["end", "$HOME `x`"]);
  });

  // m3-plan 第 3 节 W3“假 claude 按会话选剧本”
  const texts = (events: Array<Record<string, unknown>>) =>
    events.flatMap((e) =>
      e.type === "assistant" ? (e.message as { content: Array<{ type: string; text?: string }> }).content.flatMap((c) => (c.type === "text" ? [c.text!] : [])) : [],
    );
  const say = (text: string) => ({ defaultTurn: { steps: [{ text }] } });
  const workerEnv = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

  it("按角色选剧本：Worker（环境变量里关了自动记忆）用 Worker 的，项目经理用项目经理的", async () => {
    const script = { ...say("顶层"), sessions: [{ role: "worker", script: say("我是 Worker") }, { role: "pm", script: say("我是项目经理") }] };
    const worker = await withScript(script, () => run(["--session-id", "w1"], [userLine("x")], 0, false, { env: workerEnv }));
    const pm = await withScript(script, () => run(["--session-id", "p1"], [userLine("x")]));
    expect(texts(worker.events)).toEqual(["我是 Worker"]);
    expect(texts(pm.events)).toEqual(["我是项目经理"]);
  });

  it("按工作目录选剧本：cwd 完全相等、cwdUnder 在下面；都对不上用顶层剧本", async () => {
    dir ??= mkdtempSync(join(tmpdir(), "fake-claude-"));
    const worktrees = join(dir, "worktrees");
    const wt = join(worktrees, "1", "5");
    const main = join(dir, "main");
    mkdirSync(wt, { recursive: true });
    mkdirSync(main);
    const script = { ...say("顶层"), sessions: [{ cwd: main, script: say("主文件夹") }, { cwdUnder: worktrees, script: say("worktree") }] };
    const inWt = await withScript(script, () => run(["--session-id", "c1"], [userLine("x")], 0, false, { cwd: wt }));
    const inMain = await withScript(script, () => run(["--session-id", "c2"], [userLine("x")], 0, false, { cwd: main }));
    const elsewhere = await withScript(script, () => run(["--session-id", "c3"], [userLine("x")], 0, false, { cwd: dir }));
    expect(texts(inWt.events)).toEqual(["worktree"]);
    expect(texts(inMain.events)).toEqual(["主文件夹"]);
    expect(texts(elsewhere.events)).toEqual(["顶层"]);
  });

  it("选中的剧本按会话分开数轮数：另一个会话从第 0 轮起，--resume 接着数", async () => {
    const script = { sessions: [{ role: "worker", script: { turns: [{ steps: [{ text: "第 0 轮" }] }, { steps: [{ text: "第 1 轮" }] }] } }] };
    const opts = { env: workerEnv };
    const a = await withScript(script, () => run(["--session-id", "s-a"], [userLine("x")], 0, false, opts));
    const b = await withScript(script, () => run(["--session-id", "s-b"], [userLine("x")], 0, false, opts));
    const again = await withScript(script, () => run(["--resume", "s-a"], [userLine("x")], 0, false, opts));
    expect(texts(a.events)).toEqual(["第 0 轮"]);
    expect(texts(b.events)).toEqual(["第 0 轮"]);
    expect(texts(again.events)).toEqual(["第 1 轮"]);
  });
});
