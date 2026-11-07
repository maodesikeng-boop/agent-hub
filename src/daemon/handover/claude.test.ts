// claude 复制会话写交接（claude.ts）：用假的可执行文件（一个 node 脚本，把收到的参数、环境、标准输入记进文件），不起真 claude。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchFiles } from "../../shared/driver.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { createClaudeForker, claudeProjectDirName, CLAUDE_FORKERS } from "./claude.ts";
import { ForkUnsupportedError, type ForkSource } from "./forker.ts";
import { FORKERS } from "./forkers.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-forker-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 假 claude：把 argv / 环境 / stdin 记到 call.json；按 FAKE_MODE 吐 stream-json、出错或挂住。 */
function fakeClaude(): string {
  const path = join(dir, "fake-claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd() }));
  const mode = process.env.FAKE_MODE ?? "ok";
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  if (mode === "fail") { process.stderr.write("boom"); process.exit(3); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: "x" });
  out({ type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 5, cache_read_input_tokens: 190000, cache_creation_input_tokens: 100, output_tokens: 1 } } });
  out({ type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 6, cache_read_input_tokens: 190100, cache_creation_input_tokens: 200, output_tokens: 50 } } });
  if (mode === "error") { out({ type: "result", subtype: "success", is_error: true, result: "API Error", usage: {} }); return; }
  out({ type: "result", subtype: "success", is_error: false, result: mode === "empty" ? "" : "交接正文", usage: { input_tokens: 11, cache_read_input_tokens: 380100, cache_creation_input_tokens: 300, output_tokens: 51 } });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function source(over: Partial<ForkSource> = {}): ForkSource {
  const launch: LaunchFiles = {
    promptFile: join(dir, "prompt.md"),
    settingsFile: join(dir, "settings.json"),
    env: { PATH: process.env.PATH ?? "", FAKE_LOG: join(dir, "call.json"), FOO: "1" },
    fingerprint: "fp",
  };
  return {
    sessionId: 7,
    vendor: "claude",
    vendorSessionId: "orig-session-id",
    cwd: dir,
    addDirs: ["/code/bar"],
    model: "sonnet",
    effort: "high",
    launch,
    ...over,
  };
}

const call = () => JSON.parse(readFileSync(join(dir, "call.json"), "utf8")) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string };
const never = new AbortController().signal;
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("登记", () => {
  it("FORKERS.claude 是 CLAUDE_FORKERS，里面一个 native 办法 claude-native；codex、agy 不归这里", () => {
    expect(FORKERS.claude).toBe(CLAUDE_FORKERS);
    expect(CLAUDE_FORKERS.map((f) => [f.id, f.kind])).toEqual([["claude-native", "native"]]);
  });
});

describe("fork：只定编号，什么都不跑", () => {
  it("每次给一个新的 UUID，extra 记下 cwd（remove 算路径用）", async () => {
    const f = createClaudeForker({ claudePath: "/nonexistent/claude" });
    const a = await f.fork(source(), never);
    const b = await f.fork(source(), never);
    expect(a.forkId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.forkId).not.toBe(b.forkId);
    expect(a.extra).toEqual({ cwd: dir });
  });
});

