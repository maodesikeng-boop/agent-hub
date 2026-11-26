import { describe, expect, it } from "vitest";
import { LedgerRequestError, type RouterCommandAttachment } from "../../shared/index.ts";
import { planBaseOf, planBaseOfRequest } from "./plan-base.ts";

const attachment: RouterCommandAttachment = { id: "u1", name: "spec.md", mime: "text/markdown", size: 8 };

describe("plan base", () => {
  it("keeps only the request fields that were set, and a retry reads the same fields back from the plan", () => {
    const base = planBaseOfRequest({ clientId: "c1", text: "@agent-hub 看一下", routerOnly: true }, ["u1"], [attachment]);
    expect(base).toEqual({ attachmentIds: ["u1"], attachments: [attachment], routerOnly: true });
    expect(planBaseOf({ intent: "answer", reply: "好", actions: [], track: "B", ...base })).toEqual(base);

    const direct = planBaseOfRequest({ clientId: "c2", text: "直转", routerOnly: false, target: { pmId: 2 } }, [], []);
    expect(direct).toEqual({ target: { pmId: 2 } });
    expect(planBaseOf({ intent: "dispatch", reply: "", actions: [], ...direct })).toEqual(direct);
    expect(planBaseOf(null)).toEqual({});
  });

  it("refuses routerOnly together with a direct target", () => {
    expect(() => planBaseOfRequest({ clientId: "c3", text: "直转", routerOnly: true, target: { pmId: 1 } }, [], [])).toThrow(LedgerRequestError);
  });
});
