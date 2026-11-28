import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { readLedgerFile } from "../src/daemon/process-ledger.ts";
import { API_PATHS, DEFAULT_AGENT_VENDOR, ENV_HOME, ENV_PORT, ENV_SESSION_OWNER_TAG, VENDOR_LIST, type StateSnapshot } from "../src/shared/index.ts";
import { VERIFY_SMOKE_BUDGET_MS, VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { resolveHubPaths } from "../src/shared/paths.ts";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV } from "../src/vendors/agy/paths.ts";
import { wrapScriptAsPlatformCli } from "../test/fake-cli-shim.ts";
import { verifyCardCorners } from "./verify-card-corners.ts";
import { verifyComposerInteractions } from "./verify-composer-interactions.ts";
import { COMPOSER_CHAT_TEXTAREA_SELECTOR, verifyComposerLayout } from "./verify-composer-layout.ts";
import {
  createVerifyStepTracker,
  formatVerifyError,
  formatVerifyRunReport,
  type VerifyFailure,
  type VerifyPhaseRecord,
  type VerifyStepContext,
  type VerifyStepTracker,
} from "./verify-diagnostics.ts";
import { verifyProjectListHeader } from "./verify-list-header.ts";
import { verifySettingsKeyboard } from "./verify-settings-keyboard.ts";
import { verifyShellWidths } from "./verify-shell-widths.ts";
import { digestOf, lostAfterRestart, sendAndAwaitReply, type RoundTrip } from "./verify-steps.ts";
import { verifyTabFocus } from "./verify-tab-focus.ts";
import { verifyTopBarUnderSettings } from "./verify-window-drag.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../test/fake-claude/fake-claude.ts", import.meta.url));
const VITE_BIN = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
const DAEMON_MAIN = join(REPO_ROOT, "src", "daemon", "main.ts");
const LOGIN_URL = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;
const SCREENSHOT = "workbench-smoke.png";
const RUNS_LOG = "smoke-runs.txt";
const ROUND_TRIP_TEXT = "verify round trip";

interface RunResult {
  ok: boolean;
  totalMs: number;
  phases: VerifyPhaseRecord[];
  failure?: VerifyFailure;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

// macOS limits Unix socket paths to 104 bytes.
function shortTmp(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync("/tmp") ? base : "/tmp";
}

function withTimeout<T>(what: string, promise: Promise<T>, ms = VERIFY_SMOKE_STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}：${ms / 1000} 秒没完成`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function daemonEnv(home: string, scratch: string): Record<string, string> {
  const userHome = join(scratch, "user-home");
  mkdirSync(userHome, { recursive: true });
  const passthrough = ["PATH", "Path", "SystemRoot", "PATHEXT", "ComSpec", "TMPDIR", "TEMP", "TMP", ENV_SESSION_OWNER_TAG].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!] as const]));
  return {
    ...Object.fromEntries(passthrough),
    LANG: "en_US.UTF-8",
    HOME: userHome,
    USERPROFILE: userHome,
    ...(process.platform === "darwin" ? { [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" } : {}),
    [ENV_HOME]: home,
    [ENV_PORT]: "0",
    ...Object.fromEntries(
      VENDOR_LIST.map(({ id, cli }) => [cli.envVar, id === DEFAULT_AGENT_VENDOR ? wrapScriptAsPlatformCli(FAKE_CLAUDE, scratch, "fake-claude") : join(scratch, `no-${id}`)]),
    ),
    FAKE_CLAUDE_LOG: join(scratch, "fake-claude.log"),
    FAKE_CLAUDE_STATE: scratch,
  };
}

function requestShutdown(child: ChildProcess, home: string, uiToken: string): void {
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  const adminPipe = resolveHubPaths({ [ENV_HOME]: home }, home, { platform: "win32" }).adminSock;
  const req = request({ socketPath: adminPipe, method: "POST", path: "/admin/shutdown", headers: { authorization: `Bearer ${uiToken}`, "content-type": "application/json", "content-length": 2 } }, (res) => res.resume());
  req.on("error", () => child.kill());
  req.end("{}");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LaunchedDaemon {
  child: ChildProcess;
  exited: Promise<Exit>;
  origin: string;
  uiToken: string;
  loginUrl: string;
  stderr: () => string;
}

async function launchDaemon(home: string, scratch: string): Promise<LaunchedDaemon> {
  const child = spawn(process.execPath, [DAEMON_MAIN], { cwd: REPO_ROOT, env: daemonEnv(home, scratch), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<Exit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let out = "";
  let err = "";
  child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c));
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c));
  const login = await withTimeout(
    "等守护进程给出登录网址",
    new Promise<RegExpExecArray>((resolve, reject) => {
      child.stdout!.on("data", () => {
        const m = LOGIN_URL.exec(out);
        if (m) resolve(m);
      });
      void exited.then(({ code }) => reject(new Error(`守护进程提前退出（退出码 ${code}）：${err}`)));
    }),
  ).catch(async (error: unknown) => {
    child.kill("SIGKILL");
    await exited;
    throw error;
  });
  const origin = `http://127.0.0.1:${login[1]}`;
  const uiToken = login[2]!;
  return { child, exited, origin, uiToken, loginUrl: `${origin}${API_PATHS.auth}?token=${uiToken}`, stderr: () => err };
}

