import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { COMPOSER_MAX_HEIGHT_PX } from "../src/web/limits.ts";
import type { VerifyStepContext } from "./verify-diagnostics.ts";

const CHAT_COMPOSER_FRAME_SELECTOR = "#chat .composer-frame";
const CHAT_COMPOSER_SELECTOR = '#chat .composer-frame textarea[aria-label="Message"]';
const ACTION_TIMEOUT = { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS };

interface BrowserTextarea {
  value: string;
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
  selectionStart: number;
  selectionEnd: number;
  ownerDocument: { activeElement: unknown; defaultView: { getComputedStyle(el: unknown): { getPropertyValue(name: string): string } } };
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

const geometry = (box: Locator) => box.evaluate((node) => {
  const el = node as unknown as BrowserTextarea;
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return {
    multiline: el.closest(".composer-frame")?.getAttribute("data-multiline") === "true",
    focused: el.ownerDocument.activeElement === el,
    caret: [el.selectionStart, el.selectionEnd],
    height: el.clientHeight,
    sizing: style.getPropertyValue("field-sizing"),
    fontSize: Number.parseFloat(style.getPropertyValue("font-size")),
    width: el.clientWidth,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
  };
}, undefined, ACTION_TIMEOUT);

function assertSingleRow(size: Awaited<ReturnType<typeof geometry>>, height: number): void {
  assert.equal(size.multiline, false, "The draft did not return to one row");
  assert.equal(size.height, height, "Single row changed height");
  assert.notEqual(size.sizing, "content", "The single row uses intrinsic text sizing");
  assert(size.scrollHeight <= size.height && size.scrollWidth <= size.width,
    `Text overflowed the single row: ${size.scrollWidth}×${size.scrollHeight}px in ${size.width}×${size.height}px`);
}

async function verifySoftWrap(page: Page, box: Locator, singleHeight: number, engine: string, outDir: string): Promise<void> {
  const frame = page.locator(CHAT_COMPOSER_FRAME_SELECTOR);
  await box.fill("W".repeat(Math.floor((await geometry(box)).width / 24)), ACTION_TIMEOUT);
  let length = (await box.inputValue(ACTION_TIMEOUT)).length;
  for (; length < 180; length++) {
    assertSingleRow(await geometry(box), singleHeight);
    await box.press("W", ACTION_TIMEOUT);
    if ((await geometry(box)).multiline) break;
  }
  assert(length < 180, "Typing never crossed the soft wrap boundary");
  assert.equal(await box.inputValue(ACTION_TIMEOUT), "W".repeat(length + 1));
  const wrapped = await geometry(box);
  assert(wrapped.scrollHeight <= wrapped.height, "Text overflowed after the composer switched rows");
  await frame.screenshot({ path: join(outDir, `composer-${engine}-wrapped.png`), ...ACTION_TIMEOUT });
  await box.press("Backspace", ACTION_TIMEOUT);
  assertSingleRow(await geometry(box), singleHeight);
  assert.equal(await box.inputValue(ACTION_TIMEOUT), "W".repeat(length));
  const after = await geometry(box);
  assert(after.focused);
  assert.deepEqual(after.caret, [length, length]);
  await frame.screenshot({ path: join(outDir, `composer-${engine}-single.png`), ...ACTION_TIMEOUT });
  console.log(`PASS ${engine}: typing wraps at ${length + 1} characters and Backspace restores one row and the caret`);
}

async function verifyTextPaste(page: Page, box: Locator, singleHeight: number, engine: string): Promise<void> {
  const text = "Paste keeps the complete draft and wraps it. ".repeat(60);
  await box.fill("", ACTION_TIMEOUT);
  if (engine === "Chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((value) => {
      const { navigator } = globalThis as unknown as { navigator: { clipboard: { writeText(text: string): Promise<void> } } };
      return navigator.clipboard.writeText(value);
    }, text);
    await box.press("ControlOrMeta+V", ACTION_TIMEOUT);
    await page.waitForFunction(({ selector, expected }) => {
      const { document } = globalThis as unknown as { document: { querySelector(s: string): BrowserTextarea | null } };
      return document.querySelector(selector)?.value === expected;
    }, { selector: CHAT_COMPOSER_SELECTOR, expected: text }, ACTION_TIMEOUT);
  } else {
    const pasteAllowed = await box.evaluate((node, value) => {
      interface Transfer { setData(type: string, value: string): void }
      const { DataTransfer, ClipboardEvent } = globalThis as unknown as {
        DataTransfer: new () => Transfer;
        ClipboardEvent: new (type: string, init: { clipboardData: Transfer; bubbles: boolean; cancelable: boolean }) => unknown;
      };
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      const el = node as unknown as { dispatchEvent(event: unknown): boolean };
      return el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, text, ACTION_TIMEOUT);
    assert(pasteAllowed, "The composer canceled a text paste");
    await page.keyboard.insertText(text);
  }
  assert.equal(await box.inputValue(ACTION_TIMEOUT), text);
  const tall = await geometry(box);
  assert(tall.multiline && tall.height === COMPOSER_MAX_HEIGHT_PX && tall.scrollHeight > tall.height, "Pasted draft did not grow to the scrollable height limit");
  await box.press("ControlOrMeta+A", ACTION_TIMEOUT);
  await box.press("Backspace", ACTION_TIMEOUT);
  assert.equal(await box.inputValue(ACTION_TIMEOUT), "");
  assertSingleRow(await geometry(box), singleHeight);
  console.log(`PASS ${engine}: paste reaches the height cap, scrolls, and clears back to one row`);
}

