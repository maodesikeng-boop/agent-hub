import { describe, expect, it } from "vitest";
import {
  HUB_LIMITS,
  checkHubLimit,
  formatHubLimitViolations,
  hubLimitsHelpLine,
  measureHubLimit,
  splitAskCardText,
  type HubLimitId,
} from "./hub-limits.ts";
import {
  ASK_BODY_MAX_CHARS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_STEP_BRIEF_CHARS,
  MAX_TASK_BYTES,
  ROUTER_QUESTION_MAX_CHARS,
  ROUTER_REPORT_SUMMARY_MAX_CHARS,
} from "./limits.ts";
import { HUB_COMMANDS } from "./hub.ts";
import { taskGraphSkillBody } from "./task-graph-skill.ts";

describe("measureHubLimit", () => {
  it("counts characters by code point, bytes as UTF-8, and items by length", () => {
    expect(measureHubLimit("chars", "😀a字")).toBe(3);
    expect(measureHubLimit("bytes", "😀a字")).toBe(8);
    expect(measureHubLimit("items", ["a", "b"])).toBe(2);
  });

  it("rejects a value whose shape does not match the unit", () => {
    expect(() => measureHubLimit("items", "abc")).toThrow(TypeError);
    expect(() => measureHubLimit("chars", ["a"])).toThrow(TypeError);
  });
});

describe("checkHubLimit", () => {
  it("lets the limit itself pass and reports one over it", () => {
    expect(checkHubLimit("step.brief", "简".repeat(MAX_STEP_BRIEF_CHARS))).toBeNull();
    expect(checkHubLimit("step.brief", "简".repeat(MAX_STEP_BRIEF_CHARS + 1), "impl")).toEqual({
      id: "step.brief",
      target: "impl",
      actual: MAX_STEP_BRIEF_CHARS + 1,
      max: MAX_STEP_BRIEF_CHARS,
    });
  });

  it("counts a 400-emoji background as 400 characters", () => {
    expect(checkHubLimit("ask.body", "😀".repeat(ASK_BODY_MAX_CHARS))).toBeNull();
    expect(checkHubLimit("ask.body", "😀".repeat(ASK_BODY_MAX_CHARS + 1))?.actual).toBe(ASK_BODY_MAX_CHARS + 1);
  });
});

describe("formatHubLimitViolations", () => {
  it("names the field, the current size, the limit, and the tip", () => {
    const v = checkHubLimit("graph.finishSummary", "交".repeat(ROUTER_REPORT_SUMMARY_MAX_CHARS + 1))!;
    expect(formatHubLimitViolations([v])).toBe(
      `交付摘要有 ${ROUTER_REPORT_SUMMARY_MAX_CHARS + 1} 字，上限 ${ROUTER_REPORT_SUMMARY_MAX_CHARS} 字；细节写进各步骤的汇报或文件`,
    );
  });

  it("prefixes a step target, renders bytes as KB, and appends the no-effect line", () => {
    const brief = checkHubLimit("step.brief", "b".repeat(MAX_STEP_BRIEF_CHARS + 234), "impl")!;
    const task = checkHubLimit("worker.task", "t".repeat(MAX_TASK_BYTES + 5))!;
    expect(formatHubLimitViolations([brief, task], { noEffect: "这次改图没有生效" }).split("\n")).toEqual([
      `步骤「impl」的 brief有 ${MAX_STEP_BRIEF_CHARS + 234} 字，上限 ${MAX_STEP_BRIEF_CHARS} 字；长材料存成文件，brief 里写路径`,
      `任务说明有 ${MAX_TASK_BYTES + 5} 字节，上限 ${MAX_TASK_BYTES / 1024} KB；长材料存成文件，正文里写路径`,
      "这次改图没有生效",
    ]);
  });
});

