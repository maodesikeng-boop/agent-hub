import { describe, expect, it } from "vitest";
import {
  REPORT_END,
  REPORT_START,
  UNFORMATTED_LABEL,
  WORKER_REPORT_FORMAT,
  WORKER_REPORT_STATUSES,
  WORKER_REPORT_STATUS_LABELS,
  deliveryParts,
  extractReportPrUrl,
  hasReportQuestion,
  parseWorkerReport,
  workerPickNote,
  workerPickOf,
  userToWorkerHeader,
  workerBranchName,
  workerLineText,
  workerReportHeader,
} from "./worker.ts";
import { agentTextOf } from "./attachments.ts";
import { HUB_COMPOSER_COMMANDS } from "./api.ts";
import { workerPickSchema } from "./worker-pick-schema.ts";
import { AGENT_VENDORS, vendorSpec } from "./vendors.ts";
import { WORKER_LINE_SUMMARY_CHARS } from "./limits.ts";
import { WORKER_BRANCH_PREFIX } from "./names.ts";

const ATTACHMENT = { id: "u1", name: "图.png", path: "/data/uploads/u1/图.png", size: 10, mime: "image/png" };

const report = (body: string) => `${REPORT_START}\n${body}\n${REPORT_END}`;

const standard = report(`状态: 做完了
摘要: 修好了 X，加了一条测试
提交: a1b2c3d
测试: pnpm test，全过
问题: 无`);

describe("汇报格式", () => {
  it("说明里有开头、结尾和八项，状态的三种写法", () => {
    expect(REPORT_START).toBe("=== 汇报 ===");
    expect(REPORT_END).toBe("=== 汇报结束 ===");
    for (const key of ["状态:", "摘要:", "PR:", "提交:", "测试:", "偏离:", "交棒:", "问题:"]) expect(WORKER_REPORT_FORMAT).toContain(key);
    expect(WORKER_REPORT_FORMAT).toContain("做完了 | 有问题 | 放弃了");
    expect(WORKER_REPORT_STATUSES).toEqual(["done", "problem", "gave_up"]);
    expect(WORKER_REPORT_STATUS_LABELS).toEqual({ done: "做完了", problem: "有问题", gave_up: "放弃了" });
    expect(UNFORMATTED_LABEL).toBe("没按格式");
  });

  it("说明本身就能被解析", () => {
    const example = WORKER_REPORT_FORMAT.replace("做完了 | 有问题 | 放弃了", "有问题");
    expect(parseWorkerReport(example).kind).toBe("ok");
  });
});

