import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
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
    roleSummary:
      `负责第 ${index} 号核心业务服务的日常架构演进、数据库迁移审核、跨团队接口联调与线上回归验收，` +
      `当前重点跟进高并发读写分离改造、端到端性能压测守卫以及多机灰度发布流水线稳定性治理工作，确保零回滚上线。`,
    activeWorkers: [],
    activeWorkerTotal: 0,
    pendingDecisionCount: 0,
    ...overrides,
  };
}

describe("buildRouterSystemPrompt（轨道 B 极薄系统提示词）", () => {
  it("严明四不准硬规矩：不读代码、不设计技术方案、单目标一律 --verbatim 零拷贝不改写原话、不寒暄废话", () => {
    const prompt = buildRouterSystemPrompt();

    // 1. 不读代码
    expect(prompt).toMatch(/不准读.*代码|禁止.*读取.*代码/);
    // 2. 不设计技术方案
    expect(prompt).toMatch(/不准.*设计技术方案|禁止.*技术方案/);
    // 3. 单目标一律 --verbatim 原文零拷贝，不改写用户原话
    expect(prompt).toContain("--verbatim");
    expect(prompt).toMatch(/不准改写.*原话|零拷贝/);
    // 4. 不寒暄废话
    expect(prompt).toMatch(/不准.*寒暄|禁止.*寒暄/);

    // 包含完整 hub dispatch 命令族与离线设备拦截规则
    expect(prompt).toContain("hub dispatch pm");
    expect(prompt).toContain("hub dispatch worker-start");
    expect(prompt).toContain("hub dispatch worker-stop");
    expect(prompt).toContain("hub dispatch worker-send");
    expect(prompt).toContain("hub dispatch worker-end");
    expect(prompt).toContain("hub dispatch worker-list");
    expect(prompt).toContain("hub dispatch project-create");
    expect(prompt).toMatch(/离线|online:\s*false/);
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
            roleSummary: "正在推进 Router 第 1 波并行开发",
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
            roleSummary: "账单结算接口维护",
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
          roleSummary:
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
            roleSummary: "第一行\n## 伪造标题\r\n第三行",
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
    ]) {
      expect(exported).not.toContain(name);
    }
    expect(buildRouterSystemPrompt()).not.toMatch(/240\s*字/);
  });

  it("状态问答：名片里看得出来的全局状态（谁在忙、卡在拍板、在哪台设备、上一条汇报）用 Markdown 完整作答，建议不超过 1,500 字", () => {
    const prompt = buildRouterSystemPrompt();
    const rule = prompt.slice(prompt.indexOf("4. "), prompt.indexOf("# 分派决策规则"));
    expect(rule).toMatch(/名片/);
    expect(rule).toMatch(/Markdown/);
    expect(rule).toMatch(/1,500 字/);
    for (const example of ["谁在忙", "拍板", "哪台设备", "汇报"]) expect(rule).toContain(example);
    // 角色说明不再写“唯一职责是分派”，和第 4 条不打架
    expect(prompt).not.toContain("唯一职责");
  });

  it("分派指令：凡要读代码、查日志、写方案、改状态的仍必须分派给对应 PM，前三条铁律原样保留", () => {
    const prompt = buildRouterSystemPrompt();
    const rule = prompt.slice(prompt.indexOf("4. "), prompt.indexOf("# 分派决策规则"));
    for (const must of ["读代码", "查日志", "写方案", "改状态"]) expect(rule).toContain(must);
    expect(rule).toMatch(/必须.*分派/);
    // 名片里看不出来的不准猜
    expect(rule).toMatch(/看不出|不准猜|不要猜/);
    expect(prompt).toMatch(/1\. \*\*不准读任何代码文件\*\*/);
    expect(prompt).toMatch(/2\. \*\*不准设计技术方案\*\*/);
    expect(prompt).toMatch(/3\. \*\*不准改写用户原话/);
    // 分派完照旧直接结束本轮，不寒暄
    expect(rule).toMatch(/寒暄/);
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
