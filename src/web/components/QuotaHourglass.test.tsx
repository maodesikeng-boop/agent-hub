import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QuotaHourglass, sandLevelOf } from "./QuotaHourglass.tsx";

const TOP = 4;
const NECK = 11.3;

describe("sandLevelOf", () => {
  it("keeps the upper bulb full at 0% and empties it to the neck at 100%", () => {
    expect(sandLevelOf(0)).toBe(TOP);
    expect(sandLevelOf(100)).toBe(NECK);
  });

  it("clamps out-of-range and non-finite percentages", () => {
    expect(sandLevelOf(-20)).toBe(TOP);
    expect(sandLevelOf(Number.NaN)).toBe(TOP);
    expect(sandLevelOf(180)).toBe(NECK);
  });

  it("only ever lowers the sand as usage grows", () => {
    let previous = sandLevelOf(0);
    for (let percent = 1; percent <= 100; percent++) {
      const level = sandLevelOf(percent);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it("follows the sand's volume: half the usage drains the wide upper half of the bulb, which sits above its mid height", () => {
    expect(sandLevelOf(50)).toBeLessThan((TOP + NECK) / 2);
    expect(sandLevelOf(42)).toBeLessThan(sandLevelOf(50));
  });
});

describe("QuotaHourglass", () => {
  it("drives both sand surfaces from one CSS variable pair, so the sand that leaves the top is the sand in the bottom", () => {
    const { container } = render(<QuotaHourglass percent={42} tone="normal" />);
    const svg = container.querySelector("svg")!;
    const level = sandLevelOf(42);
    expect(svg.style.getPropertyValue("--sand-top")).toBe(`${level}px`);
    expect(svg.style.getPropertyValue("--sand-bottom")).toBe(`${24 - level}px`);
    expect(svg).toHaveAttribute("data-tone", "normal");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-icon", "line");
  });

  it("pours once per value: a new percent remounts only the pour stream, never starting a loop", () => {
    const { container, rerender } = render(<QuotaHourglass percent={30} tone="normal" />);
    const pour = container.querySelector(".hourglass-pour");
    const trickle = container.querySelector(".hourglass-trickle");
    rerender(<QuotaHourglass percent={30} tone="normal" />);
    expect(container.querySelector(".hourglass-pour")).toBe(pour);
    rerender(<QuotaHourglass percent={64} tone="warning" />);
    expect(container.querySelector(".hourglass-pour")).not.toBe(pour);
    expect(container.querySelector(".hourglass-trickle")).toBe(trickle);
    expect(container.querySelector("svg")).toHaveAttribute("data-tone", "warning");
  });

  it("animates only with one-shot CSS and shows the final state under reduced motion", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const rules = [...css.matchAll(/\.hourglass[\w-]*[^{]*\{([^}]*)\}/g)].map((m) => m[1]!).join("\n");
    expect(rules).not.toMatch(/infinite/);
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]!).join("\n");
    expect(reduced).toMatch(/\.hourglass-sand \{\s*transition: none;/);
    expect(reduced).toMatch(/\.hourglass-pour,\s*\.hourglass-trickle \{\s*display: none;/);
    expect(reduced).toMatch(/\.hourglass-trigger:hover \.hourglass-body/);
  });
});
