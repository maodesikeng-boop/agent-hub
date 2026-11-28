import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { webkit, type Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import type { VerifyStepContext } from "./verify-diagnostics.ts";
import { verifyComposerInteractions, verifyTouchSoftWrap } from "./verify-composer-interactions.ts";

export interface TimelineRecord {
  type: string;
  startTime: number;
  data?: { message?: string; root?: number[] };
  children?: TimelineRecord[];
}

export interface WebKitTimelineSession {
  on(event: "Timeline.eventRecorded", listener: (event: { record: TimelineRecord }) => void): void;
  off?(event: "Timeline.eventRecorded", listener: (event: { record: TimelineRecord }) => void): void;
  removeListener?(event: "Timeline.eventRecorded", listener: (event: { record: TimelineRecord }) => void): void;
  isDisposed?(): boolean;
  send(
    method: "Timeline.enable" | "Timeline.start" | "Timeline.stop" | "Timeline.disable",
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface WebKitTimelineOptions {
  timeoutMs?: number;
  steps?: VerifyStepContext;
  describeState?: () => string;
}

export interface WebKitTimelineResult<T> {
  result: T;
  records: TimelineRecord[];
}

export interface OpenComposerOptions {
  timeoutMs?: number;
  steps?: VerifyStepContext;
}

export const COMPOSER_CHAT_TEXTAREA_SELECTOR = '#chat .composer-frame textarea[aria-label="Message"]';

interface TimelineSession {
  on(event: "Timeline.eventRecorded", listener: (event: { record: TimelineRecord }) => void): void;
  send(method: "Timeline.enable" | "Timeline.start" | "Timeline.stop"): Promise<unknown>;
}

/**
 * Precondition: `session` is an active WebKit inspector session and `timeoutMs` is a positive finite duration.
 * Postcondition: subscribes to `Timeline.eventRecorded`, sends `Timeline.enable` and `Timeline.start` with
 * `{ maxCallStackDepth: 0 }`, executes `run`, and always removes the event listener and attempts `Timeline.stop` and
 * `Timeline.disable` in `finally` (skipping commands when `session.isDisposed?.()` is true). Never masks an error thrown
 * by `run` with a teardown error, rewrites empty-message ProtocolErrors with method/type/logs/state details, and rejects
 * if any inspector command exceeds `timeoutMs`.
 */
export async function runWithWebKitTimeline<T>(
  _session: WebKitTimelineSession,
  _run: () => Promise<T>,
  _options: WebKitTimelineOptions = { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS },
): Promise<WebKitTimelineResult<T>> {
  throw new Error("Not implemented");
}

/**
 * Precondition: `page` is a freshly created Playwright page and `loginUrl` is a valid Bellwood passwordless auth URL.
 * Postcondition: attaches `pageerror`, `console`, `crash`, and `close` listeners (ignoring only the known WebKit
 * `interactive-widget` viewport warning), navigates through `loginUrl` until redirected off `/auth`, opens
 * `/#/c/<conversationId>`, waits for `COMPOSER_CHAT_TEXTAREA_SELECTOR`, `networkidle`, `document.fonts.ready`, and two
 * animation frames, applying `timeoutMs` (default `VERIFY_SMOKE_STEP_TIMEOUT_MS`) to every wait.
 */
export async function openComposerPage(
  _page: Page,
  _loginUrl: string,
  _conversationId: number,
  _errors: string[],
  _options: OpenComposerOptions = { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS },
): Promise<void> {
  throw new Error("Not implemented");
}

function timelineSession(page: Page): TimelineSession {
  // Playwright exposes CDP sessions for Chromium only; WebKit's inspector sits behind its local delegate.
  const { _connection } = page as unknown as {
    _connection?: { toImpl?: (page: Page) => { delegate?: { _session?: TimelineSession } } };
  };
  const session = _connection?.toImpl?.(page)?.delegate?._session;
  assert(session && typeof session.send === "function" && typeof session.on === "function", "Playwright WebKit timeline is unavailable");
  return session;
}

interface FrameClock {
  requestAnimationFrame(callback: () => void): void;
  console: { timeStamp(label: string): void };
}

const KEYS = ["x", "Backspace", "y", "Backspace", "z", "Backspace"] as const;
const WEBKIT_VIEWPORT_WARNING = 'Viewport argument key "interactive-widget" not recognized and ignored.';
const CASES = [
  { name: "single line", draft: "Draft text", cursor: 5 },
  { name: "multiline middle edit", draft: "First line\nSecond line\nThird line", cursor: 5 },
] as const;

function layoutsPerKey(records: TimelineRecord[], startIndex: number): TimelineRecord[][] {
  const marks = new Map<string, number>();
  const layouts: TimelineRecord[] = [];
  const visit = (record: TimelineRecord): void => {
    if (record.type === "Layout") layouts.push(record);
    if (record.type === "TimeStamp" && record.data?.message) marks.set(record.data.message, record.startTime);
    record.children?.forEach(visit);
  };
  records.forEach(visit);
  return KEYS.map((_, index) => {
    const start = marks.get(`composer:start:${startIndex + index}`);
    const end = marks.get(`composer:end:${startIndex + index}`);
    assert(start !== undefined && end !== undefined && end > start, "Missing WebKit key or frame marker");
    return layouts.filter(({ startTime }) => startTime >= start && startTime < end);
  });
}

function layoutHeight(record: TimelineRecord): number {
  const root = record.data?.root;
  if (root?.length !== 8 || !root.every(Number.isFinite)) return Infinity;
  const ys = root.filter((_, index) => index % 2 === 1);
  return Math.round(Math.max(...ys) - Math.min(...ys));
}

async function pressAndTrace(page: Page, index: number, key: string): Promise<void> {
  await page.evaluate((id) => {
    (globalThis as unknown as FrameClock).console.timeStamp(`composer:start:${id}`);
  }, index);
  await page.keyboard.press(key);
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve) => {
        const clock = globalThis as unknown as FrameClock;
        clock.requestAnimationFrame(() => clock.requestAnimationFrame(() => {
          clock.console.timeStamp(`composer:end:${id}`);
          resolve();
        }));
      }),
    index,
  );
}

