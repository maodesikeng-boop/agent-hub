import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { COMPOSER_MAX_HEIGHT_PX } from "../src/web/limits.ts";

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
});

function assertSingleRow(size: Awaited<ReturnType<typeof geometry>>, height: number): void {
  assert.equal(size.multiline, false, "The draft did not return to one row");
  assert.equal(size.height, height, "Single row changed height");
  assert.notEqual(size.sizing, "content", "The single row uses intrinsic text sizing");
  assert(size.scrollHeight <= size.height && size.scrollWidth <= size.width,
    `Text overflowed the single row: ${size.scrollWidth}×${size.scrollHeight}px in ${size.width}×${size.height}px`);
}

async function verifySoftWrap(page: Page, box: Locator, singleHeight: number, engine: string, outDir: string): Promise<void> {
  const frame = page.locator(".composer-frame").filter({ has: box });
  await box.fill("W".repeat(Math.floor((await geometry(box)).width / 24)));
  let length = (await box.inputValue()).length;
  for (; length < 180; length++) {
    assertSingleRow(await geometry(box), singleHeight);
    await box.press("W");
    if ((await geometry(box)).multiline) break;
  }
  assert(length < 180, "Typing never crossed the soft wrap boundary");
  assert.equal(await box.inputValue(), "W".repeat(length + 1));
  const wrapped = await geometry(box);
  assert(wrapped.scrollHeight <= wrapped.height, "Text overflowed after the composer switched rows");
  await frame.screenshot({ path: join(outDir, `composer-${engine}-wrapped.png`) });
  await box.press("Backspace");
  assertSingleRow(await geometry(box), singleHeight);
  assert.equal(await box.inputValue(), "W".repeat(length));
  const after = await geometry(box);
  assert(after.focused);
  assert.deepEqual(after.caret, [length, length]);
  await frame.screenshot({ path: join(outDir, `composer-${engine}-single.png`) });
  console.log(`PASS ${engine}: typing wraps at ${length + 1} characters and Backspace restores one row and the caret`);
}

async function verifyTextPaste(page: Page, box: Locator, singleHeight: number, engine: string): Promise<void> {
  const text = "Paste keeps the complete draft and wraps it. ".repeat(60);
  await box.fill("");
  if (engine === "Chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((value) => {
      const { navigator } = globalThis as unknown as { navigator: { clipboard: { writeText(text: string): Promise<void> } } };
      return navigator.clipboard.writeText(value);
    }, text);
    await box.press("ControlOrMeta+V");
    await page.waitForFunction((expected) => {
      const { document } = globalThis as unknown as { document: { querySelector(selector: string): BrowserTextarea | null } };
      return document.querySelector('textarea[aria-label="Message"]')?.value === expected;
    }, text, { timeout: 3_000 });
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
    }, text);
    assert(pasteAllowed, "The composer canceled a text paste");
    await page.keyboard.insertText(text);
  }
  assert.equal(await box.inputValue(), text);
  const tall = await geometry(box);
  assert(tall.multiline && tall.height === COMPOSER_MAX_HEIGHT_PX && tall.scrollHeight > tall.height, "Pasted draft did not grow to the scrollable height limit");
  await box.press("ControlOrMeta+A");
  await box.press("Backspace");
  assert.equal(await box.inputValue(), "");
  assertSingleRow(await geometry(box), singleHeight);
  console.log(`PASS ${engine}: paste reaches the height cap, scrolls, and clears back to one row`);
}

async function verifyComposition(page: Page, box: Locator, singleHeight: number, engine: string, outDir: string): Promise<void> {
  const frame = page.locator(".composer-frame").filter({ has: box });
  await box.fill("草稿：");
  const before = await geometry(box);
  const marked = "组字期间保留原来的输入框位置。".repeat(10);
  await box.dispatchEvent("compositionstart", { bubbles: true, data: "" });
  await page.keyboard.insertText(marked);
  await box.dispatchEvent("compositionupdate", { bubbles: true, data: marked });
  assert.equal(await box.inputValue(), `草稿：${marked}`);
  const during = await geometry(box);
  assert.equal(during.multiline, false, "Marked text moved the controls before composition ended");
  assert.equal(during.height, singleHeight);
  assert.equal(during.width, before.width);
  assert(during.focused);
  await box.dispatchEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  assert.equal(await box.inputValue(), `草稿：${marked}`, "Candidate confirmation sent the draft");
  await frame.screenshot({ path: join(outDir, `composer-${engine}-composing.png`) });
  await box.dispatchEvent("compositionend", { bubbles: true, data: marked });
  const after = await geometry(box);
  assert(after.multiline && after.focused);
  assert.equal(await box.inputValue(), `草稿：${marked}`);
  assert.deepEqual(after.caret, [marked.length + 3, marked.length + 3]);
  await frame.screenshot({ path: join(outDir, `composer-${engine}-committed.png`) });
  console.log(`PASS ${engine}: marked text holds the row in place, and commit wraps without losing text or focus`);
}

export async function verifyComposerInteractions(page: Page, engine: "Chromium" | "WebKit", outDir: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("One short line");
  const { height } = await geometry(box);
  await verifySoftWrap(page, box, height, engine, outDir);
  await verifyTextPaste(page, box, height, engine);
  await verifyComposition(page, box, height, engine, outDir);
}

export async function verifyTouchSoftWrap(page: Page, scale: "sm" | "md", outDir: string): Promise<void> {
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
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("One short line");
  const { height, fontSize } = await geometry(box);
  assert.equal(fontSize, 16, "Composer touch check requires the textarea font floor");
  await verifySoftWrap(page, box, height, `WebKit-touch-${scale}`, outDir);
}
