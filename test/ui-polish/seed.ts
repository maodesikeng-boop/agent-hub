// 种子数据（docs/ui-polish-loop-design.md 第 3.2 节）：用账本自己的接口和固定时钟，往一个空的数据目录里写一套固定的数据。
// 不变量：不直接写 SQL 造业务数据，形状由账本保证；同一个剧本写两次，库里除自增编号以外的内容和时间戳逐字段相同。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../src/daemon/store/index.ts";
import { createLedger, type SqliteLedger } from "../../src/daemon/ledger/index.ts";
import { DEFAULT_PM_NAME } from "../../src/daemon/prompt.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import {
  API_PATHS,
  DEFAULT_AGENT_VENDOR,
  DEFAULT_PM_MODE,
  ENV_HOME,
  ENV_PORT,
  ENV_TAILSCALE,
  VENDOR_LIST,
  bundledModelCatalog,
  type AgentVendor,
  type Attachment,
  type RouterAgentPlan,
  type RouterCommandDispatchedTarget,
  type WorkerRecord,
  type DeviceInviteResponse,
  type SessionId,
  type VendorAvailability,
} from "../../src/shared/index.ts";
import { REPORT_END, REPORT_START } from "../../src/shared/worker.ts";
import { wrapScriptAsPlatformCli } from "../fake-cli-shim.ts";
import { assertIsolated } from "./isolation.ts";
import { BROWSER_NOW_ISO, SEED_START_ISO, SEED_STEP_MS } from "./limits.ts";
import type { Scenario } from "./screens.ts";

export interface SeedOptions {
  /** 守护进程的数据目录（AGENT_HUB_HOME），必须不存在或是空的。 */
  home: string;
  /** 放演示项目主文件夹的目录（路径会显示在界面上，所以由调用方给固定路径）。 */
  projectsDir: string;
  scenario: Scenario;
}

export interface SeedResult {
  /** 剧本里起了名字的东西对应的编号，到达步骤里用（如 `#/c/<pm.lin>`）。 */
  ids: Readonly<Record<string, number>>;
  /** 种子里最后一条数据的时间，浏览器的固定时间不能早于它。 */
  lastAt: number;
}

/** 两台设备的身份钉死：界面按设备编号排序、拼网址，随机的话每次不一样。 */
export const SEED_DEVICES = [
  { id: "0b8e7c2a-6a51-4c1e-9d3f-5a7e00000001", name: "Studio Mac" },
  { id: "0b8e7c2a-6a51-4c1e-9d3f-5a7e00000002", name: "Tokyo Mini" },
] as const;

/** 演示项目的 git 提交时间钉死，界面上显示的分支、提交才每次一样。 */
const GIT_DATE = "2026-11-16T06:00:00Z";

/** 截图用守护进程的厂商状态：claude 能用、agy 没登录（提醒卡要用），其余没装。 */
const SEED_AVAILABILITY: Partial<Record<AgentVendor, VendorAvailability>> = { claude: "available", codex: "available", agy: "signed_out" };

/**
 * 前置：home 是空的。
 * 后置：home 里是这个剧本的全部数据，时间戳从 SEED_START_ISO 起按固定步长走；
 * 没有留着等执行的动作（真守护进程起来后不会去起会话、建 worktree、改任何一行）。
 * home 不是空的抛 Error，不覆盖。
 */
export async function seedScenario(options: SeedOptions): Promise<SeedResult> {
  for (const dir of [options.home, peerHomeOf(options.home), options.projectsDir]) assertIsolated(dir);
  const result = seedHome(options.home, options.projectsDir, options.scenario, SEED_DEVICES[0]);
  // 第二台设备的数据目录挨着放（peerHomeOf），截图命令在它上面另起一个守护进程再配对
  if (options.scenario === "two-devices") seedHome(peerHomeOf(options.home), options.projectsDir, "two-devices-peer", SEED_DEVICES[1]);
  return result;
}

/** two-devices 剧本里第二台设备的数据目录。 */
export const peerHomeOf = (home: string): string => `${resolve(home)}-peer`;

