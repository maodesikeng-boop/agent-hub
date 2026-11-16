// 放大弹窗按估算高度摆卡片（task-graph-layout.ts）：带文件的拍板卡的估算必须和卡片里文件区的实际高度出自同一处规则（deliverable-size.ts）。
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sentFileMime, type Deliverable } from "../shared/index.ts";
import { DeliverableFiles } from "./components/Deliverables.tsx";
import {
  DELIVERABLE_BLOCK_GAP_REM,
  DELIVERABLE_DOC_ROW_HEIGHT_REM,
  DELIVERABLE_MEDIA_HEIGHT_REM,
  deliverablesHeightRem,
} from "./deliverable-size.ts";
import { computeTaskGraphLayout, estimateNodeSizeRem, type LayoutInputNode } from "./task-graph-layout.ts";

let seq = 0;
function d(label: string, name: string): Deliverable {
  seq += 1;
  return { label, id: seq.toString(16).padStart(16, "0"), name, mime: sentFileMime(name), size: 100, href: `/tmp/${name}`, origin: null };
}
const plan = d("方案", "plan.md");
const shot = d("截图", "shot.png");

const gate = (over: Partial<LayoutInputNode> = {}): LayoutInputNode => ({
  key: "g",
  status: "waiting",
  waitingFor: "user",
  hasCard: true,
  optionCount: 2,
  ...over,
});

describe("交付物区的高度规则", () => {
  it("没有文件是 0；只有文档、只有媒体、两行都有，各自的行高加行间距加和正文之间的间距", () => {
    expect(deliverablesHeightRem([])).toBe(0);
    expect(deliverablesHeightRem([plan])).toBe(DELIVERABLE_BLOCK_GAP_REM + DELIVERABLE_DOC_ROW_HEIGHT_REM);
    expect(deliverablesHeightRem([shot])).toBe(DELIVERABLE_BLOCK_GAP_REM + DELIVERABLE_MEDIA_HEIGHT_REM);
    expect(deliverablesHeightRem([plan, shot])).toBe(
      DELIVERABLE_BLOCK_GAP_REM + DELIVERABLE_DOC_ROW_HEIGHT_REM + DELIVERABLE_BLOCK_GAP_REM + DELIVERABLE_MEDIA_HEIGHT_REM,
    );
  });

  it("卡片里缩略图的高度读的就是估算用的那个数，不各写一份", () => {
    const { container } = render(<DeliverableFiles deliverables={[plan, shot]} />);
    expect(container.querySelector<HTMLElement>("[data-deliverables]")!.style.getPropertyValue("--deliverable-media-height")).toBe(
      `${DELIVERABLE_MEDIA_HEIGHT_REM}rem`,
    );
    expect(container.querySelector("[data-deliverable-media] button")).toHaveClass("h-(--deliverable-media-height)");
  });
});

describe("放大弹窗里带文件的拍板卡", () => {
  it("估算高度比没有文件时多出文件区的高度；没在等拍板的步骤不加", () => {
    const base = estimateNodeSizeRem(gate(), "dialog").heightRem;
    const withFiles = estimateNodeSizeRem(gate({ deliverables: [plan, shot] }), "dialog").heightRem;
    expect(withFiles).toBeCloseTo(base + deliverablesHeightRem([plan, shot]), 2);
    expect(estimateNodeSizeRem({ key: "p", status: "running", deliverables: [plan, shot] }, "dialog").heightRem).toBe(
      estimateNodeSizeRem({ key: "p", status: "running" }, "dialog").heightRem,
    );
  });

  it("同一层两张带缩略图的拍板卡上下不叠；文件变了布局缓存不返回旧高度", () => {
    const nodes = (deliverables: readonly Deliverable[]): LayoutInputNode[] => [
      { key: "plan", status: "done", position: 0 },
      gate({ key: "a", position: 1, deliverables }),
      gate({ key: "b", position: 2, deliverables }),
    ];
    const edges = [
      { from: "plan", to: "a" },
      { from: "plan", to: "b" },
    ];
    const rootFontSizePx = 17.5;
    const plain = computeTaskGraphLayout({ graphId: 1, nodes: nodes([]), edges, viewportMode: "dialog", rootFontSizePx });
    const tall = computeTaskGraphLayout({ graphId: 1, nodes: nodes([plan, shot]), edges, viewportMode: "dialog", rootFontSizePx });
    const [upper, lower] = tall.nodes.filter((n) => n.id === "a" || n.id === "b").sort((x, y) => x.y - y.y);
    expect(upper!.y + upper!.height).toBeLessThanOrEqual(lower!.y);
    expect(upper!.height).toBeGreaterThan(plain.nodes.find((n) => n.id === upper!.id)!.height);
  });
});
