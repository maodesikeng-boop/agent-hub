import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  PRODUCT_NAME,
  PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_PM_CARD_MAX_BYTES,
  ROUTER_PROJECT_SHOW_PER_TURN_MAX,
  ROUTER_REPLY_MAX_CHARS,
  utf8Bytes,
} from "../../shared/index.ts";
import * as promptModule from "./prompt.ts";
import {
  ROUTER_RECEIPTS_SECTION_MAX_BYTES,
  buildRouterSystemPrompt,
  formatFleetDigestForPrompt,
  type PromptDeviceDigest,
  type PromptPmDigestCard,
  type PromptRecentReceipt,
} from "./prompt.ts";

function makePmCard(index: number, overrides: Partial<PromptPmDigestCard> = {}): PromptPmDigestCard {
  return {
    pmId: index,
    pmName: `项目经理-${index}`,
    mode: "manage_only",
    conversationId: 1000 + index,
    activity: "idle",
    project: {
      id: 100 + index,
      name: `service-module-${index}`,
      mainFolder: `/Users/dev/workspace/org-platform-monorepo/packages/service-module-${index}`,
    },
    recentBrief:
      `负责第 ${index} 号核心业务服务的日常架构演进、数据库迁移审核、跨团队接口联调与线上回归验收，` +
      `当前重点跟进高并发读写分离改造、端到端性能压测守卫以及多机灰度发布流水线稳定性治理工作，确保零回滚上线。`,
    activeWorkers: [],
    activeWorkerTotal: 0,
    pendingDecisionCount: 0,
    ...overrides,
  };
}

describe("buildRouterSystemPrompt（总助系统提示词）", () => {
  it("角色与环境：总助（Router） → 项目经理（PM） → Worker 三层分工、工作在全局总助台、有 hub dispatch；不再有内部代号", () => {
    const prompt = buildRouterSystemPrompt();
    expect(prompt).toContain(`你是 **${PRODUCT_NAME}**`);
    expect(prompt).toContain("**总助（Router）**");
    expect(prompt).toContain("**总助（你） → 项目经理（PM） → Worker**");
    expect(prompt).toContain("**全局总助台**");
    expect(prompt).toContain("你获得了专属的 `hub dispatch` 命令行工具");
    for (const gone of ["水果刀", "轨道 B", "Piece", "四不准", "极速分派"]) expect(prompt, gone).not.toContain(gone);
  });

  it("四条硬规矩：不碰业务文件不起子代理、不替项目经理出方案、单目标一律 --verbatim 不改写原话、不讲客套废话（离线设备不分派）", () => {
    const prompt = buildRouterSystemPrompt();

    expect(prompt).toContain("# 四条硬规矩");
    expect(prompt).toMatch(/1\. \*\*不碰业务文件，不起子代理\*\*：.*严禁读取、搜索任何代码或目录/);
    expect(prompt).toContain("严禁调用任何内置子代理工具");
    expect(prompt).toMatch(/2\. \*\*不替项目经理出方案\*\*：不分析业务架构、不写技术方案/);
    expect(prompt).toMatch(/3\. \*\*传话不走样（单目标一律 `--verbatim`）\*\*/);
    expect(prompt).toContain("严禁用 `--stdin` 自己重写或缩写");
    expect(prompt).toMatch(/4\. \*\*不讲客套废话\*\*：严禁回复“好的”“收到”“马上处理”/);
    expect(prompt).toMatch(/离线|online:\s*false/);

    // 命令族：每条命令都写明具体干嘛的
    for (const cmd of ["pm", "worker-start", "worker-stop", "worker-send", "worker-end", "worker-list", "project-create"]) {
      expect(prompt).toContain(`hub dispatch ${cmd}`);
    }
    expect(prompt).toContain("**暂停 Worker 当前这一轮**");
    expect(prompt).toContain("**让 Worker 彻底收工**");
    expect(prompt).toContain("会话和分支保留，以后还能 `worker-send` 继续");
  });

  it("按 vendorAvailability 动态过滤提示词里允许指定的厂商候选列表", () => {
    const first = AGENT_VENDORS[0]!;
    const second = AGENT_VENDORS[1]!;
    const prompt = buildRouterSystemPrompt({
      vendorAvailability: Object.fromEntries(
        AGENT_VENDORS.map((v) => [v, v === first ? "available" : "not_installed"]),
      ),
    });

    expect(prompt).toContain(first);
    expect(prompt).not.toContain(`|${second}`);
    expect(prompt).not.toContain(`${second}|`);
  });
});

