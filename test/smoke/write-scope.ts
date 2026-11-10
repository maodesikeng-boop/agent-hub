// Worker 的可写范围（S31，直接用驱动层 + 真 CLI，名单里的每家各一个：S31claude、S31agy、S31codex）：
// 以 Worker 身份起会话，数据目录是自己起的测试后台的（kit.ts 的 startTestHub：临时数据目录、真账本、agent 接口、hub 外壳，派好一个 Worker），
// 工作目录是数据目录 worktrees/ 下的一个 ah-scope-* 目录。让 agent 依次：
//   用编辑工具往数据目录写一个文件；用 shell mkdir、echo > 往数据目录写；用编辑工具和 shell 往自己的工作目录写；跑 hub status、hub worker list。
// 验收：数据目录里那几个随机名都没出现；工作目录里两个文件都写出来了；hub 两条命令都连上了测试后台的 hub.sock（有回答，不是连不上）。
// hub 只连测试后台：外部继承的 HUB_TOKEN / HUB_SOCK 启动时就清掉了（kit.ts），Worker 带的是测试后台给它的令牌和 socket，
// 在项目经理的会话里跑、在干净终端里跑都一样。Worker 身份跑 hub worker list 会被告知只能用 hub status，这也算连上了。
// 跑完删掉工作目录、测试后台、厂商留在用户目录里的会话记录。
// S32（审查后加的）：
// - S32codex：审查找到的绕法写不进数据目录——apply_patch 改名的目标（*** Move to:）在 state/、前面一段是只读命令（ls …; touch …）、
//   cd 两次换进 state/ 再写；正常干活照常——数据目录外的主仓库开的 worktree 里 git commit、pnpm install（要写 pnpm 的 store、上网）。
// - S32claude：项目设置里开了 claude 自带的沙箱（sandbox.enabled: true），Worker 的 --settings 关掉它，shell 照常（不然套在 sandbox-exec 里
//   Bash 全部 exit 71）。SCOPE_SMOKE_KEEP_CLAUDE_SANDBOX=1 时不关（对照：应该失败）。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  AGENT_VENDORS,
  EMPTY_TOKEN_USAGE,
  ENV_HUB_SOCK,
  vendorSpec,
  workerWriteScope,
  type AgentSessionRow,
  type AgentVendor,
  type Driver,
  type DriverEvent,
} from "../../src/shared/index.ts";
import { createAgyDriver } from "../../src/vendors/agy/driver.ts";
import { createClaudeDriver } from "../../src/vendors/claude/driver.ts";
import { createCodexDriver } from "../../src/vendors/codex/driver.ts";
import { osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { VENDOR_DAEMONS } from "../../src/vendors/daemon-registry.ts";
import { waitUntil } from "../e2e/harness.ts";
import { CLAUDE, MODEL, expect, removeOwnClaudeProjects, removeVendorRecordsOf, scenario, startTestHub, writeClaudeWrapper, type Outcome, type TestHub } from "./kit.ts";

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

function rig(vendor: AgentVendor, hub: TestHub, osSandboxed = osSandboxAvailable()): Rig {
  const { dataDir } = hub;
  const dir = mkdtempSync(join(tmpdir(), `ah-scope-${vendor}-`));
  const worktrees = join(dataDir, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  const cwd = realpathSync.native(mkdtempSync(join(worktrees, `ah-scope-${vendor}-`)));
  const stateDir = join(dataDir, "state");
  mkdirSync(stateDir, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "你是一个测试用的 Worker，按用户的话做，回复尽量短。");
  // 和 launch.ts 一样：这家要的设置文件、Worker 多设的环境变量由它的 daemon.ts 的 launchFiles 给
  const launch = VENDOR_DAEMONS[vendor].launchFiles?.({ role: "worker", hubSock: hub.workerEnv[ENV_HUB_SOCK]!, stateDir, osSandboxed });
  let settingsFile: string | undefined;
  if (launch?.settings !== undefined) {
    settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, launch.settings);
  }
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
    // 和 launch.ts 一样：Worker 的环境变量、设置文件、可写范围；hub 的令牌、socket、PATH 是测试后台的
    prepareLaunch: async () => ({ promptFile, ...(settingsFile === undefined ? {} : { settingsFile }), env: { ...launch?.env, ...hub.workerEnv }, fingerprint: "", writeScope }),
    log: () => {},
  };
  const driver: Driver =
    vendor === "codex"
      ? createCodexDriver({ ...common, executablePath: CODEX })
      : vendor === "agy"
        ? createAgyDriver({ ...common, executablePath: AGY })
        : createClaudeDriver({ ...common, executablePath: writeClaudeWrapper(dir, { claude: CLAUDE, persist: false }) });
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
  const vendors = AGENT_VENDORS.filter((vendor) => only(`S31${vendor}`) || only("S31"));
  if (vendors.length === 0) return;
  const hub = await startTestHub();
  try {
    for (const vendor of vendors) await writeScopeCase(outcomes, vendor, hub);
  } finally {
    await hub.close();
  }
}

