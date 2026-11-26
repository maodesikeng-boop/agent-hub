import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";

// Copy of UI_SCALE_KEY: src/web/ui-scale.ts needs the DOM lib, which scripts/ compile without.
const SCALE_KEY = "agent-hub.uiScale";
const WIDE_PX = 1280;
const PHONE_PX = 390;
/** Settings puts its categories on top below this width (`max-[719px]` in SettingsDialog.tsx). */
const TOP_TABS_BELOW_PX = 720;
const MATRIX_WIDTHS_PX = [860, 700] as const;
const SETTINGS_CATEGORIES = ["General", "Providers", "Capabilities", "Resources", "Computers", "Security & Access"] as const;
const PHONE_PAGES = [
  ["scale", "Interface scale"],
  ["notifications", "Notifications"],
  ["updates", "Updates"],
  ["providers", "Providers"],
  ["vendor-sync", "Vendor sync"],
  ["capabilities", "Capabilities"],
  ["resources", "Resources"],
  ["computers", "Computers"],
  ["sign-in", "Sign in on another device"],
  ["browsers", "Signed-in browsers"],
] as const;
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

export interface FocusStyle {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}

interface RawStop extends FocusStyle {
  key: string;
  inside: boolean;
  name: string;
  role: string;
  field: boolean;
  focusVisible: boolean;
}

const alphaOf = (color: string): number => {
  if (color === "transparent") return 0;
  const args = /^[a-z-]+\(([^)]*)\)/.exec(color)?.[1];
  if (args === undefined) return 1;
  const slash = args.split("/");
  if (slash.length === 2) return Number.parseFloat(slash[1]!);
  const parts = args.split(",");
  return parts.length === 4 ? Number.parseFloat(parts[3]!) : 1;
};

/** Splits a computed box-shadow list at the commas between shadows, not the ones inside rgb(). */
const shadowsOf = (boxShadow: string): string[] => (boxShadow === "none" ? [] : boxShadow.split(/,(?![^(]*\))/).map((s) => s.trim()));

/**
 * Postcondition: true when the computed style draws a mark a person can see: a 2px or wider opaque solid outline, or on a
 * text field a field-focus shadow with a 1px or wider spread in an opaque color. Transparent or zero-spread shadows do not count.
 */
export function focusMarkVisible(style: FocusStyle, field: boolean): boolean {
  const outlinePx = style.outlineStyle === "solid" ? Number.parseFloat(style.outlineWidth) : 0;
  if (outlinePx >= 2 && alphaOf(style.outlineColor) > 0) return true;
  if (!field) return false;
  return shadowsOf(style.boxShadow).some((shadow) => {
    const color = /^([a-z-]+\([^)]*\)|transparent)/.exec(shadow)?.[1] ?? "rgb(0, 0, 0)";
    const lengths = shadow.slice(color.length).trim().split(/\s+/).filter((p) => p.endsWith("px")).map(Number.parseFloat);
    const spread = lengths[3] ?? 0;
    return spread >= 1 && alphaOf(color) > 0;
  });
}

interface BrowserGlobal {
  document: {
    activeElement: (FocusElement & { closest(selector: string): unknown }) | null;
    documentElement: { scrollWidth: number; clientWidth: number };
    querySelectorAll(selector: string): ArrayLike<{ scrollWidth: number; clientWidth: number }>;
  };
  getComputedStyle(el: unknown): FocusStyle;
  localStorage: { setItem(key: string, value: string): void };
}

interface FocusElement {
  tagName: string;
  getAnimations(): { finished: Promise<unknown> }[];
  labels?: ArrayLike<{ textContent: string | null }> | null;
  textContent: string | null;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
}

async function readStop(): Promise<RawStop> {
  const g = globalThis as unknown as BrowserGlobal;
  const el = g.document.activeElement;
  // The field-focus line and ring fade in; reading mid-transition sees the transparent start.
  if (el !== null) await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
  if (el === null) return { key: "", inside: false, name: "", role: "", field: false, focusVisible: false, outlineStyle: "", outlineWidth: "", outlineColor: "", boxShadow: "" };
  const cs = g.getComputedStyle(el);
  const name = el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.getAttribute("placeholder") ?? (el.textContent ?? "").trim().slice(0, 60);
  const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
  return {
    key: `${role}|${name}|${el.getAttribute("id") ?? ""}`,
    inside: el.closest('[role="dialog"]') !== null,
    name,
    role,
    field: el.matches("input, textarea"),
    focusVisible: el.matches(":focus-visible"),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow,
  };
}

/** Postcondition: the focused element's name, role, and whether it shows a visible focus mark. */
export async function readFocus(page: Page): Promise<FocusStop & { key: string; inside: boolean }> {
  const raw = await page.evaluate(readStop);
  return {
    key: raw.key,
    inside: raw.inside,
    name: raw.name,
    role: raw.role,
    focusVisible: raw.focusVisible,
    outline: `${raw.outlineStyle} ${raw.outlineWidth} ${raw.outlineColor}`,
    boxShadow: raw.boxShadow,
    ring: focusMarkVisible(raw, raw.field),
  };
}

/**
 * Postcondition: presses `key` from the focused element until focus cycles back, returning every stop in order.
 * WebKit moves Tab between text fields only; Alt+Tab reaches every control there but does not wrap inside a dialog's focus trap.
 */