function seedHome(rawHome: string, projectsDir: string, scenario: Scenario | "two-devices-peer", device: (typeof SEED_DEVICES)[number]): SeedResult {
  const home = resolve(rawHome);
  assertIsolated(home);
  if (existsSync(home) && readdirSync(home).length > 0) throw new Error(`种子目录 ${home} 不是空的，不覆盖`);
  const paths = resolveHubPaths({ [ENV_HOME]: home }, homedir());
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.deviceFile, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 });

  let clock = Date.parse(SEED_START_ISO);
  const now = () => (clock += SEED_STEP_MS);
  const { db } = openStore(paths);
  const ledger = createLedger(db, {
    now,
    pmHomeRoot: paths.pmHomeDir,
    personasDir: paths.personasDir,
    dataHome: home,
    worktreesDir: paths.worktreesDir,
    launchDir: paths.launchDir,
    setupLogsDir: paths.setupLogsDir,
    deviceName: () => device.name,
    osSandboxed: () => true,
    models: {
      current: (vendor) => ({ ...bundledModelCatalog(vendor), availability: SEED_AVAILABILITY[vendor] ?? "not_installed" }),
      availability: (vendor) => SEED_AVAILABILITY[vendor] ?? "not_installed",
    },
  });
  const story = new Story(ledger, projectsDir, paths.uploadsDir, () => clock, (minutes) => (clock += minutes * 60_000));
  try {
    SCENARIOS[scenario](story);
    story.settle();
    // 种子里登记的动作（起会话、建 worktree、发消息）都当已经做过：截图用的守护进程不去真的起 agent
    db.run("UPDATE actions SET status = 'done' WHERE status IN ('pending', 'running')");
  } finally {
    ledger.close();
    db.close();
  }
  if (clock > Date.parse(BROWSER_NOW_ISO)) throw new Error(`剧本 ${scenario} 的时间走到了浏览器的“现在”之后`);
  return { ids: story.ids, lastAt: clock };
}

interface PmHandle {
  pmId: number;
  conversationId: number;
  sessionId: SessionId;
}

class Story {
  readonly ids: Record<string, number> = {};
  #uuid = 0;
  readonly ledger: SqliteLedger;
  readonly projectsDir: string;
  readonly at: () => number;
  readonly jump: (minutes: number) => void;
  readonly uploadsDir: string;

  constructor(ledger: SqliteLedger, projectsDir: string, uploadsDir: string, at: () => number, jump: (minutes: number) => void) {
    this.ledger = ledger;
    this.uploadsDir = uploadsDir;
    this.projectsDir = projectsDir;
    this.at = at;
    this.jump = jump;
  }

