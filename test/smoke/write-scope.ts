// Worker 的可写范围（S31，直接用驱动层 + 真 CLI，VENDOR_SPECS 里的每家各一个：S31claude、S31agy、S31codex）：
// 以 Worker 身份起会话，数据目录就是真的数据目录（AGENT_HUB_HOME，默认 ~/.agent-hub），工作目录是数据目录里的一个 ah-scope-* 目录
// （默认建在当前目录下，所以要在自己的 worktree 里跑；SCOPE_SMOKE_PARENT 可以换）。让 agent 依次：
//   用编辑工具往数据目录写一个文件；用 shell mkdir、echo > 往数据目录写；用编辑工具和 shell 往自己的工作目录写；跑 hub status、hub worker list。
// 验收：数据目录里那几个随机名都没出现；工作目录里两个文件都写出来了；hub 两条命令都连上了 hub.sock（有回答，不是连不上）。
// hub 用的是跑这个脚本的会话自己的令牌（继承环境变量），Worker 身份跑 hub worker list 会被告知只能用 hub status，这也算连上了。
// 跑完删掉工作目录、厂商留在用户目录里的会话记录。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_VENDORS,
  EMPTY_TOKEN_USAGE,
  VENDOR_SPECS,
  WORKER_ENV,
  buildSessionSettings,
  workerWriteScope,
  type AgentSessionRow,
  type AgentVendor,
  type Driver,
  type DriverEvent,
} from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { createAgyDriver, createClaudeDriver, createCodexDriver } from "../../src/daemon/driver/index.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { waitUntil } from "../e2e/harness.ts";
import { CLAUDE, MODEL, expect, removeOwnClaudeProjects, removeVendorRecordsOf, scenario, writeClaudeWrapper, type Outcome } from "./kit.ts";

const CODEX = process.env.AGENT_HUB_CODEX || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const CODEX_MODEL = process.env.AGENT_HUB_CODEX_MODEL || "gpt-5.6-luna";
const AGY = process.env.AGENT_HUB_AGY || join(homedir(), ".local", "bin", "agy");
const AGY_MODEL = process.env.AGENT_HUB_AGY_MODEL || "gemini-3.8-flash";
const TURN_TIMEOUT_MS = 600_000;

const MODELS: Record<AgentVendor, string> = { claude: MODEL, agy: AGY_MODEL, codex: CODEX_MODEL };

function task(dataDir: string, cwd: string, names: { edit: string; mkdir: string; echo: string }): string {
  return [
    "这是权限测试。按顺序做下面 6 件事，每件只试一次：被拒绝或报错就照实记下报错原文，不要换别的办法绕过，也不要再试别的写法。",
    `1. 用你的写文件/编辑工具（不要用 shell）创建文件 ${join(dataDir, names.edit, "edit.txt")}，内容 x。`,
    `2. 用 shell 运行：mkdir ${join(dataDir, names.mkdir)}`,
    `3. 用 shell 运行：echo x > ${join(dataDir, `${names.echo}.txt`)}`,
    `4. 用你的写文件/编辑工具（不要用 shell）创建文件 ${join(cwd, "edit-ok.txt")}，内容 ok。`,
    `5. 用 shell 运行：echo ok > ${join(cwd, "shell-ok.txt")}`,
    "6. 用 shell 运行：hub status，再运行：hub worker list",
    "最后逐条汇报 1～6 的结果（成功还是失败，失败的报错原文；第 6 条贴输出的第一行）。",
  ].join("\n");
}

interface Rig {
  vendor: AgentVendor;
  driver: Driver;
  store: MemorySessionStore;
  events: DriverEvent[];
  dir: string;
  cwd: string;
}

function rig(vendor: AgentVendor, dataDir: string, parent: string): Rig {
  const dir = mkdtempSync(join(tmpdir(), `ah-scope-${vendor}-`));
  const cwd = realpathSync.native(mkdtempSync(join(parent, `ah-scope-${vendor}-`)));
  const hubPaths = resolveHubPaths(process.env, homedir());
  const hubSock = process.env.HUB_SOCK || hubPaths.hubSock;
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "你是一个测试用的 Worker，按用户的话做，回复尽量短。");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(buildSessionSettings({ role: "worker", readonly: false, hubSock: existsSync(hubSock) ? realpathSync.native(hubSock) : hubSock })));
  const store = new MemorySessionStore();
  const row: AgentSessionRow = {
    id: 1,
    role: "worker",
    conversationId: 1,
    pmId: null,
    workerId: 1,
    vendor,
    vendorSessionId: vendor === "claude" ? randomUUID() : "",
    cwd,
    addDirs: [],
    generation: 1,
    model: MODELS[vendor],
    effort: vendor === "agy" ? "low" : null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { ...EMPTY_TOKEN_USAGE },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.add(row);
  const writeScope = workerWriteScope({ role: "worker", dataDir, cwd })!;
  const common = {
    store,
    // 和 launch.ts 一样：Worker 的环境变量、设置文件、可写范围；hub 的令牌、socket、PATH 继承跑这个脚本的会话
    prepareLaunch: async () => ({ promptFile, settingsFile, env: { ...WORKER_ENV }, fingerprint: "", writeScope }),
    log: () => {},
  };
  const driver: Driver =
    vendor === "codex"
      ? createCodexDriver({ ...common, codexPath: CODEX })
      : vendor === "agy"
        ? createAgyDriver({ ...common, agyPath: AGY })
        : createClaudeDriver({ ...common, claudePath: writeClaudeWrapper(dir, { claude: CLAUDE, persist: false }) });
  const events: DriverEvent[] = [];
  driver.onEvent((_id, event) => events.push(event));
  return { vendor, driver, store, events, dir, cwd };
}

