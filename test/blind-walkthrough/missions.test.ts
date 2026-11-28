import { describe, expect, it } from "vitest";
import { assertBlindPromptClean } from "./context-barrier.ts";
import { BLIND_MAX_STEPS_PER_MISSION } from "./limits.ts";
import { buildMissionPrompt, isBlindMissionId, listMissions, selectMissions } from "./missions.ts";

describe("missions (S9, S11)", () => {
  it("lists all four cold-start user missions within BLIND_MAX_STEPS_PER_MISSION", () => {
    const missions = listMissions();
    expect(missions.map((m) => m.id)).toEqual([
      "first-launch-orient",
      "create-first-project",
      "inspect-work-and-controls",
      "recover-and-configure",
    ]);
    for (const mission of missions) {
      expect(mission.maxSteps).toBeGreaterThan(0);
      expect(mission.maxSteps).toBeLessThanOrEqual(BLIND_MAX_STEPS_PER_MISSION);
      expect(isBlindMissionId(mission.id)).toBe(true);
    }
    expect(isBlindMissionId("nonexistent-mission")).toBe(false);
  });

  it("selects requested missions in catalog order and rejects unknown ids with RangeError", () => {
    const selected = selectMissions(["recover-and-configure", "first-launch-orient"]);
    expect(selected.map((m) => m.id)).toEqual(["first-launch-orient", "recover-and-configure"]);
    expect(() => selectMissions(["unknown-mission"])).toThrow(RangeError);
  });

  it("S9 & S11: every built mission prompt passes assertBlindPromptClean with zero leaked repo context", () => {
    const missions = listMissions();
    const sampleDir = "/tmp/demo-notes-workspace";
    const cleanOptions = { repoRoot: "/Users/dev/agent-hub", worktreeRoot: "/Users/dev/.agent-hub/worktrees/7/1538" };

    for (const mission of missions) {
      const built = buildMissionPrompt(mission, sampleDir);
      expect(built.systemPrompt.length).toBeGreaterThan(20);
      expect(built.userGoal.length).toBeGreaterThan(20);
      expect(() => assertBlindPromptClean(`${built.systemPrompt}\n${built.userGoal}`, cleanOptions)).not.toThrow();
    }
    const recoverMission = missions.find((m) => m.id === "recover-and-configure")!;
    const recoverPrompt = buildMissionPrompt(recoverMission, sampleDir);
    expect(recoverPrompt.userGoal).toMatch(/reload|refresh|setting/i);
  });
});
