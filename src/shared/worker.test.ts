import { describe, expect, it } from "vitest";
import {
  REPORT_END,
  REPORT_START,
  UNFORMATTED_LABEL,
  WORKER_REPORT_FORMAT,
  WORKER_REPORT_STATUSES,
  WORKER_REPORT_STATUS_LABELS,
  parseWorkerReport,
  workerBranchName,
  workerLineText,
  workerReportHeader,
} from "./worker.ts";
import { WORKER_LINE_SUMMARY_CHARS } from "./limits.ts";
import { WORKER_BRANCH_PREFIX } from "./names.ts";

const report = (body: string) => `${REPORT_START}\n${body}\n${REPORT_END}`;

const standard = report(`状态: 做完了
摘要: 修好了 X，加了一条测试
提交: a1b2c3d
测试: pnpm test，全过
问题: 无`);

describe("汇报格式", () => {
  it("说明里有开头、结尾和五项，状态的三种写法", () => {
    expect(REPORT_START).toBe("=== 汇报 ===");
    expect(REPORT_END).toBe("=== 汇报结束 ===");
    for (const key of ["状态:", "摘要:", "提交:", "测试:", "问题:"]) expect(WORKER_REPORT_FORMAT).toContain(key);
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
      report: { status: "done", summary: "修好了 X，加了一条测试", commit: "a1b2c3d", tests: "pnpm test，全过", questions: "无" },
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
      report: { status: "gave_up", summary: "做不了，缺权限", commit: null, tests: "", questions: "" },
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
});

describe("回到项目经理那一行", () => {
  it("交给项目经理的开头", () => {
    expect(workerReportHeader(3, "修 X")).toBe("【Worker #3 · 修 X 的汇报】");
  });

  it("那一行的文字：Worker · 标题 · 状态：摘要", () => {
    expect(workerLineText({ title: "修 X", event: "started", status: null, summary: null, readonly: false })).toBe("Worker · 修 X · 已派出");
    expect(workerLineText({ title: "查 Y", event: "started", status: null, summary: null, readonly: true })).toBe("Worker · 查 Y · 已派出（只读）");
    expect(workerLineText({ title: "修 X", event: "report", status: "done", summary: "好了", readonly: false })).toBe("Worker · 修 X · 做完了：好了");
    expect(workerLineText({ title: "修 X", event: "report", status: "unformatted", summary: null, readonly: false })).toBe(
      "Worker · 修 X · 没按格式",
    );
    expect(workerLineText({ title: "修 X", event: "report", status: "unformatted", summary: "改好了", readonly: false })).toBe(
      "Worker · 修 X · 没按格式：改好了",
    );
    expect(workerLineText({ title: "修 X", event: "turn_failed", status: null, summary: "被停止了", readonly: false })).toBe(
      "Worker · 修 X · 这一轮没做完：被停止了",
    );
    expect(workerLineText({ title: "修 X", event: "worktree_failed", status: null, summary: "目录被占用", readonly: false })).toBe(
      "Worker · 修 X · 建 worktree 失败：目录被占用",
    );
    expect(workerLineText({ title: "修 X", event: "ended", status: null, summary: null, readonly: false })).toBe("Worker · 修 X · 已收工");
  });

  it("摘要的空白压成一个空格，太长按字数截断", () => {
    const line = (summary: string) => workerLineText({ title: "修 X", event: "report", status: "done", summary, readonly: false });
    expect(line("第一行\n\n  第二行\t结尾  ")).toBe("Worker · 修 X · 做完了：第一行 第二行 结尾");
    expect(line("字".repeat(WORKER_LINE_SUMMARY_CHARS))).toBe(`Worker · 修 X · 做完了：${"字".repeat(WORKER_LINE_SUMMARY_CHARS)}`);
    expect(line("字".repeat(WORKER_LINE_SUMMARY_CHARS + 1))).toBe(`Worker · 修 X · 做完了：${"字".repeat(WORKER_LINE_SUMMARY_CHARS - 1)}…`);
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
