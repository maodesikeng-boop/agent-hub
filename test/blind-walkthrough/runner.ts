// Invariant: Track 1 runs completely unattended on an isolated Bellwood instance and persists a resumable checkpoint after every step.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { assertIsolatedWorkspace, sanitizeAccessibilitySnapshot, type RawA11yNode } from "./context-barrier.ts";
import { launchIsolatedBellwood, stopIsolatedBellwood, type IsolatedBellwoodHandle } from "./isolated-app.ts";
import {
  BLIND_ACTION_RETRY_BACKOFF_MS,
  BLIND_ACTION_RETRY_MAX,
  BLIND_MAX_TOTAL_STEPS_PER_RUN,
  BLIND_RUN_BUDGET_MS,
  BLIND_STEP_TIMEOUT_MS,
  BLIND_STUCK_REPEAT_THRESHOLD,
  BLIND_TRACE_SCHEMA_VERSION,
} from "./limits.ts";
import { buildMissionPrompt, selectMissions } from "./missions.ts";
import { createWalkthroughRecorder, transcodeVideoToMp4 } from "./recorder.ts";
import { extractPainPoints, renderPainPointReportMarkdown } from "./report.ts";
import type {
  BlindAction,
  BlindAgentTurnResponse,
  BlindMission,
  BlindMissionId,
  BlindObservation,
  BlindRunConfig,
  WalkthroughStep,
  WalkthroughTrace,
} from "./types.ts";

interface InPageDomNode {
  tagName: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  children: InPageDomNode[];
}

const SYSTEM_CHROMIUM_CANDIDATES: readonly string[] = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function resolveChromiumLaunchOptions(): { readonly headless: true; readonly executablePath?: string } {
  const envExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (envExecutable && existsSync(envExecutable)) {
    return { headless: true, executablePath: envExecutable };
  }
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return { headless: true };
  } catch {
    // Fall back to a preinstalled system browser when Playwright's managed browser cache is absent (such as unit-test CI shards).
  }
  for (const candidate of SYSTEM_CHROMIUM_CANDIDATES) {
    if (existsSync(candidate)) return { headless: true, executablePath: candidate };
  }
  return { headless: true };
}

function sha256File(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted during retry backoff"));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted during retry backoff"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function captureRawA11yTree(page: Page): Promise<RawA11yNode | null> {
  try {
    return await page.evaluate((): RawA11yNode | null => {
      type DomLike = {
        nodeType: number;
        tagName?: string;
        textContent?: string | null;
        innerText?: string;
        value?: string;
        disabled?: boolean;
        children?: ArrayLike<DomLike>;
        getAttribute?(name: string): string | null;
        getBoundingClientRect?(): { width: number; height: number };
      };
      const g = globalThis as unknown as {
        document?: { body?: DomLike; activeElement?: DomLike | null; title?: string };
        getComputedStyle?(el: DomLike): { display: string; visibility: string; opacity: string };
      };
      const root = g.document?.body;
      if (!root) return null;

      const inferRole = (el: DomLike): string => {
        const explicit = el.getAttribute?.("role")?.trim();
        if (explicit) return explicit;
        const tag = (el.tagName ?? "").toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const type = (el.getAttribute?.("type") ?? "text").toLowerCase();
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "submit" || type === "button") return "button";
          return "textbox";
        }
        if (tag === "select") return "combobox";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "aside") return "complementary";
        if (tag === "dialog") return "dialog";
        if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") return "heading";
        return "generic";
      };

      const isVisible = (el: DomLike): boolean => {
        if (el.getAttribute?.("aria-hidden") === "true") return false;
        const style = g.getComputedStyle?.(el);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
        const rect = el.getBoundingClientRect?.();
        if (rect && rect.width === 0 && rect.height === 0) return false;
        return true;
      };

      const ownLabel = (el: DomLike, role: string): string => {
        const ariaLabel = el.getAttribute?.("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        const placeholder = el.getAttribute?.("placeholder")?.trim();
        const title = el.getAttribute?.("title")?.trim();
        if (role === "textbox" || role === "combobox") {
          return placeholder || title || "";
        }
        if (role !== "generic") {
          const text = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text) return text.slice(0, 140);
          return title || placeholder || "";
        }
        return "";
      };

      let visited = 0;
      const visit = (el: DomLike): InPageDomNode | null => {
        if (visited > 1500 || !isVisible(el)) return null;
        visited += 1;
        const role = inferRole(el);
        const name = ownLabel(el, role);
        const value = typeof el.value === "string" && el.value.length > 0 ? el.value.slice(0, 120) : undefined;
        const disabled = el.disabled === true || el.getAttribute?.("aria-disabled") === "true";
        const expandedRaw = el.getAttribute?.("aria-expanded");
        const expanded = expandedRaw === "true" ? true : expandedRaw === "false" ? false : undefined;
        const focused = g.document?.activeElement === el;

        const children: InPageDomNode[] = [];
        const rawChildren = el.children ?? [];
        for (let i = 0; i < rawChildren.length; i++) {
          const child = visit(rawChildren[i]!);
          if (child) children.push(child);
        }
        if (role === "generic" && name === "" && !focused && children.length === 0) return null;
        return {
          tagName: el.tagName ?? "",
          role,
          name,
          ...(value !== undefined ? { value } : {}),
          ...(disabled ? { disabled: true } : {}),
          ...(expanded !== undefined ? { expanded } : {}),
          ...(focused ? { focused: true } : {}),
          children,
        };
      };

      const bodyNode = visit(root);
      return {
        role: "document",
        name: g.document?.title || "App",
        children: bodyNode ? [bodyNode] : [],
      };
    });
  } catch {
    return null;
  }
}