describe("parseWorkerReport", () => {
  it("标准格式", () => {
    expect(parseWorkerReport(standard)).toEqual({
      kind: "ok",
      report: {
        status: "done",
        summary: "修好了 X，加了一条测试",
        commit: "a1b2c3d",
        pr: null,
        tests: "pnpm test，全过",
        deviation: null,
        handoff: "",
        questions: "无",
      },
    });
  });

  it("前面有别的文字", () => {
    const parsed = parseWorkerReport(`我先看了代码，然后改了两处。\n\n${standard}\n`);
    expect(parsed).toMatchObject({ kind: "ok", report: { status: "done", summary: "修好了 X，加了一条测试" } });
  });

  it("写了两段，取最后一段", () => {
    const first = report("状态: 有问题\n摘要: 第一次\n提交: 无\n测试: 无\n问题: 要不要改接口？");
    const parsed = parseWorkerReport(`${first}\n\n后来又想了想。\n\n${standard}`);
    expect(parsed).toMatchObject({ kind: "ok", report: { status: "done", summary: "修好了 X，加了一条测试" } });
  });

  it("最后一段没写完（没有结尾），取前面那段完整的", () => {
    const parsed = parseWorkerReport(`${standard}\n\n${REPORT_START}\n状态: 放弃了`);
    expect(parsed).toMatchObject({ kind: "ok", report: { status: "done" } });
  });

  it("没有格式：summary 是原文第一行（不是空的那行），空白压成一个、太长截断", () => {
    expect(parseWorkerReport("改好了，你看看。")).toEqual({ kind: "unformatted", summary: "改好了，你看看。" });
    expect(parseWorkerReport("")).toEqual({ kind: "unformatted", summary: "" });
    expect(parseWorkerReport(`\n\n  第一行   有  空白\n第二行`)).toEqual({ kind: "unformatted", summary: "第一行 有 空白" });
    expect(parseWorkerReport(`${REPORT_START}\n状态: 做完了\n摘要: 好了`)).toEqual({ kind: "unformatted", summary: REPORT_START });
    const long = parseWorkerReport("字".repeat(WORKER_LINE_SUMMARY_CHARS + 10));
    expect(long).toEqual({ kind: "unformatted", summary: `${"字".repeat(WORKER_LINE_SUMMARY_CHARS - 1)}…` });
  });

  it("状态写错", () => {
    expect(parseWorkerReport(report("状态: 完成\n摘要: 好了"))).toMatchObject({ kind: "unformatted" });
    expect(parseWorkerReport(report("摘要: 好了"))).toMatchObject({ kind: "unformatted" });
  });

  it("没写摘要也算没按格式", () => {
    expect(parseWorkerReport(report("状态: 做完了\n摘要:\n提交: 无"))).toMatchObject({ kind: "unformatted" });
  });

  it("Markdown 写法也认：列表符号、引用、加粗；状态后面带标点", () => {
    for (const body of [
      "- 状态: 做完了\n- 摘要: 好了",
      "* 状态: 做完了\n* 摘要: 好了",
      "> 状态: 做完了\n> 摘要: 好了",
      "**状态**: 做完了\n**摘要**: 好了",
      "**状态:** 做完了\n**摘要：** 好了",
      "- **状态**：做完了。\n- **摘要**：好了",
      "状态: 「做完了」\n摘要: 好了",
    ]) {
      expect(parseWorkerReport(report(body)), body).toMatchObject({ kind: "ok", report: { status: "done", summary: "好了" } });
    }
  });

  it("提交写“无（没提交）”这类也当没有提交", () => {
    for (const commit of ["无", "无（没提交）", "无，只读调查", "无。"]) {
      expect(parseWorkerReport(report(`状态: 做完了\n摘要: 好了\n提交: ${commit}`)), commit).toMatchObject({ report: { commit: null } });
    }
  });

  it("全角冒号、首尾空白、提交写“无”、缺了的项是空串", () => {
    expect(parseWorkerReport(report("  状态：放弃了  \n摘要：  做不了，缺权限 \n提交：无"))).toEqual({
      kind: "ok",
      report: {
        status: "gave_up",
        summary: "做不了，缺权限",
        commit: null,
        pr: null,
        tests: "",
        deviation: null,
        handoff: "",
        questions: "",
      },
    });
  });

  it("一项写了好几行：接着上一项", () => {
    const parsed = parseWorkerReport(report("状态: 有问题\n摘要: 改了一半\n提交: 无\n测试: 没跑\n问题: 1. 要不要改 AGENTS.md？\n2. 能不能装 jq？"));
    expect(parsed).toMatchObject({ kind: "ok", report: { status: "problem", questions: "1. 要不要改 AGENTS.md？\n2. 能不能装 jq？" } });
  });

  it("Windows 换行也行", () => {
    expect(parseWorkerReport(standard.replaceAll("\n", "\r\n"))).toMatchObject({ kind: "ok", report: { status: "done", commit: "a1b2c3d" } });
  });

  it("解析出的摘要不截断（完整的留给项目经理），截断只在那一行里", () => {
    const summary = "长".repeat(WORKER_LINE_SUMMARY_CHARS + 5);
    expect(parseWorkerReport(report(`状态: 做完了\n摘要: ${summary}`))).toMatchObject({ report: { summary } });
  });

  it("支持解析 PR、偏离、交棒三栏：PR URL 提取、偏离为无与以“无”开头的真偏离区分、多行交棒与问题判断", () => {
    const withHandoff = parseWorkerReport(
      report(
        [
          "状态: 做完了",
          "摘要: 实现自动开工与交棒",
          "提交: 1a2b3c4",
          "PR: https://github.com/org/repo/pull/312",
          "测试: pnpm vitest run，全绿",
          "偏离: 无",
          "交棒: 改动集中在 src/daemon/ledger/task-graphs.ts",
          "- 注意检查异步恢复时序",
          "问题: 无（全部明确）",
        ].join("\n"),
      ),
    );
    expect(withHandoff).toEqual({
      kind: "ok",
      report: {
        status: "done",
        summary: "实现自动开工与交棒",
        commit: "1a2b3c4",
        pr: "https://github.com/org/repo/pull/312",
        tests: "pnpm vitest run，全绿",
        deviation: null,
        handoff: "改动集中在 src/daemon/ledger/task-graphs.ts\n- 注意检查异步恢复时序",
        questions: "无（全部明确）",
      },
    });
    if (withHandoff.kind === "ok") {
      expect(extractReportPrUrl(withHandoff.report.pr)).toBe("https://github.com/org/repo/pull/312");
      expect(hasReportQuestion(withHandoff.report.questions)).toBe(false);
    }

    // PR: 无 或说明性文字不提取为 URL；带说明文字包裹的链接也能干净提取
    for (const nonePr of ["无", "无（本步只读）", "无，不用提 PR"]) {
      const p = parseWorkerReport(report(`状态: 做完了\n摘要: 调研完\nPR: ${nonePr}`));
      expect(p).toMatchObject({ kind: "ok", report: { pr: null } });
    }
    expect(extractReportPrUrl("PR #315（https://github.com/org/repo/pull/315）。")).toBe("https://github.com/org/repo/pull/315");
    expect(extractReportPrUrl(null)).toBeNull();

    // 以“无”开头的真实中文句子（如“无法…”、“无需…”）绝不能误判成无偏离或无问题
    const realDev = parseWorkerReport(
      report("状态: 做完了\n摘要: 改用方案 B\n偏离: 无法沿用旧表结构，改为新建扩展表\n问题: 无需新建配置项，是否认可？"),
    );
    expect(realDev).toMatchObject({
      kind: "ok",
      report: {
        deviation: "无法沿用旧表结构，改为新建扩展表",
        questions: "无需新建配置项，是否认可？",
      },
    });
    if (realDev.kind === "ok") {
      expect(hasReportQuestion(realDev.report.questions)).toBe(true);
    }
  });

  it("多行交棒含同名子列表与围栏代码块时不截断、不覆盖顶层状态或冲掉偏离刹车，且支持横线占位符", () => {
    const complexBody = [
      "状态: 做完了",
      "摘要: 完成迁移兼容层",
      "提交: -",
      "PR: -",
      "测试: pnpm vitest run test/migration.test.ts 全绿",
      "偏离: 旧视图仍被外部脚本读取，改为保留只读兼容视图",
      "交棒:",
      "下游审查请重点关注以下子项：",
      "- 测试: 复核高并发写入锁",
      "- 状态: 灰度开关默认关闭",
      "- 偏离: 无",
      "```ts",
      "const sample = {",
      '  pr: "https://github.com/org/repo/pull/999",',
      '  状态: "不是顶层状态",',
      "  偏离: null,",
      "};",
      "```",
      "  问题: 缩进子行也不应覆盖顶层问题栏",
      "问题: 无",
    ].join("\n");

    const parsed = parseWorkerReport(report(complexBody));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.report.status).toBe("done");
      expect(parsed.report.summary).toBe("完成迁移兼容层");
      expect(parsed.report.commit).toBeNull();
      expect(parsed.report.pr).toBeNull();
      expect(parsed.report.tests).toBe("pnpm vitest run test/migration.test.ts 全绿");
      // 顶层真实偏离绝不能被交棒子列表里的“- 偏离: 无”冲掉
      expect(parsed.report.deviation).toBe("旧视图仍被外部脚本读取，改为保留只读兼容视图");
      expect(parsed.report.handoff).toContain("- 测试: 复核高并发写入锁");
      expect(parsed.report.handoff).toContain("- 状态: 灰度开关默认关闭");
      expect(parsed.report.handoff).toContain('pr: "https://github.com/org/repo/pull/999"');
      expect(parsed.report.handoff).toContain("缩进子行也不应覆盖顶层问题栏");
      expect(parsed.report.questions).toBe("无");
    }

    const dashNone = parseWorkerReport(report("状态: 做完了\n摘要: 小修\n偏离: -\n问题: —"));
    expect(dashNone).toMatchObject({
      kind: "ok",
      report: { status: "done", deviation: null },
    });
    if (dashNone.kind === "ok") {
      expect(hasReportQuestion(dashNone.report.questions)).toBe(false);
    }
  });
});

