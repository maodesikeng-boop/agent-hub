import { describe, expect, it, vi } from "vitest";
import { CODE_COLOR_REPLACEMENTS, highlightHtml } from "./highlight.ts";
import { contrastRatio } from "./lib/palette.ts";

const { codeToHtml } = vi.hoisted(() => ({ codeToHtml: vi.fn(async () => "<pre></pre>") }));
vi.mock("shiki", () => ({ codeToHtml }));

const CODE_BACKGROUND = "#f7f4ed";

describe("highlightHtml", () => {
  it("swaps each github-light token under 4.5:1 on the --panel code background for a color that passes", async () => {
    for (const [original, replacement] of Object.entries(CODE_COLOR_REPLACEMENTS)) {
      expect(contrastRatio(original, CODE_BACKGROUND), original).toBeLessThan(4.5);
      expect(contrastRatio(replacement, CODE_BACKGROUND), replacement).toBeGreaterThanOrEqual(4.5);
    }
    await highlightHtml("const a = 1;", "ts");
    expect(codeToHtml).toHaveBeenCalledWith("const a = 1;", expect.objectContaining({ theme: "github-light", colorReplacements: CODE_COLOR_REPLACEMENTS }));
  });
});