  /** 一个有一次提交的 git 仓库，当项目经理的主文件夹。 */
  repo(name: string): string {
    const dir = join(this.projectsDir, name);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, ".git"))) return dir;
    const env = { ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE };
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd: dir, env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    writeFileSync(join(dir, "docs", "plan.md"), "# Plan\n\n- 按厂商配置换会话阈值\n- 排查只读 Worker 超时\n");
    writeFileSync(join(dir, "src", "session-threshold.ts"), "export const THRESHOLD = 0.8;\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return dir;
  }

  pm(key: string, name: string, folder?: string, extra: { vendor?: AgentVendor; persona?: string } = {}): PmHandle {
    const created = this.ledger.createPm({ name, mode: DEFAULT_PM_MODE, persona: extra.persona ?? "", ...(folder === undefined ? {} : { folder }), ...(extra.vendor === undefined ? {} : { vendor: extra.vendor }) });
    const handle = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
    this.ids[`pm.${key}`] = handle.pmId;
    this.ids[`c.${key}`] = handle.conversationId;
    return handle;
  }

  /** 用户说一句，agent 用了几个工具、回几段，一轮正常结束。 */
  turn(pm: PmHandle, user: string, replies: readonly string[], tools: ReadonlyArray<{ name: string; input: unknown }> = []): number {
    const id = this.post(pm, user);
    this.reply(pm, id, replies, tools);
    return id;
  }

  post(pm: PmHandle, text: string): number {
    return this.ledger.postUserMessage({ conversationId: pm.conversationId, clientId: `seed-${++this.#uuid}`, text }).messageId;
  }

  reply(pm: Pick<PmHandle, "sessionId">, messageId: number, replies: readonly string[], tools: ReadonlyArray<{ name: string; input: unknown }> = []): void {
    const l = this.ledger;
    l.applyDriverEvent(pm.sessionId, { type: "message.delivered", messageIds: [messageId], at: this.at() });
    l.applyDriverEvent(pm.sessionId, { type: "message.processing", messageIds: [messageId], at: this.at() });
    for (const t of tools) {
      const toolUseId = `tool-${++this.#uuid}`;
      l.applyDriverEvent(pm.sessionId, { type: "agent.tool", uuid: `u-${this.#uuid}`, toolUseId, name: t.name, input: t.input, at: this.at() });
      this.jump(0.1);
      l.applyDriverEvent(pm.sessionId, { type: "agent.tool_result", toolUseIds: [toolUseId], at: this.at() });
    }
    for (const text of replies) l.applyDriverEvent(pm.sessionId, { type: "agent.text", uuid: `u-${++this.#uuid}`, text, at: this.at() });
    l.applyDriverEvent(pm.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [messageId], durationMs: 14_000, at: this.at() });
  }

  /** 一条用户消息处理失败（agent 进程崩了）。 */
  fail(pm: PmHandle, text: string): number {
    const id = this.post(pm, text);
    const l = this.ledger;
    l.applyDriverEvent(pm.sessionId, { type: "message.delivered", messageIds: [id], at: this.at() });
    l.applyDriverEvent(pm.sessionId, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [id], at: this.at() });
    return id;
  }

  /** 一条用户消息没发出去（还没送达，agent 进程就崩了）：气泡左边是红色感叹号。 */
  unsent(pm: PmHandle, text: string): number {
    const id = this.post(pm, text);
    this.ledger.applyDriverEvent(pm.sessionId, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [id], at: this.at() });
    return id;
  }

  /**
   * 还排着队要交给 agent 的消息（拍板定案、Worker 汇报）都当这一轮已经处理完：不然守护进程起来会把它们发给假 claude，
   * 回一句按真实时间记的“ok”，每次截图都不一样。
   */
  settle(): void {
    for (const c of this.ledger.snapshot().conversations) {
      const queued = c.messages.filter((m) => m.status === "queued").map((m) => m.id);
      if (queued.length === 0) continue;
      const sessionId = this.sessionOf(c.conversation.id);
      this.ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: queued, at: this.at() });
      this.ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: queued, at: this.at() });
      this.ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: queued, durationMs: 3_000, at: this.at() });
    }
  }

  /** 这个对话现在的会话（generation 最大的那个）。 */
  sessionOf(conversationId: number): SessionId {
    const sessions = this.ledger.snapshot().sessions.filter((x) => x.conversationId === conversationId);
    const latest = sessions.sort((a, b) => b.generation - a.generation)[0];
    if (latest === undefined) throw new Error(`对话 ${conversationId} 没有会话`);
    return latest.sessionId;
  }

  /** 资料页点“开新会话”、跑腿的写好交接：对话里出现换新会话的分隔线，之后用新会话。 */
  renew(pm: PmHandle): void {
    this.ledger.renewSession(pm.pmId);
    const job = this.ledger.claimHandover();
    if (job === null) throw new Error("开新会话后没有待写的交接");
    this.ledger.handoverForked(job.handoverId, { kind: "native", ref: { forker: "seed", handle: { forkId: "seed-fork" } } });
    this.ledger.handoverWritten(job.handoverId, { text: "交接：限流时退避到每 3 小时一次；周报里写一句。", usage: { input: 1200, cacheRead: 0, cacheWrite: 0, output: 300, context: 1500 } });
    pm.sessionId = this.sessionOf(pm.conversationId);
  }

  /** 派一个在主文件夹里干的 Worker，它回一段汇报、这一轮结束。 */
  worker(pm: PmHandle, node: string | undefined, title: string, task: string, report: string): WorkerRecord {
    const { worker } = this.ledger.hubCall(pm.sessionId, "worker.start", { title, task, noWorktree: true, ...(node === undefined ? {} : { node }) }).data;
    const conversation = this.ledger.snapshot().conversations.find((c) => c.conversation.id === worker.workerConversationId);
    const first = conversation?.messages.find((m) => m.sender === "pm");
    if (first === undefined) throw new Error(`Worker ${worker.id} 没有任务说明那条消息`);
    this.reply({ sessionId: this.sessionOf(worker.workerConversationId) }, first.id, [report], [{ name: "Read", input: { file_path: "src/shared/vendors.ts" } }]);
    return worker;
  }

  /** 用户发一条带附件的消息；body 为 null 的附件只登记不留文件（界面显示“文件已过期”）。 */
  withAttachments(pm: PmHandle, text: string, files: ReadonlyArray<{ name: string; mime: string; body: Buffer | null }>): number {
    const attachments: Attachment[] = files.map((f, i) => {
      // 上传编号的格式同守护进程（uploads.ts 的 UPLOAD_ID：16 位十六进制）
      const id = (this.#uuid * 16 + i).toString(16).padStart(16, "0");
      const dir = join(this.uploadsDir, id);
      const path = join(dir, f.name);
      if (f.body !== null) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, f.body);
      }
      return { id, name: f.name, path, size: f.body?.length ?? 2048, mime: f.mime };
    });
    const id = this.ledger.postUserMessage({ conversationId: pm.conversationId, clientId: `seed-${++this.#uuid}`, text, attachments }).messageId;
    this.reply(pm, id, ["收到三个文件：截图、周数据表，还有一份笔记（已经过期，打不开了）。"]);
    return id;
  }

  routerCommand(inputText: string, status: "dispatched" | "answered", plan: RouterAgentPlan, dispatched: RouterCommandDispatchedTarget[] = []): void {
    this.ledger.createRouterCommand({
      clientId: `seed-command-${++this.#uuid}`,
      inputText,
      vendor: DEFAULT_AGENT_VENDOR,
      status,
      plan,
      dispatched: dispatched.length === 0 ? null : dispatched,
      durationMs: 8_400,
    });
  }
}

