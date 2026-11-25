import { describe, expect, it } from "vitest";
import { TOPBAR_ROUTER_INPUT_MAX_REM, TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM, TOPBAR_ROUTER_POPOVER_TURNS_MAX } from "./limits.ts";
import {
  CLOSED_TOPBAR_SESSION,
  canSubmitQuickMessage,
  closeQuickSession,
  handoffQuickDraft,
  recordQuickTurn,
  selectQuickRouterTurns,
  shouldDismissOnTopBarOutsidePress,
  type QuickMessageValidation,
  type TopBarRouterSession,
} from "./router-topbar-model.ts";

describe("router-topbar-model", () => {
  it("exposes the planned top-bar session limits and contract surface", () => {
    expect(TOPBAR_ROUTER_POPOVER_TURNS_MAX).toBe(20);
    expect(TOPBAR_ROUTER_INPUT_MAX_REM).toBe(35);
    expect(TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM).toBe(32);
    expect(CLOSED_TOPBAR_SESSION).toEqual({ open: false, clientIds: [] });
    expect(typeof recordQuickTurn).toBe("function");
    expect(typeof closeQuickSession).toBe("function");
    expect(typeof selectQuickRouterTurns).toBe("function");
    expect(typeof handoffQuickDraft).toBe("function");
    expect(typeof canSubmitQuickMessage).toBe("function");
    expect(typeof shouldDismissOnTopBarOutsidePress).toBe("function");
    type ContractTypes = [TopBarRouterSession, QuickMessageValidation];
    const _typeCheck: ContractTypes | null = null;
    expect(_typeCheck).toBeNull();
  });

  it.todo("recordQuickTurn opens the session and appends a new clientId in oldest-first order");
  it.todo("recordQuickTurn ignores duplicate clientIds without reordering existing turns");
  it.todo("recordQuickTurn drops the oldest clientIds when the session exceeds TOPBAR_ROUTER_POPOVER_TURNS_MAX");
  it.todo("recordQuickTurn throws RangeError when clientId is blank");
  it.todo("closeQuickSession returns CLOSED_TOPBAR_SESSION and preserves reference identity when already closed");
  it.todo("selectQuickRouterTurns returns only turns matching sessionClientIds in session order");
  it.todo("selectQuickRouterTurns prefers confirmed liveTurns over pendingTurns for the same clientId");
  it.todo("selectQuickRouterTurns returns the same array reference when inputs are unchanged");
  it.todo("handoffQuickDraft prefers non-blank popoverDraft over topBarDraft and never overwrites a non-blank existingRouterDraft");
  it.todo("canSubmitQuickMessage rejects whitespace-only text as empty and text above ROUTER_COMMAND_MAX_CHARS code points as too_long");
  it.todo("canSubmitQuickMessage accepts valid text up to ROUTER_COMMAND_MAX_CHARS and returns the trimmed string");
  it.todo("shouldDismissOnTopBarOutsidePress returns false for clicks inside the top-bar anchor or inside an open dialog such as FilePreview");
  it.todo("shouldDismissOnTopBarOutsidePress returns true for clicks outside the anchor and dialogs");
});