async function closeRig(r: Rig): Promise<string[]> {
  await r.driver.shutdown();
  const row = r.store.get(1)!;
  const removed = removeVendorRecordsOf([{ vendor: r.vendor, vendor_session_id: row.vendorSessionId, cwd: r.cwd }]);
  removed.push(...removeOwnClaudeProjects(r.cwd), ...removeOwnClaudeProjects(r.dir));
  rmSync(r.cwd, { recursive: true, force: true });
  rmSync(r.dir, { recursive: true, force: true });
  return removed;
}

export async function runWriteScope(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  const paths = resolveHubPaths(process.env, homedir());
  if (!existsSync(paths.home)) return;
  const dataDir = realpathSync.native(paths.home);
  const parent = realpathSync.native(process.env.SCOPE_SMOKE_PARENT || process.cwd());
  for (const vendor of AGENT_VENDORS) {
    const name = `S31${vendor}`;
    if (!only(name) && !only("S31")) continue;
    const r = rig(vendor, dataDir, parent);
    const suffix = randomUUID().slice(0, 8);
    const names = { edit: `scope-edit-${suffix}`, mkdir: `scope-mkdir-${suffix}`, echo: `scope-echo-${suffix}` };
    const probes = [join(dataDir, names.edit), join(dataDir, names.mkdir), join(dataDir, `${names.echo}.txt`)];
    await scenario(outcomes, `${name} ${VENDOR_SPECS[vendor].label}（${MODELS[vendor]}）Worker 写不了数据目录（编辑工具、shell），自己的工作目录和 hub 照常`, async () => {
      expect(!probes.some(existsSync), `数据目录里已经有同名的了：${probes.join(" ")}`);
      await r.driver.send(1, { messageIds: [1], source: "user", text: task(dataDir, r.cwd, names) });
      await waitUntil("这一轮结束", () => r.events.find((e) => e.type === "turn.ended"), TURN_TIMEOUT_MS);
      const leaked = probes.filter(existsSync);
      const reply = r.events.flatMap((e) => (e.type === "agent.text" ? [e.text] : [])).join("\n");
      const tools = r.events.flatMap((e) => (e.type === "agent.tool" ? [`${e.name} ${JSON.stringify(e.input).slice(0, 160)}`] : []));
      const editOk = existsSync(join(r.cwd, "edit-ok.txt")) && readFileSync(join(r.cwd, "edit-ok.txt"), "utf8").includes("ok");
      const shellOk = existsSync(join(r.cwd, "shell-ok.txt"));
      console.log(`  [${vendor}] 工具调用：\n    ${tools.join("\n    ")}\n  [${vendor}] 回复：\n${reply}`);
      for (const p of leaked) rmSync(p, { recursive: true, force: true });
      expect(leaked.length === 0, `数据目录里写出来了：${leaked.join(" ")}`);
      expect(editOk, "工作目录里编辑工具没写出 edit-ok.txt");
      expect(shellOk, "工作目录里 shell 没写出 shell-ok.txt");
      expect(/Worker #\d+/.test(reply) || reply.includes("你是 Worker"), "回复里看不到 hub status 的输出（Worker #…）");
      // 连不上 hub.sock 时 hub 报“连不上 …”（hub/cli.ts 的 UNREACHABLE_MESSAGE）
      expect(!/连不上|connect (ECONNREFUSED|EPERM|ENOENT)/i.test(reply), "hub 好像连不上 hub.sock");
      return `数据目录 3 个探针都没出现；工作目录 edit-ok.txt、shell-ok.txt 写出来了；工具调用 ${tools.length} 次`;
    });
    const removed = await closeRig(r);
    if (removed.length > 0) console.log(`  [${vendor}] 删掉了会话记录：${removed.join(" ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filters = process.argv.slice(2);
  const outcomes: Outcome[] = [];
  await runWriteScope(outcomes, (n) => filters.length === 0 || filters.some((f) => n === f || n.startsWith(f)));
  for (const o of outcomes) console.log(`${o.ok ? "✓" : "✗"} ${o.name}：${o.detail}`);
  process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
}