describe("formatFleetDigestForPrompt（跨设备名片格式化与 24 KB 预算控制）", () => {
  it("清晰格式化本机与远端设备（含离线/陈旧标记）、PM 详情与最多 5 条近期指令回执", () => {
    const devices: PromptDeviceDigest[] = [
      {
        deviceId: "self",
        deviceName: "MacBook Pro",
        platform: "darwin",
        online: true,
        stale: false,
        pms: [
          makePmCard(1, {
            pmName: "小林",
            project: { id: 7, name: "agent-hub", mainFolder: "/work/agent-hub" },
            recentBrief: "正在推进 Router 第 1 波并行开发",
            pendingDecisionCount: 1,
            activeWorkers: [
              { id: 400, title: "6家厂商统一 routerDefault", activity: "working", readonly: false },
            ],
            activeWorkerTotal: 1,
          }),
        ],
      },
      {
        deviceId: "dev-tokyo",
        deviceName: "Tokyo Linux",
        platform: "linux",
        online: false,
        stale: true,
        pms: [
          makePmCard(2, {
            pmName: "阿青",
            project: { id: 9, name: "billing-api", mainFolder: "/srv/billing-api" },
            recentBrief: "账单结算接口维护",
          }),
        ],
      },
    ];

    const receipts: PromptRecentReceipt[] = Array.from({ length: 7 }, (_, i) => ({
      id: 50 - i,
      text: `测试历史指令 #${50 - i}`,
      status: "done",
      actions: [
        {
          op: "worker.start",
          deviceId: "self",
          deviceName: "MacBook Pro",
          projectId: 7,
          projectName: "agent-hub",
          workerId: 400 + i,
          title: `任务-${i}`,
          readonly: i % 2 === 0,
        },
      ],
    }));

    const out = formatFleetDigestForPrompt(devices, receipts);

    expect(out).toContain("MacBook Pro");
    expect(out).toContain("device=self");
    expect(out).toContain("小林");
    expect(out).toContain("agent-hub");
    expect(out).toContain("#400");
    expect(out).toContain("Tokyo Linux");
    expect(out).toContain("online: false");
    // 近期回执只保留最多 5 条（#50 ~ #46 保留，#45、#44 截掉）
    expect(out).toContain("#50");
    expect(out).toContain("#46");
    expect(out).not.toContain("#45");
    expect(out).not.toContain("#44");
    expect(utf8Bytes(out)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);
  });

  it("30 个 PM 超出 24 KB 预算时：优先完整保留有活跃 Worker 或未决项的 PM，其余降级为单行摘要，总字节严格 <= 24_576", () => {
    expect(ROUTER_FLEET_DIGEST_MAX_BYTES).toBe(24_576);

    // 构造 30 个重负载 PM（每张完整名片含长中文摘要、路径与多项信息，全量展开超过 28 KB）
    const activeWorkerPmIds = new Set([3, 11, 19, 27]);
    const pendingDecisionPmIds = new Set([6, 15, 24, 30]);

    const pms: PromptPmDigestCard[] = [];
    for (let i = 1; i <= 30; i++) {
      const hasWorkers = activeWorkerPmIds.has(i);
      const hasPending = pendingDecisionPmIds.has(i);
      pms.push(
        makePmCard(i, {
          recentBrief:
            `【专属职责标识-PM-${i}】` +
            "负责大型分布式微服务网关、账本存储引擎、实时消息流推送、多端沙箱权限治理及自动化回归测试体系建设，长期维护高可用架构演进与线上稳定性保障方案，严控内存与延迟预算指标。".repeat(
              2,
            ),
          activeWorkers: hasWorkers
            ? [
                { id: i * 10 + 1, title: `关键活跃任务-${i}-A：核心链路改造与压测`, activity: "working", readonly: false },
                { id: i * 10 + 2, title: `关键活跃任务-${i}-B：只读日志排查与审计`, activity: "working", readonly: true },
              ]
            : [
                // 给空闲 PM 塞一些已无效/或通过长项目描述增大全量展开体积（空闲 PM activeWorkers 为空，但全量时带长路径与长 roleSummary）
              ],
          activeWorkerTotal: hasWorkers ? 2 : 0,
          pendingDecisionCount: hasPending ? 2 : 0,
          project: {
            id: 200 + i,
            name: `enterprise-platform-subsystem-service-${i}`,
            mainFolder: `/Users/enterprise/monorepo/workspaces/domain-clusters/cluster-${(i % 3) + 1}/enterprise-platform-subsystem-service-${i}`,
            // 专属标识放在“主线”里：单行摘要只带“做什么”的前几个字，降级后看不到它
            catalog: {
              oneLiner: "企业级平台子系统：分布式微服务网关、账本存储引擎、实时消息流推送与多端沙箱权限治理，长期维护高可用架构演进与线上稳定性保障方案，严控内存与延迟预算指标。",
              aliases: [`service-${i}`, "企业平台", "网关"],
              focus: `【专属职责标识-PM-${i}】自动化回归测试体系建设与灰度发布流水线稳定性治理，确保零回滚上线。`,
              refreshedAt: Date.now(),
            },
          },
        }),
      );
    }

    const devices: PromptDeviceDigest[] = [
      { deviceId: "self", deviceName: "Studio Mac", platform: "darwin", online: true, pms: pms.slice(0, 10) },
      { deviceId: "peer-tokyo", deviceName: "Tokyo Build Node", platform: "linux", online: true, pms: pms.slice(10, 20) },
      { deviceId: "peer-sg", deviceName: "Singapore Worker Node", platform: "linux", online: true, pms: pms.slice(20, 30) },
    ];

    const receipts: PromptRecentReceipt[] = [
      {
        id: 99,
        text: "在 enterprise-platform-subsystem-service-3 派个 Worker 跟进压测",
        status: "done",
        actions: [
          {
            op: "pm.forward",
            deviceId: "self",
            deviceName: "Studio Mac",
            pmId: 3,
            pmName: "项目经理-3",
            verbatim: true,
          },
        ],
      },
    ];

    const output = formatFleetDigestForPrompt(devices, receipts);
    const bytes = Buffer.byteLength(output, "utf8");

    // 1. 严格遵守 24_576 字节硬上限
    expect(bytes).toBeLessThanOrEqual(24_576);
    expect(utf8Bytes(output)).toBe(bytes);

    // 2. 所有有活跃 Worker 或有未决项的 PM（共 8 个）100% 保留完整名片（能看到专属 roleSummary 标识与活跃 Piece 详情）
    for (const id of [...activeWorkerPmIds, ...pendingDecisionPmIds]) {
      expect(output, `高优 PM #${id} 应保留完整职责摘要`).toContain(`【专属职责标识-PM-${id}】`);
    }
    for (const id of activeWorkerPmIds) {
      expect(output, `有活跃 Worker 的 PM #${id} 应保留活跃 Piece 标题`).toContain(`关键活跃任务-${id}-A`);
    }

    // 3. 30 个 PM 全部在名片文本中可查到编号与项目名，且至少有一部分空闲 PM 已降级为紧凑单行摘要（不再带长篇【专属职责标识】）
    for (let i = 1; i <= 30; i++) {
      expect(output).toContain(`项目经理-${i}`);
      expect(output).toContain(`enterprise-platform-subsystem-service-${i}`);
    }
    const idleIds = Array.from({ length: 30 }, (_, idx) => idx + 1).filter(
      (id) => !activeWorkerPmIds.has(id) && !pendingDecisionPmIds.has(id),
    );
    const downgradedCount = idleIds.filter((id) => !output.includes(`【专属职责标识-PM-${id}】`)).length;
    expect(downgradedCount).toBeGreaterThan(0);
  });

  it("极端超大规模（300 个 PM）下依然严格不超 24_576 字节且 UTF-8 合法不乱码", () => {
    const hugePms = Array.from({ length: 300 }, (_, idx) =>
      makePmCard(idx + 1, {
        activeWorkerTotal: idx < 5 ? 1 : 0,
        activeWorkers: idx < 5 ? [{ id: idx + 1, title: `活跃任务-${idx + 1}`, activity: "working", readonly: false }] : [],
        pendingDecisionCount: idx === 6 ? 1 : 0,
      }),
    );
    const devices: PromptDeviceDigest[] = [
      { deviceId: "self", deviceName: "Mega Host", online: true, pms: hugePms },
    ];

    const out = formatFleetDigestForPrompt(devices);
    const bytes = Buffer.byteLength(out, "utf8");
    expect(bytes).toBeLessThanOrEqual(24_576);
    expect(out).not.toContain("\uFFFD");
    // 前几个有活跃任务的 PM 仍然保留在输出中
    expect(out).toContain("项目经理-1");
    expect(out).toContain("项目经理-7");
  });

  it("空设备列表与含换行/控制字符的字段均安全处理不破坏结构", () => {
    const emptyOut = formatFleetDigestForPrompt([], []);
    expect(emptyOut).toContain("暂无已配置的设备或项目经理");
    expect(utf8Bytes(emptyOut)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);

    const dirtyDevices: PromptDeviceDigest[] = [
      {
        deviceId: "self\ninjected",
        deviceName: "Mac\r\nHost\u0007",
        online: true,
        pms: [
          makePmCard(1, {
            pmName: "小\n林",
            recentBrief: "第一行\n## 伪造标题\r\n第三行",
          }),
        ],
      },
    ];
    const cleaned = formatFleetDigestForPrompt(dirtyDevices);
    expect(cleaned).not.toContain("\u0007");
    expect(cleaned).toContain("小 林");
    expect(cleaned).toContain("第一行 ## 伪造标题 第三行");
  });
});

