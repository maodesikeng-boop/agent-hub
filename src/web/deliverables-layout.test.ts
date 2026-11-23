import { describe, expect, it } from "vitest";
import { sentFileMime, type Deliverable } from "../shared/index.ts";
import { layoutCardDeliverables } from "./deliverables-layout.ts";

let seq = 0;
function makeDeliverable(label: string, name: string, href = `/tmp/${name}`): Deliverable {
  seq += 1;
  return {
    label,
    id: seq.toString(16).padStart(16, "0"),
    name,
    mime: sentFileMime(name),
    size: 512,
    href,
    origin: null,
  };
}

describe("layoutCardDeliverables", () => {
  it("embeds files and screenshots directly under the matching paragraph or list item and leaves unmentioned ones trailing", () => {
    const plan = makeDeliverable("续期方案", "cert-plan.md");
    const before = makeDeliverable("改前状态页", "before-ssl.png");
    const after = makeDeliverable("改后状态页", "after-ssl.png");
    const extra = makeDeliverable("回归核对清单", "checklist.md");
    const deliverables = [plan, before, after, extra];
    const body = [
      "下面两块已经准备好：",
      "",
      "1. 续期任务改成每天凌晨检查，详见 cert-plan.md。",
      "2. 状态页对照见 before-ssl.png 与 after-ssl.png。",
      "",
      "确认后切换生产。",
    ].join("\n");

    const layout = layoutCardDeliverables(body, deliverables);
    expect(layout.segments).toHaveLength(4);
    expect(layout.segments[0]!.deliverables).toEqual([]);
    expect(layout.segments[1]!.isListItem).toBe(true);
    expect(layout.segments[1]!.deliverables).toEqual([plan]);
    expect(layout.segments[2]!.isListItem).toBe(true);
    expect(layout.segments[2]!.deliverables).toEqual([before, after]);
    expect(layout.segments[3]!.deliverables).toEqual([]);
    expect(layout.trailing).toEqual([extra]);

    // WeakMap returns the exact same reference for identical inputs.
    expect(layoutCardDeliverables(body, deliverables)).toBe(layout);
  });

  it("omits deliverables already linked inline in the card title or body", () => {
    const plan = makeDeliverable("方案", "plan.md");
    const shot = makeDeliverable("桌面截图", "desktop.png");
    const layout = layoutCardDeliverables(
      "详细说明里放了截图 desktop.png。",
      [plan, shot],
      `请看[方案](${plan.href})再拍板`,
    );
    expect(layout.segments.flatMap((s) => s.deliverables)).toEqual([shot]);
    expect(layout.trailing).toEqual([]);
  });

  it("keeps adjacent unmatched blocks merged into a single markdown segment", () => {
    const extra = makeDeliverable("附件", "report.pdf");
    const body = "第一段。\n\n1. 列表一\n2. 列表二\n\n结尾段。";
    const layout = layoutCardDeliverables(body, [extra]);
    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]!.markdown).toBe(body);
    expect(layout.trailing).toEqual([extra]);
  });

  it("matches by label when filename is not spelled out in the text", () => {
    const verdict = makeDeliverable("验收结论", "out-01.md");
    const body = "一、改动说明。\n\n二、完整的验收结论已经整理好。";
    const layout = layoutCardDeliverables(body, [verdict]);
    expect(layout.segments).toHaveLength(2);
    expect(layout.segments[0]!.deliverables).toEqual([]);
    expect(layout.segments[1]!.deliverables).toEqual([verdict]);
    expect(layout.trailing).toEqual([]);
  });
});
