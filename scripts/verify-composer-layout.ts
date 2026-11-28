import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { webkit, type Page } from "playwright";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { formatVerifyError, readVerifyError, withVerifyTimeout, type VerifyStepContext } from "./verify-diagnostics.ts";
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

type TimelineMethod = "Timeline.enable" | "Timeline.start" | "Timeline.stop" | "Timeline.disable";

function rewriteTimelineError(error: unknown, method: TimelineMethod, state?: string): unknown {
  const { errorType, message, protocolType, method: protocolMethod = method, logs, code, signal } = readVerifyError(error);
  if (message && !protocolType && !logs) return error;
  const parts = [
    `WebKit ${protocolMethod} failed`,
    protocolType ? `type=${protocolType}` : undefined,
    message,
    state ? `state=${state}` : undefined,
  ].filter(Boolean);
  return Object.assign(new Error(parts.join("; "), { cause: error }), {
    name: errorType, type: protocolType, method: protocolMethod, code, signal,
  });
}

async function sendTimelineCommand(
  session: WebKitTimelineSession,
  method: TimelineMethod,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  describeState?: () => string,
): Promise<unknown> {
  const state = (): string => {
    try {
      return describeState?.().trim() ?? "";
    } catch (error) {
      return `state unavailable (${formatVerifyError(error).summary})`;
    }
  };
  const command = async (): Promise<unknown> => {
    try {
      return await (params === undefined ? session.send(method) : session.send(method, params));
    } catch (error) {
      throw rewriteTimelineError(error, method, state());
    }
  };
  return withVerifyTimeout(`WebKit ${method}`, command(), timeoutMs, state);
}

export async function runWithWebKitTimeline<T>(
  session: WebKitTimelineSession,
  run: () => Promise<T>,
  options: WebKitTimelineOptions = {},
): Promise<WebKitTimelineResult<T>> {
  const timeoutMs = options.timeoutMs ?? VERIFY_SMOKE_STEP_TIMEOUT_MS;
  const { steps, describeState } = options;
  const inStep = <R>(name: string, fn: () => Promise<R>): Promise<R> => (steps ? steps.step(name, fn) : fn());
  const records: TimelineRecord[] = [];
  const onEvent = ({ record }: { record: TimelineRecord }): void => {
    records.push(record);
  };

  let enabled = false;
  let started = false;
  let result!: T;
  let hasPrimaryError = false;
  let teardownError: unknown;
  let hasTeardownError = false;

  session.on("Timeline.eventRecorded", onEvent);
  try {
    await inStep("Timeline.enable", () => sendTimelineCommand(session, "Timeline.enable", undefined, timeoutMs, describeState));
    enabled = true;
    await inStep("Timeline.start", () =>
      sendTimelineCommand(session, "Timeline.start", { maxCallStackDepth: 1 }, timeoutMs, describeState),
    );
    started = true;
    result = await run();
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    try {
      if (typeof session.off === "function") session.off("Timeline.eventRecorded", onEvent);
      else if (typeof session.removeListener === "function") session.removeListener("Timeline.eventRecorded", onEvent);
    } catch (detachError) {
      const detail = formatVerifyError(detachError).summary;
      steps?.note(`WebKit Timeline listener detach failed: ${detail}`);
    }

    if (session.isDisposed?.() === true) {
      if (started || enabled) {
        steps?.note("WebKit Timeline session already disposed; skipped Timeline.stop and Timeline.disable");
      }
    } else {
      if (started) {
        try {
          await sendTimelineCommand(session, "Timeline.stop", undefined, timeoutMs, describeState);
        } catch (stopError) {
          const detail = formatVerifyError(stopError).summary;
          steps?.note(`WebKit Timeline.stop failed during teardown: ${detail}`);
          if (!hasPrimaryError && !hasTeardownError) {
            hasTeardownError = true;
            teardownError = stopError;
          }
        }
      }
      if (enabled && session.isDisposed?.() !== true) {
        try {
          await sendTimelineCommand(session, "Timeline.disable", undefined, timeoutMs, describeState);
        } catch (disableError) {
          const detail = formatVerifyError(disableError).summary;
          steps?.note(`WebKit Timeline.disable failed during teardown: ${detail}`);
          if (!hasPrimaryError && !hasTeardownError) {
            hasTeardownError = true;
            teardownError = disableError;
          }
        }
      }
    }
  }

  if (hasTeardownError) throw teardownError;
  return { result, records };
}

