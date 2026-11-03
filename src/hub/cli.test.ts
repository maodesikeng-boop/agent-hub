// hub 命令行的测试：起一个真的 agent 接口（假账本），经 Unix socket 调。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, HUB_EXIT, LedgerRequestError, type SessionTokens } from "../shared/index.ts";
import { runHub, runHubSafely, type HubIo } from "./cli.ts";
import { FakeHubLedger } from "../daemon/agent-api/fake-ledger.ts";
import { startAgentApi, type RunningAgentApi } from "../daemon/agent-api/server.ts";
import { installHubShim } from "../daemon/agent-api/shim.ts";
import { createSessionTokens } from "../daemon/agent-api/tokens.ts";

const HUB_MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const HUB_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** 一个读了就让测试失败的标准输入：用来证明没写 --stdin 时 hub 不碰它。 */
class TrapStdin extends Readable {
  touched = false;
  override _read(): void {
    this.touched = true;
    // 永远不给数据也不结束：真被读了就会卡住
  }
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

describe("hub cli", () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let running: RunningAgentApi;
  let ledger: FakeHubLedger;
  let tokens: SessionTokens;
  let token: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = mkdtempSync("/tmp/ah-");
    home = join(dir, "home");
    cwd = join(dir, "work");
    mkdirSync(home);
    mkdirSync(cwd);
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
    running = await startAgentApi({ ledger, tokens, runDir: join(dir, "run"), hubSock: join(dir, "run", "hub.sock") });
    token = tokens.issue(42);
    env = { [ENV_HUB_TOKEN]: token, [ENV_HUB_SOCK]: running.socketPath, HOME: home };
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function hub(
    argv: string[],
    opts: { stdin?: Readable; env?: Record<string, string | undefined>; timeoutMs?: number; stdinIdleMs?: number } = {},
  ) {
    let stdout = "";
    let stderr = "";
    const stdin = opts.stdin ?? new TrapStdin();
    const io: HubIo = {
      argv,
      env: opts.env ?? env,
      cwd,
      stdin: () => stdin,
      stdout: { write: (s: string) => void (stdout += s) },
      stderr: { write: (s: string) => void (stderr += s) },
      timeoutMs: opts.timeoutMs,
      stdinIdleMs: opts.stdinIdleMs,
    };
    const code = await runHub(io);
    if (opts.stdin === undefined) expect((stdin as TrapStdin).touched, "stdin must not be read without --stdin").toBe(false);
    return { code, stdout, stderr } satisfies Captured;
  }

  /** 异步跑一个子进程，标准输入马上关掉。 */
  const run = (file: string, args: string[], childEnv: Record<string, string | undefined>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(file, args, { env: childEnv, cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
      child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  const stdinOf = (text: string) => Readable.from([Buffer.from(text, "utf8")]);

  describe("success", () => {
    it("project create prints text, exits 0 and sends the right body", async () => {
      const r = await hub(["project", "create", "--folder", "/x"]);
      expect(r.code).toBe(HUB_EXIT.ok);
      expect(r.stdout).toBe("已执行 project.create（会话 42）\n");
      expect(r.stderr).toBe("");
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "project.create", args: { folder: "/x" } }]);
    });

    it("project create passes --name and --description", async () => {
      expect((await hub(["project", "create", "--folder", "/x", "--name", "foo", "--description", "说明"])).code).toBe(0);
      expect(ledger.calls[0]?.args).toEqual({ folder: "/x", name: "foo", description: "说明" });
    });

    it.each([
      [["status"], "status", {}],
      [["persona", "show"], "persona.show", {}],
      [["project", "attach", "/a/b"], "project.attach", { folder: "/a/b" }],
      [["project", "detach", "/a/b"], "project.detach", { folder: "/a/b" }],
      [["persona", "edit", "--mode", "hands_on"], "persona.edit", { mode: "hands_on" }],
      [["persona", "edit", "--text", "新设定", "--reason", "用户说的"], "persona.edit", { text: "新设定", reason: "用户说的" }],
    ] as const)("hub %j → %s", async (argv, command, args) => {
      const r = await hub([...argv]);
      expect(r.code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command, args }]);
    });

    it("prints help with exit 0 and does not call the daemon", async () => {
      const r = await hub(["--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hub project create --folder");
      expect(r.stdout).not.toContain("assign");
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("hub worker", () => {
    it("worker start reads the task from --stdin and sends title, flags and task", async () => {
      const task = "把 X 修好\n验收：pnpm test 全绿，$HOME 和 `反引号` 原样\n";
      const r = await hub(["worker", "start", "--title", "修 X", "--model", "claude-haiku-5-5", "--readonly", "--no-worktree", "--stdin"], {
        stdin: stdinOf(task),
      });
      expect(r.code).toBe(HUB_EXIT.ok);
      expect(ledger.calls).toEqual([
        {
          sessionId: 42,
          command: "worker.start",
          args: { title: "修 X", model: "claude-haiku-5-5", readonly: true, noWorktree: true, task: task.slice(0, -1) },
        },
      ]);
    });

    it("worker start without the optional flags sends only title and task", async () => {
      expect((await hub(["worker", "start", "--title", "修 X", "--stdin"], { stdin: stdinOf("任务") })).code).toBe(0);
      expect(ledger.calls[0]?.args).toEqual({ title: "修 X", task: "任务" });
    });

    it("worker send <编号> --stdin sends a numeric workerId and the text", async () => {
      expect((await hub(["worker", "send", "3", "--stdin"], { stdin: stdinOf("再改一下\n") })).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "worker.send", args: { workerId: 3, text: "再改一下" } }]);
    });

    it.each([
      [["worker", "end", "3"], "worker.end", { workerId: 3 }],
      [["worker", "list"], "worker.list", {}],
    ] as const)("hub %j → %s", async (argv, command, args) => {
      expect((await hub([...argv])).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command, args }]);
    });

    it.each([
      [["worker"]],
      [["worker", "fire", "3"]],
      [["worker", "start", "--stdin"]],
      [["worker", "start", "--title", "修 X"]],
      [["worker", "start", "--title", "修 X", "--text", "任务"]],
      [["worker", "start", "--title", "修 X", "--stdin", "extra"]],
      [["worker", "send", "3"]],
      [["worker", "send", "--stdin"]],
      [["worker", "send", "abc", "--stdin"]],
      [["worker", "send", "0", "--stdin"]],
      [["worker", "send", "3", "--title", "x", "--stdin"]],
      [["worker", "end"]],
      [["worker", "end", "1.5"]],
      [["worker", "end", "-1"]],
      [["worker", "end", "3", "4"]],
      [["worker", "list", "--readonly"]],
    ])("usage error: hub %j", async (argv) => {
      const r = await hub([...argv], { stdin: stdinOf("任务") });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).not.toBe("");
      expect(ledger.calls).toHaveLength(0);
    });

    it("an empty task from --stdin is a usage error", async () => {
      expect((await hub(["worker", "start", "--title", "修 X", "--stdin"], { stdin: stdinOf("\n") })).code).toBe(2);
      expect((await hub(["worker", "send", "3", "--stdin"], { stdin: stdinOf("  ") })).code).toBe(2);
      expect(ledger.calls).toHaveLength(0);
    });

    it("the usage text lists the worker commands", async () => {
      const r = await hub(["--help"]);
      for (const usage of ["hub worker start --title", "--readonly", "--no-worktree", "hub worker send <编号> --stdin", "hub worker end <编号>", "hub worker list"]) {
        expect(r.stdout).toContain(usage);
      }
    });
  });

  describe("long text via --stdin", () => {
    it("delivers a 3 KB persona text with $, backticks and quotes unchanged", async () => {
      const line = "价格 $HUB_TOKEN `rm -rf /` \"双引号\" 'single' \\ $(whoami) ${x}\n";
      let text = "";
      while (Buffer.byteLength(text) < 3 * 1024) text += line;
      const r = await hub(["persona", "edit", "--stdin"], { stdin: stdinOf(`${text}\n`) });
      expect(r.code).toBe(0);
      // 去掉末尾一个换行，其余原样
      expect(ledger.calls[0]?.args).toEqual({ text });
    });

    it("strips exactly one trailing newline", async () => {
      await hub(["persona", "edit", "--stdin"], { stdin: stdinOf("a\n\n") });
      expect(ledger.calls[0]?.args).toEqual({ text: "a\n" });
    });

    it("strips one trailing CRLF as well", async () => {
      await hub(["persona", "edit", "--stdin"], { stdin: stdinOf("a\r\n") });
      await hub(["persona", "edit", "--stdin"], { stdin: stdinOf("b\r\n\r\n") });
      expect(ledger.calls.map((c) => c.args)).toEqual([{ text: "a" }, { text: "b\r\n" }]);
    });

    it("invalid UTF-8 on stdin exits 2 without calling the daemon", async () => {
      const stdin = Readable.from([Buffer.from([0x61, 0xff, 0xfe, 0x62])]);
      const r = await hub(["persona", "edit", "--stdin"], { stdin });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain("UTF-8");
      expect(ledger.calls).toHaveLength(0);
    });

    it("stdin that never sends anything exits 2 with a heredoc hint", async () => {
      const r = await hub(["persona", "edit", "--stdin"], { stdin: new TrapStdin(), stdinIdleMs: 100 });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain("标准输入一直没有结束，记得用 heredoc");
      expect(ledger.calls).toHaveLength(0);
    });

    it("slow but steady stdin is not cut off by the idle limit", async () => {
      async function* slow() {
        for (const part of ["一", "二", "三", "四"]) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield Buffer.from(part, "utf8");
        }
      }
      const r = await hub(["persona", "edit", "--stdin"], { stdin: Readable.from(slow()), stdinIdleMs: 150 });
      expect(r.code).toBe(0);
      expect(ledger.calls[0]?.args).toEqual({ text: "一二三四" });
    });

    it("a real process whose stdin stays open and silent exits 2 instead of hanging", async () => {
      const script = `import { runHub } from ${JSON.stringify(HUB_CLI)};
process.exitCode = await runHub({ argv: process.argv.slice(1), env: process.env, cwd: process.cwd(), stdin: () => process.stdin,
  stdout: process.stdout, stderr: process.stderr, stdinIdleMs: 200 });`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, "persona", "edit", "--stdin"], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("hub hung on a silent stdin"));
        }, 10_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      child.stdin.destroy();
      expect(code).toBe(HUB_EXIT.usage);
      expect(stderr).toContain("记得用 heredoc");
      expect(ledger.calls).toHaveLength(0);
    });

    it("persona edit --stdin together with --mode and --reason", async () => {
      await hub(["persona", "edit", "--stdin", "--mode", "manage_only", "--reason", "r"], { stdin: stdinOf("全文") });
      expect(ledger.calls[0]?.args).toEqual({ text: "全文", mode: "manage_only", reason: "r" });
    });
  });

  describe("does not read stdin without --stdin", () => {
    it("persona edit with neither --stdin, --text nor --mode exits 2 at once (in-process)", async () => {
      const r = await hub(["persona", "edit", "--reason", "r"]);
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toMatch(/--stdin|--text/);
      expect(ledger.calls).toHaveLength(0);
    });

    it("a real hub process with stdin held open exits 2 without hanging", async () => {
      const child = spawn(process.execPath, [HUB_MAIN, "persona", "edit", "--reason", "r"], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
      // 标准输入一直开着，不写也不关
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("hub hung waiting on stdin"));
        }, 10_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      child.stdin.destroy();
      expect(code).toBe(HUB_EXIT.usage);
      expect(stderr).toMatch(/--stdin|--text/);
    });
  });

  describe("usage errors (exit 2)", () => {
    it.each([
      [[]],
      [["frobnicate"]],
      [["project"]],
      [["project", "archive", "foo"]],
      [["pm"]],
      [["persona"]],
      [["status", "extra"]],
      [["project", "create", "--name", "foo"]],
      [["project", "create", "--folder", "/x", "--bogus", "1"]],
      [["project", "attach"]],
      [["project", "detach", "/a", "/b"]],
      // 11-03 拿掉的命令
      [["pm", "list"]],
      [["project", "assign", "foo", "--to", "阿周", "--text", "交接"]],
      [["persona", "edit"]],
      [["persona", "edit", "--reason", "只有理由"]],
      [["persona", "edit", "--mode", "boss"]],
      [["project", "create", "--name", "--folder", "/x"]],
    ])("hub %j", async (argv) => {
      const r = await hub([...argv]);
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).not.toBe("");
      expect(ledger.calls).toHaveLength(0);
    });

    it("--stdin and --text together", async () => {
      const r = await hub(["persona", "edit", "--stdin", "--text", "x"], { stdin: stdinOf("y") });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(ledger.calls).toHaveLength(0);
    });

    it("an empty persona text from --stdin or --text", async () => {
      expect((await hub(["persona", "edit", "--stdin"], { stdin: stdinOf("\n") })).code).toBe(2);
      expect((await hub(["persona", "edit", "--stdin"], { stdin: stdinOf("") })).code).toBe(2);
      expect((await hub(["persona", "edit", "--text", ""])).code).toBe(2);
      expect(ledger.calls).toHaveLength(0);
    });

    it("HUB_TOKEN not set", async () => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_TOKEN]: undefined } });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain(ENV_HUB_TOKEN);
    });

    it.each([["a\nb"], ["中文令牌"], ["a b"], ["a\u0001b"]])("HUB_TOKEN with illegal characters %j exits 2 without a stack", async (bad) => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_TOKEN]: bad } });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain(ENV_HUB_TOKEN);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stderr).not.toContain(bad);
      expect(ledger.calls).toHaveLength(0);
    });

    it("a real hub process with an illegal HUB_TOKEN exits 2 with one line and no stack", async () => {
      const r = await run(process.execPath, [HUB_MAIN, "status"], { ...env, [ENV_HUB_TOKEN]: "bad\ntoken" });
      expect(r.status).toBe(HUB_EXIT.usage);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stderr).not.toContain("bad\ntoken");
    });

    it("an unexpected exception becomes one line and exit 2, no stack", async () => {
      let stderr = "";
      const code = await runHubSafely({
        argv: ["persona", "edit", "--stdin"],
        env,
        cwd,
        stdin: () => {
          throw new Error("stdin exploded");
        },
        stdout: { write: () => true },
        stderr: { write: (s: string) => void (stderr += s) },
      });
      expect(code).toBe(HUB_EXIT.usage);
      expect(stderr).toBe("hub：出了意外的错：stdin exploded\n");
      expect(ledger.calls).toHaveLength(0);
    });

    it("HUB_SOCK not set", async () => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: "" } });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain(ENV_HUB_SOCK);
    });
  });

  describe("rejected by the daemon (exit 1)", () => {
    it("prints the ledger's message", async () => {
      ledger.failWith = new LedgerRequestError("conflict", "一个项目经理只管一个项目，请新建一个项目经理");
      const r = await hub(["project", "create", "--folder", "/a"]);
      expect(r.code).toBe(HUB_EXIT.rejected);
      expect(r.stderr).toBe("一个项目经理只管一个项目，请新建一个项目经理\n");
      expect(r.stdout).toBe("");
    });

    it("a revoked token is a rejection, not a usage error", async () => {
      tokens.revoke(42);
      const r = await hub(["status"]);
      expect(r.code).toBe(HUB_EXIT.rejected);
      expect(r.stderr).not.toBe("");
    });

    it("an over-long field is rejected by the daemon", async () => {
      const r = await hub(["project", "create", "--folder", "/x", "--name", "n".repeat(100)]);
      expect(r.code).toBe(HUB_EXIT.rejected);
      expect(ledger.calls).toHaveLength(0);
    });

    it("stdin larger than the body limit is refused without reading it all", async () => {
      const huge = "x".repeat(2 * 1024 * 1024);
      const r = await hub(["persona", "edit", "--stdin"], { stdin: stdinOf(huge) });
      expect([HUB_EXIT.usage, HUB_EXIT.rejected]).toContain(r.code);
      expect(r.stderr).not.toBe("");
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("unreachable daemon (exit 3)", () => {
    const UNREACHABLE = /连不上 agent-hub/;
    const MAYBE_EXECUTED = /请求可能已经执行，请先用 `hub status` 确认/;

    it("HUB_SOCK points at a missing file", async () => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: join(dir, "nope.sock") } });
      expect(r.code).toBe(HUB_EXIT.unreachable);
      expect(r.stderr).toMatch(UNREACHABLE);
    });

    it("HUB_SOCK points at a regular file", async () => {
      const file = join(dir, "plain");
      writeFileSync(file, "");
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: file } });
      expect(r.code).toBe(HUB_EXIT.unreachable);
      expect(r.stderr).toMatch(UNREACHABLE);
    });

    it("the daemon has stopped (socket closed)", async () => {
      await running.close();
      const r = await hub(["status"]);
      expect(r.code).toBe(HUB_EXIT.unreachable);
      expect(r.stderr).toMatch(UNREACHABLE);
      // afterEach 会再关一次，换一个能关的
      running = await startAgentApi({ ledger, tokens, runDir: join(dir, "run2"), hubSock: join(dir, "run2", "hub.sock") });
    });

    it("unreachable is not reported as maybe-executed", async () => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: join(dir, "nope.sock") } });
      expect(r.stderr).not.toMatch(MAYBE_EXECUTED);
    });

    it("the daemon accepts but never answers (timeout): sent, maybe executed", async () => {
      const sock = join(dir, "silent.sock");
      const held: Socket[] = [];
      const silent: Server = createServer((socket) => void held.push(socket));
      await new Promise<void>((resolve) => silent.listen(sock, resolve));
      try {
        const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: sock }, timeoutMs: 200 });
        expect(r.code).toBe(HUB_EXIT.unreachable);
        expect(r.stderr).toMatch(MAYBE_EXECUTED);
        expect(r.stderr).toContain("hub status");
        expect(r.stderr).not.toMatch(UNREACHABLE);
      } finally {
        for (const socket of held) socket.destroy();
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });

    it("the daemon reads the request then drops the connection: sent, maybe executed", async () => {
      const sock = join(dir, "drop.sock");
      const dropper: Server = createServer((socket) => socket.once("data", () => socket.destroy()));
      await new Promise<void>((resolve) => dropper.listen(sock, resolve));
      try {
        const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: sock } });
        expect(r.code).toBe(HUB_EXIT.unreachable);
        expect(r.stderr).toMatch(MAYBE_EXECUTED);
      } finally {
        await new Promise<void>((resolve) => dropper.close(() => resolve()));
      }
    });
  });

  describe("path arguments", () => {
    it("expands a leading ~ to HOME", async () => {
      await hub(["project", "create", "--folder", "~/code/foo"]);
      expect(ledger.calls[0]?.args).toEqual({ folder: join(home, "code", "foo") });
    });

    it("expands a bare ~ and ~ in attach/detach", async () => {
      await hub(["project", "attach", "~"]);
      await hub(["project", "detach", "~/x"]);
      expect(ledger.calls.map((c) => c.args)).toEqual([{ folder: home }, { folder: join(home, "x") }]);
    });

    it("resolves relative paths against the current directory", async () => {
      await hub(["project", "create", "--folder", "sub/dir"]);
      await hub(["project", "attach", "."]);
      expect(ledger.calls.map((c) => c.args)).toEqual([{ folder: join(cwd, "sub", "dir") }, { folder: cwd }]);
    });

    it("does not treat ~user or a ~ in the middle as HOME", async () => {
      await hub(["project", "attach", "/a/~/b"]);
      expect(ledger.calls[0]?.args).toEqual({ folder: "/a/~/b" });
    });

    it("~ without HOME is a usage error", async () => {
      const r = await hub(["project", "attach", "~/x"], { env: { ...env, HOME: undefined } });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("run/bin/hub shim", () => {
    it("writes an executable 0700 wrapper that runs hub with the given node", async () => {
      const binDir = join(dir, "run", "bin");
      const shim = installHubShim({ binDir });
      expect(shim).toBe(join(binDir, "hub"));
      expect(statSync(shim).mode & 0o777).toBe(0o700);
      expect(statSync(binDir).mode & 0o777).toBe(0o700);
      const content = readFileSync(shim, "utf8");
      expect(content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(content).toContain(process.execPath);

      // 服务在本进程里，不能用 spawnSync（会卡住事件循环）
      const r = await run(shim, ["project", "create", "--folder", "~/p"], { PATH: "/usr/bin:/bin", ...env });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("已执行 project.create（会话 42）\n");
      expect(ledger.calls[0]?.args).toEqual({ folder: join(home, "p") });
    });

    it("exit codes pass through the shim", () => {
      const shim = installHubShim({ binDir: join(dir, "run", "bin") });
      const r = spawnSync(shim, ["status"], { env: { PATH: "/usr/bin:/bin", [ENV_HUB_SOCK]: running.socketPath }, encoding: "utf8" });
      expect(r.status).toBe(HUB_EXIT.usage);
    });

    it("quotes paths with spaces and single quotes", () => {
      const odd = join(dir, "it's here");
      mkdirSync(odd);
      const fakeNode = join(odd, "my node");
      writeFileSync(fakeNode, '#!/bin/sh\necho "args:$#:$1:$2:$3"\n', { mode: 0o755 });
      const shim = installHubShim({ binDir: join(dir, "bin2"), nodePath: fakeNode, mainScript: join(odd, "main $x.ts") });
      const r = spawnSync(shim, ["a b", "$HOME"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
      expect(r.stdout).toBe(`args:3:${join(odd, "main $x.ts")}:a b:$HOME\n`);
    });

    it("rewrites an existing shim (e.g. node moved) and keeps it 0700", () => {
      const binDir = join(dir, "run", "bin");
      installHubShim({ binDir, nodePath: "/old/node" });
      const shim = installHubShim({ binDir });
      expect(readFileSync(shim, "utf8")).not.toContain("/old/node");
      expect(statSync(shim).mode & 0o777).toBe(0o700);
    });
  });
});
