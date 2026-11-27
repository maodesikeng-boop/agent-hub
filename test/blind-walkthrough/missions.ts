// Invariant: every mission brief describes only user-level goals and passes assertBlindPromptClean with zero insider UI hints.
import { BLIND_MAX_STEPS_PER_MISSION } from "./limits.ts";
import type { BlindMission, BlindMissionId } from "./types.ts";

const MISSION_CATALOG: readonly BlindMission[] = [
  {
    id: "first-launch-orient",
    title: "First launch orientation",
    goal: "Explore the initial screen of this newly opened desktop/web workbench app, understand what it does, locate where projects or workspaces and conversations live, and note anything confusing on first sight.",
    persona: "A brand-new user opening this app for the very first time without reading documentation.",
    maxSteps: Math.min(10, BLIND_MAX_STEPS_PER_MISSION),
    expectedOutcomes: [
      "Identify the main navigation areas on the landing screen",
      "Understand how to reach a project conversation or create a workspace",
      "Note any unclear labels, hidden entry points, or dead ends",
    ],
  },
  {
    id: "create-first-project",
    title: "Create first project and chat",
    goal: "Create a new project or workspace connected to your local starter folder, open its conversation, send a first task asking for a quick summary of the folder's README, wait for a reply, and send one follow-up message in the same conversation.",
    persona: "A new user trying to connect their own project folder and complete a two-turn conversation.",
    maxSteps: Math.min(16, BLIND_MAX_STEPS_PER_MISSION),
    expectedOutcomes: [
      "Find and complete the new project creation flow using the provided starter folder",
      "Send a first message and observe a reply",
      "Send a follow-up message in the same conversation",
    ],
  },
  {
    id: "inspect-work-and-controls",
    title: "Inspect work panel and controls",
    goal: "Explore the workspace controls around the active conversation, including side panels, status tabs, and conversation actions, to see whether their purpose and layout are self-explanatory.",
    persona: "A new user checking where task progress, details, and workspace controls live.",
    maxSteps: Math.min(10, BLIND_MAX_STEPS_PER_MISSION),
    expectedOutcomes: [
      "Open or inspect workspace detail panels and tabs",
      "Test obvious controls and report any confusing labels or unresponsive elements",
    ],
  },
  {
    id: "recover-and-configure",
    title: "Reload page and inspect settings",
    goal: "Reload or refresh the app page to make sure your work is still easy to return to, then open Settings to check how AI model providers and preferences are configured.",
    persona: "A new user verifying persistence after a page refresh and looking for configuration options.",
    maxSteps: Math.min(10, BLIND_MAX_STEPS_PER_MISSION),
    expectedOutcomes: [
      "Reload the browser page and verify the workspace state remains accessible",
      "Find and open Settings and inspect the provider configuration view",
    ],
  },
];

const MISSION_IDS = new Set<string>(MISSION_CATALOG.map((m) => m.id));

export const BLIND_AGENT_SYSTEM_PROMPT = [
  "You are a brand-new user trying an unfamiliar productivity workbench app for the very first time.",
  "You have no manual and no insider knowledge. Rely only on the screenshot and visible labels provided on each step.",
  "Think aloud honestly about what you expect each control to do, and report every real confusion, hidden control, misleading label, layout flaw, or dead end.",
  "Reply with ONLY one valid JSON object matching this exact schema (no markdown fences or extra prose):",
  "{",
  '  "thought": "brief first-person observation and next intention",',
  '  "confusion": "specific UX confusion if anything is unclear or frustrating, otherwise null",',
  '  "action": <one of the allowed action objects below>',
  "}",
  "Allowed action objects:",
  '- {"kind":"click_label","role":"button|link|tab|menuitem|textbox|... (optional)","label":"exact visible text or accessible name"}',
  '- {"kind":"click_point","x":500,"y":250} (normalized coordinates in [0, 1000] relative to the viewport: x=0 left edge to 1000 right edge, y=0 top edge to 1000 bottom edge; prefer click_label whenever an accessible label is listed)',
  '- {"kind":"type","text":"text to type into the active or target input","submit":false}',
  '- {"kind":"press","key":"Enter|Escape|Tab|..."}',
  '- {"kind":"scroll","deltaY":300}',
  '- {"kind":"reload"}',
  '- {"kind":"wait","reason":"waiting for reply or screen update"}',
  '- {"kind":"note_friction","summary":"concise description of a UX pain point"}',
  '- {"kind":"finish","achieved":true,"summary":"concise outcome summary"}',
  "Use finish as soon as you complete the current goal or determine you are genuinely blocked.",
].join("\n");

/**
 * Postcondition: returns the ordered catalog of cold-start new-user missions.
 */
export function listMissions(): readonly BlindMission[] {
  return MISSION_CATALOG;
}

export function isBlindMissionId(value: string): value is BlindMissionId {
  return MISSION_IDS.has(value);
}

/**
 * Precondition: requestedIds is empty (select all) or contains valid BlindMissionId values.
 * Postcondition: returns missions in catalog order; throws RangeError if any id is unknown.
 */
export function selectMissions(requestedIds?: readonly string[]): readonly BlindMission[] {
  if (!requestedIds || requestedIds.length === 0) return MISSION_CATALOG;
  const wanted = new Set<string>();
  for (const id of requestedIds) {
    if (!isBlindMissionId(id)) {
      throw new RangeError(`Unknown blind walkthrough mission id: ${id}`);
    }
    wanted.add(id);
  }
  return MISSION_CATALOG.filter((mission) => wanted.has(mission.id));
}

/**
 * Precondition: sampleProjectDir is an isolated demo folder outside the repository.
 * Postcondition: returns a plain-language system prompt and mission brief containing no source paths, selectors, or product jargon.
 */
export function buildMissionPrompt(
  mission: BlindMission,
  sampleProjectDir: string,
): { readonly systemPrompt: string; readonly userGoal: string } {
  const folderHint =
    mission.id === "create-first-project"
      ? ` Your local starter folder path is: ${sampleProjectDir}`
      : "";
  const userGoal = [
    `Persona: ${mission.persona}`,
    `Goal (${mission.title}): ${mission.goal}${folderHint}`,
    `Expected outcomes: ${mission.expectedOutcomes.join("; ")}.`,
  ].join("\n");
  return {
    systemPrompt: BLIND_AGENT_SYSTEM_PROMPT,
    userGoal,
  };
}
