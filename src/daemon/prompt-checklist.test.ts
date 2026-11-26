import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUB_COMMAND } from "../shared/names.ts";
import type { AgentVendor } from "../shared/vendors.ts";
import { checklistPromptTool } from "../vendors/_common/checklist.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { buildLaunchPrompt, checklistReminderNote, checklistRuleSection } from "./prompt.ts";
import { noProjectContext, workerContext } from "./test-helpers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-prompt-checklist-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VENDORS = VENDOR_LIST.map((spec) => [spec.id, spec] as const);

function prompts(vendor: AgentVendor): { pm: string; worker: string } {
  const pm = noProjectContext();
  return {
    pm: buildLaunchPrompt({ ...pm, pm: { ...pm.pm, vendor } }, dir),
    worker: buildLaunchPrompt({ ...workerContext(), vendor }, dir),
  };
}

describe(checklistPromptTool.name, () => {
  it.each(VENDORS)("%s: names its own tool when it reports a checklist, otherwise hub checklist", (_id, spec) => {
    const { tool, hub } = checklistPromptTool(spec);
    expect(tool.trim()).not.toBe("");
    expect(hub).toBe(spec.checklist.sources.length === 0);
    if (hub) expect(tool).toContain(`${HUB_COMMAND} checklist`);
    else expect(tool).toBe(spec.checklist.promptTool);
  });
});

describe(checklistRuleSection.name, () => {
  it.each(VENDORS)("%s: PM and Worker prompts both carry the same section", (id) => {
    const section = checklistRuleSection(id);
    expect(section.startsWith("# 进度清单")).toBe(true);
    const { pm, worker } = prompts(id);
    expect(pm).toContain(section);
    expect(worker).toContain(section);
  });

  it.each(VENDORS)("%s: names the vendor's tool, the trigger, the timing, progress, closing, and the exemption", (id, spec) => {
    const section = checklistRuleSection(id);
    const { tool, hub } = checklistPromptTool(spec);
    expect(section).toContain(tool);
    if (hub) for (const sub of ["set", "start", "done", "cancel"]) expect(section).toContain(`${HUB_COMMAND} checklist ${sub}`);
    for (const phrase of ["改文件", "两条以上命令", "第一个", "进行中", "完成", "结束前", "纯问答", "不用列"]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it.each(VENDORS)("%s: the old three-step bullet is gone", (id) => {
    const { pm, worker } = prompts(id);
    for (const prompt of [pm, worker]) expect(prompt).not.toContain("一轮要做 3 步或更多时");
  });

  it.each(VENDORS)("%s: the section and both prompts are byte-stable across builds", (id) => {
    expect(checklistRuleSection(id)).toBe(checklistRuleSection(id));
    const first = prompts(id);
    const second = prompts(id);
    expect(second.pm).toBe(first.pm);
    expect(second.worker).toBe(first.worker);
  });

  it("names no vendor id in the shared rule text", () => {
    const [first, second] = VENDOR_LIST.filter((spec) => spec.checklist.sources.length > 0);
    if (first === undefined || second === undefined) throw new Error("need two vendors with a checklist source");
    const withoutTool = (id: string, tool: string) => checklistRuleSection(id).split(tool).join("<tool>");
    expect(withoutTool(first.id, checklistPromptTool(first).tool)).toBe(withoutTool(second.id, checklistPromptTool(second).tool));
  });
});

describe(checklistReminderNote.name, () => {
  it.each(VENDORS)("%s: a system note naming the same tool as the section", (id, spec) => {
    const note = checklistReminderNote(id);
    expect(note.startsWith("【系统】")).toBe(true);
    expect(note).toContain(checklistPromptTool(spec).tool);
    expect(note).not.toContain("\n");
    expect(checklistReminderNote(id)).toBe(note);
  });

  it("does not say this turn, because it may arrive with the next message", () => {
    for (const spec of VENDOR_LIST) expect(checklistReminderNote(spec.id)).not.toContain("这一轮你");
  });
});

describe("Antigravity uses its built-in update_steps tool", () => {
  it("names update_steps rather than the hub fallback, and treats the call as a checklist tool", () => {
    const agy = VENDOR_LIST.find((spec) => spec.id === "agy");
    if (agy === undefined) throw new Error("agy is not registered");
    expect(checklistPromptTool(agy)).toEqual({ tool: "`update_steps`", hub: false });
    expect(agy.tools?.actions.update_steps).toBe("todo");
    expect(checklistRuleSection("agy")).toContain("`update_steps`");
  });
});