describe("write：claude -p --resume 原编号 --fork-session --no-session-persistence", () => {
  it("参数：resume、fork-session、不落盘、复制那份的编号、模型/思考程度/提示词文件/设置/--add-dir 照项目经理传；提示词走标准输入", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    const handle = await f.fork(source(), never);
    await f.write(source(), handle, "请写交接", never);
    const { argv, stdin, cwd } = call();
    expect(argv).toContain("-p");
    expect(valueOf(argv, "--output-format")).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(valueOf(argv, "--resume")).toBe("orig-session-id");
    expect(argv).toContain("--fork-session");
    expect(argv).toContain("--no-session-persistence");
    expect(valueOf(argv, "--session-id")).toBe(handle.forkId);
    expect(valueOf(argv, "--model")).toBe("sonnet");
    expect(valueOf(argv, "--effort")).toBe("high");
    expect(valueOf(argv, "--append-system-prompt-file")).toBe(join(dir, "prompt.md"));
    expect(valueOf(argv, "--settings")).toBe(join(dir, "settings.json"));
    expect(valueOf(argv, "--add-dir")).toBe("/code/bar");
    expect(argv).not.toContain("--input-format");
    expect(stdin).toBe("请写交接");
    expect(cwd).toBe(dir);
  });

  it("环境变量：launch.env 照传，没有 HUB_TOKEN、HUB_SOCK（连守护进程自己环境里的也去掉），没有父会话变量", async () => {
    process.env[ENV_HUB_TOKEN] = "leak";
    process.env[ENV_HUB_SOCK] = "/leak.sock";
    process.env.CLAUDECODE = "1";
    try {
      const f = createClaudeForker({ claudePath: fakeClaude() });
      await f.write(source(), await f.fork(source(), never), "p", never);
    } finally {
      delete process.env[ENV_HUB_TOKEN];
      delete process.env[ENV_HUB_SOCK];
      delete process.env.CLAUDECODE;
    }
    const { env } = call();
    expect(env.FOO).toBe("1");
    expect(env[ENV_HUB_TOKEN]).toBeUndefined();
    expect(env[ENV_HUB_SOCK]).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("persist: true 时不加 --no-session-persistence（排查用）", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude(), persist: true });
    await f.write(source(), await f.fork(source(), never), "p", never);
    expect(call().argv).not.toContain("--no-session-persistence");
  });

  it("model、effort、settings 为 null 时不传", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    const src = source({ model: null, effort: null, addDirs: [], launch: { ...source().launch, settingsFile: undefined } });
    await f.write(src, await f.fork(src, never), "p", never);
    const { argv } = call();
    for (const flag of ["--model", "--effort", "--settings", "--add-dir"]) expect(argv).not.toContain(flag);
  });

  it("取 result 的文字；用量是 result.usage 四个数，context 是最后一个 assistant 请求的 input + 缓存读 + 缓存写", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    const r = await f.write(source(), await f.fork(source(), never), "p", never);
    expect(r.text).toBe("交接正文");
    expect(r.usage).toEqual({ input: 11, cacheRead: 380100, cacheWrite: 300, output: 51, context: 190306 });
  });

  it("写出来是空的：照常返回空串，空不空由账本判断", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    process.env.FAKE_MODE = "empty";
    try {
      expect((await f.write(source(), await f.fork(source(), never), "p", never)).text).toBe("");
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("退出码非 0 抛错，消息带标准错误；result.is_error 也抛；找不到可执行文件抛", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    process.env.FAKE_MODE = "fail";
    try {
      await expect(f.write(source(), await f.fork(source(), never), "p", never)).rejects.toThrow(/exit code 3.*boom/s);
      process.env.FAKE_MODE = "error";
      await expect(f.write(source(), await f.fork(source(), never), "p", never)).rejects.toThrow(/API Error/);
    } finally {
      delete process.env.FAKE_MODE;
    }
    const missing = createClaudeForker({ claudePath: join(dir, "nope") });
    await expect(missing.write(source(), await missing.fork(source(), never), "p", never)).rejects.toThrow(/nope/);
  });

  it("signal abort：杀掉进程，抛错", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    const ac = new AbortController();
    process.env.FAKE_MODE = "hang";
    try {
      const p = f.write(source(), await f.fork(source(), never), "p", ac.signal);
      const settled = expect(p).rejects.toThrow(/abort/i);
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      await settled;
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("原会话不是 claude 的编号（空）→ ForkUnsupportedError", async () => {
    const f = createClaudeForker({ claudePath: fakeClaude() });
    const src = source({ vendorSessionId: "" });
    await expect(f.write(src, await f.fork(src, never), "p", never)).rejects.toThrow(ForkUnsupportedError);
  });
});

describe("remove：保险性地删复制那份可能落盘的 jsonl，幂等", () => {
  it("目录名是路径里非字母数字都换成 -；文件在就删（连同同名目录），不在算成功", async () => {
    expect(claudeProjectDirName("/Users/a.b/code_x")).toBe("-Users-a-b-code-x");
    const config = join(dir, "cfg");
    const cwd = "/work/proj";
    const proj = join(config, "projects", claudeProjectDirName(cwd));
    mkdirSync(join(proj, "abc"), { recursive: true });
    writeFileSync(join(proj, "abc.jsonl"), "{}");
    writeFileSync(join(proj, "keep.jsonl"), "{}");
    const f = createClaudeForker({ claudePath: "claude", configDir: config });
    await f.remove({ forkId: "abc", extra: { cwd } });
    expect(existsSync(join(proj, "abc.jsonl"))).toBe(false);
    expect(existsSync(join(proj, "abc"))).toBe(false);
    expect(existsSync(join(proj, "keep.jsonl"))).toBe(true);
    await expect(f.remove({ forkId: "abc", extra: { cwd } })).resolves.toBeUndefined();
    await expect(f.remove({ forkId: "abc" })).resolves.toBeUndefined();
  });

  it("forkId 含路径符号的（防路径穿越）不删任何东西", async () => {
    const config = join(dir, "cfg");
    const proj = join(config, "projects", claudeProjectDirName("/w"));
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "victim.jsonl"), "{}");
    const f = createClaudeForker({ claudePath: "claude", configDir: config });
    await f.remove({ forkId: "../victim", extra: { cwd: "/w" } });
    expect(existsSync(join(proj, "victim.jsonl"))).toBe(true);
  });
});
