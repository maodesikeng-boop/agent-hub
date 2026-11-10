// 冒烟测试的共用零件：起守护进程（临时数据目录、真 claude）、发消息等回复、读库、读驱动层记下的 claude 原始输入输出、查进程。
// 各组场景（m1.ts、m2.ts、force-kill.ts）只写“做什么、期望什么”，起停和查东西都用这里的。
// - 数据放临时目录，跑完删掉（有场景失败时留着，方便看日志）；不碰 ~/.agent-hub。
// - 不往用户的 ~/.claude/projects/ 里留东西：起 claude 走一个转发脚本（writeClaudeWrapper），需要 --resume 的场景保留会话记录，
//   其余场景加 --no-session-persistence；收尾（finish）时删掉这次数据目录对应的 ~/.claude/projects/<目录名>/，只删自己这次产生的。
//   原来驱动层写的 state/logs/sessions/ 没有了：转发脚本把 claude 的 stdout 另存一份在 <数据目录>/streams/，场景从那里读。
// - 默认用小模型（AGENT_HUB_DEFAULT_MODEL，默认 claude-haiku-5-5），提示词都很短。
// - claude 的路径：claude spec 的 cli.envVar（AGENT_HUB_CLAUDE），默认 PATH 里的 claude。用户全局 ~/.claude 的设置照常生效。
// - 只连自己起的测试后台：启动时清掉外部继承的 HUB_TOKEN / HUB_SOCK（clean-env.ts），在项目经理的会话里跑也不会连到真正在用的后台；
//   不起整个守护进程、直接用驱动层的场景，要 Worker 能跑 hub 的用 startTestHub。
import "../clean-env.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import claudeSpec from "../../src/vendors/claude/spec.ts";
import { claudeProjectDirName } from "../../src/vendors/claude/transcript.ts";
import { ENV_DEFAULT_MODEL, ENV_HUB_SOCK, ENV_HUB_TOKEN, type Message, type SessionId, type SessionState, type StateSnapshot } from "../../src/shared/index.ts";
import { createSessionTokens, installHubShim, startAgentApi } from "../../src/daemon/agent-api/index.ts";
import { vendorSessionFiles } from "../../src/daemon/driver/transcript.ts";
import { createLedger, type SqliteLedger } from "../../src/daemon/ledger/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { openTestDb } from "../../src/daemon/store/test-helpers.ts";
import { Client, agentTexts, makeEnv, messagesOf, shortTmp, sleep, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "../e2e/harness.ts";

export const MODEL = process.env[ENV_DEFAULT_MODEL] || "claude-haiku-5-5";
export const CLAUDE = process.env[claudeSpec.cli.envVar] || claudeSpec.cli.command;
/** 真 claude 一轮最多等多久。 */
export const TURN_MS = 180_000;

export { sleep, waitUntil };

/** 转发脚本记下的 claude 输出放在 <数据目录>/streams/，文件名是会话 ID 的哈希（不让会话 ID 出现在 tee 的命令行里，查进程时认不错）。 */
const STREAMS_DIR = "streams";
const streamFileName = (vendorSessionId: string): string => `${createHash("sha1").update(vendorSessionId).digest("hex").slice(0, 16)}.jsonl`;

/**
 * 冒烟用的 claude 转发脚本（exec，进程号不变）：
 * - 带 --session-id / --resume 的（驱动层起的会话进程）：stdout 另存一份到 <dir>/streams/（场景要看原始事件：init、result、权限拒绝……）；
 * - persist 为 false：加 --no-session-persistence，claude 不在 ~/.claude/projects/ 存会话记录（只有 -p 能用；不能 --resume）。
 * 返回脚本路径。
 */
export function writeClaudeWrapper(dir: string, options: { claude: string; persist: boolean }): string {
  const streams = join(dir, STREAMS_DIR);
  mkdirSync(streams, { recursive: true });
  const script = join(dir, "claude-smoke.sh");
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    script,
    `#!/bin/bash
real=${quote(options.claude)}
streams=${quote(streams)}
id=
prev=
for a in "$@"; do
  case "$prev" in --session-id|--resume) id="$a";; esac
  prev="$a"
done
flag=(${options.persist ? "" : "--no-session-persistence"})
if [ -z "$id" ]; then exec "$real" "\${flag[@]}" "$@"; fi
key=$(printf %s "$id" | shasum | cut -c1-16)
exec "$real" "\${flag[@]}" "$@" > >(tee -a "$streams/$key.jsonl")
`,
  );
  chmodSync(script, 0o755);
  return script;
}

