import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { SHELL_CHAT_USABLE_REM, SHELL_LIST_REM } from "../src/web/limits.ts";

// Copies of UI_SCALES and UI_SCALE_KEY: src/web/ui-scale.ts needs the DOM lib, which scripts/ compile without.
const SCALES = ["sm", "md", "lg", "xl"] as const;
const SCALE_KEY = "agent-hub.uiScale";
// The desktop window minimum keeps the columns side by side at every scale.
const DESKTOP_MIN_PX = 860;
// A narrower browser window: side by side or one column, depending on the scale.
const BROWSER_PX = 700;
// Phone-width windows with a mouse: too narrow for the PM column beside a usable conversation at any scale.
const ONE_COLUMN_PX = [400, 375] as const;
const WIDE_PX = 1280;
const HEIGHT_PX = 800;
const DRAFT = "narrow window";
const SETTLE_SAMPLES = 15;

interface ShellWidths {
  shell: string | null;
  rootPx: number;
  listPx: number | null;
  chatPx: number | null;
  scrollPx: number;
}

interface BrowserGlobal {
  document: {
    documentElement: { scrollWidth: number };
    querySelector(selector: string): { getAttribute(name: string): string | null; getBoundingClientRect(): { width: number } } | null;
    elementFromPoint(x: number, y: number): unknown;
  };
  getComputedStyle(el: unknown): { fontSize: string };
  localStorage: { setItem(key: string, value: string): void };
  requestAnimationFrame(cb: () => void): void;
}

interface Box {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** Postcondition: returns the shell's widths once two samples, each two frames apart, measure the same, or the last sample. */
async function settledWidths(page: Page): Promise<ShellWidths> {
  return page.evaluate(async (samples) => {
    const g = globalThis as unknown as BrowserGlobal;
    // A frame runs its animation callbacks before its resize observers, so only the frame after next sees their layout.
    const nextLayout = () => new Promise<void>((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(() => done())));
    const measure = async (): Promise<string> => {
      await nextLayout();
      const width = (selector: string) => g.document.querySelector(selector)?.getBoundingClientRect().width ?? null;
      const m: ShellWidths = {
        shell: g.document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null,
        rootPx: Number.parseFloat(g.getComputedStyle(g.document.documentElement).fontSize),
        listPx: width('[data-panel][id="list"]'),
        chatPx: width('[data-panel][id="chat"]'),
        scrollPx: g.document.documentElement.scrollWidth,
      };
      return JSON.stringify(m);
    };
    let last = await measure();
    for (let i = 0; i < samples; i++) {
      const next = await measure();
      if (next === last) break;
      last = next;
    }
    return JSON.parse(last) as ShellWidths;
  }, SETTLE_SAMPLES);
}

function assertColumns(m: ShellWidths, label: string): void {
  assert.equal(m.shell, "desktop", `${label}: expected the PM column beside the conversation, got the ${m.shell} shell`);
  const listMinPx = SHELL_LIST_REM.min * m.rootPx;
  const chatUsablePx = SHELL_CHAT_USABLE_REM * m.rootPx;
  assert.ok(m.listPx !== null && m.listPx >= listMinPx - 0.5, `${label}: PM column ${m.listPx}px is under its ${listMinPx}px minimum`);
  assert.ok(m.chatPx !== null && m.chatPx >= chatUsablePx - 1, `${label}: conversation ${m.chatPx}px is under its usable ${chatUsablePx}px`);
}

/** Postcondition: from a conversation in the single-column shell, goes back to the project list, opens a project, and types. */
async function openProjectAndType(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  await page.locator('section[aria-label="Project managers"] .project-row > button').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  const draft = page.locator("main.chat-main .composer-frame textarea");
  await draft.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  const onTop = await draft.evaluate((el) => {
    const r = (el as unknown as Box).getBoundingClientRect();
    const g = globalThis as unknown as BrowserGlobal;
    return r.width > 0 && g.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  });
  assert.ok(onTop, `${label}: the composer is covered or has no width`);
  await draft.click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  await draft.fill("");
  await page.keyboard.type(DRAFT);
  assert.equal(await draft.inputValue(), DRAFT, `${label}: typing did not reach the composer`);
}

/**
 * Postcondition: with the work panel closed, at every interface scale: the desktop window minimum keeps the PM column at
 * its minimum beside a usable conversation; a narrower browser window does the same or switches to the single-column
 * shell; phone-width mouse windows use the single-column shell, where a project opens and its composer takes typing; a
 * wide window brings the columns back with the draft; and the page never scrolls sideways.
 */
export async function verifyShellWidths(browser: Browser, loginUrl: string, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: WIDE_PX, height: HEIGHT_PX } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    for (const scale of SCALES) {
      await page.setViewportSize({ width: WIDE_PX, height: HEIGHT_PX });
      await page.evaluate(({ key, value }) => {
        const g = globalThis as unknown as BrowserGlobal;
        g.localStorage.setItem(key, value);
        g.localStorage.setItem("agent-hub.rightRail", "closed");
      }, { key: SCALE_KEY, value: scale });
      await page.reload();
      await page.locator("#root textarea").first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
      await page.locator('nav[aria-label="Workspace"] button:has([data-testid^="rail-device-dot-"])').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
      await page.locator('[data-panel][id="list"]').waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });

      for (const width of [DESKTOP_MIN_PX, BROWSER_PX, ...ONE_COLUMN_PX]) {
        const label = `${scale} at ${width}px`;
        await page.setViewportSize({ width, height: HEIGHT_PX });
        const m = await settledWidths(page);
        assert.ok(m.scrollPx <= width, `${label}: page scrolls sideways (${m.scrollPx}px)`);
        if (width === DESKTOP_MIN_PX || (width === BROWSER_PX && m.shell === "desktop")) {
          assertColumns(m, label);
          continue;
        }
        assert.equal(m.shell, "mobile", `${label}: expected the single-column shell, got the ${m.shell} shell with a ${m.chatPx}px conversation`);
        if (width !== BROWSER_PX) await openProjectAndType(page, label);
      }

      await page.setViewportSize({ width: WIDE_PX, height: HEIGHT_PX });
      assertColumns(await settledWidths(page), `${scale} back at ${WIDE_PX}px`);
      const draft = page.locator("#chat .composer-frame textarea");
      assert.equal(await draft.inputValue(), DRAFT, `${scale} back at ${WIDE_PX}px: the draft typed in one column is gone`);
      await draft.fill("");
    }
    assert.deepEqual(errors, [], `Shell width check hit page errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
}