describe("v2 回答边界与常量收口（docs/router-workbench-v2-design.md 第 5.2 节、第 9.2 节选项 A）", () => {
  it("prompt.ts 不再自带与 limits.ts 同名的常量，也没有 240 字的回复上限", () => {
    const exported = Object.keys(promptModule);
    for (const name of [
      "ROUTER_REPLY_NOTE_MAX_CHARS",
      "ROUTER_FLEET_DIGEST_MAX_BYTES",
      "ROUTER_PM_ACTIVE_WORKERS_MAX",
      "ROUTER_PERSONA_SUMMARY_MAX_CHARS",
      "ROUTER_PM_CARD_MAX_BYTES",
    ]) {
      expect(exported).not.toContain(name);
    }
    expect(buildRouterSystemPrompt()).not.toMatch(/240\s*字/);
  });

  it("状态问答：名片里看得出来的全局状态（谁在忙、卡在拍板、在哪台设备、上一条汇报）用 Markdown 完整作答，建议不超过 1,500 字", () => {
    const prompt = buildRouterSystemPrompt();
    const rule = prompt.slice(prompt.indexOf("## 你负责干嘛"), prompt.indexOf("# 四条硬规矩"));
    expect(rule).toMatch(/名片/);
    expect(rule).toMatch(/Markdown/);
    expect(rule).toMatch(/1,500 字/);
    for (const example of ["谁在忙", "拍板", "哪台设备"]) expect(rule).toContain(example);
    // 角色说明不再写“唯一职责是分派”，和第 4 条不打架
    expect(prompt).not.toContain("唯一职责");
  });

  it("分派指令：凡要读代码、查日志、写方案、改状态的仍必须分派给对应 PM，前三条铁律原样保留", () => {
    const prompt = buildRouterSystemPrompt();
    const duty = prompt.slice(prompt.indexOf("## 你负责干嘛"), prompt.indexOf("# 四条硬规矩"));
    for (const must of ["查代码", "看日志", "写方案", "改状态"]) expect(duty).toContain(must);
    expect(duty).toContain("**只要目标项目已有 PM，默认一律转交给 PM**");
    // 名片里看不出来的不准猜
    expect(duty).toMatch(/看不出来的细节不准猜，转交给对应的项目经理去查/);
    expect(prompt).toMatch(/1\. \*\*不碰业务文件，不起子代理\*\*/);
    expect(prompt).toMatch(/2\. \*\*不替项目经理出方案\*\*/);
    expect(prompt).toMatch(/3\. \*\*传话不走样/);
    // 分派完照旧直接结束本轮，不讲客套
    expect(prompt).toContain("调完 `hub dispatch` 分派成功就直接结束本轮");
  });

  it("单轮上下文不超过 24 KB + 600 B：近期回执带满长回复也只占回执分节的 600 字节", () => {
    const devices: PromptDeviceDigest[] = [
      {
        deviceId: "self",
        deviceName: "MacBook Pro",
        online: true,
        pms: Array.from({ length: 30 }, (_, i) => makePmCard(i + 1)),
      },
    ];
    const receipts: PromptRecentReceipt[] = Array.from({ length: 5 }, (_, i) => ({
      id: 900 + i,
      text: "现在谁在干活？".repeat(50),
      status: "answered",
      actions: [],
      replyNote: "答".repeat(ROUTER_REPLY_MAX_CHARS),
    }));
    const out = formatFleetDigestForPrompt(devices, receipts);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES + ROUTER_RECEIPTS_SECTION_MAX_BYTES);
    const receiptsSection = out.slice(out.indexOf("## 近期指令回执"));
    if (out.includes("## 近期指令回执")) {
      expect(utf8Bytes(receiptsSection)).toBeLessThanOrEqual(ROUTER_RECEIPTS_SECTION_MAX_BYTES);
    }
    // 小规模名片时回执分节一定在，且仍守 600 字节
    const small = formatFleetDigestForPrompt([{ ...devices[0]!, pms: devices[0]!.pms.slice(0, 2) }], receipts);
    const smallSection = small.slice(small.indexOf("## 近期指令回执"));
    expect(small).toContain("## 近期指令回执");
    expect(utf8Bytes(smallSection)).toBeLessThanOrEqual(ROUTER_RECEIPTS_SECTION_MAX_BYTES);
  });
});

