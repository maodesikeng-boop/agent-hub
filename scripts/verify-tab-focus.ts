import type { Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { readFocus } from "./verify-settings-keyboard.ts";

/**
 * Precondition: `page` shows a project manager's conversation with the work panel closed.
 * Postcondition: a work panel tab pressed with the mouse right after typing shows no focus mark, and the tabs reached by
 * Tab or the arrow keys show the 2px keyboard outline. The work panel is closed again and the draft is empty.
 */
export async function verifyTabFocus(page: Page): Promise<void> {
  const timeout = VERIFY_SMOKE_STEP_TIMEOUT_MS;
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await page.getByRole("button", { name: /^Show work panel/ }).click({ timeout });
  const tabs = page.getByRole("tablist", { name: "Work panel tabs" });
  await composer.click({ timeout });
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await tabs.getByRole("tab", { name: "Info", exact: true }).click({ timeout });
  const pressed = await readFocus(page);
  if (pressed.name !== "Info" || pressed.focusVisible) {
    throw new Error(`Pressing the Info tab after typing drew a keyboard focus mark: ${JSON.stringify(pressed)}`);
  }
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const tabbed = await readFocus(page);
  if (tabbed.name !== "Info" || !tabbed.ring) throw new Error(`Shift+Tab back to the Info tab drew no focus mark: ${JSON.stringify(tabbed)}`);
  await page.keyboard.press("ArrowLeft");
  await tabs.locator('[role="tab"]:focus', { hasText: "Completed" }).waitFor({ timeout });
  const arrowed = await readFocus(page);
  if (!arrowed.name.startsWith("Completed") || !arrowed.ring) throw new Error(`ArrowLeft to the Completed tab drew no focus mark: ${JSON.stringify(arrowed)}`);
  await page.getByRole("button", { name: "Close work panel" }).click({ timeout });
}