describe("回到项目经理那一行", () => {
  it("交给项目经理的开头", () => {
    expect(workerReportHeader(3, "修 X")).toBe("【Worker #3 · 修 X 的汇报】");
  });

  it("那一行的文字：Worker「标题」状态：摘要", () => {
    expect(workerLineText({ title: "修 X", event: "started", status: null, summary: null, readonly: false })).toBe("Worker「修 X」已派出");
    expect(workerLineText({ title: "查 Y", event: "started", status: null, summary: null, readonly: true })).toBe("Worker「查 Y」已派出（只读）");
    expect(workerLineText({ title: "修 X", event: "report", status: "done", summary: "好了", readonly: false })).toBe("Worker「修 X」做完了：好了");
    expect(workerLineText({ title: "修 X", event: "report", status: "unformatted", summary: null, readonly: false })).toBe(
      "Worker「修 X」没按格式",
    );
    expect(workerLineText({ title: "修 X", event: "report", status: "unformatted", summary: "改好了", readonly: false })).toBe(
      "Worker「修 X」没按格式：改好了",
    );
    expect(workerLineText({ title: "修 X", event: "turn_failed", status: null, summary: "被停止了", readonly: false })).toBe(
      "Worker「修 X」这一轮没做完：被停止了",
    );
    expect(workerLineText({ title: "修 X", event: "worktree_failed", status: null, summary: "目录被占用", readonly: false })).toBe(
      "Worker「修 X」建 worktree 失败：目录被占用",
    );
    expect(workerLineText({ title: "修 X", event: "ended", status: null, summary: null, readonly: false })).toBe("Worker「修 X」已收工");
    expect(workerLineText({ title: "修 X", event: "user_message", status: null, summary: "顺便\n改 README", readonly: false })).toBe(
      "Worker「修 X」你对它说：顺便 改 README",
    );
  });

  it("用户直接对 Worker 说的话：交给项目经理的开头；写给 Worker 时带【用户直接对你说】标签（单独一块），项目经理的话和别的对话里的没有标签", () => {
    expect(userToWorkerHeader(3, "修 X")).toBe("【用户直接对 Worker #3 · 修 X 说的话（Worker 已收到）】");
    expect(deliveryParts({ workerId: 3, sender: "user", text: "改 README", meta: null })).toEqual({ prefixes: ["【用户直接对你说】"], text: "改 README" });
    expect(deliveryParts({ workerId: 3, sender: "pm", text: "改 README", meta: null })).toEqual({ prefixes: [], text: "改 README" });
    expect(deliveryParts({ workerId: null, sender: "user", text: "改 README", meta: null })).toEqual({ prefixes: [], text: "改 README" });
    // 带附件：原文和附件路径在 text 里（和项目经理收到的一样，见 agentTextOf），标签另放
    const withFile = { workerId: 3, sender: "user" as const, text: "看这张图", meta: { attachments: [ATTACHMENT] } };
    expect(deliveryParts(withFile)).toEqual({ prefixes: ["【用户直接对你说】"], text: agentTextOf(withFile) });
    expect(agentTextOf(withFile)).toContain(ATTACHMENT.path);
  });

  it("以 / 开头的原文原样留在 text 的开头，标签不和它拼在一起（命令才会被展开）", () => {
    expect(deliveryParts({ workerId: 3, sender: "user", text: "/x 参数", meta: null })).toEqual({ prefixes: ["【用户直接对你说】"], text: "/x 参数" });
  });

  it("摘要的空白压成一个空格，太长按字数截断", () => {
    const line = (summary: string) => workerLineText({ title: "修 X", event: "report", status: "done", summary, readonly: false });
    expect(line("第一行\n\n  第二行\t结尾  ")).toBe("Worker「修 X」做完了：第一行 第二行 结尾");
    expect(line("字".repeat(WORKER_LINE_SUMMARY_CHARS))).toBe(`Worker「修 X」做完了：${"字".repeat(WORKER_LINE_SUMMARY_CHARS)}`);
    expect(line("字".repeat(WORKER_LINE_SUMMARY_CHARS + 1))).toBe(`Worker「修 X」做完了：${"字".repeat(WORKER_LINE_SUMMARY_CHARS - 1)}…`);
    expect(WORKER_LINE_SUMMARY_CHARS).toBe(120);
  });
});

