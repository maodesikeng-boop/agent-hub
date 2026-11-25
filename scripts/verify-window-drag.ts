import assert from "node:assert/strict";
import type { Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";

interface DragProbe {
  document: { elementFromPoint(x: number, y: number): { closest(selector: string): unknown } | null };
  dragMessages: unknown[];
}

/**
 * Postcondition: with the Settings page open, the middle of the top bar hit-tests to a `data-window-drag` region, a click and
 * a double-click there reach the native drag bridge as one drag and one zoom without closing the page, and a click on the
 * rail still closes it. The bridge is a recorder standing in for `window.webkit.messageHandlers.windowDrag`.
 */
export async function verifyTopBarUnderSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as DragProbe;
    g.dragMessages = [];
    const windowDrag = { postMessage: (payload: unknown) => g.dragMessages.push(payload) };
    Object.defineProperty(g, "webkit", { configurable: true, value: { messageHandlers: { windowDrag } } });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });

  const topBar = (await page.locator(".shell-topbar").boundingBox())!;
  const x = topBar.x + topBar.width / 2;
  const y = topBar.y + topBar.height / 2;
  const onChrome = await page.evaluate(([px, py]) => {
    const g = globalThis as unknown as DragProbe;
    return g.document.elementFromPoint(px!, py!)?.closest("[data-window-drag]") != null;
  }, [x, y]);
  assert.ok(onChrome, `With Settings open, (${x}, ${y}) does not hit the top bar's drag region`);

  await page.mouse.click(x, y);
  await page.mouse.dblclick(x, y);
  const messages = await page.evaluate(() => (globalThis as unknown as DragProbe).dragMessages);
  assert.deepEqual(messages, [{ doubleClick: false }, { doubleClick: false }, { doubleClick: true }], "The top bar under Settings did not reach the drag bridge");
  assert.ok(await settings.isVisible(), "Pressing the top bar closed the Settings page");

  const rail = (await page.locator('nav[aria-label="Workspace"]').boundingBox())!;
  await page.mouse.click(rail.x + rail.width / 2, rail.y + rail.height / 2);
  await settings.waitFor({ state: "hidden", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
}