const SCENARIOS: Record<Scenario | "two-devices-peer", (s: Story) => void> = {
  fresh(s) {
    // 第一次启动时守护进程自己建的那一个（daemon.ts），这里用固定时钟先建好
    s.pm("default", DEFAULT_PM_NAME);
  },
  standard,
  stress(s) {
    standard(s);
    stress(s);
  },
  "two-devices": standard,
  "two-devices-peer"(s) {
    const tokyo = s.pm("tokyo", "东京小助手");
    s.turn(tokyo, "今天的构建跑完了吗？", ["跑完了，全部通过，耗时 6 分 12 秒。"]);
    const lab = s.pm("lab", "实验室");
    s.turn(lab, "GPU 机器空出来了吗？", ["空出来了，A100 两张都闲着。"]);
  },
};

const PR_142 = "https://github.com/example/agent-hub/pull/142";

/** Worker 按九栏格式写的汇报（src/shared/worker.ts 的 WORKER_REPORT_FORMAT）：守护进程认得出状态，汇报气泡的头像上才有状态点。 */
const workerReport = (status: "做完了" | "有问题" | "放弃了", summary: string): string =>
  [REPORT_START, `状态: ${status}`, `摘要: ${summary}`, "PR: 无", "提交: 无", "测试: 无", "偏离: 无", "交棒: 无", "文件: 无", "问题: 无", REPORT_END].join("\n");