describe("workerBranchName", () => {
  it("hub/<编号>-<短名>：小写，空白和符号变成 -，中文保留", () => {
    expect(workerBranchName(3, "Fix README typo")).toBe(`${WORKER_BRANCH_PREFIX}3-fix-readme-typo`);
    expect(workerBranchName(12, "修 X 的 bug!")).toBe(`${WORKER_BRANCH_PREFIX}12-修-x-的-bug`);
    expect(workerBranchName(4, "a/b..c~d^e:f?g*h[i]\\j@{k}")).toBe(`${WORKER_BRANCH_PREFIX}4-a-b-c-d-e-f-g-h-i-j-k`);
  });

  it("带重音的字母不拆开：先 NFC，组合用的附加符号也算字母的一部分", () => {
    expect(workerBranchName(7, "éclair")).toBe(`${WORKER_BRANCH_PREFIX}7-éclair`);
    expect(workerBranchName(7, "e\u0301clair")).toBe(`${WORKER_BRANCH_PREFIX}7-éclair`);
    expect(workerBranchName(8, "नमस्ते")).toBe(`${WORKER_BRANCH_PREFIX}8-नमस्ते`);
  });

  it("短名太长截断；整个是符号就只有编号", () => {
    expect(workerBranchName(5, "x".repeat(200))).toBe(`${WORKER_BRANCH_PREFIX}5-${"x".repeat(30)}`);
    expect(workerBranchName(6, "!!! ...")).toBe(`${WORKER_BRANCH_PREFIX}6`);
  });
});