async function recordKeys(page: Page): Promise<string[]> {
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  const session = timelineSession(page);
  const records: TimelineRecord[] = [];
  let singleHeight = 0;
  session.on("Timeline.eventRecorded", ({ record }) => records.push(record));
  await session.send("Timeline.enable");
  await session.send("Timeline.start");
  try {
    for (const [caseIndex, scenario] of CASES.entries()) {
      await box.fill(scenario.draft);
      await box.evaluate((el, at) => {
        (el as unknown as { setSelectionRange(start: number, end: number): void }).setSelectionRange(at, at);
      }, scenario.cursor);
      await page.evaluate(() => new Promise<void>((resolve) => {
        const clock = globalThis as unknown as FrameClock;
        clock.requestAnimationFrame(() => clock.requestAnimationFrame(resolve));
      }));
      if (caseIndex === 0) {
        const size = await box.boundingBox();
        assert(size && size.height > 0, "Cannot measure the composer row");
        singleHeight = Math.ceil(size.height) + 1;
      }
      let text: string = scenario.draft;
      let cursor: number = scenario.cursor;
      for (const [index, key] of KEYS.entries()) {
        await pressAndTrace(page, caseIndex * KEYS.length + index, key);
        if (key === "Backspace") {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
        } else {
          text = text.slice(0, cursor) + key + text.slice(cursor);
          cursor++;
        }
        assert.equal(await box.inputValue(), text, `WebKit did not apply ${key}`);
      }
    }
  } finally {
    await session.send("Timeline.stop");
  }
  const layouts = CASES.map((_, i) => layoutsPerKey(records, i * KEYS.length));
  const lines = CASES.map(({ name }, i) => {
    const counts = layouts[i]!.map((perKey) => perKey.length);
    const ok = counts.every((count) => count <= 1);
    return `${ok ? "PASS" : "FAIL"} WebKit ${name}: ${counts.join(", ")} layouts per key (limit 1)`;
  });
  const heights = layouts[0]!.flat().map(layoutHeight);
  const local = heights.length > 0 && heights.every((height) => height <= singleHeight);
  lines.push(`${local ? "PASS" : "FAIL"} WebKit single line layout root heights: ${heights.join(", ")}px (row limit ${singleHeight}px)`);
  return lines;
}

async function openComposer(page: Page, loginUrl: string, conversationId: number, errors: string[]): Promise<void> {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && message.text() !== WEBKIT_VIEWPORT_WARNING) errors.push(message.text());
  });
  await page.goto(loginUrl);
  await page.goto(new URL(`/#/c/${conversationId}`, loginUrl).href);
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { document } = globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } };
    await document.fonts.ready;
  });
}

export async function verifyComposerLayout(loginUrl: string, conversationId: number, outDir: string, _steps?: VerifyStepContext): Promise<void> {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    await openComposer(page, loginUrl, conversationId, errors);
    const lines = await recordKeys(page);
    writeFileSync(join(outDir, "composer-layout.txt"), `${lines.join("\n")}\n`);
    for (const line of lines) console.log(line);
    await verifyComposerInteractions(page, "WebKit", outDir);
    await page.close();
    // Only Compact keeps body text under 16px, where the touch textarea's 16px font floor applies.
    for (const scale of ["sm"] as const) {
      const touchPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true, reducedMotion: "reduce" });
      await openComposer(touchPage, loginUrl, conversationId, errors);
      await verifyTouchSoftWrap(touchPage, scale, outDir);
      await touchPage.close();
    }
    assert.deepEqual(errors, []);
    assert(!lines.some((line) => line.startsWith("FAIL")), "WebKit composer exceeded its layout budget");
  } finally {
    await browser.close();
  }
}