export async function openComposerPage(
  page: Page,
  loginUrl: string,
  conversationId: number,
  errors: string[],
  options: OpenComposerOptions = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? VERIFY_SMOKE_STEP_TIMEOUT_MS;
  const { steps } = options;
  const inStep = <R>(name: string, fn: () => Promise<R>): Promise<R> => (steps ? steps.step(name, fn) : fn());

  page.on("pageerror", (error) => {
    const message = error instanceof Error ? error.message || error.name : String(error);
    errors.push(message);
    steps?.note(`WebKit pageerror: ${message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && message.text() !== WEBKIT_VIEWPORT_WARNING) errors.push(message.text());
  });
  page.on("crash", () => {
    steps?.note(`WebKit page crashed (conversation ${conversationId})`);
  });
  page.on("close", () => {
    steps?.note(`WebKit page closed (conversation ${conversationId})`);
  });

  await inStep("auth goto", () => page.goto(loginUrl, { timeout }));
  await inStep("wait auth redirect", () =>
    page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout }),
  );
  await inStep("conversation goto", () => page.goto(new URL(`/#/c/${conversationId}`, loginUrl).href, { timeout }));
  await inStep("wait chat composer", () =>
    page.locator(COMPOSER_CHAT_TEXTAREA_SELECTOR).waitFor({ state: "visible", timeout }),
  );
  await inStep("wait networkidle", () => page.waitForLoadState("networkidle", { timeout }));
  await inStep("wait fonts and settle", () =>
    withVerifyTimeout("Waiting for fonts and two animation frames", page.evaluate(async () => {
      const browser = globalThis as unknown as {
        document: { fonts: { ready: Promise<unknown> } };
        requestAnimationFrame(callback: () => void): void;
      };
      await browser.document.fonts.ready;
      await new Promise<void>((resolve) =>
        browser.requestAnimationFrame(() => browser.requestAnimationFrame(resolve)),
      );
    }), timeout),
  );
}

function timelineSession(page: Page): WebKitTimelineSession {
  // Playwright exposes CDP sessions for Chromium only; WebKit's inspector sits behind its local delegate.
  const { _connection } = page as unknown as {
    _connection?: { toImpl?: (page: Page) => { delegate?: { _session?: WebKitTimelineSession } } };
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
  await withVerifyTimeout("Marking the start of the key trace", page.evaluate((id) => {
    (globalThis as unknown as FrameClock).console.timeStamp(`composer:start:${id}`);
  }, index));
  await withVerifyTimeout(`Pressing ${key}`, page.keyboard.press(key));
  await withVerifyTimeout("Waiting for two animation frames after the keypress", page.evaluate(
    (id) =>
      new Promise<void>((resolve) => {
        const clock = globalThis as unknown as FrameClock;
        clock.requestAnimationFrame(() => clock.requestAnimationFrame(() => {
          clock.console.timeStamp(`composer:end:${id}`);
          resolve();
        }));
      }),
    index,
  ));
}

async function recordKeys(page: Page, steps?: VerifyStepContext, describeState?: () => string): Promise<string[]> {
  const box = page.locator(COMPOSER_CHAT_TEXTAREA_SELECTOR);
  const session = timelineSession(page);
  const inStep = <R>(name: string, fn: () => Promise<R>): Promise<R> => (steps ? steps.step(name, fn) : fn());
  let singleHeight = 0;

  const { records } = await runWithWebKitTimeline(
    session,
    async () => {
      for (const [caseIndex, scenario] of CASES.entries()) {
        await inStep(scenario.name, async () => {
          await box.fill(scenario.draft, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
          await inStep("settle draft", async () => {
            await withVerifyTimeout("Positioning the draft caret", box.evaluate((el, at) => {
              (el as unknown as { setSelectionRange(start: number, end: number): void }).setSelectionRange(at, at);
            }, scenario.cursor));
            await withVerifyTimeout("Waiting for two animation frames after setting the draft", page.evaluate(() => {
              const clock = globalThis as unknown as FrameClock;
              return new Promise<void>((resolve) => clock.requestAnimationFrame(() => clock.requestAnimationFrame(resolve)));
            }));
          });
          if (caseIndex === 0) {
            const size = await box.boundingBox({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
            assert(size && size.height > 0, "Cannot measure the composer row");
            singleHeight = Math.ceil(size.height) + 1;
          }
          let text: string = scenario.draft;
          let cursor: number = scenario.cursor;
          for (const [index, key] of KEYS.entries()) {
            await inStep(`press ${key} (${index + 1})`, () => pressAndTrace(page, caseIndex * KEYS.length + index, key));
            if (key === "Backspace") {
              text = text.slice(0, cursor - 1) + text.slice(cursor);
              cursor--;
            } else {
              text = text.slice(0, cursor) + key + text.slice(cursor);
              cursor++;
            }
            assert.equal(await box.inputValue({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS }), text, `WebKit did not apply ${key}`);
          }
        });
      }
    },
    { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS, steps, describeState },
  );

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

export async function verifyComposerLayout(
  loginUrl: string,
  conversationId: number,
  outDir: string,
  steps?: VerifyStepContext,
): Promise<void> {
  const inStep = <T>(name: string, fn: () => Promise<T>): Promise<T> => (steps ? steps.step(name, fn) : fn());
  let browserDisconnected = false;
  const browser = await inStep("launch WebKit", () => webkit.launch({ headless: true }));
  browser.on("disconnected", () => {
    browserDisconnected = true;
    steps?.note("WebKit browser disconnected");
  });

  let primaryFailed = false;
  let closeFailed: unknown;
  let hasCloseFailed = false;
  try {
    const page = await inStep("new WebKit page", () =>
      browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" }),
    );
    page.setDefaultTimeout(VERIFY_SMOKE_STEP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(VERIFY_SMOKE_STEP_TIMEOUT_MS);
    let pageCrashed = false;
    let pageClosed = false;
    page.on("crash", () => {
      pageCrashed = true;
    });
    page.on("close", () => {
      pageClosed = true;
    });
    const errors: string[] = [];
    const describeState = (): string =>
      `browserDisconnected=${browserDisconnected}, pageCrashed=${pageCrashed}, pageClosed=${pageClosed}, errors=${errors.length}`;

    await inStep("openComposerPage", () =>
      openComposerPage(page, loginUrl, conversationId, errors, { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS, steps }),
    );
    const lines = await inStep("recordKeys", () => recordKeys(page, steps, describeState));
    writeFileSync(join(outDir, "composer-layout.txt"), `${lines.join("\n")}\n`);
    for (const line of lines) console.log(line);
    await inStep("verifyComposerInteractions", () => verifyComposerInteractions(page, "WebKit", outDir, steps));
    await page.close();

    // Only Compact keeps body text under 16px, where the touch textarea's 16px font floor applies.
    for (const scale of ["sm"] as const) {
      const touchPage = await inStep(`new WebKit touch page (${scale})`, () =>
        browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true, reducedMotion: "reduce" }),
      );
      touchPage.setDefaultTimeout(VERIFY_SMOKE_STEP_TIMEOUT_MS);
      touchPage.setDefaultNavigationTimeout(VERIFY_SMOKE_STEP_TIMEOUT_MS);
      await inStep(`openComposerPage touch (${scale})`, () =>
        openComposerPage(touchPage, loginUrl, conversationId, errors, {
          timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS,
          steps,
        }),
      );
      await inStep(`verifyTouchSoftWrap (${scale})`, () => verifyTouchSoftWrap(touchPage, scale, outDir, steps));
      await touchPage.close();
    }

    assert.deepEqual(errors, []);
    assert(!lines.some((line) => line.startsWith("FAIL")), "WebKit composer exceeded its layout budget");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      const detail = formatVerifyError(closeError).summary;
      steps?.note(`WebKit browser.close failed during teardown: ${detail}`);
      if (!primaryFailed) {
        hasCloseFailed = true;
        closeFailed = closeError;
      }
    }
  }
  if (hasCloseFailed) throw closeFailed;
}