describe("输入框指定派 Worker 的厂商、模型、思考程度（workerPick）", () => {
  const user = { workerId: null, sender: "user" as const, text: "把 A 拆成三块并行做" };
  const vendor = AGENT_VENDORS[0]!;
  const model = vendorSpec(vendor).models.bundled[0]!.id;

  it("参数句子：三项都选了就写 --vendor --model --effort；Default（null）的项不写；只选厂商只出 --vendor", () => {
    expect(workerPickNote({ vendor, model, effort: "high" })).toBe(`【用户指定：这条消息里派的 Worker 用 --vendor ${vendor} --model ${model} --effort high】`);
    expect(workerPickNote({ vendor, model, effort: null })).toBe(`【用户指定：这条消息里派的 Worker 用 --vendor ${vendor} --model ${model}】`);
    expect(workerPickNote({ vendor, model: null, effort: "low" })).toBe(`【用户指定：这条消息里派的 Worker 用 --vendor ${vendor} --effort low】`);
    expect(workerPickNote({ vendor, model: null, effort: null })).toBe(`【用户指定：这条消息里派的 Worker 用 --vendor ${vendor}】`);
  });

  it("deliveryParts：有 pick 时 prefixes 多一块，原文仍是最后一块（以 / 开头照样原样）", () => {
    const pick = { vendor, model, effort: "high" };
    const note = workerPickNote(pick);
    expect(deliveryParts({ ...user, meta: { workerPick: pick } })).toEqual({ prefixes: [note], text: user.text });
    expect(deliveryParts({ ...user, text: "/review 这个 PR", meta: { workerPick: pick } })).toEqual({ prefixes: [note], text: "/review 这个 PR" });
    // 和附件一起：原文 + 附件路径在 text 里，pick 另放
    const both = { ...user, meta: { workerPick: pick, attachments: [ATTACHMENT] } };
    expect(deliveryParts(both)).toEqual({ prefixes: [note], text: agentTextOf(both) });
    expect(agentTextOf(both)).toContain(ATTACHMENT.path);
  });

  it("没有 pick、meta 是 null、pick 形状不对（老消息、被改过的库）：和以前一样，prefixes 为空", () => {
    expect(deliveryParts({ ...user, meta: null })).toEqual({ prefixes: [], text: user.text });
    expect(deliveryParts({ ...user, meta: { attachments: [] } })).toEqual({ prefixes: [], text: user.text });
    expect(deliveryParts({ ...user, meta: { workerPick: { vendor: "nope", model: null, effort: null } } }).prefixes).toEqual([]);
    expect(deliveryParts({ ...user, meta: { workerPick: "codex" } }).prefixes).toEqual([]);
    expect(workerPickOf({ meta: { workerPick: { vendor, model: 3, effort: null } } })).toBeNull();
  });

  it("不是用户发的消息不带 pick 块；不会盖掉 Worker 对话里的标签", () => {
    const pick = { vendor, model: null, effort: null };
    expect(deliveryParts({ workerId: null, sender: "pm", text: "x", meta: { workerPick: pick } }).prefixes).toEqual([]);
    expect(deliveryParts({ workerId: 3, sender: "user", text: "x", meta: { workerPick: pick } }).prefixes).toEqual(["【用户直接对你说】", workerPickNote(pick)]);
  });

  it("zod 校验：厂商在 AGENT_VENDORS 里、模型过 checkModel、档位是短字符串；多余的字段、缺字段都不行", () => {
    expect(workerPickSchema.safeParse({ vendor, model, effort: "high" }).success).toBe(true);
    expect(workerPickSchema.safeParse({ vendor, model: null, effort: null }).success).toBe(true);
    for (const bad of [
      { vendor: "nope", model: null, effort: null },
      { vendor, model: "bad model", effort: null },
      { vendor, model: "x".repeat(101), effort: null },
      { vendor, model: null, effort: "" },
      { vendor, model: null, effort: "x".repeat(41) },
      { vendor, model: null, effort: "high】 --vendor evil" },
      { vendor, model: null },
      { model: null, effort: null },
      { vendor, model: null, effort: null, extra: 1 },
      { vendor, model: 1, effort: null },
      "codex",
      null,
    ]) {
      expect(workerPickSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("HUB_COMPOSER_COMMANDS：hub:worker 的名字和说明放在 shared", () => {
    expect(HUB_COMPOSER_COMMANDS).toEqual([{ name: "hub:worker", description: "Pick provider, model and effort for Workers" }]);
  });
});