function standard(s: Story): void {
  const repo = s.repo("agent-hub");
  const lin = s.pm("lin", "小林", repo, { persona: "严谨、先讲结论。改动前先说清边界，测试不过不交。" });
  const others = [
    ["ma", "老马", "博客的图片都压到 200 KB 以内了。"],
    ["qing", "阿青", "爬虫的抓取频率降到每小时一次了。"],
    ["zhou", "小周", "昨晚的数据库备份做完了，3.2 GB，已校验。"],
    ["momo", "Momo", "The weekly draft is in docs/weekly/2026-46.md."],
    ["you", "柚子", "测试机的证书续好了，下次到期是明年 2 月。"],
  ] as const;
  const pms: Record<string, PmHandle> = {};
  for (const [key, name, reply] of others) {
    const folder = key === "zhou" ? s.repo("ops-scripts") : key === "qing" ? s.repo("crawler") : undefined;
    // 老马用 DeepSeek：资料页“现在选的厂商没登录”那一屏用它
    const pm = s.pm(key, name, folder, key === "ma" ? { vendor: "deepseek" } : {});
    pms[key] = pm;
    s.turn(pm, "进度怎么样？", [reply]);
    s.jump(23);
  }
  const old = s.pm("old", "旧博客");
  s.turn(old, "博客迁移完了吗？", ["迁完了，旧站可以归档。"]);
  s.ledger.archivePm(old.pmId);

  // 阿青：两张提问卡（一张选了选项加备注、一张关掉）、定时任务、性格设定改过一次、换过一次会话
  const qing = pms.qing!;
  s.turn(qing, "抓取失败率最近怎么样？", ["上周平均 0.8%，周三那天因为对方限流到了 6%。"]);
  const ask1 = s.ledger.hubCall(qing.sessionId, "ask", { text: "限流时要不要自动退避到每 3 小时一次？", options: ["要", "不要"], recommended: "要" });
  s.jump(2);
  s.ledger.resolveRouterItem(ask1.data.item!.id, { clientId: "seed-ask-1", optionIndex: 0, note: "退避后记得在周报里写一句" });
  const ask2 = s.ledger.hubCall(qing.sessionId, "ask", { text: "要不要把抓取日志同步到对象存储？" });
  s.ledger.hubCall(qing.sessionId, "ask.close", { itemId: ask2.data.item!.id });
  s.ledger.hubCall(qing.sessionId, "schedule.add", { name: "每日抓取报告", prompt: "汇总昨天的抓取量和失败率，发我一段话。", daily: "09:00" });
  s.ledger.hubCall(qing.sessionId, "persona.edit", { text: "说话简短，数字给到小数点后一位。", reason: "用户说报告太长" });
  s.jump(5);
  s.renew(qing);
  s.turn(qing, "新会话里还记得退避的事吗？", ["记得：限流时退避到每 3 小时一次，周报里写一句。"]);

  // 小周：任务图第一步指定了没登录的 Antigravity，系统挂了一张要你动手的提醒卡
  const zhou = pms.zhou!;
  s.turn(zhou, "把备份脚本的校验交给 Antigravity 跑一遍", ["好，建了一张图，校验那一步用 Antigravity。"]);
  s.ledger.hubCall(zhou.sessionId, "graph.create", {
    specJson: JSON.stringify({ title: "备份校验", steps: [{ key: "verify", title: "校验昨晚的备份", brief: "跑 scripts/verify-backup.sh，贴结果", vendor: "agy" }] }),
  });

  // Momo：一条没发出去、一条处理失败、带附件（图片、文件、文件已过期）
  const momo = pms.momo!;
  s.unsent(momo, "Post the summary to the team channel");
  s.jump(1);
  s.fail(momo, "Translate the weekly draft into Japanese");
  s.jump(3);
  s.withAttachments(momo, "Here are the screenshots and the spreadsheet", [
    { name: "dashboard.png", mime: "image/png", body: TINY_PNG },
    { name: "metrics-2026-46.csv", mime: "text/csv", body: Buffer.from("week,visits\n45,1820\n46,2210\n") },
    { name: "old-notes.md", mime: "text/markdown", body: null },
  ]);

  // 柚子：两张还没回答的提问（右栏 Needs You）
  const you = pms.you!;
  s.ledger.hubCall(you.sessionId, "ask", { text: "证书续期要不要改成自动？\n\n现在每次都要手动跑 certbot，下次到期是明年 2 月。", options: ["改成自动", "保持手动"], recommended: "改成自动" });
  s.ledger.hubCall(you.sessionId, "ask", { text: "测试机的系统要不要顺便升级到最新？", options: ["升级", "先不升"] });

  // 小林：基准图那一屏
  s.jump(20);
  s.turn(
    lin,
    "把自动换会话的阈值改成按厂商配置，顺便查一下为什么只读 Worker 偶发超时",
    [
      "好，我拆成三步：\n\n1. **按厂商配置换会话阈值**：改 `VENDOR_SPECS` 与账本\n2. **排查只读 Worker 超时**：只读排查工具清单缓存与超时逻辑\n3. **补边界测试**：两处改完后一起补\n\n第 2 步要你定一下失败结果缓存多久，卡挂在右栏了。",
    ],
    [
      { name: "Read", input: { file_path: "src/shared/vendors.ts" } },
      { name: "Bash", input: { command: "hub graph create --stdin" } },
    ],
  );
  const graph = s.ledger.hubCall(lin.sessionId, "graph.create", {
    specJson: JSON.stringify({
      title: "换会话阈值按厂商配置",
      goal: "阈值按厂商配置，并修好只读 Worker 偶发超时",
      steps: [
        { key: "plan", title: "拆分边界" },
        { key: "threshold", title: "按厂商配置换会话阈值", deps: ["plan"] },
        { key: "timeout", title: "排查只读 Worker 超时", deps: ["plan"] },
        { key: "tests", title: "补充换会话边界测试", deps: ["threshold", "timeout"] },
        { key: "pr", title: "提 PR", deps: ["tests"] },
      ],
    }),
  });
  s.ids["graph.lin"] = graph.data.graph.id;
  s.ledger.hubCall(lin.sessionId, "graph.done", { nodeKey: "plan", summary: "拆成两路并行" });
  const w1 = s.worker(lin, "threshold", "按厂商配置换会话阈值", "把 AUTO_RENEW_CONTEXT_TOKENS 改成按厂商配置，补测试。", workerReport("做完了", "阈值挪进 VENDOR_SPECS，32 条测试通过，PR #142。"));
  s.ids["w.threshold"] = w1.workerConversationId;
  s.ledger.hubCall(lin.sessionId, "worker.end", { workerId: w1.id });
  s.ledger.hubCall(lin.sessionId, "graph.done", { nodeKey: "threshold", summary: "32 条测试通过", prUrl: PR_142 });
  const w2 = s.worker(lin, "timeout", "排查只读 Worker 超时", "只读排查：为什么只读 Worker 偶发超时。", workerReport("有问题", "MCP 首次握手超过 30 秒时失败结果被缓存了 10 分钟。要定缓存多久。"));
  s.ids["w.timeout"] = w2.workerConversationId;
  s.ledger.hubCall(lin.sessionId, "ask", {
    node: "timeout",
    text: "失败结果缓存多久？\n\nMCP 服务偶发超时后，失败结果被当成正常结果缓存了 **10 分钟**。缩短后重试更快，但服务真挂了时会多打几次。",
    options: ["60 秒", "5 分钟"],
    recommended: "60 秒",
  });
  s.jump(3);
  s.ledger.hubCall(lin.sessionId, "router.report", {
    summary: "按厂商配置换会话阈值已合并，32 条测试通过。",
    links: [{ label: "PR #142", target: PR_142 }],
  });
  s.ledger.hubCall(pms.ma!.sessionId, "router.report", { summary: "博客图片压缩完成，首页加载从 3.1 秒降到 1.4 秒。" });

  // 总助：一条已分派、一条直接回答
  s.routerCommand("把证书续期的事交给柚子", "dispatched", { intent: "dispatch", reply: "", actions: [] }, [
    { deviceId: SEED_DEVICES[0].id, pmId: you.pmId, messageId: 1, ok: true, op: "pm.forward", deviceName: SEED_DEVICES[0].name, pmName: "柚子", conversationId: you.conversationId },
  ]);
  s.routerCommand("今天哪些项目经理在忙？", "answered", { intent: "answer", reply: "小林在等你定失败结果缓存多久；小周卡在 Antigravity 没登录；其余都空闲。", actions: [] });
}

