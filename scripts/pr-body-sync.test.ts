import { describe, expect, it } from "vitest";
import { PR_BODY_MAX_CHARS, decidePrBodySync, parsePrBodyTag, type PrBodyTarget } from "./pr-body-sync.ts";

const REPO = "acme/widgets";

function pr(overrides: Partial<PrBodyTarget> = {}): PrBodyTarget {
  return { number: 452, state: "open", headRepo: REPO, body: "old", ...overrides };
}

describe("parsePrBodyTag", () => {
  it("reads the PR number from a full ref or a short tag name", () => {
    expect(parsePrBodyTag("refs/tags/pr-body/452")).toBe(452);
    expect(parsePrBodyTag("pr-body/7")).toBe(7);
  });

  it("rejects other tags, branch refs, and malformed numbers", () => {
    for (const ref of ["refs/tags/v1.2.0", "refs/heads/pr-body/452", "pr-body/", "pr-body/abc", "pr-body/0", "pr-body/012", "pr-body/4/5", "pr-body/-3"]) {
      expect(parsePrBodyTag(ref), ref).toBeNull();
    }
  });
});

describe("decidePrBodySync", () => {
  const base = { tagRef: "refs/tags/pr-body/452", repo: REPO };

  it("updates an open same-repository PR with the message exactly as written, headings included", () => {
    const body = "## Why\n\nKeep the stamp.\n\n# Not a comment\n";
    expect(decidePrBodySync({ ...base, tagMessage: body, pr: pr() })).toEqual({ kind: "update", pr: 452, body: body.slice(0, -1) });
  });

  it("skips a closed or merged PR and an unchanged body", () => {
    expect(decidePrBodySync({ ...base, tagMessage: "new", pr: pr({ state: "closed" }) }).kind).toBe("skip");
    expect(decidePrBodySync({ ...base, tagMessage: "old\n", pr: pr() }).kind).toBe("skip");
  });

  it("rejects a head branch from another repository or a deleted one", () => {
    expect(decidePrBodySync({ ...base, tagMessage: "new", pr: pr({ headRepo: "mallory/widgets" }) }).kind).toBe("reject");
    expect(decidePrBodySync({ ...base, tagMessage: "new", pr: pr({ headRepo: null }) }).kind).toBe("reject");
  });

  it("rejects a bad tag name, a lightweight tag, a blank message, and a missing PR", () => {
    expect(decidePrBodySync({ ...base, tagRef: "refs/tags/pr-body/x", tagMessage: "new", pr: pr() }).kind).toBe("reject");
    expect(decidePrBodySync({ ...base, tagMessage: null, pr: pr() }).kind).toBe("reject");
    expect(decidePrBodySync({ ...base, tagMessage: " \n\n", pr: pr() }).kind).toBe("reject");
    expect(decidePrBodySync({ ...base, tagMessage: "new", pr: null }).kind).toBe("reject");
  });

  it("accepts a body at GitHub's limit and rejects one character more instead of cutting it", () => {
    expect(decidePrBodySync({ ...base, tagMessage: "x".repeat(PR_BODY_MAX_CHARS), pr: pr() }).kind).toBe("update");
    expect(decidePrBodySync({ ...base, tagMessage: "x".repeat(PR_BODY_MAX_CHARS + 1), pr: pr() }).kind).toBe("reject");
  });
});