describe("项目档案进名片（docs/router-project-catalog-design.md）", () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const catalog = {
    oneLiner: "把会议录音转成带说话人的文字稿，再出摘要",
    aliases: ["mercury", "语音转文字", "会议纪要"],
    focus: "换成本地 Whisper 模型，降低延迟",
    refreshedAt: now - 3 * 3_600_000,
  };
  const card = (project: Partial<NonNullable<PromptPmDigestCard["project"]>>, extra: Partial<PromptPmDigestCard> = {}) =>
    makePmCard(12, { project: { id: 10, name: "mercury", mainFolder: "/Users/me/mercury", ...project }, recentBrief: "Worker #88 做完说话人分离", ...extra });
  const render = (pm: PromptPmDigestCard) => formatFleetDigestForPrompt([{ deviceId: "self", deviceName: "Mac", online: true, pms: [pm] }], [], ROUTER_FLEET_DIGEST_MAX_BYTES, now);

  it("完整名片带用户写的说明、做什么、别名、主线和最近一句，不再带 summary 拼接行", () => {
    const text = render(card({ description: "会议录音转文字", catalog }));
    expect(text).toContain("- 说明: 会议录音转文字（用户写的）");
    expect(text).toContain(`- 做什么: ${catalog.oneLiner}`);
    expect(text).toContain("- 别名: mercury、语音转文字、会议纪要");
    expect(text).toContain(`- 主线: ${catalog.focus}`);
    expect(text).toContain("- 最近: Worker #88 做完说话人分离");
    expect(text).toContain("- 档案: 3 小时前更新（细节：hub dispatch project-show --device self --project 10）");
    expect(text).not.toContain("- summary:");
  });

  it("还没建档的项目写“未建档”，用户写了说明时照样显示说明", () => {
    const text = render(card({ description: "会议录音转文字", catalog: null }));
    expect(text).toContain("- 档案: 未建档");
    expect(text).toContain("- 说明: 会议录音转文字（用户写的）");
    expect(text).not.toContain("- 做什么:");
    expect(render(card({}))).toContain("- 档案: 未建档");
  });

  it("压成单行时带做什么的前 PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS 个字", () => {
    const pms = Array.from({ length: 40 }, (_, i) =>
      makePmCard(i + 1, { project: { id: 100 + i, name: `p${i}`, mainFolder: `/x/${"深".repeat(100)}${i}`, catalog: { ...catalog, oneLiner: "做".repeat(150) } }, recentBrief: "最".repeat(120) }),
    );
    const text = formatFleetDigestForPrompt([{ deviceId: "self", deviceName: "Mac", online: true, pms }], [], 8_000, now);
    const compact = text.split("\n").find((l) => l.startsWith("- PM #"))!;
    expect(compact).toContain(`做什么=${"做".repeat(PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS - 1)}…`);
  });

  it("单张名片不超过 ROUTER_PM_CARD_MAX_BYTES，超了先砍主线再砍别名", () => {
    const big = { ...catalog, oneLiner: "一".repeat(150), focus: `主线${"二".repeat(150)}`, aliases: Array.from({ length: 8 }, (_, i) => `别名${i}${"三".repeat(20)}`) };
    const longWorkers = Array.from({ length: 6 }, (_, i) => ({ id: i, title: "长".repeat(60), activity: "working", readonly: false }));
    const pm = card({ description: "说".repeat(150), catalog: big }, { recentBrief: "近".repeat(120), activeWorkers: longWorkers, activeWorkerTotal: 6 });
    const section = render(pm).split("\n\n").find((p) => p.startsWith("## 设备"))!;
    const pmCard = section.slice(section.indexOf("### PM"));
    expect(utf8Bytes(pmCard)).toBeLessThanOrEqual(ROUTER_PM_CARD_MAX_BYTES);
    expect(pmCard).not.toContain("- 主线:");
    expect(pmCard).toContain("- 做什么:");

    const medium = card({ catalog: { ...big, aliases: ["短"] } }, { activeWorkers: longWorkers.slice(0, 4), activeWorkerTotal: 4 });
    const mediumCard = render(medium);
    expect(mediumCard).toContain("- 别名: 短");
  });

  it("系统提示词写明名片看不准时用 hub dispatch project-show 展开，单轮最多查 ROUTER_PROJECT_SHOW_PER_TURN_MAX 个", () => {
    const prompt = buildRouterSystemPrompt();
    expect(prompt).toContain("hub dispatch project-show --device <self|deviceId> --project <projectId>");
    expect(prompt).toContain(`一轮最多查 ${ROUTER_PROJECT_SHOW_PER_TURN_MAX} 个`);
    expect(prompt).toContain("别名");
  });
});