async function loginCookie(daemon: LaunchedDaemon): Promise<string> {
  const auth = await fetch(daemon.loginUrl, { redirect: "manual" });
  const cookie = (auth.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  if (auth.status !== 302 || cookie === "") throw new Error(`免密登录没跳转或没给 cookie：HTTP ${auth.status}`);
  return cookie;
}

async function fetchState(daemon: LaunchedDaemon, cookie: string): Promise<StateSnapshot> {
  const state = await fetch(`${daemon.origin}${API_PATHS.state}`, { headers: { cookie, origin: daemon.origin } });
  const body = (await state.json()) as StateSnapshot;
  if (state.status !== 200 || !Array.isArray(body.conversations)) throw new Error(`/api/state 不对：HTTP ${state.status}`);
  return body;
}

/** Stops the daemon the way the desktop shell does and checks that no child it recorded outlives it. */
async function stopDaemon(daemon: LaunchedDaemon, home: string): Promise<void> {
  requestShutdown(daemon.child, home, daemon.uiToken);
  const exit = await withTimeout("等守护进程正常关机", daemon.exited);
  if (exit.code !== 0) throw new Error(`守护进程关机退出码 ${exit.code}（信号 ${exit.signal}）：${daemon.stderr()}`);
  const leftovers = readLedgerFile(resolveHubPaths({ [ENV_HOME]: home }, home).childProcessesFile).filter((e) => isAlive(e.pid));
  if (leftovers.length > 0) throw new Error(`关机后还有子进程没退出：${leftovers.map((e) => `${e.pid}（${e.purpose}）`).join("、")}`);
}

async function verifySavedProjectListWidth(page: Page): Promise<void> {
  const openLocalList = async () => {
    await page.locator('nav[aria-label="Workspace"] button:has([data-testid^="rail-device-dot-"])').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  };
  await openLocalList();
  const handle = page.getByRole("separator", { name: "Resize project list" });
  await handle.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  const remPx = await page.evaluate(() => {
    const g = globalThis as unknown as { document: { documentElement: unknown }; getComputedStyle(el: unknown): { fontSize: string } };
    return Number.parseFloat(g.getComputedStyle(g.document.documentElement).fontSize) || 17.5;
  });
  const listBoxWidth = async () => (await page.locator("#list").boundingBox())?.width ?? null;
  const waitForListWidth = async (wantPx: number, label: string) => {
    await withTimeout(
      label,
      (async () => {
        const deadline = Date.now() + VERIFY_SMOKE_STEP_TIMEOUT_MS;
        for (;;) {
          const width = await listBoxWidth();
          if (width !== null && Math.abs(width - wantPx) <= 2) return;
          if (Date.now() > deadline) throw new Error(`list width ${width}px did not reach ${wantPx}px`);
          await page.waitForTimeout(50);
        }
      })(),
    );
  };
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 600, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await waitForListWidth(25 * remPx, "等左栏拖到 25rem 上限");

  await handle.dblclick();
  await waitForListWidth(16.5 * remPx, "等双击把手恢复 16.5rem 默认宽");

  const box2 = (await handle.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2 + 100, box2.y + box2.height / 2, { steps: 8 });
  await page.mouse.up();
  const draggedPx = (await listBoxWidth()) ?? 0;
  if (draggedPx <= 16.5 * remPx + 20) throw new Error(`拖动后左栏未变宽：${draggedPx}px`);

  await page.reload();
  await openLocalList();
  await handle.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
  await waitForListWidth(draggedPx, "等刷新后保持记住的左栏宽度");
}

async function runChromiumChecks(
  browser: Browser,
  daemon: LaunchedDaemon,
  cookie: string,
  outDir: string,
  state: StateSnapshot,
  tracker: VerifyStepTracker,
  checkComposer: boolean,
  conversationId: number | undefined,
): Promise<RoundTrip> {
  const pageErrors: string[] = [];
  const page = await tracker.runPhase("浏览器渲染工作台", async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    p.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
    p.on("crash", () => tracker.note("Chromium page crashed"));
    p.on("close", () => tracker.note("Chromium page closed"));
    await p.goto(daemon.loginUrl, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await p.waitForURL(`${daemon.origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await p.locator("#root textarea").first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await p.waitForLoadState("networkidle", { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await verifySavedProjectListWidth(p);
    const rootText = (await p.locator("#root").innerText()).trim();
    if (rootText === "") throw new Error("工作台渲染出来是空的");
    if (pageErrors.length > 0) throw new Error(`页面报错 ${pageErrors.length} 条：\n${pageErrors.join("\n")}`);
    return p;
  });

  await tracker.runPhase("设置页打开时顶栏照样拖窗", async () => {
    await verifyTopBarUnderSettings(page);
    if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
  });

  await tracker.runPhase("左栏长电脑名与新建按钮不重合", async () => {
    await verifyProjectListHeader(browser, daemon.loginUrl, daemon.origin);
  });

  await tracker.runPhase("Columns and single column at every scale", async () => {
    await verifyShellWidths(browser, daemon.loginUrl, daemon.origin);
  });

  await tracker.runPhase("Settings and New PM keyboard focus at Compact and XL", async () => {
    await verifySettingsKeyboard(browser, daemon.loginUrl, daemon.origin, state.server.folderPicker);
  });

  if (checkComposer) {
    if (conversationId === undefined) throw new Error("Composer layout check requires a conversation");
    await tracker.runPhase("Chromium composer interactions", async (steps) => {
      await steps.step("conversation goto", () =>
        page.goto(new URL(`/#/c/${conversationId}`, daemon.loginUrl).href, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS }),
      );
      await steps.step("wait chat composer", () =>
        page.locator(COMPOSER_CHAT_TEXTAREA_SELECTOR).waitFor({ state: "visible", timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS }),
      );
      await verifyComposerInteractions(page, "Chromium", outDir, steps);
      if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
    });
  }

  const trip = await tracker.runPhase("发消息等假 claude 回复、截图", async () => {
    const result = await sendAndAwaitReply(page, { origin: daemon.origin, cookie, text: ROUND_TRIP_TEXT, timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.screenshot({ path: join(outDir, SCREENSHOT) });
    if (pageErrors.length > 0) throw new Error(`发消息时页面报错 ${pageErrors.length} 条：\n${pageErrors.join("\n")}`);
    return result;
  });

  await tracker.runPhase("Work panel tabs: no focus mark on press, outline by keyboard", async () => {
    await verifyTabFocus(page);
    await verifyCardCorners(page);
    if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
  });

  return trip;
}

export interface SmokeBrowserHandle {
  close(): Promise<void>;
}

export interface SmokeBrowserDeps<TBrowser extends SmokeBrowserHandle = SmokeBrowserHandle> {
  verifyWebKitComposer(conversationId: number, steps: VerifyStepContext): Promise<void>;
  launchChromium(): Promise<TBrowser>;
  runChromiumChecks(browser: TBrowser, tracker: VerifyStepTracker, checkComposer: boolean, conversationId: number | undefined): Promise<RoundTrip>;
}

export interface SmokeBrowserOptions {
  checkComposer: boolean;
  conversationId: number | undefined;
  tracker: VerifyStepTracker;
}

export async function runBrowserVerifications<TBrowser extends SmokeBrowserHandle>(
  deps: SmokeBrowserDeps<TBrowser>,
  options: SmokeBrowserOptions,
): Promise<RoundTrip> {
  if (options.checkComposer) {
    const id = options.conversationId;
    if (id === undefined) throw new Error("Composer layout check requires a conversation");
    await options.tracker.runPhase("WebKit composer layout", (steps) => deps.verifyWebKitComposer(id, steps));
  }

  const browser = await deps.launchChromium();
  let trip!: RoundTrip;
  let primaryFailed = false;
  let closeFailed: unknown;
  let hasCloseFailed = false;
  try {
    trip = await deps.runChromiumChecks(browser, options.tracker, options.checkComposer, options.conversationId);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      const detail = closeError instanceof Error ? closeError.message || closeError.name : String(closeError);
      options.tracker.note(`Chromium browser.close failed during teardown: ${detail}`);
      if (!primaryFailed) {
        hasCloseFailed = true;
        closeFailed = closeError;
      }
    }
  }
  if (hasCloseFailed) throw closeFailed;
  return trip;
}

async function runOnce(outDir: string, checkComposer: boolean): Promise<RunResult> {
  const started = performance.now();
  const tracker = createVerifyStepTracker();
  const root = mkdtempSync(join(shortTmp(), "bellwood-verify-"));
  const home = join(root, "home");
  const scratch = join(root, "scratch");
  let daemon: LaunchedDaemon | null = null;
  let lastDaemon: LaunchedDaemon | null = null;

  try {
    await tracker.runPhase("构建网页", async () => {
      const build = spawnSync(process.execPath, [VITE_BIN, "build", "--logLevel", "error"], { cwd: REPO_ROOT, encoding: "utf8" });
      if (build.status !== 0) throw new Error(`构建网页失败（退出码 ${build.status}）：${build.stderr}`);
    });

    daemon = await tracker.runPhase("起守护进程", () => launchDaemon(home, scratch));
    lastDaemon = daemon;
    const activeDaemon = daemon;

    const { cookie, state } = await tracker.runPhase("登录、健康检查、/api/state", async () => {
      const sessionCookie = await loginCookie(activeDaemon);
      const headers = { cookie: sessionCookie, origin: activeDaemon.origin };
      const health = await fetch(`${activeDaemon.origin}${API_PATHS.health}`, { headers });
      const healthBody = (await health.json()) as { ok?: boolean };
      if (health.status !== 200 || healthBody.ok !== true) throw new Error(`健康检查不对：HTTP ${health.status} ${JSON.stringify(healthBody)}`);
      const snapshot = await fetchState(activeDaemon, sessionCookie);
      return { cookie: sessionCookie, state: snapshot };
    });

    const conversationId = state.conversations[0]?.conversation.id;
    const trip = await runBrowserVerifications(
      {
        verifyWebKitComposer: (id, steps) => verifyComposerLayout(activeDaemon.loginUrl, id, outDir, steps),
        launchChromium: () => chromium.launch({ headless: true }),
        runChromiumChecks: (browser, stepTracker, composerFlag, id) =>
          runChromiumChecks(browser, activeDaemon, cookie, outDir, state, stepTracker, composerFlag, id),
      },
      { checkComposer, conversationId, tracker },
    );

    const before = await tracker.runPhase("正常关机", async () => {
      const digest = digestOf(await fetchState(activeDaemon, cookie), [trip.conversationId]);
      await stopDaemon(activeDaemon, home);
      daemon = null;
      return digest;
    });

    daemon = await tracker.runPhase("同一数据目录重启", () => launchDaemon(home, scratch));
    lastDaemon = daemon;
    const restartedDaemon = daemon;

    await tracker.runPhase("核对消息、再关机", async () => {
      const after = digestOf(await fetchState(restartedDaemon, await loginCookie(restartedDaemon)), [trip.conversationId]);
      const lost = lostAfterRestart(before, after);
      if (lost.length > 0) throw new Error(`同一数据目录重启后数据变了：\n${lost.join("\n")}`);
      if (!after.messages.some((m) => m.id === trip.replyMessageId)) throw new Error(`重启后找不到回复 ${trip.replyMessageId}`);
      await stopDaemon(restartedDaemon, home);
      daemon = null;
    });

    await tracker.runPhase("删临时目录", async () => {
      rmSync(root, { recursive: true });
      if (existsSync(root)) throw new Error(`临时目录没删掉：${root}`);
    });

    return { ok: true, totalMs: performance.now() - started, phases: tracker.snapshot().phases };
  } catch (error) {
    const snap = tracker.snapshot();
    const failure = formatVerifyError(error, {
      phasePath: snap.activePath,
      phaseDurationMs: snap.activeDurationMs,
      notes: snap.notes,
      daemonStderr: (daemon ?? lastDaemon)?.stderr(),
    });
    return { ok: false, totalMs: performance.now() - started, phases: snap.phases, failure };
  } finally {
    if (daemon !== null) {
      daemon.child.kill("SIGKILL");
      await daemon.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { runs: { type: "string", default: "1" }, out: { type: "string", default: join(shortTmp(), "bellwood-verify-smoke") }, "composer-layout": { type: "boolean" } } });
  const runs = Number.parseInt(values.runs, 10);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs 要是正整数：${values.runs}`);
  const outDir = values.out;
  mkdirSync(outDir, { recursive: true });

  const lines: string[] = [`verify 冒烟 ${new Date().toISOString()}，${process.platform}/${process.arch}，Node ${process.version}`];
  const results: RunResult[] = [];
  for (let i = 1; i <= runs; i++) {
    const r = await runOnce(outDir, values["composer-layout"] ?? false);
    results.push(r);
    const line = formatVerifyRunReport(i, {
      ok: r.ok,
      totalMs: r.totalMs,
      budgetMs: VERIFY_SMOKE_BUDGET_MS,
      phases: r.phases,
      failure: r.failure,
    });
    lines.push(line);
    console.log(line);
  }
  const sorted = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const failed = results.filter((r) => !r.ok).length;
  const summary = `共 ${runs} 次，${failed === 0 ? "全部通过" : `${failed} 次失败`}；中位数 ${seconds(median)}，区间 ${seconds(sorted[0]!)} ~ ${seconds(sorted.at(-1)!)}；截图 ${join(outDir, SCREENSHOT)}`;
  lines.push(summary);
  console.log(summary);
  writeFileSync(join(outDir, RUNS_LOG), `${lines.join("\n")}\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
