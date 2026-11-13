// hub 命令行的测试：起一个真的 agent 接口（假账本），经 Unix socket 调。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  ALL_EFFORTS,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  HUB_COMMAND,
  HUB_EXIT,
  LedgerRequestError,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
  type SessionTokens,
} from "../shared/index.ts";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { HUB_USAGE, runHub, runHubSafely, type HubIo } from "./cli.ts";
import { FakeHubLedger } from "../daemon/agent-api/fake-ledger.ts";
import { startAgentApi, type RunningAgentApi } from "../daemon/agent-api/server.ts";
import { installHubShim } from "../daemon/agent-api/shim.ts";
import { createSessionTokens } from "../daemon/agent-api/tokens.ts";
import { resolveHubPaths } from "../shared/paths.ts";

/** 命令名（names.ts）：改名只改那一处，这里的断言跟着变。 */
const cmd = HUB_COMMAND;

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
    dir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "ah-"));
    home = join(dir, "home");
    cwd = join(dir, "work");
    mkdirSync(home);
    mkdirSync(cwd);
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
    const sock = process.platform === "win32" ? resolveHubPaths({}, dir).hubSock : join(dir, "run", "hub.sock");
    running = await startAgentApi({ ledger, tokens, runDir: join(dir, "run"), hubSock: sock });
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
      expect(r.stdout).toContain(`${cmd} project create --folder`);
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

    it("worker start --effort sends the level; any level from the vendor list is accepted", async () => {
      for (const level of ALL_EFFORTS) {
        expect((await hub(["worker", "start", "--title", "修 X", "--effort", level, "--stdin"], { stdin: stdinOf("任务") })).code).toBe(0);
      }
      expect(ledger.calls.map((c) => c.args)).toEqual(
        ALL_EFFORTS.map((effort) => ({ title: "修 X", effort, task: "任务" })),
      );
    });

    it("worker start --effort with a level not in the list is a usage error", async () => {
      for (const level of ["turbo", "LOW", ""]) {
        const r = await hub(["worker", "start", "--title", "修 X", "--effort", level, "--stdin"], { stdin: stdinOf("任务") });
        expect(r.code).toBe(HUB_EXIT.usage);
        expect(r.stderr).toContain(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("worker start --vendor sends the vendor; unknown vendor is a usage error", async () => {
      for (const vendor of AGENT_VENDORS) {
        expect((await hub(["worker", "start", "--title", "修 X", "--vendor", vendor, "--stdin"], { stdin: stdinOf("任务") })).code).toBe(0);
      }
      expect(ledger.calls.map((c) => c.args)).toEqual(AGENT_VENDORS.map((vendor) => ({ title: "修 X", vendor, task: "任务" })));
      ledger.calls.length = 0;
      for (const bad of ["gemini", "CLAUDE", ""]) {
        const r = await hub(["worker", "start", "--title", "修 X", "--vendor", bad, "--stdin"], { stdin: stdinOf("任务") });
        expect(r.code).toBe(HUB_EXIT.usage);
        expect(r.stderr).toContain(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("worker start --vendor agy: full id with the effort inside, or a bare model plus --effort, both go through unchanged", async () => {
      expect((await hub(["worker", "start", "--title", "修 X", "--vendor", "agy", "--model", "gemini-4-argon-high", "--stdin"], { stdin: stdinOf("任务") })).code).toBe(0);
      expect(
        (await hub(["worker", "start", "--title", "修 X", "--vendor", "agy", "--model", "gemini-4-argon", "--effort", "high", "--stdin"], { stdin: stdinOf("任务") })).code,
      ).toBe(0);
      expect(ledger.calls.map((c) => c.args)).toEqual([
        { title: "修 X", vendor: "agy", model: "gemini-4-argon-high", task: "任务" },
        { title: "修 X", vendor: "agy", model: "gemini-4-argon", effort: "high", task: "任务" },
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

    it("worker start / send --max-time and worker max-time parse human durations and reject invalid ones", async () => {
      expect(
        (await hub(["worker", "start", "--title", "修 X", "--max-time", "15m", "--stdin"], { stdin: stdinOf("任务") })).code,
      ).toBe(0);
      expect(
        (await hub(["worker", "send", "3", "--max-time", "1h30m", "--stdin"], { stdin: stdinOf("继续") })).code,
      ).toBe(0);
      expect((await hub(["worker", "max-time", "3", "45m"])).code).toBe(0);
      expect(ledger.calls.map((c) => ({ command: c.command, args: c.args }))).toEqual([
        { command: "worker.start", args: { title: "修 X", maxTimeMs: 15 * 60_000, task: "任务" } },
        { command: "worker.send", args: { workerId: 3, maxTimeMs: 90 * 60_000, text: "继续" } },
        { command: "worker.max-time", args: { workerId: 3, maxTimeMs: 45 * 60_000 } },
      ]);

      ledger.calls.length = 0;
      for (const bad of ["abc", "5s", "25h", ""]) {
        const r1 = await hub(["worker", "start", "--title", "修 X", "--max-time", bad, "--stdin"], { stdin: stdinOf("任务") });
        expect(r1.code).toBe(HUB_EXIT.usage);
        const r2 = await hub(["worker", "send", "3", "--max-time", bad, "--stdin"], { stdin: stdinOf("继续") });
        expect(r2.code).toBe(HUB_EXIT.usage);
        const r3 = await hub(["worker", "max-time", "3", bad]);
        expect(r3.code).toBe(HUB_EXIT.usage);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("ask --stdin sends the text", async () => {
      expect((await hub(["ask", "--stdin"], { stdin: stdinOf("用 A 还是 B？\n") })).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "ask", args: { text: "用 A 还是 B？" } }]);
    });

    it("ask --option collects multiple options and validates count and content", async () => {
      const r = await hub(["ask", "--option", " 审一个 PR / 分支 ", "--option", "审本地代码路径", "--stdin"], {
        stdin: stdinOf("你想审什么？\n"),
      });
      expect(r.code).toBe(0);
      expect(ledger.calls).toEqual([
        {
          sessionId: 42,
          command: "ask",
          args: { text: "你想审什么？", options: ["审一个 PR / 分支", "审本地代码路径"] },
        },
      ]);

      ledger.calls.length = 0;
      const oneOpt = await hub(["ask", "--option", "只有一个", "--stdin"], { stdin: stdinOf("问") });
      expect(oneOpt.code).toBe(HUB_EXIT.usage);
      expect(oneOpt.stderr).toContain("选项至少要给 2 个");

      const elevenOpts = await hub(
        ["ask", ...Array.from({ length: 11 }, (_, i) => ["--option", `选项${i}`]).flat(), "--stdin"],
        { stdin: stdinOf("问") },
      );
      expect(elevenOpts.code).toBe(HUB_EXIT.usage);
      expect(elevenOpts.stderr).toContain("选项最多 10 个");

      for (const bad of ["   ", "带\n换行", "x".repeat(201)]) {
        const res = await hub(["ask", "--option", "好选项", "--option", bad, "--stdin"], { stdin: stdinOf("问") });
        expect(res.code).toBe(HUB_EXIT.usage);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it.each([[["ask"]], [["ask", "--text", "x"]], [["ask", "3", "--stdin"]], [["ask", "--title", "x", "--stdin"]]])(
      "usage error: hub %j",
      async (argv) => {
        const r = await hub([...argv], { stdin: stdinOf("问") });
        expect(r.code).toBe(HUB_EXIT.usage);
        expect(ledger.calls).toHaveLength(0);
      },
    );

    it("an empty question from --stdin is a usage error", async () => {
      expect((await hub(["ask", "--stdin"], { stdin: stdinOf("\n") })).code).toBe(2);
      expect(ledger.calls).toHaveLength(0);
    });

    it.each([
      [["worker", "end", "3"], "worker.end", { workerId: 3 }],
      [["worker", "list"], "worker.list", {}],
      [["worker", "show", "3"], "worker.show", { workerId: 3 }],
      [["worker", "log", "3"], "worker.log", { workerId: 3 }],
      [["worker", "log", "3", "--last", "5"], "worker.log", { workerId: 3, last: 5 }],
      [["worker", "log", "--last", "200", "3"], "worker.log", { workerId: 3, last: 200 }],
      [["worker", "log", "3", "--stats"], "worker.log", { workerId: 3, stats: true }],
      [["worker", "show", "3", "--task"], "worker.show", { workerId: 3, task: true }],
      [["worker", "show", "3", "--report"], "worker.show", { workerId: 3, report: "latest" }],
      [["worker", "show", "3", "--report", "2"], "worker.show", { workerId: 3, report: 2 }],
      [["worker", "search", "登录", "Bug"], "worker.search", { keywords: ["登录", "Bug"] }],
      [["worker", "search", "x", "--limit", "100"], "worker.search", { keywords: ["x"], limit: 100 }],
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
      [["worker", "show"]],
      [["worker", "show", "abc"]],
      [["worker", "show", "3", "4"]],
      [["worker", "show", "3", "--last", "5"]],
      [["worker", "show", "3", "--task", "--report"]],
      [["worker", "show", "3", "--task", "2"]],
      [["worker", "show", "3", "--report", "0"]],
      [["worker", "show", "3", "--report", "x"]],
      [["worker", "show", "3", "--report", "2", "3"]],
      [["worker", "search"]],
      [["worker", "search", "x", "--limit", "0"]],
      [["worker", "search", "x", "--limit", "101"]],
      [["worker", "search", "x", "--limit", "abc"]],
      [["worker", "search", "x", "--stats"]],
      [["worker", "log"]],
      [["worker", "log", "3", "--last", "0"]],
      [["worker", "log", "3", "--last", "201"]],
      [["worker", "log", "3", "--last", "abc"]],
      [["worker", "log", "3", "--last", "-1"]],
      [["worker", "log", "3", "--last", "1.5"]],
      [["worker", "log", "3", "--last"]],
      [["worker", "log", "3", "--stats", "--last", "5"]],
      [["worker", "log", "3", "--stdin"]],
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
      const vendorUnion = AGENT_VENDORS.join("|");
      const effortUnion = ALL_EFFORTS.join("|");
      for (const usage of [`${cmd} models [--vendor ${vendorUnion}] [--refresh]`, `${cmd} worker start --title`, `--vendor ${vendorUnion}`, `--effort ${effortUnion}`, "--max-time <时长>", "--readonly", "--no-worktree", `${cmd} worker send <编号> [--max-time <时长>] --stdin`, `${cmd} worker max-time <编号> <时长>`, `${cmd} worker end <编号>`, `${cmd} worker list`, `${cmd} worker show <编号>`, `${cmd} worker log <编号> [--last N | --stats]`, `${cmd} ask [--node <步骤>] [--graph <图编号>] [--option <选项>...] [--recommended <选项>] [--replace <编号>] --stdin`]) {
        expect(r.stdout).toContain(usage);
      }
      expect(r.stdout).not.toContain(`${cmd} router ask`);
      expect(r.stdout).not.toContain(`${cmd} graph ask`);
    });

    it("worker start --node [--graph] passes task-graph binding flags and worker end rejects removed --incomplete", async () => {
      expect(
        (await hub(["worker", "start", "--title", "实现 CLI", "--node", "impl-cli", "--graph", "7", "--stdin"], {
          stdin: stdinOf("做 CLI"),
        })).code,
      ).toBe(0);
      expect((await hub(["worker", "end", "3"])).code).toBe(0);
      expect(ledger.calls).toEqual([
        { sessionId: 42, command: "worker.start", args: { title: "实现 CLI", node: "impl-cli", graphId: 7, task: "做 CLI" } },
        { sessionId: 42, command: "worker.end", args: { workerId: 3 } },
      ]);
      ledger.calls.length = 0;
      expect((await hub(["worker", "end", "3", "--incomplete"])).code).toBe(HUB_EXIT.usage);
      const badGraph = await hub(["worker", "start", "--title", "修 X", "--node", "n1", "--graph", "abc", "--stdin"], {
        stdin: stdinOf("x"),
      });
      expect(badGraph.code).toBe(HUB_EXIT.usage);
      expect(ledger.calls).toHaveLength(0);
    });

    it("worker start --node 换人：--title、--stdin 都可以不给；给了 --stdin 读到空的也不报错、不带 task", async () => {
      expect((await hub(["worker", "start", "--node", "s1", "--vendor", "codex"])).code).toBe(HUB_EXIT.ok);
      expect((await hub(["worker", "start", "--node", "s1", "--stdin"], { stdin: stdinOf("") })).code).toBe(HUB_EXIT.ok);
      expect((await hub(["worker", "start", "--node", "s1", "--stdin"], { stdin: stdinOf("先跑 X\n") })).code).toBe(HUB_EXIT.ok);
      expect(ledger.calls).toEqual([
        { sessionId: 42, command: "worker.start", args: { vendor: "codex", node: "s1" } },
        { sessionId: 42, command: "worker.start", args: { node: "s1" } },
        { sessionId: 42, command: "worker.start", args: { node: "s1", task: "先跑 X" } },
      ]);
      // 不带 --node 的照旧要 --title、--stdin、非空正文
      ledger.calls.length = 0;
      expect((await hub(["worker", "start", "--stdin"], { stdin: stdinOf("x") })).code).toBe(HUB_EXIT.usage);
      expect((await hub(["worker", "start", "--title", "修 X", "--stdin"], { stdin: stdinOf("") })).code).toBe(HUB_EXIT.usage);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("hub router & hub graph", () => {
    it("unified ask (--node / --recommended / --replace) and legacy CLI aliases (router ask / graph ask) forward cleanly to ask", async () => {
      expect(
        (
          await hub(
            [
              "ask",
              "--node",
              "confirm-mcp",
              "--graph",
              "9",
              "--option",
              "全量同步",
              "--option",
              "仅无冲突",
              "--recommended",
              "全量同步",
              "--stdin",
            ],
            { stdin: stdinOf("调研发现 2 项端口不同\n") },
          )
        ).code,
      ).toBe(0);

      expect(
        (
          await hub(
            [
              "router",
              "ask",
              "--question",
              "用独立表还是复用？",
              "--option",
              "独立表（推荐）",
              "--option",
              "复用旧表",
              "--replace",
              "5",
              "--stdin",
            ],
            { stdin: stdinOf("独立表幂等迁移更干净\n") },
          )
        ).code,
      ).toBe(0);

      expect(
        (
          await hub([
            "router",
            "report",
            "--summary",
            "PR #398 已合入",
            "--pr",
            "https://github.com/o/r/pull/398",
            "--worker",
            "395",
            "--file",
            "docs/router-design.md",
            "--link",
            "面板=http://localhost:5173",
          ])
        ).code,
      ).toBe(0);

      expect((await hub(["router", "note", "--text", "正在拆第 1 波 PR"])).code).toBe(0);
      expect((await hub(["router", "note", "--clear"])).code).toBe(0);

      expect(ledger.calls).toEqual([
        {
          sessionId: 42,
          command: "ask",
          args: {
            node: "confirm-mcp",
            graphId: 9,
            options: ["全量同步", "仅无冲突"],
            recommended: "全量同步",
            text: "调研发现 2 项端口不同",
          },
        },
        {
          sessionId: 42,
          command: "ask",
          args: {
            options: ["独立表（推荐）", "复用旧表"],
            replaceItemId: 5,
            text: "用独立表还是复用？\n\n独立表幂等迁移更干净",
          },
        },
        {
          sessionId: 42,
          command: "router.report",
          args: {
            summary: "PR #398 已合入",
            links: [
              { label: "PR #398", target: "https://github.com/o/r/pull/398" },
              { label: "Worker #395", target: "worker:395" },
              { label: "router-design.md", target: "docs/router-design.md" },
              { label: "面板", target: "http://localhost:5173" },
            ],
          },
        },
        { sessionId: 42, command: "router.note", args: { text: "正在拆第 1 波 PR" } },
        { sessionId: 42, command: "router.note", args: { clear: true } },
      ]);
    });

    it("ask --recommended supports exact option text or 1..N index", async () => {
      expect(
        (
          await hub([
            "ask",
            "--option",
            "方案 A",
            "--option",
            "方案 B",
            "--recommended",
            "2",
            "--stdin",
          ], { stdin: stdinOf("选哪个？\n") })
        ).code,
      ).toBe(0);
      expect(ledger.calls[0]?.args).toEqual({
        text: "选哪个？",
        options: ["方案 A", "方案 B"],
        recommended: "方案 B",
      });
    });

    it("graph create / patch 的 usage 直接附一行 JSON 字段示例", async () => {
      const r = await hub(["--help"]);
      expect(r.stdout).toContain(`JSON：${TASK_GRAPH_CREATE_JSON_HINT}`);
      expect(r.stdout).toContain(`JSON：${TASK_GRAPH_PATCH_JSON_HINT}`);
      for (const field of ["title", "goal", "steps", "brief", "review"]) {
        expect(TASK_GRAPH_CREATE_JSON_HINT).toContain(`"${field}"`);
      }
      for (const field of ["goal", "addSteps", "updateSteps", "removeSteps", "skipSteps"]) {
        expect(TASK_GRAPH_PATCH_JSON_HINT).toContain(`"${field}"`);
      }
    });

    it("graph create / show / list / ask / patch / done / decide / skip / cancel / finish parse cleanly", async () => {
      const spec = JSON.stringify({ nodes: [{ key: "n1", title: "第一步" }] });
      expect((await hub(["graph", "create", "--title", "主线流图", "--stdin"], { stdin: stdinOf(`${spec}\n`) })).code).toBe(0);
      expect((await hub(["graph", "show"])).code).toBe(0);
      expect((await hub(["graph", "show", "9"])).code).toBe(0);
      expect((await hub(["graph", "list", "--all"])).code).toBe(0);
      expect((await hub(["graph", "list", "--status", "completed"])).code).toBe(0);
      expect(
        (
          await hub(
            ["graph", "ask", "confirm-mcp", "--graph", "9", "--option", "全量同步", "--option", "仅无冲突", "--stdin"],
            { stdin: stdinOf("调研发现 2 项端口不同\n") },
          )
        ).code,
      ).toBe(0);
      expect((await hub(["graph", "patch", "9", "--stdin"], { stdin: stdinOf('{"skipNodes":["n1"]}\n') })).code).toBe(0);
      expect(
        (
          await hub([
            "graph",
            "done",
            "n1",
            "--graph",
            "9",
            "--pr",
            "https://github.com/o/r/pull/1",
            "--commit",
            "abc1234",
            "--branch",
            "hub/1-n1",
            "--summary",
            "已完成",
          ])
        ).code,
      ).toBe(0);
      expect((await hub(["graph", "decide", "confirm-mcp", "--choice", "全量同步", "--note", "先备份", "--graph", "9"])).code).toBe(0);
      expect((await hub(["graph", "skip", "n1", "--reason", "不需要了", "--graph", "9"])).code).toBe(0);
      expect((await hub(["graph", "cancel", "9", "--reason", "改方案"])).code).toBe(0);
      expect((await hub(["graph", "finish", "--stdin"], { stdin: stdinOf("已合并发布\n") })).code).toBe(0);
      expect((await hub(["graph", "finish", "9", "--unmerged-ok", "--stdin"], { stdin: stdinOf("实验分支保留不合并\n") })).code).toBe(0);

      expect(ledger.calls.map((c) => ({ command: c.command, args: c.args }))).toEqual([
        { command: "graph.create", args: { title: "主线流图", specJson: spec } },
        { command: "graph.show", args: {} },
        { command: "graph.show", args: { graphId: 9 } },
        { command: "graph.list", args: { all: true } },
        { command: "graph.list", args: { status: "completed" } },
        {
          command: "ask",
          args: {
            node: "confirm-mcp",
            graphId: 9,
            options: ["全量同步", "仅无冲突"],
            text: "调研发现 2 项端口不同",
          },
        },
        { command: "graph.patch", args: { graphId: 9, specJson: '{"skipNodes":["n1"]}' } },
        {
          command: "graph.done",
          args: {
            nodeKey: "n1",
            graphId: 9,
            prUrl: "https://github.com/o/r/pull/1",
            commit: "abc1234",
            branch: "hub/1-n1",
            summary: "已完成",
          },
        },
        { command: "graph.decide", args: { nodeKey: "confirm-mcp", graphId: 9, choice: "全量同步", note: "先备份" } },
        { command: "graph.skip", args: { nodeKey: "n1", graphId: 9, reason: "不需要了" } },
        { command: "graph.cancel", args: { graphId: 9, reason: "改方案" } },
        { command: "graph.finish", args: { summary: "已合并发布" } },
        { command: "graph.finish", args: { graphId: 9, unmergedOk: true, summary: "实验分支保留不合并" } },
      ]);
    });

    it("graph done supports --stdin handoff note alongside optional --summary / --pr", async () => {
      ledger.calls.length = 0;
      expect(
        (await hub(["graph", "done", "impl", "--graph", "5", "--pr", "https://github.com/o/r/pull/9", "--summary", "放行", "--stdin"], {
          stdin: stdinOf("补给下一步审查的话\n"),
        })).code,
      ).toBe(0);
      expect(ledger.calls).toEqual([
        {
          sessionId: 42,
          command: "graph.done",
          args: {
            nodeKey: "impl",
            graphId: 5,
            prUrl: "https://github.com/o/r/pull/9",
            summary: "放行",
            note: "补给下一步审查的话",
          },
        },
      ]);
    });

    it.each([
      [["router"]],
      [["router", "ask", "--option", "A", "--option", "B"]],
      [["router", "ask", "--question", "问", "--option", "只有一个"]],
      [["router", "ask", "--question", "问", "--option", "1", "--option", "2", "--option", "3", "--option", "4", "--option", "5"]],
      [["router", "report"]],
      [["router", "report", "--summary", "好", "--link", "没有等号"]],
      [["router", "note"]],
      [["router", "note", "--clear", "--text", "冲突"]],
      [["graph"]],
      [["graph", "create", "--title", "缺stdin"]],
      [["graph", "ask", "confirm-mcp"]],
      [["graph", "ask", "confirm-mcp", "--question", "问", "--recommended", "1"]],
      [["graph", "patch"]],
      [["graph", "finish"]],
      [["graph", "finish", "1", "2", "--stdin"]],
      [["graph", "decide", "confirm-mcp"]],
      [["graph", "list", "--status", "bogus"]],
    ])("usage error: hub %j", async (argv) => {
      const r = await hub([...argv], { stdin: stdinOf("x") });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("hub models", () => {
    it.each([
      [["models"], {}],
      [["models", "--vendor", "claude"], { vendor: "claude" }],
      [["models", "--refresh"], { refresh: true }],
      [["models", "--vendor", "agy", "--refresh"], { vendor: "agy", refresh: true }],
    ] as const)("hub %j → models %j", async (argv, args) => {
      const r = await hub([...argv]);
      expect(r.code).toBe(HUB_EXIT.ok);
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "models", args }]);
    });

    it.each([
      [["models", "--vendor", "gemini"]],
      [["models", "--vendor", ""]],
      [["models", "extra"]],
      [["models", "--stdin"]],
      [["models", "--readonly"]],
    ])("usage error: hub %j", async (argv) => {
      const r = await hub([...argv]);
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain(`${cmd} models [--vendor ${AGENT_VENDORS.join("|")}] [--refresh]`);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("hub schedule（M6）", () => {
    it("add --daily HH:MM --stdin 把任务说明（多行、带 $）原样放进 prompt", async () => {
      const prompt = "汇报昨天的进展\n用 $HOME 别展开\n";
      expect((await hub(["schedule", "add", "--name", "每日汇报", "--daily", "09:00", "--stdin"], { stdin: stdinOf(prompt) })).code).toBe(0);
      expect(ledger.calls).toEqual([
        { sessionId: 42, command: "schedule.add", args: { name: "每日汇报", daily: "09:00", prompt: prompt.slice(0, -1) } },
      ]);
    });

    it.each([
      ["30m", 30],
      ["2h", 120],
      ["15m", 15],
      ["168h", 168 * 60],
    ])("add --every %s → everyMinutes %i", async (every, minutes) => {
      expect((await hub(["schedule", "add", "--name", "巡检", "--every", every, "--stdin"], { stdin: stdinOf("看一眼") })).code).toBe(0);
      expect(ledger.calls[0]?.args).toEqual({ name: "巡检", everyMinutes: minutes, prompt: "看一眼" });
    });

    it.each([
      [["schedule", "list"], "schedule.list", {}],
      [["schedule", "pause", "3"], "schedule.pause", { scheduleId: 3 }],
      [["schedule", "resume", "3"], "schedule.resume", { scheduleId: 3 }],
      [["schedule", "remove", "3"], "schedule.remove", { scheduleId: 3 }],
    ] as const)("hub %j → %s", async (argv, command, args) => {
      expect((await hub([...argv])).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command, args }]);
    });

    it.each([
      [["schedule"]],
      [["schedule", "edit", "3"]],
      [["schedule", "add", "--daily", "09:00", "--stdin"]],
      [["schedule", "add", "--name", "x", "--stdin"]],
      [["schedule", "add", "--name", "x", "--daily", "09:00", "--every", "2h", "--stdin"]],
      [["schedule", "add", "--name", "x", "--daily", "09:00"]],
      [["schedule", "add", "--name", "x", "--daily", "09:00", "--text", "y"]],
      [["schedule", "add", "--name", "x", "--daily", "9:00", "--stdin"]],
      [["schedule", "add", "--name", "x", "--daily", "24:00", "--stdin"]],
      [["schedule", "add", "--name", "x", "--daily", "09:60", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "10m", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "0h", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "169h", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "2d", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "1.5h", "--stdin"]],
      [["schedule", "add", "--name", "x", "--every", "2", "--stdin"]],
      [["schedule", "add", "--name", "x", "--daily", "09:00", "--stdin", "extra"]],
      [["schedule", "pause"]],
      [["schedule", "pause", "abc"]],
      [["schedule", "resume", "0"]],
      [["schedule", "remove", "3", "4"]],
      [["schedule", "remove", "-1"]],
      [["schedule", "list", "--stdin"]],
    ])("usage error: hub %j", async (argv) => {
      const r = await hub([...argv], { stdin: stdinOf("任务") });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).not.toBe("");
      expect(ledger.calls).toHaveLength(0);
    });

    it("the pause error names the schedule, not a Worker", async () => {
      expect((await hub(["schedule", "pause", "abc"])).stderr).toContain("定时任务编号");
    });

    it("an empty task from --stdin is a usage error", async () => {
      expect((await hub(["schedule", "add", "--name", "x", "--daily", "09:00", "--stdin"], { stdin: stdinOf("\n") })).code).toBe(2);
      expect(ledger.calls).toHaveLength(0);
    });

    it("the usage text lists the schedule commands", async () => {
      const r = await hub(["--help"]);
      for (const usage of [
        `${cmd} schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin`,
        `${cmd} schedule list`,
        `${cmd} schedule pause <编号>`,
        `${cmd} schedule resume <编号>`,
        `${cmd} schedule remove <编号>`,
      ]) {
        expect(r.stdout).toContain(usage);
      }
    });
  });

  describe("hub project setup（29）", () => {
    it("--stdin 读准备命令（多行、带 $ 原样）", async () => {
      const command = 'pnpm install --frozen-lockfile --ignore-scripts\ncp "$AGENT_HUB_ROOT_PATH/.env" .\n';
      expect((await hub(["project", "setup", "--stdin"], { stdin: stdinOf(command) })).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "project.setup", args: { command: command.slice(0, -1) } }]);
    });

    it("--clear 发 command: null，不读标准输入", async () => {
      expect((await hub(["project", "setup", "--clear"])).code).toBe(0);
      expect(ledger.calls).toEqual([{ sessionId: 42, command: "project.setup", args: { command: null } }]);
    });

    it.each([[["project", "setup"]], [["project", "setup", "--stdin", "--clear"]], [["project", "setup", "--text", "x"]], [["project", "setup", "--clear", "x"]]])(
      "usage error: hub %j",
      async (argv) => {
        const r = await hub([...argv], { stdin: stdinOf("x") });
        expect(r.code).toBe(HUB_EXIT.usage);
        expect(ledger.calls).toHaveLength(0);
      },
    );

    it("标准输入读到空的是用法错（清除要用 --clear）", async () => {
      expect((await hub(["project", "setup", "--stdin"], { stdin: stdinOf("\n") })).code).toBe(2);
      expect(ledger.calls).toHaveLength(0);
    });

    it("用法里有这条命令", async () => {
      const r = await hub(["--help"]);
      expect(r.stdout).toContain(`${cmd} project setup --stdin | --clear`);
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

    it("不认识的参数、缺值、布尔参数带值：中文，不带 node 的英文原文", async () => {
      const cases: [string[], string][] = [
        [["status", "--foo"], "不认识的参数 --foo"],
        [["status", "-x"], "不认识的参数 -x"],
        [["project", "create", "--name"], "--name 后面要跟一个值"],
        [["project", "create", "--name", "--folder", "/x"], "--name 后面要跟一个值"],
        [["persona", "edit", "--stdin=1"], "--stdin 不带值"],
      ];
      for (const [argv, expected] of cases) {
        const r = await hub(argv);
        expect(r.code, argv.join(" ")).toBe(HUB_EXIT.usage);
        expect(r.stderr, argv.join(" ")).toContain(`${cmd}：${expected}`);
        expect(r.stderr, argv.join(" ")).not.toMatch(/Unknown|option|argument|ambiguous|positional/i);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("an unexpected exception becomes one Chinese line and exit 4 (not 2), no stack, no exception text", async () => {
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
      expect(code).toBe(HUB_EXIT.internal);
      expect(HUB_EXIT.internal).toBe(4);
      expect(stderr).toBe(`${cmd}：出了意外的错，这条命令没有跑完。重试一次；还不行，把现象告诉用户\n`);
      expect(stderr).not.toContain("stdin exploded");
      expect(ledger.calls).toHaveLength(0);
    });

    it("HUB_SOCK not set", async () => {
      const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: "" } });
      expect(r.code).toBe(HUB_EXIT.usage);
      expect(r.stderr).toContain(ENV_HUB_SOCK);
    });

    it("已知命令参数错只打印对应命令（或命令组）用法 + hub help 提示，不打印无关命令；未知顶层命令或环境变量缺失打印完整 HUB_USAGE", async () => {
      const workerStartErr = await hub(["worker", "start", "--stdin"], { stdin: stdinOf("任务") });
      expect(workerStartErr.code).toBe(HUB_EXIT.usage);
      expect(workerStartErr.stderr).toContain(`${cmd}：${cmd} worker start 要 --title <标题>`);
      expect(workerStartErr.stderr).toContain(`${cmd} worker start --title`);
      expect(workerStartErr.stderr).toContain(`（完整用法运行 ${cmd} help）`);
      expect(workerStartErr.stderr).not.toContain(`${cmd} schedule add`);
      expect(workerStartErr.stderr).not.toContain(`${cmd} worker log`);

      const workerGroupErr = await hub(["worker", "fire", "3"]);
      expect(workerGroupErr.code).toBe(HUB_EXIT.usage);
      expect(workerGroupErr.stderr).toContain(`${cmd} worker start --title`);
      expect(workerGroupErr.stderr).toContain(`${cmd} worker log <编号>`);
      expect(workerGroupErr.stderr).toContain(`（完整用法运行 ${cmd} help）`);
      expect(workerGroupErr.stderr).not.toContain(`${cmd} schedule add`);
      expect(workerGroupErr.stderr).not.toContain(`${cmd} project create`);

      const askErr = await hub(["ask"]);
      expect(askErr.code).toBe(HUB_EXIT.usage);
      expect(askErr.stderr).toContain(
        `${cmd} ask [--node <步骤>] [--graph <图编号>] [--option <选项>...] [--recommended <选项>] [--replace <编号>] --stdin`,
      );
      expect(askErr.stderr).toContain(`（完整用法运行 ${cmd} help）`);
      expect(askErr.stderr).not.toContain(`${cmd} worker start`);

      const helpOut = await hub(["help"]);
      expect(helpOut.code).toBe(HUB_EXIT.ok);
      expect(helpOut.stdout).toBe(HUB_USAGE);

      const unknownTop = await hub(["frobnicate"]);
      expect(unknownTop.code).toBe(HUB_EXIT.usage);
      expect(unknownTop.stderr).toContain(HUB_USAGE);

      const emptyArgv = await hub([]);
      expect(emptyArgv.code).toBe(HUB_EXIT.usage);
      expect(emptyArgv.stderr).toContain(HUB_USAGE);

      const missingToken = await hub(["worker", "list"], { env: { ...env, [ENV_HUB_TOKEN]: "" } });
      expect(missingToken.code).toBe(HUB_EXIT.usage);
      expect(missingToken.stderr).toContain(HUB_USAGE);
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
    const UNREACHABLE = /连不上守护进程/;
    const MAYBE_EXECUTED = new RegExp(`请求可能已经执行，请先用 \`${cmd} status\` 确认`);

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
      const sock2 = process.platform === "win32" ? resolveHubPaths({}, join(dir, "h2")).hubSock : join(dir, "run2", "hub.sock");
      running = await startAgentApi({ ledger, tokens, runDir: join(dir, "run2"), hubSock: sock2 });
    });

    it("守护进程没开：只打 network 那句话和 hint，不打 ENOENT、ECONNREFUSED 这类系统码", async () => {
      for (const sock of [join(dir, "nope.sock"), join(dir, "plain")]) {
        writeFileSync(join(dir, "plain"), "");
        const r = await hub(["status"], { env: { ...env, [ENV_HUB_SOCK]: sock } });
        expect(r.code).toBe(HUB_EXIT.unreachable);
        expect(r.stderr).toBe(`${LOCAL_ERRORS.network.text}。${LOCAL_ERRORS.network.hint}\n`);
        expect(r.stderr).not.toMatch(/ENOENT|ECONNREFUSED|ENOTSOCK|ECONN|EACCES/);
      }
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
        expect(r.stderr).toContain(`${cmd} status`);
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

  describe.skipIf(process.platform === "win32")("run/bin/hub shim", () => {
    it("writes an executable 0700 wrapper that runs hub with the given node", async () => {
      const binDir = join(dir, "run", "bin");
      const shim = installHubShim({ binDir });
      expect(shim).toBe(join(binDir, cmd));
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

  describe("hub self-reload", () => {
    it("项目经理登记成功立即返回；--build 原样带上；Worker 调被拒（退出码 rejected）；多余参数是用法错", async () => {
      const calls: Array<{ sessionId: number; build: boolean }> = [];
      const runDir2 = join(dir, "run-sr");
      const srSock = process.platform === "win32" ? resolveHubPaths({}, join(dir, "hsr")).hubSock : join(runDir2, "hub.sock");
      const api2 = await startAgentApi({
        ledger,
        tokens,
        runDir: runDir2,
        hubSock: srSock,
        selfReload: (input) => {
          calls.push(input);
          return { text: "已登记空闲排空热重启", data: null };
        },
      });
      try {
        ledger.sessionRoles.set(951, "pm");
        ledger.sessionRoles.set(952, "worker");
        const pmEnv = { [ENV_HUB_TOKEN]: tokens.issue(951), [ENV_HUB_SOCK]: api2.socketPath, HOME: home };
        const workerEnv = { [ENV_HUB_TOKEN]: tokens.issue(952), [ENV_HUB_SOCK]: api2.socketPath, HOME: home };

        const r1 = await hub(["self-reload"], { env: pmEnv });
        expect(r1.code).toBe(HUB_EXIT.ok);
        expect(r1.stdout).toBe("已登记空闲排空热重启\n");
        const r2 = await hub(["self-reload", "--build"], { env: pmEnv });
        expect(r2.code).toBe(HUB_EXIT.ok);
        expect(calls).toEqual([
          { sessionId: 951, build: false },
          { sessionId: 951, build: true },
        ]);

        const denied = await hub(["self-reload"], { env: workerEnv });
        expect(denied.code).toBe(HUB_EXIT.rejected);
        expect(denied.stderr).toContain("只有项目经理");
        expect(calls).toHaveLength(2);

        const usage = await hub(["self-reload", "now"], { env: pmEnv });
        expect(usage.code).toBe(HUB_EXIT.usage);
        expect(usage.stderr).toContain("self-reload [--build]");
        expect(HUB_USAGE).toContain("self-reload [--build]");
      } finally {
        await api2.close();
      }
    });
  });

  describe("hub dispatch (Router Track B dedicated CLI)", () => {
    it("routes all 7 dispatch subcommands to /v1/router.dispatch without touching stdin on --verbatim", async () => {
      const dispatches: Array<{ sessionId: number; commandId: number; payload: unknown }> = [];
      const { createRouterSandboxGuard } = await import("../daemon/router/sandbox.ts");
      const sandboxGuard = createRouterSandboxGuard();
      const runDir2 = join(dir, "run-r");
      const rSock = process.platform === "win32" ? resolveHubPaths({}, join(dir, "hr")).hubSock : join(runDir2, "hub.sock");
      const routerApi = await startAgentApi({
        ledger,
        tokens,
        runDir: runDir2,
        hubSock: rSock,
        sandboxGuard,
        onRouterDispatch: async (sessionId, commandId, payload) => {
          dispatches.push({ sessionId, commandId, payload });
          return { text: `已投递 ${payload.op}`, data: { op: payload.op } };
        },
      });
      try {
        const assistantSessionId = 901;
        ledger.sessionRoles.set(assistantSessionId, "assistant");
        sandboxGuard.bind(assistantSessionId, 77);
        const routerToken = tokens.issue(assistantSessionId);
        const routerEnv = { [ENV_HUB_TOKEN]: routerToken, [ENV_HUB_SOCK]: routerApi.socketPath, HOME: home };

        // 1. pm --verbatim (TrapStdin verifies stdin is NOT touched!)
        const r1 = await hub(["dispatch", "pm", "--device", "self", "--pm", "2", "--verbatim"], { env: routerEnv });
        expect(r1.code).toBe(HUB_EXIT.ok);
        expect(r1.stdout).toBe("已投递 pm\n");

        // 2. pm --stdin (multi-target split)
        const r2 = await hub(["dispatch", "pm", "--device", "dev-2", "--pm", "3", "--stdin"], {
          env: routerEnv,
          stdin: stdinOf("拆分后的第二项任务\n"),
        });
        expect(r2.code).toBe(HUB_EXIT.ok);

        // 3. worker-start --readonly --verbatim
        const r3 = await hub(
          [
            "dispatch",
            "worker-start",
            "--device",
            "self",
            "--project",
            "5",
            "--title",
            "排查泄漏",
            "--vendor",
            "claude",
            "--effort",
            "low",
            "--readonly",
            "--verbatim",
          ],
          { env: routerEnv },
        );
        expect(r3.code).toBe(HUB_EXIT.ok);

        // 4. worker-stop
        const r4 = await hub(["dispatch", "worker-stop", "--device", "self", "--worker", "9"], { env: routerEnv });
        expect(r4.code).toBe(HUB_EXIT.ok);

        // 5. worker-send --verbatim
        const r5 = await hub(["dispatch", "worker-send", "--device", "dev-2", "--worker", "11", "--verbatim"], { env: routerEnv });
        expect(r5.code).toBe(HUB_EXIT.ok);

        // 6. worker-end
        const r6 = await hub(["dispatch", "worker-end", "--device", "self", "--worker", "9"], { env: routerEnv });
        expect(r6.code).toBe(HUB_EXIT.ok);

        // 7. worker-list
        const r7 = await hub(["dispatch", "worker-list", "--device", "self", "--project", "5"], { env: routerEnv });
        expect(r7.code).toBe(HUB_EXIT.ok);

        // 8. project-create (remote preserves ~/..., self expands local path)
        const r8 = await hub(
          [
            "dispatch",
            "project-create",
            "--device",
            "dev-2",
            "--folder",
            "~/demo-app",
            "--name",
            "Demo",
            "--pm-name",
            "小张",
            "--vendor",
            "claude",
            "--mode",
            "hands_on",
          ],
          { env: routerEnv },
        );
        expect(r8.code).toBe(HUB_EXIT.ok);

        expect(dispatches).toEqual([
          { sessionId: 901, commandId: 77, payload: { op: "pm", device: "self", pmId: 2, verbatim: true } },
          { sessionId: 901, commandId: 77, payload: { op: "pm", device: "dev-2", pmId: 3, text: "拆分后的第二项任务" } },
          {
            sessionId: 901,
            commandId: 77,
            payload: {
              op: "worker-start",
              device: "self",
              projectId: 5,
              title: "排查泄漏",
              vendor: "claude",
              effort: "low",
              readonly: true,
              verbatim: true,
            },
          },
          { sessionId: 901, commandId: 77, payload: { op: "worker-stop", device: "self", workerId: 9 } },
          { sessionId: 901, commandId: 77, payload: { op: "worker-send", device: "dev-2", workerId: 11, verbatim: true } },
          { sessionId: 901, commandId: 77, payload: { op: "worker-end", device: "self", workerId: 9 } },
          { sessionId: 901, commandId: 77, payload: { op: "worker-list", device: "self", projectId: 5 } },
          {
            sessionId: 901,
            commandId: 77,
            payload: {
              op: "project-create",
              device: "dev-2",
              folder: "~/demo-app",
              name: "Demo",
              pmName: "小张",
              vendor: "claude",
              mode: "hands_on",
            },
          },
        ]);
      } finally {
        await routerApi.close();
      }
    });

    it("rejects --verbatim combined with --stdin or missing both on text-bearing dispatch subcommands", async () => {
      const both = await hub(["dispatch", "pm", "--device", "self", "--pm", "2", "--verbatim", "--stdin"], {
        stdin: stdinOf("x"),
      });
      expect(both.code).toBe(HUB_EXIT.usage);
      expect(both.stderr).toContain("--verbatim 和 --stdin 只能用一个");

      const neither = await hub(["dispatch", "pm", "--device", "self", "--pm", "2"]);
      expect(neither.code).toBe(HUB_EXIT.usage);
      expect(neither.stderr).toContain("--verbatim 或 --stdin");
    });
  });
});