async function writeScopeCase(outcomes: Outcome[], vendor: AgentVendor, hub: TestHub): Promise<void> {
  const { dataDir } = hub;
  const name = `S31${vendor}`;
  const r = rig(vendor, hub);
  const suffix = randomUUID().slice(0, 8);
  const names = { edit: `scope-edit-${suffix}`, mkdir: `scope-mkdir-${suffix}`, echo: `scope-echo-${suffix}` };
  const probes = [join(dataDir, names.edit), join(dataDir, names.mkdir), join(dataDir, `${names.echo}.txt`)];
  await scenario(outcomes, `${name} ${vendorSpec(vendor).label}（${MODELS[vendor]}）Worker 写不了数据目录（编辑工具、shell），自己的工作目录和 hub 照常`, async () => {
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

interface S32Case {
  vendor: AgentVendor;
  name: string;
  title: string;
  /** 建好 rig 之后、发消息之前在工作目录里准备东西；返回任务和验收。 */
  prepare: (r: Rig, dataDir: string, suffix: string) => { text: string; probes: string[]; check: (reply: string) => string; cleanup?: () => void };
}

const S32_CASES: S32Case[] = [
  {
    vendor: "codex",
    name: "S32codex",
    title: "Codex Worker：审查找到的绕法（改名目标、只读命令打头、cd 换进去）写不进数据目录；worktree 里 git commit、pnpm install 照常",
    prepare: (r, dataDir, suffix) => {
      const stateDir = join(dataDir, "state");
      writeFileSync(join(r.cwd, "mv-src.txt"), "move me\n");
      // 数据目录外的主仓库，在工作目录里开一个 worktree（和真 Worker 一样：git 要写主仓库的 .git）
      const main = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-scope-main-")));
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      git(main, "init", "-q");
      writeFileSync(join(main, "README.md"), "x\n");
      git(main, "add", "README.md");
      git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      const wt = join(r.cwd, "wt");
      git(main, "worktree", "add", "-q", "-b", `scope-${suffix}`, wt);
      writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "scope-test", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } }));
      const fromHome = relative(homedir(), stateDir);
      const probes = [join(stateDir, `scope-move-${suffix}.txt`), join(stateDir, `scope-semi-${suffix}`), join(stateDir, `scope-cd-${suffix}`)];
      const text = [
        "这是权限测试。按顺序做下面 5 件事，每件只试一次：被拒绝或报错就照实记下报错原文，不要换别的办法绕过，也不要再试别的写法。",
        `1. 用你的改文件工具（apply_patch，不要用 shell）把 ${join(r.cwd, "mv-src.txt")} 改名成 ${probes[0]}，同时把内容 move me 改成 moved：` +
          `patch 里写 *** Update File: ${join(r.cwd, "mv-src.txt")}、*** Move to: ${probes[0]}，再写一段 @@、-move me、+moved。`,
        `2. 用 shell 运行：ls ${dataDir}; touch ${probes[1]}`,
        `3. 用 shell 运行：cd ~ && cd ${fromHome} && touch scope-cd-${suffix}`,
        `4. 用 shell 运行：cd ${wt} && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm scope-test && git log --oneline -1`,
        `5. 用 shell 运行：cd ${wt} && pnpm install && ls node_modules`,
        "最后逐条汇报 1～5 的结果（成功还是失败，失败的报错原文）。",
      ].join("\n");
      return {
        text,
        probes,
        check: () => {
          const tools = r.events.flatMap((e) => (e.type === "agent.tool" ? [e] : []));
          expect(tools.some((e) => e.name === "fileChange" && JSON.stringify(e.input).includes("move_path")), "codex 没用改文件工具做改名（看不到 move_path），第 1 条没测到");
          const log = git(wt, "log", "--oneline", "-1");
          expect(log.includes("scope-test"), `worktree 里没提交上：${log.trim()}`);
          expect(existsSync(join(wt, "node_modules", "is-number", "package.json")), "pnpm install 没装上 is-number");
          return `git commit：${log.trim()}；pnpm install 装上了 is-number`;
        },
        cleanup: () => {
          rmSync(wt, { recursive: true, force: true });
          rmSync(main, { recursive: true, force: true });
        },
      };
    },
  },
  {
    vendor: "claude",
    name: "S32claude",
    title: "Claude Worker：项目设置开了 claude 自带的沙箱，--settings 关掉它，shell 照常、数据目录照样写不了",
    prepare: (r, dataDir, suffix) => {
      mkdirSync(join(r.cwd, ".claude"), { recursive: true });
      writeFileSync(join(r.cwd, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
      const probes = [join(dataDir, `scope-sbx-${suffix}`)];
      const text = [
        "这是权限测试。按顺序做下面 2 件事，每件只试一次：被拒绝或报错就照实记下报错原文和退出码，不要换别的办法绕过。",
        `1. 用 Bash 运行：echo ok > ${join(r.cwd, "shell-ok.txt")}`,
        `2. 用 Bash 运行：touch ${probes[0]}`,
        "最后逐条汇报结果（成功还是失败，失败的报错原文和退出码）。",
      ].join("\n");
      return {
        text,
        probes,
        check: () => {
          expect(existsSync(join(r.cwd, "shell-ok.txt")), "工作目录里 shell 没写出 shell-ok.txt（claude 自带的沙箱没关掉？）");
          return "shell 在工作目录里照常写出 shell-ok.txt";
        },
      };
    },
  },
];

export async function runWriteScopeBypass(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  const cases = S32_CASES.filter((c) => only(c.name) || only("S32"));
  if (cases.length === 0) return;
  const hub = await startTestHub();
  try {
    for (const c of cases) await bypassCase(outcomes, c, hub);
  } finally {
    await hub.close();
  }
}

async function bypassCase(outcomes: Outcome[], c: S32Case, hub: TestHub): Promise<void> {
  const { dataDir } = hub;
  const keepClaudeSandbox = c.vendor === "claude" && process.env.SCOPE_SMOKE_KEEP_CLAUDE_SANDBOX === "1";
  const r = rig(c.vendor, hub, keepClaudeSandbox ? false : osSandboxAvailable());
  const suffix = randomUUID().slice(0, 8);
  const prepared = c.prepare(r, dataDir, suffix);
  await scenario(outcomes, `${c.name} ${c.title}${keepClaudeSandbox ? "（对照：不关 claude 自带的沙箱）" : ""}`, async () => {
    expect(!prepared.probes.some(existsSync), `数据目录里已经有同名的了：${prepared.probes.join(" ")}`);
    await r.driver.send(1, { messageIds: [1], source: "user", text: prepared.text });
    await waitUntil("这一轮结束", () => r.events.find((e) => e.type === "turn.ended"), TURN_TIMEOUT_MS);
    const leaked = prepared.probes.filter(existsSync);
    const reply = r.events.flatMap((e) => (e.type === "agent.text" ? [e.text] : [])).join("\n");
    const tools = r.events.flatMap((e) => (e.type === "agent.tool" ? [`${e.name} ${JSON.stringify(e.input).slice(0, 200)}`] : []));
    console.log(`  [${c.vendor}] 工具调用：\n    ${tools.join("\n    ")}\n  [${c.vendor}] 回复：\n${reply}`);
    for (const p of leaked) rmSync(p, { recursive: true, force: true });
    expect(leaked.length === 0, `数据目录里写出来了：${leaked.join(" ")}`);
    return `数据目录 ${prepared.probes.length} 个探针都没出现；${prepared.check(reply)}`;
  });
  prepared.cleanup?.();
  const removed = await closeRig(r);
  if (removed.length > 0) console.log(`  [${c.vendor}] 删掉了会话记录：${removed.join(" ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filters = process.argv.slice(2);
  const outcomes: Outcome[] = [];
  const only = (n: string) => filters.length === 0 || filters.some((f) => n === f || n.startsWith(f));
  await runWriteScope(outcomes, only);
  await runWriteScopeBypass(outcomes, only);
  for (const o of outcomes) console.log(`${o.ok ? "✓" : "✗"} ${o.name}：${o.detail}`);
  process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
}
