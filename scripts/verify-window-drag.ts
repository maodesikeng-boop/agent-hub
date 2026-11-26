import assert from "node:assert/strict";
import type { Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";

interface DragProbe {
  document: { elementFromPoint(x: number, y: number): { closest(selector: string): unknown } | null };
  dragMessages: unknown[];
}

const ROUTER_INPUT = 'input[aria-label="Message Router"]';

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  // Radix starts listening for outside presses one task after the page mounts; a press before that is not an outside press.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return settings;
}

const dragMessages = (page: Page) => page.evaluate(() => (globalThis as unknown as DragProbe).dragMessages);

/**
 * Postcondition: with the Settings page open, the wood beside the top-bar Router input hit-tests to a `data-window-drag`
 * region, and a click and a double-click there reach the native drag bridge as one drag and one zoom without closing the
 * page; a click on the rail still closes it; and a click on the Router input posts nothing to the bridge, closes the page,
 * and leaves the focus in the input. The bridge is a recorder standing in for `window.webkit.messageHandlers.windowDrag`.
 */
export async function verifyTopBarUnderSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as DragProbe;
    g.dragMessages = [];
    const windowDrag = { postMessage: (payload: unknown) => g.dragMessages.push(payload) };
    Object.defineProperty(g, "webkit", { configurable: true, value: { messageHandlers: { windowDrag } } });
  });
  const settings = await openSettings(page);

  const topBar = (await page.locator(".shell-topbar").boundingBox())!;
  const input = (await page.locator(".topbar-router").boundingBox())!;
  const x = topBar.x + (input.x - topBar.x) / 2;
  const y = topBar.y + topBar.height / 2;
  const onChrome = await page.evaluate(([px, py]) => {
    const g = globalThis as unknown as DragProbe;
    const hit = g.document.elementFromPoint(px!, py!);
    return hit?.closest("[data-window-drag]") != null && hit.closest("[data-no-drag]") == null;
  }, [x, y]);
  assert.ok(onChrome, `With Settings open, (${x}, ${y}) beside the Router input does not hit the top bar's drag region`);

  await page.mouse.click(x, y);
  await page.mouse.dblclick(x, y);
  assert.deepEqual(await dragMessages(page), [{ doubleClick: false }, { doubleClick: false }, { doubleClick: true }], "The top bar under Settings did not reach the drag bridge");
  assert.ok(await settings.isVisible(), "Pressing the top bar closed the Settings page");

  const rail = (await page.locator('nav[aria-label="Workspace"]').boundingBox())!;
  await page.mouse.click(rail.x + rail.width / 2, rail.y + rail.height / 2);
  await settings.waitFor({ state: "hidden", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });

  const reopened = await openSettings(page);
  await page.mouse.click(input.x + input.width / 2, input.y + input.height / 2);
  await reopened.waitFor({ state: "hidden", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  await page.locator(ROUTER_INPUT).and(page.locator(":focus")).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  assert.equal((await dragMessages(page)).length, 3, "Clicking the top-bar Router input reached the window drag bridge");
}
