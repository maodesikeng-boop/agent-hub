import { describe, expect, it } from "vitest";
import { assertNewPmStops, focusMarkVisible } from "./verify-settings-keyboard.ts";

const NO_OUTLINE = { outlineStyle: "none", outlineWidth: "0px", outlineColor: "rgb(0, 0, 0)" };

describe("focusMarkVisible", () => {
  it("accepts a 2px opaque outline", () => {
    expect(focusMarkVisible({ outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgb(74, 64, 56)", boxShadow: "none" }, false)).toBe(true);
  });

  it("rejects a transparent or thin outline", () => {
    expect(focusMarkVisible({ outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgba(0, 0, 0, 0)", boxShadow: "none" }, false)).toBe(false);
    expect(focusMarkVisible({ outlineStyle: "solid", outlineWidth: "1px", outlineColor: "rgb(74, 64, 56)", boxShadow: "none" }, false)).toBe(false);
  });

  it("rejects transparent and zero-spread shadows on a text field", () => {
    expect(focusMarkVisible({ ...NO_OUTLINE, boxShadow: "rgba(0, 0, 0, 0) 0px 0px 0px 0px" }, true)).toBe(false);
    expect(focusMarkVisible({ ...NO_OUTLINE, boxShadow: "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px" }, true)).toBe(false);
    expect(focusMarkVisible({ ...NO_OUTLINE, boxShadow: "rgb(74, 64, 56) 0px 0px 0px 0px" }, true)).toBe(false);
    expect(focusMarkVisible({ ...NO_OUTLINE, boxShadow: "rgba(74, 64, 56, 0) 0px 0px 0px 1px" }, true)).toBe(false);
    expect(focusMarkVisible({ ...NO_OUTLINE, boxShadow: "oklab(0 0 0 / 0) 0px 0px 0px 1px" }, true)).toBe(false);
  });

  it("accepts the field-focus 1px spread on a text field only", () => {
    const ring = { ...NO_OUTLINE, boxShadow: "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(74, 64, 56) 0px 0px 0px 1px" };
    expect(focusMarkVisible(ring, true)).toBe(true);
    expect(focusMarkVisible(ring, false)).toBe(false);
  });
});

describe("assertNewPmStops", () => {
  const stops = ["Change look", "Name", "Main folder", "Choose…", "Mode", "More settings", "Provider", "Model", "Effort", "Persona", "Create"].map((name) => ({
    name,
    role: name === "Choose…" ? "button" : "",
    focusVisible: true,
    outline: "solid 2px rgb(74, 64, 56)",
    boxShadow: "none",
    ring: true,
  }));

  it("requires Choose… when the device reports a folder picker", () => {
    const skipped = stops.filter(({ name }) => name !== "Choose…");
    expect(() => assertNewPmStops(stops, true)).not.toThrow();
    expect(() => assertNewPmStops(skipped, true)).toThrow("Tab never reached Choose…");
    expect(() => assertNewPmStops(skipped, false)).not.toThrow();
  });

  it("rejects a Choose… stop without a visible focus mark", () => {
    const unmarked = stops.map((stop) => stop.name === "Choose…" ? { ...stop, outline: "none", ring: false } : stop);
    expect(() => assertNewPmStops(unmarked, true)).toThrow('keyboard focus shows no 2px outline on button "Choose…"');
  });
});