describe("hubLimitsHelpLine", () => {
  it("lists every rule of a command in table order", () => {
    const line = hubLimitsHelpLine("ask")!;
    expect(line.trimStart().startsWith("上限：")).toBe(true);
    const ids = Object.keys(HUB_LIMITS) as HubLimitId[];
    let from = 0;
    for (const id of ids.filter((k) => (HUB_LIMITS[k].commands as readonly string[]).includes("ask"))) {
      const at = line.indexOf(HUB_LIMITS[id].label, from);
      expect(at, id).toBeGreaterThanOrEqual(from);
      from = at;
    }
    expect(line).toContain(`问题第一行 ${ROUTER_QUESTION_MAX_CHARS} 字`);
    expect(line).toContain(`提问背景 ${ASK_BODY_MAX_CHARS} 字`);
    expect(line).toContain(`步骤拍板卡背景 ${MAX_GATE_SUMMARY_CHARS} 字`);
  });

  it("returns null for a command without limits and a line for every command a rule names", () => {
    expect(hubLimitsHelpLine("status")).toBeNull();
    const named = new Set(Object.values(HUB_LIMITS).flatMap((r) => r.commands as readonly string[]));
    for (const command of HUB_COMMANDS) {
      expect(hubLimitsHelpLine(command) !== null, command).toBe(named.has(command));
    }
  });

  it("follows a changed rule value", () => {
    const rule = HUB_LIMITS["step.brief"] as { max: number };
    const original = rule.max;
    try {
      rule.max = 1234;
      expect(hubLimitsHelpLine("graph.create")).toContain("步骤 brief 1234 字");
      expect(formatHubLimitViolations([checkHubLimit("step.brief", "x".repeat(1235))!])).toContain("上限 1234 字");
    } finally {
      rule.max = original;
    }
  });
});

describe("splitAskCardText", () => {
  it("keeps a question and a background at their limits whole", () => {
    const question = "问".repeat(ROUTER_QUESTION_MAX_CHARS);
    const body = `${"景".repeat(ASK_BODY_MAX_CHARS - 40)}https://example.feishu.cn/docx/AbCdEf`.padEnd(ASK_BODY_MAX_CHARS, "x");
    expect(splitAskCardText(`${question}\r\n\r\n${body}\n`, false)).toEqual({ ok: true, card: { question, body } });
  });

  it("rejects a background one character over instead of cutting it", () => {
    const result = splitAskCardText(`要不要换成流式？\n\n${"景".repeat(ASK_BODY_MAX_CHARS + 123)}`, false);
    expect(result).toEqual({ ok: false, violations: [{ id: "ask.body", actual: ASK_BODY_MAX_CHARS + 123, max: ASK_BODY_MAX_CHARS }] });
  });

  it("rejects a single line longer than the question limit instead of splitting it", () => {
    const result = splitAskCardText("问".repeat(ROUTER_QUESTION_MAX_CHARS + 40), false);
    expect(result).toEqual({ ok: false, violations: [{ id: "ask.question", actual: ROUTER_QUESTION_MAX_CHARS + 40, max: ROUTER_QUESTION_MAX_CHARS }] });
  });

  it("uses the step-card limits for step asks", () => {
    expect(splitAskCardText(`${"问".repeat(MAX_GATE_QUESTION_CHARS)}\n${"景".repeat(MAX_GATE_SUMMARY_CHARS)}`, true).ok).toBe(true);
    const over = splitAskCardText(`${"问".repeat(MAX_GATE_QUESTION_CHARS + 1)}\n${"景".repeat(MAX_GATE_SUMMARY_CHARS + 1)}`, true);
    expect(over).toEqual({
      ok: false,
      violations: [
        { id: "ask.stepQuestion", actual: MAX_GATE_QUESTION_CHARS + 1, max: MAX_GATE_QUESTION_CHARS },
        { id: "ask.stepBody", actual: MAX_GATE_SUMMARY_CHARS + 1, max: MAX_GATE_SUMMARY_CHARS },
      ],
    });
  });

  it("returns a null body for a one-line ask and throws on blank text", () => {
    expect(splitAskCardText("  按方案 A 吗？  ", false)).toEqual({ ok: true, card: { question: "按方案 A 吗？", body: null } });
    expect(() => splitAskCardText(" \n ", false)).toThrow(RangeError);
  });
});

describe("unchanged shipped text", () => {
  it("keeps the Task Graph manual's handoff limits worded as before", () => {
    expect(taskGraphSkillBody()).toContain("总上限 12,000 字均分、单路最多 4,000 字");
  });
});