async function performAction(page: Page, action: BlindAction): Promise<void> {
  const actionTimeout = 4_000;
  switch (action.kind) {
    case "click_point":
      await page.mouse.click(action.x, action.y);
      break;
    case "click_label": {
      const candidates = [
        ...(action.role ? [page.getByRole(action.role as Parameters<Page["getByRole"]>[0], { name: action.label })] : []),
        page.getByRole("button", { name: action.label }),
        page.getByRole("tab", { name: action.label }),
        page.getByRole("link", { name: action.label }),
        page.getByLabel(action.label),
        page.getByPlaceholder(action.label),
        page.getByText(action.label, { exact: false }),
      ];
      let clicked = false;
      for (const locator of candidates) {
        try {
          const target = locator.first();
          if ((await target.count()) > 0 && (await target.isVisible())) {
            await target.click({ timeout: actionTimeout });
            clicked = true;
            break;
          }
        } catch {
          // Try the next visible accessible match before treating the click as a miss.
        }
      }
      if (!clicked) {
        // Dead or missing target leaves visualChanged=false so friction scoring captures it.
      }
      break;
    }
    case "type": {
      const hasFocusedEditable = await page
        .evaluate(() => {
          const g = globalThis as unknown as { document?: { activeElement?: { tagName?: string; isContentEditable?: boolean } | null } };
          const active = g.document?.activeElement;
          const tag = (active?.tagName ?? "").toLowerCase();
          return tag === "textarea" || tag === "input" || active?.isContentEditable === true;
        })
        .catch(() => false);
      if (!hasFocusedEditable) {
        const editable = page.locator("textarea, input:not([type='hidden']):not([type='checkbox']):not([type='radio'])").first();
        if ((await editable.count()) > 0 && (await editable.isVisible())) {
          await editable.click({ timeout: actionTimeout }).catch(() => {});
        }
      }
      await page.keyboard.type(action.text, { delay: 10 });
      if (action.submit) {
        await page.keyboard.press("Enter");
      }
      break;
    }
    case "press":
      await page.keyboard.press(action.key);
      break;
    case "scroll":
      await page.mouse.wheel(0, action.deltaY);
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
      break;
    case "wait":
      await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
      break;
    case "note_friction":
    case "finish":
      break;
  }
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});
}

function actionSignature(action: BlindAction): string {
  return JSON.stringify(action);
}

