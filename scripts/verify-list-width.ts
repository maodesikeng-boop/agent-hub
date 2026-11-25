import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { SHELL_LIST_REM } from "../src/web/limits.ts";

// Copies of UI_SCALES and UI_SCALE_KEY: src/web/ui-scale.ts needs the DOM lib, which scripts/ compile without.
const SCALES = ["sm", "md", "lg", "xl"] as const;
const SCALE_KEY = "agent-hub.uiScale";
// The desktop window minimum, where Large and XL already leave the conversation under its own minimum, and a narrower browser.
const WIDTHS_PX = [860, 700] as const;

interface ShellWidths {
  rootPx: number;
  listPx: number;
  scrollPx: number;
}

interface BrowserGlobal {
  document: {
    documentElement: { scrollWidth: number };
    querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
  };
  getComputedStyle(el: unknown): { fontSize: string };
  localStorage: { setItem(key: string, value: string): void };
  requestAnimationFrame(cb: () => void): void;
}

async function settledWidths(page: Page): Promise<ShellWidths> {
  return page.evaluate(async () => {
    const g = globalThis as unknown as BrowserGlobal;
    await new Promise<void>((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(() => done())));
    const list = g.document.querySelector('[data-panel][id="list"]');
    if (list === null) throw new Error("PM column pane not found");
    return {
      rootPx: Number.parseFloat(g.getComputedStyle(g.document.documentElement).fontSize),
      listPx: list.getBoundingClientRect().width,
      scrollPx: g.document.documentElement.scrollWidth,
    };
  });
}

/**
 * Postcondition: with the work panel closed, the PM column is at least its minimum at every interface scale, both at the
 * desktop window minimum and in a narrower browser window, and the page never scrolls sideways.
 */
export async function verifyProjectListMinimum(browser: Browser, loginUrl: string, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    for (const scale of SCALES) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(({ key, value }) => {
        const g = globalThis as unknown as BrowserGlobal;
        g.localStorage.setItem(key, value);
        g.localStorage.setItem("agent-hub.rightRail", "closed");
      }, { key: SCALE_KEY, value: scale });
      await page.reload();
      await page.locator("#root textarea").first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
      await page.locator('nav[aria-label="Workspace"] button:has([data-testid^="rail-device-dot-"])').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
      await page.locator('[data-panel][id="list"]').waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
      for (const width of WIDTHS_PX) {
        await page.setViewportSize({ width, height: 800 });
        const m = await settledWidths(page);
        const minPx = SHELL_LIST_REM.min * m.rootPx;
        assert.ok(m.listPx >= minPx - 0.5, `${scale} at ${width}px: PM column ${m.listPx.toFixed(2)}px is under its ${minPx}px minimum`);
        assert.ok(m.scrollPx <= width, `${scale} at ${width}px: page scrolls sideways (${m.scrollPx}px)`);
      }
    }
    assert.deepEqual(errors, [], `PM column width check hit page errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
}
