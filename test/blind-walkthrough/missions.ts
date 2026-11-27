// Invariant: every mission brief describes only user-level goals and passes assertBlindPromptClean with zero insider UI hints.
import type { BlindMission, BlindMissionId } from "./types.ts";

/**
 * Postcondition: returns the ordered catalog of cold-start new-user missions.
 */
export function listMissions(): readonly BlindMission[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: requestedIds is empty (select all) or contains valid BlindMissionId values.
 * Postcondition: returns missions in catalog order; throws RangeError if any id is unknown.
 */
export function selectMissions(_requestedIds?: readonly string[]): readonly BlindMission[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: sampleProjectDir is an isolated demo folder outside the repository.
 * Postcondition: returns a plain-language system prompt and mission brief containing no source paths, selectors, or product jargon.
 */
export function buildMissionPrompt(_mission: BlindMission, _sampleProjectDir: string): { readonly systemPrompt: string; readonly userGoal: string } {
  throw new Error("Not implemented");
}

export function isBlindMissionId(_value: string): _value is BlindMissionId {
  throw new Error("Not implemented");
}
