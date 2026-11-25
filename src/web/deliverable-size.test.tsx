import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sentFileMime, type Deliverable } from "../shared/index.ts";
import { DeliverableFiles } from "./components/Deliverables.tsx";
import { DELIVERABLE_MEDIA_HEIGHT_REM } from "./deliverable-size.ts";

let seq = 0;
function d(label: string, name: string): Deliverable {
  seq += 1;
  return { label, id: seq.toString(16).padStart(16, "0"), name, mime: sentFileMime(name), size: 100, href: `/tmp/${name}`, origin: null };
}

describe("DeliverableFiles media height", () => {
  it("drives thumbnail height from DELIVERABLE_MEDIA_HEIGHT_REM", () => {
    const { container } = render(<DeliverableFiles deliverables={[d("Plan", "plan.md"), d("Shot", "shot.png")]} />);
    expect(container.querySelector<HTMLElement>("[data-deliverables]")!.style.getPropertyValue("--deliverable-media-height")).toBe(
      `${DELIVERABLE_MEDIA_HEIGHT_REM}rem`,
    );
    expect(container.querySelector("[data-deliverable-media] button")).toHaveClass("h-(--deliverable-media-height)");
  });
});