/**
 * 删掉各家为这次数据目录里的会话留在用户目录里的原始记录（有的厂商起会话时没法不存）：只删账本里这次的会话 ID 对应的，
 * 删哪些由各家 daemon.ts 的 sessionFiles 说（src/daemon/driver/transcript.ts 的 vendorSessionFiles，没写的厂商不删）。
 * 厂商自己的索引（如 codex 的 state_5.sqlite、history）里的行删不掉，也不动。返回删掉的路径。
 */
export function removeOwnVendorRecords(dbFile: string, home = homedir()): string[] {
  const db = openDatabase(dbFile);
  try {
    return removeVendorRecordsOf(db.all("SELECT vendor, vendor_session_id, cwd FROM agent_sessions"), home);
  } finally {
    db.close();
  }
}

/** 同上，会话的索引直接给（没有账本的冒烟，比如直接用驱动层的）。 */
export function removeVendorRecordsOf(rows: { vendor: string; vendor_session_id: string; cwd: string }[], home = homedir()): string[] {
  const removed: string[] = [];
  const drop = (path: string) => {
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  };
  for (const row of rows) {
    for (const path of vendorSessionFiles({ vendor: row.vendor, vendorSessionId: row.vendor_session_id, cwd: row.cwd }, { home })) drop(path);
  }
  return removed;
}

/** 不起守护进程的场景用的测试后台：临时数据目录里的真账本 + agent 接口（run/hub.sock）+ hub 外壳，派好一个 Worker。 */
export interface TestHub {
  /** 数据目录（realpath 过）：Worker 的可写范围按它算，worktrees/ 在它下面。 */
  dataDir: string;
  ledger: SqliteLedger;
  /** 让 Worker 连这个测试后台的环境变量：它的 HUB_TOKEN、HUB_SOCK，PATH 最前面是这里的 hub 外壳。盖在驱动层继承的环境变量之上。 */
  workerEnv: Record<string, string>;
  close(): Promise<void>;
}

/**
 * 起一个测试后台（docs 见本文件开头）：Worker 在里面跑 hub status 看到的是这里派的 Worker，不会连到真正在用的后台；
 * 干净的终端里没有 HUB_TOKEN 也能跑。close 停掉 agent 接口、删掉数据目录和项目文件夹（项目文件夹不能放数据目录里，后台会拒绝）。
 */
