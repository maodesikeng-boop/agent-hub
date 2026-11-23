import { describe, expect, it } from "vitest";
import { DECISION_DRAFTS_MAX } from "./limits.ts";
import {
  askDecisionDraftKey,
  clearDecisionDraft,
  gateDecisionDraftKey,
  getDecisionDraft,
  resetDecisionDrafts,
  routerDecisionDraftKey,
  setDecisionDraft,
} from "./decision-drafts.ts";

describe("decision-drafts", () => {
  it("shares identical keys across AskCard, GateDecisionCard, and RouterDecisionCard", () => {
    const askKey = askDecisionDraftKey(null, 42);
    expect(
      routerDecisionDraftKey("local", {
        key: "item:local:101",
        askMessageId: 42,
        source: { kind: "router_item", itemId: 101 },
      }),
    ).toBe(askKey);

    const gateWithMsg = gateDecisionDraftKey("tokyo-1", 7, "review", 99);
    expect(askDecisionDraftKey("tokyo-1", 99)).toBe(gateWithMsg);
    expect(
      routerDecisionDraftKey("tokyo-1", {
        key: "gate:tokyo-1:7:review",
        askMessageId: 99,
        source: {
          kind: "gate",
          graphId: 7,
          graphTitle: "Release",
          nodeKey: "review",
          nodeTitle: "Review",
          blockedNodeCount: 1,
          nextNodeTitles: ["Ship"],
          recommended: null,
        },
      }),
    ).toBe(gateWithMsg);

    const gateWithoutMsg = gateDecisionDraftKey(null, 7, "review", null);
    expect(
      routerDecisionDraftKey("local", {
        key: "gate:local:7:review",
        askMessageId: null,
        source: {
          kind: "gate",
          graphId: 7,
          graphTitle: "Release",
          nodeKey: "review",
          nodeTitle: "Review",
          blockedNodeCount: 0,
          nextNodeTitles: [],
          recommended: null,
        },
      }),
    ).toBe(gateWithoutMsg);
  });

  it("bounds stored drafts to DECISION_DRAFTS_MAX via LRU eviction and clears entries", () => {
    resetDecisionDrafts();
    for (let i = 0; i < DECISION_DRAFTS_MAX + 25; i++) {
      setDecisionDraft(`ask:local:${i}`, `draft ${i}`);
    }
    expect(getDecisionDraft("ask:local:0")).toBe("");
    expect(getDecisionDraft("ask:local:24")).toBe("");
    expect(getDecisionDraft(`ask:local:${DECISION_DRAFTS_MAX + 24}`)).toBe(`draft ${DECISION_DRAFTS_MAX + 24}`);

    clearDecisionDraft(`ask:local:${DECISION_DRAFTS_MAX + 24}`);
    expect(getDecisionDraft(`ask:local:${DECISION_DRAFTS_MAX + 24}`)).toBe("");
  });
});
