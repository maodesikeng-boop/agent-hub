import { describe, expect, it } from "vitest";
import { HUB_USAGE_PROMPT, WORKER_HUB_USAGE_PROMPT } from "../daemon/prompt.ts";
import { HUB_LIMITS, hubLimitsHelpLine, type HubLimitId, type HubLimitRule } from "../shared/hub-limits.ts";
import { HUB_MAX_BODY_BYTES, MAX_STEP_BRIEF_CHARS, ROUTER_REPORT_SUMMARY_MAX_CHARS } from "../shared/limits.ts";
import { HUB_COMMAND_SPECS, HUB_USAGE, commandUsageFor } from "./usage.ts";

function amount(rule: HubLimitRule): string {
  if (rule.unit === "chars") return `${rule.max} 字`;
  if (rule.unit === "items") return `${rule.max} 个`;
  return rule.max % 1024 === 0 ? `${rule.max / 1024} KB` : `${rule.max} 字节`;
}

const RULES = Object.entries(HUB_LIMITS) as [HubLimitId, HubLimitRule][];

describe("hub limits in help", () => {
  it("lists every rule under each of its commands in per-command usage", () => {
    for (const [id, rule] of RULES) {
      for (const command of rule.commands) {
        const spec = HUB_COMMAND_SPECS.find((s) => s.command === command)!;
        const usage = commandUsageFor(spec.action === undefined ? [spec.group] : [spec.group, spec.action]);
        expect(usage, `${id} under ${command}`).toContain(hubLimitsHelpLine(command)!);
        expect(usage, `${id} under ${command}`).toContain(`${rule.label} ${amount(rule)}`);
      }
    }
  });

  it("shows the limits the user hit in full hub help", () => {
    const sections = HUB_USAGE.split(/\n(?=  hub )/u);
    const of = (prefix: string) => sections.find((s) => s.startsWith(`  hub ${prefix}`)) ?? "";
    expect(of("graph create")).toContain(`步骤 brief ${MAX_STEP_BRIEF_CHARS} 字`);
    expect(of("graph patch")).toContain(`步骤 brief ${MAX_STEP_BRIEF_CHARS} 字`);
    expect(of("graph finish")).toContain(`交付摘要 ${ROUTER_REPORT_SUMMARY_MAX_CHARS} 字`);
    expect(of("router report")).toContain(`汇报摘要 ${ROUTER_REPORT_SUMMARY_MAX_CHARS} 字`);
    expect(of("ask ")).toContain("上限：");
  });

  it("states the stdin cap in the shared stdin note", () => {
    const stdinNote = HUB_USAGE.split("\n").find((line) => line.startsWith("长文本用 --stdin"))!;
    expect(stdinNote).toContain(`${HUB_LIMITS.stdin.label}最多 ${HUB_MAX_BODY_BYTES / 1024} KB`);
  });
});

describe("system prompts stay unchanged", () => {
  it("adds no limit line to the PM or Worker hub prompt", () => {
    for (const prompt of [HUB_USAGE_PROMPT, WORKER_HUB_USAGE_PROMPT]) {
      expect(prompt).not.toContain("上限：");
      expect(prompt).not.toContain("提问背景");
      expect(prompt).not.toContain("交付摘要");
    }
  });
});