/** 超长、超多：20 多个项目经理、长名字、长消息、Markdown、图表、300 条历史、多张图、十几个 Piece。 */
function stress(s: Story): void {
  const long = s.pm("long", "一个名字特别特别长的项目经理用来测试左栏和顶栏会不会被撑开", s.repo("a-project-folder-with-an-unusually-long-name-for-layout-testing"));
  s.turn(long, "x".repeat(0) + "请把下面这段需求整理成一份清单：" + "用户反馈左栏名字太长时会把时间挤掉，右栏任务标题太长时会换三行。".repeat(6), ["好的，整理如下。" + "这是一段很长的回复，用来看消息气泡在长文本下的换行和行宽。".repeat(12)]);
  for (let i = 1; i <= 18; i++) {
    const pm = s.pm(`extra${i}`, `助手 ${String(i).padStart(2, "0")}`);
    s.turn(pm, "在吗？", [`在的，第 ${i} 号助手待命。`]);
  }
  const md = s.pm("md", "文档整理");
  s.ids["c.md"] = md.conversationId;
  for (let i = 0; i < 150; i++) s.turn(md, `第 ${i + 1} 个问题：这一段历史消息用来撑出滚动。`, [`第 ${i + 1} 个回答。`]);
  s.turn(md, "给我一份完整的发布说明", [MARKDOWN_SAMPLE]);
  s.turn(md, "画一下流程和每周访问量", [CHART_SAMPLE]);

  const lin = { pmId: s.ids["pm.lin"]!, conversationId: s.ids["c.lin"]!, sessionId: s.sessionOf(s.ids["c.lin"]!) };
  const big = s.ledger.hubCall(lin.sessionId, "graph.create", {
    specJson: JSON.stringify({
      title: "一张十几步、多层并行的大图，用来测试任务流图全览在横向放不下时怎么滚动",
      steps: [
        { key: "a", title: "收集需求" },
        ...["b1", "b2", "b3"].map((key, i) => ({ key, title: `并行调研第 ${i + 1} 路：一个比较长的步骤标题`, deps: ["a"] })),
        ...["c1", "c2", "c3", "c4"].map((key, i) => ({ key, title: `实现模块 ${i + 1}`, deps: ["b1", "b2", "b3"] })),
        { key: "d", title: "集成测试", deps: ["c1", "c2", "c3", "c4"] },
        ...["e1", "e2"].map((key, i) => ({ key, title: `回归 ${i + 1}`, deps: ["d"] })),
        { key: "f", title: "发布", deps: ["e1", "e2"] },
      ],
    }),
  });
  s.ids["graph.big"] = big.data.graph.id;
  s.ledger.hubCall(lin.sessionId, "graph.done", { graphId: big.data.graph.id, nodeKey: "a", summary: "需求齐了" });
  const qing = { pmId: s.ids["pm.qing"]!, conversationId: s.ids["c.qing"]!, sessionId: s.sessionOf(s.ids["c.qing"]!) };
  // 历史任务图挂在阿青那边：右栏 Completed 组只在有收工 Piece 时出现（RightRail 的 completedGraphCount 在 App.tsx 里未传入）
  const done = s.ledger.hubCall(qing.sessionId, "graph.create", { specJson: JSON.stringify({ title: "上周的发布", steps: [{ key: "ship", title: "发布 1.4" }] }) });
  s.ids["graph.done"] = done.data.graph.id;
  s.ledger.hubCall(qing.sessionId, "graph.done", { graphId: done.data.graph.id, nodeKey: "ship", summary: "发布完成" });
  s.ledger.hubCall(qing.sessionId, "graph.finish", { graphId: done.data.graph.id, summary: "1.4 发布完成", unmergedOk: true });
  for (let i = 1; i <= 13; i++) {
    const w = s.worker(qing, undefined, `抓取任务 ${i}：一个比较长的 Piece 标题，用来看右栏会不会换行`, `处理第 ${i} 批站点。`, `第 ${i} 批做完了。`);
    if (i <= 4) s.ledger.hubCall(qing.sessionId, "worker.end", { workerId: w.id });
  }
  for (let i = 0; i < 3; i++) s.ledger.hubCall(qing.sessionId, "router.report", { summary: `第 ${i + 1} 批抓取完成，失败率 ${(0.5 + i * 0.2).toFixed(1)}%，详见报告。` });
  for (let i = 0; i < 4; i++) {
    s.ledger.hubCall(qing.sessionId, "ask", { text: `第 ${i + 1} 个待拍板：这个站点的抓取频率要不要从每小时一次降到每天一次？对方最近明显在限流，依据见上面的失败率曲线和日志摘要。`.repeat(i === 0 ? 3 : 1), options: ["降到每天", "保持每小时"] });
  }
  s.routerCommand("把所有抓取任务的失败率汇总一下，按站点排序，超过 5% 的标红", "answered", { intent: "answer", reply: "汇总如下：\n\n| 站点 | 失败率 |\n| --- | --- |\n| a.example | 6.1% |\n| b.example | 0.4% |", actions: [] });
}
export interface IsolatedDaemon {
  /** 带登录口令的网址，打开就登录。 */
  loginUrl: string;
  origin: string;
  stop(): Promise<void>;
}