export async function startTestHub(): Promise<TestHub> {
  const dataDir = realpathSync.native(mkdtempSync(join(shortTmp(), "ah-hub-")));
  const folder = realpathSync.native(mkdtempSync(join(shortTmp(), "ah-project-")));
  const db = openTestDb();
  const ledger = createLedger(db, { pmHomeRoot: join(dataDir, "pm-home"), dataHome: dataDir, worktreesDir: join(dataDir, "worktrees") });
  const pm = ledger.createPm({ name: "冒烟", mode: "hands_on", persona: "", defaultModel: null });
  ledger.hubCall(pm.sessionId, "project.create", { folder });
  const worker = ledger.hubCall(pm.sessionId, "worker.start", { title: "冒烟", task: "冒烟测试用的 Worker", noWorktree: true }).data.worker;
  const sessionId = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id as SessionId;
  const tokens = createSessionTokens();
  const runDir = join(dataDir, "run");
  const api = await startAgentApi({ ledger, tokens, runDir, hubSock: join(runDir, "hub.sock") });
  const binDir = join(runDir, "bin");
  installHubShim({ binDir });
  return {
    dataDir,
    ledger,
    workerEnv: { [ENV_HUB_TOKEN]: tokens.issue(sessionId), [ENV_HUB_SOCK]: api.socketPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    async close() {
      await api.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/**
 * 删掉 claude 为这个临时目录（和它下面的目录）在 ~/.claude/projects/ 里建的 <目录名>/：会话记录、自动记忆。
 * 只认这个临时目录本身的名字（带 -ah-e2e-/ah-mv-/ah-smoke- 这种随机后缀的 mkdtemp 目录），别的项目的目录一个都不碰。
 */
export function removeOwnClaudeProjects(dir: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  if (!/^ah-[a-z0-9]+-/.test(basename(dir))) return [];
  const projects = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const names = new Set([claudeProjectDirName(dir)]);
  try {
    names.add(claudeProjectDirName(realpathSync.native(dir)));
  } catch {
    // 目录已经没了
  }
  if (!existsSync(projects)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(projects)) {
    if (![...names].some((n) => entry === n || entry.startsWith(`${n}-`))) continue;
    rmSync(join(projects, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

/** 一个起好的守护进程和它的临时数据目录。一个场景（或 S1～S4 那一串）用一个。 */
export class Smoke {
  readonly env: E2eEnv;
  daemon!: RunningDaemon;
  client!: Client;
  /** 一直用来推进的“界面”：第一次启动自动建的项目经理和它的私聊。 */
  privateId = 0;
  pmId = 0;
  /** 起 claude 用的转发脚本（见 writeClaudeWrapper）。 */
  private readonly claudePath: string;

  private constructor(env: E2eEnv, persist: boolean) {
    this.env = env;
    this.claudePath = writeClaudeWrapper(env.dir, { claude: CLAUDE, persist });
  }

  /**
   * 起守护进程、登录、拿到默认项目经理和它的私聊。
   * persist：场景里会 --resume（重启守护进程、换设置重启 claude 进程……）的要写 true，claude 才存会话记录（收尾时删）；
   * 默认 false（加 --no-session-persistence）。拿不准就写 true：多存一份、收尾删掉，比 --resume 失败好。
   */
  static async boot(options: { persist?: boolean } = {}): Promise<Smoke> {
    const smoke = new Smoke(makeEnv(), options.persist ?? false);
    await smoke.start();
    const state = await smoke.client.state();
    smoke.privateId = state.conversations[0]!.conversation.id;
    smoke.pmId = state.pms[0]!.id;
    return smoke;
  }

  /** （重新）起守护进程，沿用同一个数据目录和 cookie。 */
  async start(): Promise<void> {
    this.daemon = await this.env.start({ vendorPath: this.claudePath, env: { [ENV_DEFAULT_MODEL]: MODEL } });
    this.client = this.client ? this.client.withPort(this.daemon.port) : await Client.login(this.daemon);
  }

  /** SIGTERM 关守护进程，等它退出。 */
  async terminate(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.daemon.child.kill("SIGTERM");
    return this.daemon.exited;
  }

  /**
   * 收尾：关守护进程（退出码要是 0）、查有没有 claude 残留，然后删数据目录（keep 为真就留着）。
   * 返回发现的问题，空数组就是干净。
   */
  async finish(keep: boolean): Promise<string[]> {
    const problems: string[] = [];
    const vendorIds = this.vendorSessionIds();
    if (this.daemon.child.exitCode === null && this.daemon.child.signalCode === null) {
      const exit = await this.terminate();
      if (exit.code !== 0) problems.push(`关机退出码 ${exit.code}`);
    }
    const left = vendorIds.flatMap((id) => this.processesOf(id));
    if (left.length > 0) problems.push(`关机后还有 ${left.length} 个 claude 进程没退出：${left.join(" | ")}`);
    removeOwnClaudeProjects(this.env.dir);
    if (keep) console.log(`  数据目录留着：${this.env.dir}`);
    else await this.env.cleanup();
    return problems;
  }

  // ---- 发消息、等回复 ----

  /** 发一条消息，等它变成“已回复”，返回这条之后 agent 说的文字（可能不止一条）。 */
  async ask(conversationId: number, text: string, timeoutMs = TURN_MS): Promise<{ messageId: number; replies: string[] }> {
    const messageId = await this.client.post(conversationId, text);
    await waitForStatus(this.client, messageId, "replied", timeoutMs);
    return { messageId, replies: await this.repliesAfter(conversationId, messageId) };
  }

  async repliesAfter(conversationId: number, messageId: number): Promise<string[]> {
    const state = await this.client.state();
    return messagesOf(state, conversationId)
      .filter((m: Message) => m.id > messageId && m.sender === "agent" && m.kind === "text")
      .map((m) => m.text);
  }

  /** 等这条消息之后出现 agent 的工具调用（摘要里带 includes），返回它。 */
  async waitForTool(conversationId: number, afterId: number, includes: string, timeoutMs = TURN_MS): Promise<Message> {
    return waitUntil(
      `tool call with ${includes}`,
      async () =>
        messagesOf(await this.client.state(), conversationId).find(
          (m: Message) => m.id > afterId && m.sender === "agent" && m.kind === "tool" && m.text.includes(includes),
        ),
      timeoutMs,
    );
  }

  async lastReply(conversationId: number): Promise<string> {
    return agentTexts(await this.client.state(), conversationId).at(-1) ?? "";
  }

  /** 这个对话的当前会话（generation 最大的）。 */
  async currentSession(conversationId: number): Promise<SessionState> {
    const sessions = (await this.client.state()).sessions.filter((s) => s.conversationId === conversationId);
    if (sessions.length === 0) throw new Error(`对话 ${conversationId} 没有会话`);
    return sessions.reduce((a, b) => (b.generation > a.generation ? b : a));
  }

  /** 建一个文件夹（临时目录下），里面放几个文件。返回真实路径（macOS 上 /var 是 /private/var 的软链接）。 */
  folder(name: string, files: Record<string, string> = {}): string {
    const dir = join(this.env.dir, "code", name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    return realpathSync.native(dir);
  }

  // ---- 读库（只读，用完就关，守护进程开着也行）----

  query<T>(sql: string, ...params: Array<string | number | null>): T[] {
    const db = openDatabase(join(this.env.home, "state", "hub.sqlite"));
    try {
      return db.all<T>(sql, ...params);
    } finally {
      db.close();
    }
  }

  /** 会话那一行：进程号、Claude 的会话 ID（vendor）、属于哪个项目经理。 */
  sessionRow(id?: number): { id: number; pid: number | null; vendorSessionId: string; pmId: number | null; conversationId: number | null } {
    const rows = this.query<{ id: number; pid: number | null; vendor_session_id: string; pm_id: number | null; conversation_id: number | null }>(
      id === undefined ? "SELECT * FROM agent_sessions ORDER BY id LIMIT 1" : "SELECT * FROM agent_sessions WHERE id = ?",
      ...(id === undefined ? [] : [id]),
    );
    const row = rows[0];
    if (!row) throw new Error("agent_sessions 里没有这一行");
    return { id: row.id, pid: row.pid, vendorSessionId: row.vendor_session_id, pmId: row.pm_id, conversationId: row.conversation_id };
  }

  vendorSessionIds(): string[] {
    try {
      return this.query<{ vendor_session_id: string }>("SELECT vendor_session_id FROM agent_sessions").map((r) => r.vendor_session_id);
    } catch {
      return []; // 库还没建出来
    }
  }

  // ---- claude 的原始输出（转发脚本另存的 <数据目录>/streams/，一个 Claude 会话 ID 一个文件）----

  /** 一个会话的 claude 输出，每行一个 JSON；坏行跳过。 */
  sessionLog(sessionId: number): Array<Record<string, any>> {
    const file = join(this.env.dir, STREAMS_DIR, streamFileName(this.sessionRow(sessionId).vendorSessionId));
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, any>];
        } catch {
          return [];
        }
      });
  }

  /**
   * 我们写给 claude 的用户消息（--replay-user-messages 回显的那些）的文字：几个 text 块之间空一行连起来
   * （我们加的字各占一块，原文放最后一块）。被当命令展开的消息没有回显，不在这里。
   */
  writtenTexts(sessionId: number): string[] {
    return this.sessionLog(sessionId)
      .filter((e) => e.isReplay === true)
      .map((e) => {
        const content = e.message?.content;
        return Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("\n\n") : String(content ?? "");
      });
  }

  /** agent 在 Bash 工具里敲过的命令，按先后。 */
  bashCommands(sessionId: number): string[] {
    return this.sessionLog(sessionId).flatMap((e) =>
      e.type === "assistant" && Array.isArray(e.message?.content)
        ? e.message.content.flatMap((c: any) => (c.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string" ? [c.input.command as string] : []))
        : [],
    );
  }

  /** claude 报的“被权限拦了”的调用（result 事件里的 permission_denials）：工具名 + 参数。 */
  permissionDenials(sessionId: number): string[] {
    return this.sessionLog(sessionId).flatMap((e) =>
      e.type === "result" && Array.isArray(e.permission_denials) ? e.permission_denials.map((d: any) => `${d.tool_name}: ${JSON.stringify(d.tool_input)}`) : [],
    );
  }

  // ---- 进程 ----

  /** 命令行里带这个 Claude 会话 ID 的进程（ps 的 pid 和命令）。 */
  processesOf(vendorSessionId: string): string[] {
    return psLines().filter((l) => l.includes(vendorSessionId));
  }

  /** 当前会话的 claude 命令行（看 --add-dir、--resume 这些参数）。 */
  claudeCommandLine(vendorSessionId: string): string {
    return this.processesOf(vendorSessionId).find((l) => /\bclaude\b|--input-format/.test(l)) ?? "";
  }
}

export function psLines(): string[] {
  return execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** 进程号 → { 父进程, 进程组 }，用来看孙进程在不在 claude 的进程组里。 */
export function processTable(): Map<number, { ppid: number; pgid: number; command: string }> {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  const table = new Map<number, { ppid: number; pgid: number; command: string }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return table;
}

export type Outcome = { name: string; ok: boolean; detail: string };

/** 跑一个场景：打印名字、计时、记结果。fn 返回一句话说明“看到了什么”，抛错就是失败。 */
export async function scenario(outcomes: Outcome[], name: string, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  process.stdout.write(`${name} … `);
  try {
    const detail = await fn();
    outcomes.push({ name, ok: true, detail });
    console.log(`通过（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${detail}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcomes.push({ name, ok: false, detail });
    console.log(`失败：${detail}`);
    return false;
  }
}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** 文字里有没有 Markdown 列表（至少两行以“- ”“* ”“• ”或“1. ”开头）。 */
export function looksLikeList(text: string): boolean {
  return text.split("\n").filter((l) => /^\s*([-*•]|\d+[.、)])\s+\S/.test(l)).length >= 2;
}
