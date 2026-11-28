import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HUB_HELP_ONLY_COMMANDS } from "../shared/hub.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { taskGraphSkillCatalogEntry } from "../shared/task-graph-skill.ts";
import { HUB_USAGE_PROMPT, buildFingerprintPrompt } from "./prompt.ts";
import { projectContext, workerContext } from "./test-helpers.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// Updating any pinned hash restarts live sessions and triggers a one-time full cache write per session.
const PINNED_HUB_USAGE_PROMPT_SHA = "4841b5863981b8fdec5af0397e46d9afc5db2e630e02ab9e9ee6291da3f72d47";
const PINNED_SKILL_CATALOG_SHA = "f9de34b4ffdfa1328f458de709cfe2a8da8cb701c26e8ff4db7408f8434be5a2";
const PINNED_PM_FINGERPRINT_PROMPT_SHA = "440590b7ef5c474fe9208bd8cf79e644721279cfa2e85383350fdf4b5c4ee893";
const PINNED_WORKER_FINGERPRINT_PROMPT_SHA = "6ab0c56f491cc6eb27aa76660c0812deeb925b180b45f8eff91cf9ab59725bc4";

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