/** 和 src/daemon/main.ts 一样，另外认本机回环网址当设备网址（two-devices 要同机两个守护进程配对）。 */
const LOOPBACK_MAIN = fileURLToPath(new URL("../e2e/loopback-daemon.ts", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../fake-claude/fake-claude.ts", import.meta.url));
const FROZEN_CLOCK = fileURLToPath(new URL("./frozen-clock.ts", import.meta.url));
const LOGIN_URL = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;

/**
 * 在灌好种子的数据目录上起真守护进程：端口随机，各厂商命令都换成不存在的路径或假命令，不问真的 Tailscale，
 * 发的是当前工作区 `pnpm build` 出来的网页。
 * 后置：返回时已经能登录；stop 之后进程退出、端口释放。同一台机器上可以同时起几个（two-devices 剧本要两个）。
 */
export async function startIsolatedDaemon(options: { home: string; repoRoot: string; pairWith?: IsolatedDaemon }): Promise<IsolatedDaemon> {
  const home = resolve(options.home);
  const scratch = join(home, "..", `${home.split(sep).pop()}-scratch`);
  assertIsolated(home);
  assertIsolated(scratch);
  mkdirSync(join(scratch, "user-home"), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TZ: process.env.TZ ?? "",
    // 守护进程看到的用户主目录也换掉：同步、扫描各家配置都落在这里，不碰真的 ~/.claude、~/.codex
    HOME: join(scratch, "user-home"),
    [ENV_HOME]: home,
    [ENV_PORT]: "0",
    [ENV_TAILSCALE]: join(scratch, "no-tailscale"),
    UI_POLISH_NOW_MS: String(Date.parse(BROWSER_NOW_ISO)),
    // 默认厂商用假 claude（装着、能用），别家指到不存在的路径（没装）；种子里的动作都标了做完，假 claude 不会被真的叫起来干活
    ...Object.fromEntries(VENDOR_LIST.map(({ id, cli }) => [cli.envVar, id === DEFAULT_AGENT_VENDOR ? wrapScriptAsPlatformCli(FAKE_CLAUDE, scratch, "fake-claude") : join(scratch, `no-${id}`)])),
    FAKE_CLAUDE_LOG: join(scratch, "fake-claude.log"),
    FAKE_CLAUDE_STATE: scratch,
  };
  const child = spawn(process.execPath, ["--import", FROZEN_CLOCK, LOOPBACK_MAIN], { cwd: options.repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const match = await new Promise<RegExpExecArray>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`守护进程 15 秒没给登录网址：${err}`)), 15_000);
    const check = () => {
      const m = LOGIN_URL.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m);
      }
    };
    child.stdout.on("data", check);
    void exited.then(() => {
      clearTimeout(timer);
      fail(new Error(`守护进程提前退出：${err}`));
    });
  });
  const origin = `http://127.0.0.1:${match[1]}`;
  const daemon: IsolatedDaemon = {
    loginUrl: `${origin}${API_PATHS.auth}?token=${match[2]}`,
    origin,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    },
  };
  if (options.pairWith !== undefined) await pair(daemon, options.pairWith);
  return daemon;
}