export async function walkFocus(page: Page, label: string, shotDir?: string, key = "Tab"): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  let first: string | undefined;
  for (let i = 0; i < MAX_STOPS; i++) {
    await page.keyboard.press(key);
    const { key: id, inside, ...stop } = await readFocus(page);
    assert.ok(inside, `${label}: Tab moved focus out of the dialog after ${stops.map((s) => s.name).join(", ")}`);
    if (seen.has(id)) {
      assert.equal(id, first, `${label}: focus stuck on ${stop.role} "${stop.name}" instead of cycling back to the first stop`);
      return stops;
    }
    if (first === undefined) first = id;
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

function assertReaches(stops: readonly FocusStop[], expected: readonly string[], label: string): void {
  const names = stops.map((s) => s.name);
  const order = expected.map((name) => names.findIndex((n) => n === name || n.startsWith(`${name} `)));
  const missing = expected.filter((_, i) => order[i] === -1);
  assert.deepEqual(missing, [], `${label}: Tab never reached ${missing.join(", ")} (stops: ${names.join(", ")})`);
  const rotated = order.map((i) => (i - order[0]! + names.length) % names.length);
  assert.ok(rotated.every((v, i) => i === 0 || v > rotated[i - 1]!), `${label}: Tab order ${names.join(", ")} breaks ${expected.join(", ")}`);
}

export function assertNewPmStops(stops: readonly FocusStop[], folderPicker: boolean): void {
  const expected = ["Change look", "Name", "Main folder", ...(folderPicker ? ["Choose…"] : []), "Mode", "More settings", "Provider", "Model", "Effort", "Persona", "Create"];
  assertReaches(stops, expected, "New PM");
  assertRings(stops, "New PM");
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

type SettingsLayout = "side" | "top" | "phone";

async function settingsLayout(page: Page): Promise<SettingsLayout> {
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const phone = page.getByRole("heading", { name: "Settings", level: 1 });
  await dialog.or(phone).first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  if (!(await dialog.isVisible())) return "phone";
  return (await dialog.locator("div[data-window-drag]", { hasText: /^Settings$/ }).isVisible()) ? "side" : "top";
}

/**
 * Postcondition: at the Compact and XL scales, at 860px and 700px, Settings takes the layout its width and scale call for
 * (categories beside the sheet, on top, or the phone page) and no category or phone page scrolls sideways.
 */
async function verifySettingsWidths(page: Page, origin: string): Promise<void> {
  for (const scale of ["sm", "xl"] as const) {
    await page.evaluate(({ key, value }) => (globalThis as unknown as BrowserGlobal).localStorage.setItem(key, value), { key: SCALE_KEY, value: scale });
    for (const width of MATRIX_WIDTHS_PX) {
      const label = `${scale} at ${width}px`;
      await page.setViewportSize({ width, height: HEIGHT_PX });
      await page.goto(`${origin}/`);
      await openSettings(page);
      const layout = await settingsLayout(page);
      // XL's larger root size narrows the shell past the phone breakpoint at 700px; Compact keeps the dialog there.
      const expected: SettingsLayout = width >= TOP_TABS_BELOW_PX ? "side" : scale === "xl" ? "phone" : "top";
      assert.equal(layout, expected, `${label}: Settings shows the ${layout} layout`);
      if (layout === "phone") {
        await noSidewaysScroll(page, `${label} phone Settings`);
        for (const [section, title] of PHONE_PAGES) {
          await page.evaluate((hash) => ((globalThis as unknown as { location: { hash: string } }).location.hash = hash), `#/settings/${section}`);
          await page.getByRole("heading", { name: title, level: 1 }).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
          await noSidewaysScroll(page, `${label} phone ${title}`);
        }
        continue;
      }
      for (const category of SETTINGS_CATEGORIES) {
        await page.getByRole("tab", { name: category }).click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
        await page.getByRole("tabpanel", { name: category }).getByRole("heading", { name: category, level: 2, exact: true }).first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
        await noSidewaysScroll(page, `${label} ${category}`);
      }
    }
  }
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
}

/**
 * Postcondition: General settings, New PM, and their phone and scale variants keep every control keyboard-visible and in bounds,
 * and every Settings category holds its layout at Compact and XL at 860px and 700px.
 */
export async function verifySettingsKeyboard(browser: Browser, loginUrl: string, origin: string, folderPicker: boolean, shotDir?: string): Promise<void> {
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
    await verifySettingsWidths(page, origin);
    await page.evaluate((key) => (globalThis as unknown as BrowserGlobal).localStorage.setItem(key, "md"), SCALE_KEY);
    await page.setViewportSize({ width: WIDE_PX, height: HEIGHT_PX });
    await page.goto(`${origin}/`);
    await openSettings(page);
    await page.getByRole("tab", { name: "General" }).focus({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertRings(await walkFocus(page, "settings-general", shotDir), "Settings General");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.locator('nav[aria-label="Workspace"] button:has([data-testid="rail-device-dot-local"])').click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.getByRole("button", { name: "New project manager" }).first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    const dialog = page.getByRole("dialog", { name: "New project manager" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Keyboard check", { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await dialog.getByRole("button", { name: "More settings" }).click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await dialog.getByRole("textbox", { name: "Persona" }).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assert.ok(await dialog.getByRole("button", { name: "Create" }).isEnabled(), "New PM: Create stays disabled with a valid name");
    await dialog.getByRole("textbox", { name: "Name" }).focus();
    assertNewPmStops(await walkFocus(page, "new-pm", shotDir), folderPicker);
    assert.deepEqual(errors, [], `Settings keyboard check hit page errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
}
