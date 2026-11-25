import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_VENDOR, ROUTER_COMMAND_MAX_CHARS, type RouterCommandRecord } from "../shared/index.ts";
import { TOPBAR_ROUTER_INPUT_MAX_REM, TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM, TOPBAR_ROUTER_POPOVER_TURNS_MAX } from "./limits.ts";
import {
  CLOSED_TOPBAR_SESSION,
  canSubmitQuickMessage,
  handoffQuickDraft,
  recordQuickTurn,
  selectQuickRouterTurns,
  shouldDismissOnTopBarOutsidePress,
} from "./router-topbar-model.ts";
import { turnEntryOfCommand, type RouterTurnEntry } from "./router-stream.ts";

function liveTurn(clientId: string, over: Partial<RouterCommandRecord> = {}): RouterTurnEntry {
  return turnEntryOfCommand(
    {
      id: clientId.length,
      clientId,
      inputText: clientId,
      vendor: DEFAULT_AGENT_VENDOR,
      model: null,
      effort: null,
      status: "answered",
      plan: { intent: "answer", reply: `reply ${clientId}`, actions: [] },
      dispatched: null,
      error: null,
      durationMs: 1,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    },
    undefined,
    true,
  );
}

function pendingTurn(clientId: string): RouterTurnEntry {
  return { kind: "turn", key: `turn:${clientId}`, clientId, createdAt: 1, inputText: clientId, attachments: [], status: "sending", command: null, destinations: [], live: true };
}