/** 和网页“设置 → 电脑”一样：在 peer 上发邀请，在 entry 上添加。 */
async function pair(entry: IsolatedDaemon, peer: IsolatedDaemon): Promise<void> {
  const login = async (d: IsolatedDaemon) => {
    const res = await fetch(d.loginUrl, { redirect: "manual" });
    return { cookie: (res.headers.get("set-cookie") ?? "").split(";", 1)[0]!, origin: d.origin };
  };
  const send = async (c: { cookie: string; origin: string }, path: string, body?: unknown) => {
    const res = await fetch(c.origin + path, {
      method: "POST",
      headers: { cookie: c.cookie, origin: c.origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`配对失败 ${path}：${res.status} ${await res.text()}`);
    return res;
  };
  const invite = (await (await send(await login(peer), API_PATHS.deviceInvites)).json()) as DeviceInviteResponse;
  await send(await login(entry), API_PATHS.devices, { url: invite.url, code: invite.code });
}

/** 1×1 的灰色 PNG：附件里的“图片”。 */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJYwPhHnLkSgAAAABJRU5ErkJggg==", "base64");

const MARKDOWN_SAMPLE = `## 1.5 发布说明

这一版主要改了**换会话**和**只读 Worker**两块，另外修了几个界面细节。详见 [PR #142](${"https://github.com/example/agent-hub/pull/142"})。

### 改了什么

1. 换会话的阈值按厂商配置
2. 只读 Worker 的失败结果只缓存 60 秒
   - 第一次握手超时不再当成正常结果
   - 重试间隔按指数退避
3. 设置里的厂商页加了安装日志

> 升级前先停掉正在跑的 Worker，升级后会自动接着跑。

| 项 | 之前 | 之后 |
| --- | ---: | ---: |
| 换会话门槛 | 固定 160k | 按厂商 |
| 失败缓存 | 10 分钟 | 60 秒 |
| 冷启动 | 3.1 秒 | 1.4 秒 |

\`\`\`ts
export const AUTO_RENEW = {
  claude: 160_000,
  codex: 200_000,
} as const;
\`\`\`

行内代码像 \`hub worker start\` 这样。`;

const CHART_SAMPLE = `流程：

\`\`\`mermaid
flowchart LR
  A[收集需求] --> B[拆分边界]
  B --> C[实现]
  B --> D[排查]
  C --> E[测试]
  D --> E
\`\`\`

每周访问量：

\`\`\`vega-lite
{"data":{"values":[{"week":"43","visits":1520},{"week":"44","visits":1610},{"week":"45","visits":1820},{"week":"46","visits":2210}]},"mark":"bar","encoding":{"x":{"field":"week","type":"ordinal"},"y":{"field":"visits","type":"quantitative"}}}
\`\`\``;
