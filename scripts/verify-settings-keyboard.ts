import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";

// Copy of UI_SCALE_KEY: src/web/ui-scale.ts needs the DOM lib, which scripts/ compile without.
const SCALE_KEY = "agent-hub.uiScale";
const WIDE_PX = 1280;
const PHONE_PX = 390;
const HEIGHT_PX = 800;
// A focus trap cycles back to the first stop well before this; more stops means focus escaped the dialog.
const MAX_STOPS = 60;

export interface FocusStop {
  name: string;
  role: string;
  focusVisible: boolean;
  outline: string;
  boxShadow: string;
  ring: boolean;
}

interface BrowserGlobal {
  document: {
    activeElement: (FocusElement & { closest(selector: string): unknown }) | null;
    documentElement: { scrollWidth: number; clientWidth: number };
    querySelectorAll(selector: string): ArrayLike<{ scrollWidth: number; clientWidth: number }>;
  };
  getComputedStyle(el: unknown): { outlineStyle: string; outlineWidth: string; boxShadow: string };
  localStorage: { setItem(key: string, value: string): void };
}

interface FocusElement {
  tagName: string;
  textContent: string | null;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
}

function readStop(): FocusStop & { key: string; inside: boolean } {
  const g = globalThis as unknown as BrowserGlobal;
  const el = g.document.activeElement;
  if (el === null) return { key: "", inside: false, name: "", role: "", focusVisible: false, outline: "", boxShadow: "", ring: false };
  const cs = g.getComputedStyle(el);
  const outlinePx = cs.outlineStyle === "solid" ? Number.parseFloat(cs.outlineWidth) : 0;
  const field = el.matches("input, textarea");
  const name = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? (el.textContent ?? "").trim().slice(0, 60);
  const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
  return {
    key: `${role}|${name}|${el.getAttribute("id") ?? ""}`,
    inside: el.closest('[role="dialog"]') !== null,
    name,
    role,
    focusVisible: el.matches(":focus-visible"),
    outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
    boxShadow: cs.boxShadow,
    // Text fields draw the field-focus border and 1px ring instead of an outline.
    ring: outlinePx >= 2 || (field && cs.boxShadow !== "none"),
  };
}

/**
 * Postcondition: presses `key` from the focused element until focus cycles back, returning every stop in order.
 * WebKit moves Tab between text fields only; Alt+Tab reaches every control there.
 */
export async function walkFocus(page: Page, label: string, shotDir?: string, key = "Tab"): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_STOPS; i++) {
    await page.keyboard.press(key);
    const { key: id, inside, ...stop } = await page.evaluate(readStop);
    assert.ok(inside, `${label}: Tab moved focus out of the dialog after ${stops.map((s) => s.name).join(", ")}`);
    if (seen.has(id)) return stops;
    seen.add(id);
    stops.push(stop);
    if (shotDir !== undefined) await page.getByRole("dialog").last().screenshot({ path: join(shotDir, `${label}-${String(stops.length).padStart(2, "0")}.png`), animations: "disabled" });
  }
  throw new Error(`${label}: focus did not cycle within ${MAX_STOPS} Tab presses`);
}

export function assertRings(stops: readonly FocusStop[], label: string): void {
  assert.ok(stops.length > 1, `${label}: Tab reached ${stops.length} control`);
  const missing = stops.filter((s) => !s.focusVisible || !s.ring);
  assert.deepEqual(missing, [], `${label}: keyboard focus shows no 2px outline on ${missing.map((s) => `${s.role} "${s.name}"`).join(", ")}`);
}

async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const over = await page.evaluate(() => {
    const g = globalThis as unknown as BrowserGlobal;
    const scrollers = Array.from(g.document.querySelectorAll(".dialog-body-fade, main"));
    const page = g.document.documentElement;
    return [page, ...scrollers].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.scrollWidth}>${el.clientWidth}`);
  });
  assert.deepEqual(over, [], `${label}: Settings scrolls sideways`);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
}

/** Postcondition: General settings, New PM, and their phone and scale variants keep every control keyboard-visible and in bounds. */
export async function verifySettingsKeyboard(browser: Browser, loginUrl: string, origin: string, shotDir?: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: WIDE_PX, height: HEIGHT_PX } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    for (const scale of ["sm", "xl"] as const) {
      await page.evaluate(({ key, value }) => (globalThis as unknown as BrowserGlobal).localStorage.setItem(key, value), { key: SCALE_KEY, value: scale });
      for (const width of [WIDE_PX, PHONE_PX]) {
        await page.setViewportSize({ width, height: HEIGHT_PX });
        await page.goto(`${origin}/`);
        await openSettings(page);
        await page.getByRole("combobox", { name: "Interface scale" }).or(page.getByRole("button", { name: /^Interface scale/ })).first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
        await noSidewaysScroll(page, `${scale} at ${width}px`);
      }
    }
    await page.evaluate((key) => (globalThis as unknown as BrowserGlobal).localStorage.setItem(key, "md"), SCALE_KEY);
    await page.setViewportSize({ width: WIDE_PX, height: HEIGHT_PX });
    await page.goto(`${origin}/`);
    await openSettings(page);
    await page.getByRole("tab", { name: "General" }).focus({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertRings(await walkFocus(page, "settings-general", shotDir), "Settings General");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.locator('nav[aria-label="Workspace"] button:has([data-testid^="rail-device-dot-"])').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.getByRole("button", { name: "New project manager" }).first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.getByRole("textbox", { name: "Name" }).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertRings(await walkFocus(page, "new-pm", shotDir), "New PM");
    assert.deepEqual(errors, [], `Settings keyboard check hit page errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
}