describe("router-topbar-model", () => {
  it("keeps the planned limits: 20 turns, a 35rem input, and a 32rem popover", () => {
    expect(TOPBAR_ROUTER_POPOVER_TURNS_MAX).toBe(20);
    expect(TOPBAR_ROUTER_INPUT_MAX_REM).toBe(35);
    expect(TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM).toBe(32);
    expect(CLOSED_TOPBAR_SESSION).toEqual({ open: false, clientIds: [] });
  });

  it("recordQuickTurn opens the session and appends a new clientId in oldest-first order", () => {
    const one = recordQuickTurn(CLOSED_TOPBAR_SESSION, "a");
    expect(one).toEqual({ open: true, clientIds: ["a"] });
    expect(recordQuickTurn(one, "b")).toEqual({ open: true, clientIds: ["a", "b"] });
    expect(CLOSED_TOPBAR_SESSION.clientIds).toEqual([]);
  });

  it("recordQuickTurn ignores duplicate clientIds without reordering existing turns", () => {
    const session = recordQuickTurn(recordQuickTurn(CLOSED_TOPBAR_SESSION, "a"), "b");
    expect(recordQuickTurn(session, "a")).toBe(session);
    expect(recordQuickTurn({ open: false, clientIds: ["a"] }, "a")).toEqual({ open: true, clientIds: ["a"] });
  });

  it("recordQuickTurn drops the oldest clientIds when the session exceeds TOPBAR_ROUTER_POPOVER_TURNS_MAX", () => {
    let session = CLOSED_TOPBAR_SESSION;
    for (let i = 0; i <= TOPBAR_ROUTER_POPOVER_TURNS_MAX; i++) session = recordQuickTurn(session, `c${i}`);
    expect(session.clientIds).toHaveLength(TOPBAR_ROUTER_POPOVER_TURNS_MAX);
    expect(session.clientIds[0]).toBe("c1");
    expect(session.clientIds.at(-1)).toBe(`c${TOPBAR_ROUTER_POPOVER_TURNS_MAX}`);
  });

  it("recordQuickTurn throws RangeError when clientId is blank", () => {
    expect(() => recordQuickTurn(CLOSED_TOPBAR_SESSION, " ")).toThrow(RangeError);
  });

  it("selectQuickRouterTurns returns only turns matching sessionClientIds in session order", () => {
    const live = [liveTurn("other"), liveTurn("b"), liveTurn("a")];
    expect(selectQuickRouterTurns(["a", "b", "missing"], live, []).map((t) => t.clientId)).toEqual(["a", "b"]);
    expect(selectQuickRouterTurns([], live, [])).toEqual([]);
  });

  it("selectQuickRouterTurns prefers confirmed liveTurns over pendingTurns for the same clientId", () => {
    const confirmed = liveTurn("a");
    const [turn] = selectQuickRouterTurns(["a"], [confirmed], [pendingTurn("a")]);
    expect(turn).toBe(confirmed);
    expect(selectQuickRouterTurns(["p"], [confirmed], [pendingTurn("p")])[0]?.status).toBe("sending");
  });

  it("selectQuickRouterTurns returns the same array reference when inputs are unchanged", () => {
    const ids = ["a"];
    const a = liveTurn("a");
    const first = selectQuickRouterTurns(ids, [a], []);
    expect(selectQuickRouterTurns(ids, [a], [])).toBe(first);
    expect(selectQuickRouterTurns(ids, [a, liveTurn("unrelated")], [pendingTurn("x")])).toBe(first);
    expect(selectQuickRouterTurns(ids, [liveTurn("a", { status: "failed" })], [])).not.toBe(first);
  });

  it("handoffQuickDraft carries every unsent quick draft into the Router composer without overwriting what is already there", () => {
    expect(handoffQuickDraft("", "reply", "")).toBe("reply");
    expect(handoffQuickDraft("top", "  ", "")).toBe("top");
    expect(handoffQuickDraft("top", "reply", "")).toBe("top\nreply");
    expect(handoffQuickDraft("", "reply", "already typed")).toBe("already typed\nreply");
    expect(handoffQuickDraft(" ", "", "already typed")).toBeNull();
    expect(handoffQuickDraft(" ", "", "")).toBeNull();
  });

  it("canSubmitQuickMessage rejects whitespace-only text as empty and text above ROUTER_COMMAND_MAX_CHARS code points as too_long", () => {
    expect(canSubmitQuickMessage(" \n ")).toEqual({ ok: false, reason: "empty" });
    expect(canSubmitQuickMessage("字".repeat(ROUTER_COMMAND_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too_long" });
  });

  it("canSubmitQuickMessage accepts valid text up to ROUTER_COMMAND_MAX_CHARS and returns the trimmed string", () => {
    expect(canSubmitQuickMessage("  hi Router \n")).toEqual({ ok: true, trimmed: "hi Router" });
    const astral = "😀".repeat(ROUTER_COMMAND_MAX_CHARS);
    expect(canSubmitQuickMessage(astral)).toEqual({ ok: true, trimmed: astral });
  });

  it("shouldDismissOnTopBarOutsidePress returns false for clicks inside the top-bar anchor or inside an open dialog such as FilePreview", () => {
    document.body.innerHTML = `
      <div id="anchor"><input id="field" /></div>
      <div data-slot="dialog-overlay" id="overlay"></div>
      <div data-slot="dialog-content"><button id="in-dialog">x</button></div>
      <main><p id="outside">chat</p></main>`;
    const anchor = document.getElementById("anchor")!;
    expect(shouldDismissOnTopBarOutsidePress(document.getElementById("field"), anchor)).toBe(false);
    expect(shouldDismissOnTopBarOutsidePress(document.getElementById("in-dialog"), anchor)).toBe(false);
    expect(shouldDismissOnTopBarOutsidePress(document.getElementById("overlay"), anchor)).toBe(false);
  });

  it("shouldDismissOnTopBarOutsidePress returns true for clicks outside the anchor and dialogs", () => {
    document.body.innerHTML = `<div id="anchor"><input /></div><main><p id="outside">chat</p></main>`;
    expect(shouldDismissOnTopBarOutsidePress(document.getElementById("outside"), document.getElementById("anchor"))).toBe(true);
    expect(shouldDismissOnTopBarOutsidePress(document.getElementById("outside"), null)).toBe(true);
    expect(shouldDismissOnTopBarOutsidePress(null, null)).toBe(true);
  });
});