function describeActionForJournal(action: BlindAction): string {
  switch (action.kind) {
    case "click_label":
      return `clicked "${action.label}"`;
    case "click_point":
      return `clicked (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case "type":
      return `typed ${JSON.stringify(action.text.slice(0, 60))}${action.submit ? " and submitted" : ""}`;
    case "press":
      return `pressed ${action.key}`;
    case "scroll":
      return `scrolled ${action.deltaY}px`;
    case "reload":
      return "reloaded page";
    case "wait":
      return `waited (${action.reason})`;
    case "note_friction":
      return `noted friction: ${action.summary}`;
    case "finish":
      return `finished (${action.achieved ? "achieved" : "blocked"}: ${action.summary})`;
  }
}

async function decideWithRetries(
  config: BlindRunConfig,
  handle: IsolatedBellwoodHandle,
  observation: BlindObservation,
): Promise<{ readonly ok: true; readonly response: BlindAgentTurnResponse } | { readonly ok: false; readonly noiseReason: string }> {
  for (let attempt = 0; attempt <= BLIND_ACTION_RETRY_MAX; attempt++) {
    if (config.signal?.aborted) {
      return { ok: false, noiseReason: `run_aborted: ${String(config.signal.reason ?? "aborted")}` };
    }
    if (!handle.isRunning()) {
      return { ok: false, noiseReason: "isolated_daemon_exited" };
    }
    const stepController = new AbortController();
    const onParentAbort = () => stepController.abort(config.signal?.reason ?? new Error("run aborted"));
    config.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => stepController.abort(new Error("step timeout")), BLIND_STEP_TIMEOUT_MS);
    try {
      const response = await config.adapter.decideNext(observation, stepController.signal);
      return { ok: true, response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.signal?.aborted) {
        return { ok: false, noiseReason: `adapter_aborted: ${message}` };
      }
      if (!handle.isRunning()) {
        return { ok: false, noiseReason: `isolated_daemon_exited: ${message}` };
      }
      if (attempt >= BLIND_ACTION_RETRY_MAX) {
        return { ok: false, noiseReason: `adapter_error: ${message}` };
      }
      try {
        await sleepCancellable(BLIND_ACTION_RETRY_BACKOFF_MS, config.signal);
      } catch {
        return { ok: false, noiseReason: `adapter_aborted_during_backoff: ${message}` };
      }
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  return { ok: false, noiseReason: "adapter_retry_exhausted" };
}

async function safeScreenshot(page: Page, targetPath: string): Promise<boolean> {
  try {
    await page.screenshot({ path: targetPath });
    return true;
  } catch {
    return false;
  }
}

async function executeWalkthrough(
  config: BlindRunConfig,
  existingTrace: WalkthroughTrace | null,
): Promise<WalkthroughTrace> {
  assertIsolatedWorkspace(config.outDir, { platform: config.platform });
  assertIsolatedWorkspace(config.tempRoot, { platform: config.platform });
  if (config.missionIds.length === 0) throw new RangeError("missionIds must be non-empty");
  if (config.viewports.length === 0) throw new RangeError("viewports must be non-empty");

  const missions = selectMissions(config.missionIds);
  const recorder = createWalkthroughRecorder(config.outDir);
  const maxTotalSteps = Math.min(config.maxTotalSteps ?? BLIND_MAX_TOTAL_STEPS_PER_RUN, BLIND_MAX_TOTAL_STEPS_PER_RUN);
  const startedAt = existingTrace?.startedAt ?? new Date().toISOString();
  const completedMissions: BlindMissionId[] = [...(existingTrace?.completedMissions ?? [])];
  const steps: WalkthroughStep[] = [...(existingTrace?.steps ?? [])];
  let abortedReason: string | null = null;
  const runDeadline = Date.now() + BLIND_RUN_BUDGET_MS;

  const remainingMissions: readonly BlindMission[] = missions.filter((m) => !completedMissions.includes(m.id));
  const systemPromptSha256 = sha256Text(config.adapter.systemPrompt);

  const buildTraceSnapshot = (finishedAt: string | null, videoPath: string | null): WalkthroughTrace => ({
    schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
    runId: config.runId,
    track: "browser_blind",
    startedAt,
    finishedAt,
    blindVendor: config.adapter.id,
    appVendorMode: config.appVendorMode,
    missionIds: config.missionIds,
    completedMissions: [...completedMissions],
    steps: [...steps],
    videoPath,
    systemPromptSha256,
    abortedReason,
  });

  const handle = await launchIsolatedBellwood({
    tempRoot: config.tempRoot,
    appVendorMode: config.appVendorMode,
    folderPickerMode: "bridge_sample_project",
    platform: config.platform,
  });

  const rawVideoDir = join(config.outDir, "raw-video");
  mkdirSync(rawVideoDir, { recursive: true });
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let rawVideoPath: string | null = null;

  try {
    const firstViewport = config.viewports[0]!;
    browser = await chromium.launch(resolveChromiumLaunchOptions());
    context = await browser.newContext({
      viewport: { width: firstViewport.width, height: firstViewport.height },
      recordVideo: {
        dir: rawVideoDir,
        size: { width: firstViewport.width, height: firstViewport.height },
      },
    });
    page = await context.newPage();

    let stepConsoleErrors: string[] = [];
    let stepPageErrors: string[] = [];
    let stepFailedRequests: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") stepConsoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      stepPageErrors.push(err.message);
    });
    page.on("requestfailed", (req) => {
      stepFailedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? "failed"})`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        stepFailedRequests.push(`${res.request().method()} ${res.url()} (HTTP ${res.status()})`);
      }
    });

    await page.goto(handle.loginUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForURL(`${handle.origin}/`, { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    for (const mission of remainingMissions) {
      if (abortedReason !== null || steps.length >= maxTotalSteps) break;
      const missionPrompt = buildMissionPrompt(mission, handle.sampleProjectDir);
      let missionBlocked = false;

      for (const viewport of config.viewports) {
        if (abortedReason !== null || steps.length >= maxTotalSteps) break;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});

        const journal: string[] = [`Mission goal: ${missionPrompt.userGoal}`];
        let missionStepCount = 0;
        let lastSig = "";
        let stuckRepeats = 0;

        while (missionStepCount < mission.maxSteps && steps.length < maxTotalSteps) {
          if (Date.now() > runDeadline) {
            abortedReason = "run_budget_exceeded";
            break;
          }

          stepConsoleErrors = [];
          stepPageErrors = [];
          stepFailedRequests = [];

          const stepIndex = steps.length + 1;
          const stepStart = Date.now();
          const screenshotBefore = recorder.nextScreenshotPath(stepIndex, "before");
          const screenshotAfter = recorder.nextScreenshotPath(stepIndex, "after");
          await safeScreenshot(page, screenshotBefore);
          const beforeHash = sha256File(screenshotBefore);
          const rawA11y = await captureRawA11yTree(page);
          const sanitizedA11y = sanitizeAccessibilitySnapshot(rawA11y);

          const observation: BlindObservation = {
            stepIndex,
            missionId: mission.id,
            viewport,
            url: page.url(),
            screenshotPath: screenshotBefore,
            visualHash: beforeHash,
            a11yNodes: sanitizedA11y.nodes,
            a11yText: sanitizedA11y.text,
            recentJournal: [...journal.slice(-8)],
          };

          const decision = await decideWithRetries(config, handle, observation);
          if (!decision.ok) {
            await safeScreenshot(page, screenshotAfter);
            const afterHash = sha256File(screenshotAfter);
            const noiseStep: WalkthroughStep = {
              index: stepIndex,
              missionId: mission.id,
              viewport: viewport.kind,
              timestamp: new Date().toISOString(),
              thought: "Step interrupted by harness or environment outage.",
              confusion: decision.noiseReason,
              action: { kind: "wait", reason: "harness_interrupted" },
              screenshotBefore,
              screenshotAfter,
              telemetry: {
                consoleErrors: [...stepConsoleErrors],
                pageErrors: [...stepPageErrors],
                failedRequests: [...stepFailedRequests],
                visualChanged: beforeHash !== afterHash,
                daemonAlive: handle.isRunning(),
                durationMs: Date.now() - stepStart,
              },
              noiseReason: decision.noiseReason,
            };
            steps.push(noiseStep);
            abortedReason = decision.noiseReason;
            recorder.saveCheckpoint(buildTraceSnapshot(null, null));
            break;
          }

          const { thought, confusion, action } = decision.response;
          await performAction(page, action);
          await safeScreenshot(page, screenshotAfter);
          const afterHash = sha256File(screenshotAfter);
          const visualChanged = beforeHash !== afterHash;

          const sig = actionSignature(action);
          if (sig === lastSig && !visualChanged && action.kind !== "note_friction" && action.kind !== "finish") {
            stuckRepeats += 1;
          } else {
            lastSig = sig;
            stuckRepeats = 1;
          }

          const isStuck = stuckRepeats >= BLIND_STUCK_REPEAT_THRESHOLD;
          const recordedConfusion = isStuck
            ? `${confusion ? `${confusion} | ` : ""}Stuck loop detected: repeated ${describeActionForJournal(action)} ${stuckRepeats} times with zero visual change`
            : confusion;

          const stepRecord: WalkthroughStep = {
            index: stepIndex,
            missionId: mission.id,
            viewport: viewport.kind,
            timestamp: new Date().toISOString(),
            thought,
            confusion: recordedConfusion,
            action,
            screenshotBefore,
            screenshotAfter,
            telemetry: {
              consoleErrors: [...stepConsoleErrors],
              pageErrors: [...stepPageErrors],
              failedRequests: [...stepFailedRequests],
              visualChanged,
              daemonAlive: handle.isRunning(),
              durationMs: Date.now() - stepStart,
            },
            noiseReason: null,
          };
          steps.push(stepRecord);
          missionStepCount += 1;
          journal.push(`Step ${stepIndex}: ${describeActionForJournal(action)} (visualChanged=${String(visualChanged)})`);
          recorder.saveCheckpoint(buildTraceSnapshot(null, null));

          if (action.kind === "finish") {
            if (!action.achieved) missionBlocked = true;
            break;
          }
          if (isStuck) {
            missionBlocked = true;
            break;
          }
        }
      }

      if (abortedReason === null && !missionBlocked && !completedMissions.includes(mission.id)) {
        completedMissions.push(mission.id);
        recorder.saveCheckpoint(buildTraceSnapshot(null, null));
      }
    }

    const video = page.video();
    await page.close();
    page = null;
    if (video) {
      rawVideoPath = await video.path().catch(() => null);
    }
    await context.close();
    context = null;
    await browser.close();
    browser = null;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopIsolatedBellwood(handle, true);
  }

  let finalVideoPath: string | null = null;
  if (rawVideoPath && existsSync(rawVideoPath)) {
    const mp4Target = join(config.outDir, "walkthrough.mp4");
    const transcoded = await transcodeVideoToMp4(rawVideoPath, mp4Target);
    if (transcoded.ok && transcoded.mp4Path) {
      finalVideoPath = transcoded.mp4Path;
      rmSync(rawVideoDir, { recursive: true, force: true });
    }
  }

  const finalTrace = buildTraceSnapshot(new Date().toISOString(), finalVideoPath);
  recorder.saveCheckpoint(finalTrace);
  writeFileSync(join(config.outDir, "trace.json"), `${JSON.stringify(finalTrace, null, 2)}\n`, "utf8");
  const report = extractPainPoints(finalTrace);
  writeFileSync(join(config.outDir, "pain-points.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(config.outDir, "pain-points.md"), renderPainPointReportMarkdown(report), "utf8");
  return finalTrace;
}

/**
 * Precondition: config.tempRoot and config.outDir pass assertIsolatedWorkspace and config.missionIds is non-empty.
 * Postcondition: executes all requested missions across configured viewports, records step screenshots and video, stops the isolated daemon cleanly, and returns the completed WalkthroughTrace.
 */
export async function runBlindWalkthrough(config: BlindRunConfig): Promise<WalkthroughTrace> {
  return executeWalkthrough(config, null);
}

/**
 * Precondition: runDir contains a checkpoint file written by an interrupted runBlindWalkthrough invocation.
 * Postcondition: validates checkpoint integrity, resumes from the next unfinished step without duplicating completed steps, and returns the completed WalkthroughTrace.
 * Throws Error on corrupt or unsupported-version checkpoints.
 */
export async function resumeBlindWalkthrough(
  runDir: string,
  config: Omit<BlindRunConfig, "runId" | "outDir">,
): Promise<WalkthroughTrace> {
  assertIsolatedWorkspace(runDir, { platform: config.platform });
  const recorder = createWalkthroughRecorder(runDir);
  const checkpoint = recorder.loadCheckpoint();
  return executeWalkthrough(
    {
      ...config,
      runId: checkpoint.runId,
      outDir: runDir,
    },
    checkpoint,
  );
}