async function verifyComposition(page: Page, box: Locator, singleHeight: number, engine: string, outDir: string): Promise<void> {
  const frame = page.locator(CHAT_COMPOSER_FRAME_SELECTOR);
  await box.fill("草稿：", ACTION_TIMEOUT);
  const before = await geometry(box);
  const marked = "组字期间保留原来的输入框位置。".repeat(10);
  await box.dispatchEvent("compositionstart", { bubbles: true, data: "" }, ACTION_TIMEOUT);
  await page.keyboard.insertText(marked);
  await box.dispatchEvent("compositionupdate", { bubbles: true, data: marked }, ACTION_TIMEOUT);
  assert.equal(await box.inputValue(ACTION_TIMEOUT), `草稿：${marked}`);
  const during = await geometry(box);
  assert.equal(during.multiline, false, "Marked text moved the controls before composition ended");
  assert.equal(during.height, singleHeight);
  assert.equal(during.width, before.width);
  assert(during.focused);
  await box.dispatchEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }, ACTION_TIMEOUT);
  assert.equal(await box.inputValue(ACTION_TIMEOUT), `草稿：${marked}`, "Candidate confirmation sent the draft");
  await frame.screenshot({ path: join(outDir, `composer-${engine}-composing.png`), ...ACTION_TIMEOUT });
  await box.dispatchEvent("compositionend", { bubbles: true, data: marked }, ACTION_TIMEOUT);
  const after = await geometry(box);
  assert(after.multiline && after.focused);
  assert.equal(await box.inputValue(ACTION_TIMEOUT), `草稿：${marked}`);
  assert.deepEqual(after.caret, [marked.length + 3, marked.length + 3]);
  await frame.screenshot({ path: join(outDir, `composer-${engine}-committed.png`), ...ACTION_TIMEOUT });
  console.log(`PASS ${engine}: marked text holds the row in place, and commit wraps without losing text or focus`);
}

export async function verifyComposerInteractions(
  page: Page,
  engine: "Chromium" | "WebKit",
  outDir: string,
  steps?: VerifyStepContext,
): Promise<void> {
  const inStep = <T>(name: string, fn: () => Promise<T>): Promise<T> => (steps ? steps.step(name, fn) : fn());
  const box = page.locator(CHAT_COMPOSER_SELECTOR);
  await box.fill("One short line", ACTION_TIMEOUT);
  const { height } = await geometry(box);
  await inStep(`${engine} soft wrap`, () => verifySoftWrap(page, box, height, engine, outDir));
  await inStep(`${engine} text paste`, () => verifyTextPaste(page, box, height, engine));
  await inStep(`${engine} composition`, () => verifyComposition(page, box, height, engine, outDir));
}

export async function verifyTouchSoftWrap(
  page: Page,
  scale: "sm" | "md",
  outDir: string,
  steps?: VerifyStepContext,
): Promise<void> {
  const inStep = <T>(name: string, fn: () => Promise<T>): Promise<T> => (steps ? steps.step(name, fn) : fn());
  const { coarse, bodyFontSize } = await page.evaluate(async (uiScale) => {
    const browser = globalThis as unknown as {
      document: { documentElement: { dataset: { uiScale: string } }; body: unknown };
      requestAnimationFrame(callback: () => void): void;
      matchMedia(query: string): { matches: boolean };
      getComputedStyle(el: unknown): { fontSize: string };
    };
    browser.document.documentElement.dataset.uiScale = uiScale;
    await new Promise<void>((resolve) => browser.requestAnimationFrame(() => browser.requestAnimationFrame(resolve)));
    return {
      coarse: browser.matchMedia("(pointer: coarse)").matches,
      bodyFontSize: Number.parseFloat(browser.getComputedStyle(browser.document.body).fontSize),
    };
  }, scale);
  assert(coarse && bodyFontSize < 16, "Composer touch check requires a coarse pointer and body text under 16px");
  const box = page.locator(CHAT_COMPOSER_SELECTOR);
  await box.fill("One short line", ACTION_TIMEOUT);
  const { height, fontSize } = await geometry(box);
  assert.equal(fontSize, 16, "Composer touch check requires the textarea font floor");
  await inStep(`WebKit-touch-${scale} soft wrap`, () => verifySoftWrap(page, box, height, `WebKit-touch-${scale}`, outDir));
}
