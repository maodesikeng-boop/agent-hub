import { describe, expect, it } from "vitest";
import { MACHINE_CHECKS } from "./checks.ts";
import { nestedFrameHits, raggedEdgeHits, thickLineHits, type EdgeItem, type FrameBox } from "./structure-checks.ts";

const rect = { x: 0, y: 0, w: 100, h: 40 };
const box = (over: Partial<FrameBox> & Pick<FrameBox, "label">): FrameBox => ({
  rect,
  sides: [1, 1, 1, 1],
  dashed: false,
  ring: 0,
  dot: false,
  control: false,
  media: false,
  quote: false,
  frameParent: -1,
  ...over,
});
const edge = (column: string, label: string, left: number, top: number, bottom = top + 20): EdgeItem => ({ column, label, left, top, bottom });

describe("thick-line", () => {
  it("flags solid borders and inset rings wider than a hairline", () => {
    const hits = thickLineHits([
      box({ label: "card", sides: [2, 2, 2, 2] }),
      box({ label: "rail edge", sides: [0, 2, 0, 0] }),
      box({ label: "selected tile", sides: [0, 0, 0, 0], ring: 2 }),
      box({ label: "hairline card" }),
      box({ label: "selected hairline", sides: [0, 0, 0, 0], ring: 1 }),
    ]);
    expect(hits.map((h) => h.evidence)).toEqual(["card 边框 2px", "rail edge 边框 2px", "selected tile 内描边 2px"]);
    expect(hits.every((h) => h.check === "thick-line")).toBe(true);
  });

  it("allows the dashed drop target, the Markdown quote bar, and the halo around a dot", () => {
    expect(
      thickLineHits([
        box({ label: "drop target", sides: [2, 2, 2, 2], dashed: true }),
        box({ label: "blockquote", sides: [0, 0, 0, 3], quote: true }),
        box({ label: "status dot", sides: [0, 0, 0, 0], ring: 2, dot: true }),
      ]),
    ).toEqual([]);
    expect(thickLineHits([box({ label: "boxed quote", sides: [2, 0, 0, 3], quote: true })])).toHaveLength(1);
  });
});

describe("box-in-box", () => {
  it("flags a framed box whose nearest framed ancestor is an in-flow container", () => {
    const frames = [
      box({ label: "ask card “问题”" }),
      box({ label: "reply panel", frameParent: 0 }),
      box({ label: "persona tag", frameParent: 0 }),
    ];
    expect(nestedFrameHits(frames).map((h) => h.evidence)).toEqual(["reply panel 套在 ask card 里", "persona tag 套在 ask card 里"]);
  });

  it("ignores controls, media, half-framed lines, and boxes that sit directly in an overlay", () => {
    const frames = [
      box({ label: "card" }),
      box({ label: "option button", frameParent: 0, control: true }),
      box({ label: "thumbnail", frameParent: 0, media: true }),
      box({ label: "divider", frameParent: 0, sides: [1, 0, 0, 0] }),
      box({ label: "group box in a dialog" }),
    ];
    expect(nestedFrameHits(frames)).toEqual([]);
  });
});

describe("ragged-edge", () => {
  it("reports row starts in one column that miss each other by a pixel or few", () => {
    const hits = raggedEdgeHits([
      edge("左栏", "Pinned", 31, 100),
      edge("左栏", "avatar", 24, 130, 166),
      edge("左栏", "name", 70, 132),
      edge("左栏", "avatar 2", 24, 172, 208),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.check).toBe("ragged-edge");
    expect(hits[0]!.evidence).toBe("左栏：avatar 从 24px 起，Pinned 从 31px 起，只差 7px");
  });

  it("accepts one shared edge, sub-pixel rounding, deliberate indents, and edges in different columns", () => {
    expect(
      raggedEdgeHits([
        edge("右栏", "Task Graph", 20, 0),
        edge("右栏", "pipe", 20.4, 30),
        edge("右栏", "12px indent", 32, 60),
        edge("右栏", "12px indent again", 32, 90),
        edge("左栏", "Pinned", 22, 0),
      ]),
    ).toEqual([]);
  });

  it("takes only the leftmost item of a row as its start", () => {
    expect(raggedEdgeHits([edge("右栏", "icon", 20, 0), edge("右栏", "label beside the icon", 23, 2)])).toEqual([]);
  });
});

it("registers the three structure checks with severities the rubric can cite", () => {
  const byId = new Map(MACHINE_CHECKS.map((c) => [c.id, c.severity]));
  expect(byId.get("thick-line")).toBe("P1");
  expect(byId.get("box-in-box")).toBe("P1");
  expect(byId.get("ragged-edge")).toBe("P2");
});
