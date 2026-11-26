import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HUB_HELP_ONLY_COMMANDS } from "../shared/hub.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { taskGraphSkillCatalogEntry } from "../shared/task-graph-skill.ts";
import { HUB_USAGE_PROMPT, buildFingerprintPrompt } from "./prompt.ts";
import { projectContext, workerContext } from "./test-helpers.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// Updating any pinned hash restarts live sessions and triggers a one-time full cache write per session.
const PINNED_HUB_USAGE_PROMPT_SHA = "96c0b31df31be77752cea30fcb146739a8dad8cf834b9a0d9264c4dea53713ad";
const PINNED_SKILL_CATALOG_SHA = "379bde7b4a3182276ba37d31a17c960c6a44cbaef1596d041c49fddfa83605e9";
const PINNED_PM_FINGERPRINT_PROMPT_SHA = "21aec72504887c84847c4a6d4f48eecfb6b0044d735891cfae10fc747b3eca00";
const PINNED_WORKER_FINGERPRINT_PROMPT_SHA = "ec9f82da7793d7baa57ed19dfa04b7c162617c0ed3fcda543634802f75d2137e";

const CACHE_REBUILD_HINT =
  "Changing this prefix restarts every live session and forces a one-time full prompt-cache rebuild; if intentional, update the hash and state the cache cost in the PR description.";

describe("S8: launch fingerprint prefix guard (prompt cache stability)", () => {
  it("pins HUB_USAGE_PROMPT so help-only hub commands never alter live system prompts", () => {
    expect(Object.keys(HUB_HELP_ONLY_COMMANDS).length).toBeGreaterThan(0);
    expect(sha256(HUB_USAGE_PROMPT), CACHE_REBUILD_HINT).toBe(PINNED_HUB_USAGE_PROMPT_SHA);
  });

  it("pins taskGraphSkillCatalogEntry so manual body updates never restart PM sessions", () => {
    expect(sha256(taskGraphSkillCatalogEntry()), CACHE_REBUILD_HINT).toBe(PINNED_SKILL_CATALOG_SHA);
  });

  it("pins canonical PM and Worker fingerprint prompts and confirms persona/mode edits keep the PM fingerprint unchanged", () => {
    const pmBase = buildFingerprintPrompt(projectContext(), "/work/foo");
    const pmEdited = buildFingerprintPrompt(
      projectContext({
        pm: { id: 1, name: "小林", mode: "hands_on", vendor: "claude", persona: "完全不同的性格设定", personaRevision: 9 },
      }),
      "/work/foo",
    );
    expect(sha256(pmBase), CACHE_REBUILD_HINT).toBe(PINNED_PM_FINGERPRINT_PROMPT_SHA);
    expect(launchFingerprint({ prompt: pmEdited, settings: "", skills: taskGraphSkillCatalogEntry() })).toBe(
      launchFingerprint({ prompt: pmBase, settings: "", skills: taskGraphSkillCatalogEntry() }),
    );

    const workerBase = buildFingerprintPrompt(workerContext(), "/data/worktrees/1/5");
    expect(sha256(workerBase), CACHE_REBUILD_HINT).toBe(PINNED_WORKER_FINGERPRINT_PROMPT_SHA);
  });
});
