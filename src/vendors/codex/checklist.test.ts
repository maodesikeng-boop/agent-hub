import { describe, it } from "vitest";

describe("Codex checklist", () => {
  it.todo("turn/plan/updated from codex-plan.live.jsonl yields three replace updates in order");
  it.todo("returns null when plan is missing");
  it.todo("item/started startedAtMs becomes agent.tool startedAt; a missing value leaves it unset");
  it.todo("codex-default.live.jsonl yields no checklist event");
  it.todo("buildCodexArgs includes -c tools.update_plan.enabled=true");
});
