// 冒烟测试的共用零件：起守护进程（临时数据目录、真 claude）、发消息等回复、读库、读驱动层记下的 claude 原始输入输出、查进程。
// 各组场景（m1.ts、m2.ts、force-kill.ts）只写“做什么、期望什么”，起停和查东西都用这里的。
// - 数据放临时目录，跑完删掉（有场景失败时留着，方便看日志）；不碰 ~/.agent-hub。
// - 默认用小模型（AGENT_HUB_DEFAULT_MODEL，默认 claude-haiku-5-5），提示词都很短。
// - claude 的路径：AGENT_HUB_CLAUDE，默认 PATH 里的 claude。用户全局 ~/.claude 的设置照常生效。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV_DEFAULT_MODEL, type Message, type SessionState, type StateSnapshot } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { Client, agentTexts, makeEnv, messagesOf, sleep, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "../e2e/harness.ts";

export const MODEL = process.env[ENV_DEFAULT_MODEL] || "claude-haiku-5-5";
export const CLAUDE = process.env.AGENT_HUB_CLAUDE || "claude";
/** 真 claude 一轮最多等多久。 */
export const TURN_MS = 180_000;

export { sleep, waitUntil };

/** 一个起好的守护进程和它的临时数据目录。一个场景（或 S1～S4 那一串）用一个。 */
export class Smoke {
  readonly env: E2eEnv;
  daemon!: RunningDaemon;
  client!: Client;
  /** 一直用来推进的“界面”：第一次启动自动建的项目经理和它的私聊。 */
  privateId = 0;
  pmId = 0;

  private constructor(env: E2eEnv) {
    this.env = env;
  }

  /** 起守护进程、登录、拿到默认项目经理和它的私聊。 */
  static async boot(): Promise<Smoke> {
    const smoke = new Smoke(makeEnv());
    await smoke.start();
    const state = await smoke.client.state();
    smoke.privateId = state.conversations[0]!.conversation.id;
    smoke.pmId = state.pms[0]!.id;
    return smoke;
  }

  /** （重新）起守护进程，沿用同一个数据目录和 cookie。 */
  async start(): Promise<void> {
    this.daemon = await this.env.start({ claudePath: CLAUDE, env: { [ENV_DEFAULT_MODEL]: MODEL } });
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

  // ---- 驱动层记下的 claude 原始输入输出（state/logs/sessions/<会话>.jsonl）----

  /** 一个会话的日志，每行一个 JSON；坏行跳过。 */
  sessionLog(sessionId: number): Array<Record<string, any>> {
    const file = join(this.env.home, "state", "logs", "sessions", `${sessionId}.jsonl`);
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

export type { StateSnapshot };
