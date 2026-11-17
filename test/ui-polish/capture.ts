// 截图（docs/ui-polish-loop-design.md 第 3.2 节）：一条命令截全部界面。
// 不变量：同一个提交、同一份清单截两次，每张图的字节完全一样（视口、字号、时区、时钟、种子、动效都钉死，截图期间不改数据）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Cookie, type Page, type Request } from "playwright";
import {
  BROWSER_NOW_ISO,
  DEVICE_SCALE_FACTOR,
  SHOT_LOCALE,
  SHOT_NETWORK_QUIET_MS,
  SHOT_PARALLEL,
  SHOT_READY_TIMEOUT_MS,
  SHOT_SEEN_CONVERSATIONS,
  SHOT_STABLE_POLL_MS,
  SHOT_TIMEZONE,
  SHOT_WORK_DIR,
  VIEWPORTS,
  type ViewportName,
} from "./limits.ts";
import { runMachineChecks, type MachineFinding } from "./checks.ts";
import { inPage } from "./in-page-api.ts";
import { assertIsolated } from "./isolation.ts";
import { applyMutation } from "./mutations.ts";
import { applyPatch, blockWrites, heldRequests } from "./patches.ts";
import { SCREEN_INVENTORY, SCREEN_STEPS, expandShots, type Scenario, type ScreenStep, type Shot } from "./screens.ts";
import { peerHomeOf, seedScenario, startIsolatedDaemon, type IsolatedDaemon, type SeedResult } from "./seed.ts";

export interface CaptureOptions {
  repoRoot: string;
  /** 图和清单写到哪。 */
  outDir: string;
  /** 只截这些界面 id 或区域；不给就是全部。 */
  only?: readonly string[];
  /** 校准用：在这些界面（界面 id，或 `<界面>@<视口>` 只弄坏那一个视口）上各注入哪些弄坏（mutations.ts），每个弄坏另出一张图，key 是 `<界面>@<视口>!<弄坏 id>`。 */
  mutate?: Readonly<Record<string, readonly string[]>>;
  /** 种子数据和隔离守护进程的数据目录放哪，默认 SHOT_WORK_DIR。每次开头清空。 */
  workDir?: string;
}

export interface CapturedShot {
  /** `<界面 id>@<视口>`，弄坏的图后面带 `!<弄坏 id>`。 */
  key: string;
  screenId: string;
  viewport: ViewportName;
  /** 相对 outDir。 */
  file: string;
  sha256: string;
  /** 有 focus 的界面另有一张局部的 2 倍图。 */
  focusFile?: string;
  focusSha256?: string;
  machineFindings: MachineFinding[];
}

/** 一次截图的清单，写成 outDir/manifest.json。 */
export interface CaptureManifest {
  /** 截的是哪个提交；工作区有没提交的改动时后面带 `+dirty`。 */
  commit: string;
  /** 浏览器版本，换了浏览器字节会变，对比前先看它。 */
  browser: string;
  shots: CapturedShot[];
}

interface Backend {
  daemon: IsolatedDaemon;
  seed: SeedResult;
  /** 登录一次拿到的 cookie：每张图的浏览器上下文都带它，不再各走一次登录链接（不然守护进程里“已登录的浏览器”条数随截图先后变）。 */
  cookies: Cookie[];
  stop(): Promise<void>;
}

/**
 * 前置：已经 `pnpm build`（dist/web 是当前工作区的）。
 * 后置：outDir 里是每张图的 PNG 和 manifest.json；任何一个界面到不了或超时，整个调用失败并说出是哪个界面，不留半截清单。
 * 自己起、自己关隔离的守护进程和浏览器，不碰用户正在跑的守护进程和数据目录。
 */
export async function captureAll(options: CaptureOptions): Promise<CaptureManifest> {
  const workDir = options.workDir ?? SHOT_WORK_DIR;
  assertIsolated(options.outDir);
  assertIsolated(workDir);
  const shots = expandShots(SCREEN_INVENTORY, options.only);
  const mutate = options.mutate ?? {};
  const jobs: Array<{ shot: Shot; mutation?: string }> = shots.flatMap((shot) => [
    { shot },
    ...(mutate[shot.key] ?? mutate[shot.screen.id] ?? []).map((mutation) => ({ shot, mutation })),
  ]);
  mkdirSync(options.outDir, { recursive: true });
  rmSync(join(options.outDir, "manifest.json"), { force: true });
  rmSync(join(options.outDir, "failed"), { recursive: true, force: true });
  for (const entry of readdirSync(options.outDir)) {
    if (entry.endsWith(".png")) rmSync(join(options.outDir, entry), { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const backends = new Map<Scenario, Backend>();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    for (const scenario of new Set(shots.map((s) => s.screen.scenario))) {
      const backend = await startBackend(scenario, options.repoRoot, workDir);
      backends.set(scenario, backend);
      backend.cookies = await signIn(browser, backend.daemon);
    }
    const results: CapturedShot[] = new Array(jobs.length);
    const failures: string[] = [];
    let next = 0;
    const worker = async (b: Browser) => {
      while (next < jobs.length) {
        const index = next++;
        const job = jobs[index]!;
        try {
          results[index] = await captureOne(b, backends.get(job.shot.screen.scenario)!, job.shot, job.mutation, options.outDir);
        } catch (error) {
          const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
          failures.push(`${job.shot.key}${job.mutation ? `!${job.mutation}` : ""}：${message}`);
        }
      }
    };
    const b = browser;
    await Promise.all(Array.from({ length: Math.min(SHOT_PARALLEL, jobs.length) }, () => worker(b)));
    if (failures.length > 0) throw new Error(`${failures.length} 个界面截图失败：\n${failures.sort().join("\n")}`);
    const manifest: CaptureManifest = { commit: currentCommit(options.repoRoot), browser: `chromium ${b.version()}`, shots: results };
    writeFileSync(join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await browser?.close();
    await Promise.all([...backends.values()].map((b) => b.stop()));
  }
}

/** 两份清单里字节不一样的图的 key（一边有一边没有的也算）；都一样返回空数组。 */
export function diffManifests(a: CaptureManifest, b: CaptureManifest): string[] {
  const fingerprint = (s: CapturedShot) => `${s.sha256}|${s.focusSha256 ?? ""}`;
  const left = new Map(a.shots.map((s) => [s.key, fingerprint(s)]));
  const right = new Map(b.shots.map((s) => [s.key, fingerprint(s)]));
  const keys = [...new Set([...left.keys(), ...right.keys()])];
  return keys.filter((key) => left.get(key) !== right.get(key));
}

async function startBackend(scenario: Scenario, repoRoot: string, workDir: string): Promise<Backend> {
  const home = join(workDir, scenario, "home");
  const seed = await seedScenario({ home, projectsDir: join(workDir, "projects"), scenario });
  if (scenario !== "two-devices") {
    const daemon = await startIsolatedDaemon({ home, repoRoot });
    return { daemon, seed, cookies: [], stop: () => daemon.stop() };
  }
  const peer = await startIsolatedDaemon({ home: peerHomeOf(home), repoRoot });
  try {
    const daemon = await startIsolatedDaemon({ home, repoRoot, pairWith: peer });
    return { daemon, seed, cookies: [], stop: async () => void (await Promise.all([daemon.stop(), peer.stop()])) };
  } catch (error) {
    await peer.stop();
    throw error;
  }
}

/** 用一个桌面上下文走一次登录链接，存下 cookie（同 Playwright 文档里用 storageState 复用登录的做法）。 */
async function signIn(browser: Browser, daemon: IsolatedDaemon): Promise<Cookie[]> {
  const context = await browser.newContext({ locale: SHOT_LOCALE, timezoneId: SHOT_TIMEZONE });
  try {
    const page = await context.newPage();
    await page.goto(daemon.loginUrl);
    await page.waitForURL(`${daemon.origin}/`);
    return (await context.storageState()).cookies;
  } finally {
    await context.close();
  }
}

async function captureOne(browser: Browser, backend: Backend, shot: Shot, mutation: string | undefined, outDir: string): Promise<CapturedShot> {
  const view = VIEWPORTS[shot.viewport];
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    isMobile: view.touch,
    hasTouch: view.touch,
    locale: SHOT_LOCALE,
    timezoneId: SHOT_TIMEZONE,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    const network = trackRequests(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const steps = stepsOf(shot.screen.id, backend.seed);
    await page.clock.setFixedTime(new Date(BROWSER_NOW_ISO));
    const now = Date.parse(BROWSER_NOW_ISO);
    const storage: Record<string, string> = {
      "agent-hub:lastSeen": JSON.stringify(Object.fromEntries(Array.from({ length: SHOT_SEEN_CONVERSATIONS }, (_, i) => [i + 2, now]))),
      ...Object.assign({}, ...steps.flatMap((s) => ("storage" in s ? [s.storage] : []))),
    };
    await context.addInitScript((items: Record<string, string>) => {
      if (sessionStorage.getItem("ui-polish:seeded") === "1") return;
      sessionStorage.setItem("ui-polish:seeded", "1");
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    }, storage);
    await blockWrites(page);
    for (const step of steps) if ("patch" in step) await applyPatch(page, step.patch);
    await context.addCookies(backend.cookies);
    await page.goto(`${backend.daemon.origin}/`);
    await page.waitForLoadState("domcontentloaded");
    let crop: string | undefined;
    if (!steps.some((s) => "goto" in s)) await page.waitForSelector("#root > *", { timeout: SHOT_READY_TIMEOUT_MS });
    for (const step of steps) crop = (await runStep(page, step, backend.daemon.origin)) ?? crop;
    await page.evaluate(inPage.fontsReady);
    await page.mouse.move(view.width - 1, view.height - 1);
    if (mutation !== undefined) await applyMutation(page, mutation);
    const key = `${shot.key}${mutation === undefined ? "" : `!${mutation}`}`;
    await network.quiet();
    const png = await stableScreenshot(page);
    const file = `${key}.png`;
    writeFileSync(join(outDir, file), png);
    const result: CapturedShot = {
      key,
      screenId: shot.screen.id,
      viewport: shot.viewport,
      file,
      sha256: sha256(png),
      machineFindings: await runMachineChecks(page, { touch: view.touch }),
    };
    if (crop !== undefined && shot.screen.focus !== undefined) {
      const focusPng = await page.locator(crop).first().screenshot({ animations: "disabled", caret: "hide", scale: "device" });
      result.focusFile = `${key}.focus.png`;
      writeFileSync(join(outDir, result.focusFile), focusPng);
      result.focusSha256 = sha256(focusPng);
    }
    if (errors.length > 0) throw new Error(`页面报错：${errors.join("；")}`);
    return result;
  } catch (error) {
    const page = context.pages()[0];
    if (page !== undefined) {
      mkdirSync(join(outDir, "failed"), { recursive: true });
      await page.screenshot({ path: join(outDir, "failed", `${shot.key}${mutation === undefined ? "" : `!${mutation}`}.png`) }).catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}

function stepsOf(screenId: string, seed: SeedResult): ScreenStep[] {
  const steps = SCREEN_STEPS[screenId];
  if (steps === undefined) throw new Error(`界面 ${screenId} 在 SCREEN_STEPS 里没有到达步骤`);
  const fill = (text: string) =>
    text.replace(/\{([a-z0-9.-]+)\}/gi, (_, name: string) => {
      const id = seed.ids[name];
      if (id === undefined) throw new Error(`界面 ${screenId} 的步骤引了种子里没有的 ${name}`);
      return String(id);
    });
  return steps.map((step) => ("goto" in step ? { goto: fill(step.goto) } : step));
}

async function runStep(page: Page, step: ScreenStep, origin: string): Promise<string | undefined> {
  const timeout = SHOT_READY_TIMEOUT_MS;
  if ("goto" in step) {
    await page.goto(`${origin}/${step.goto}`);
    await page.waitForSelector("#root > *", { timeout });
  } else if ("click" in step) await page.locator(step.click).first().click({ timeout });
  else if ("hover" in step) await page.locator(step.hover).first().hover({ timeout });
  else if ("focus" in step) await page.locator(step.focus).first().focus({ timeout });
  else if ("type" in step) {
    const input = page.locator(step.type.into).first();
    await input.focus({ timeout });
    await input.pressSequentially(step.type.text);
  } else if ("press" in step) await page.keyboard.press(step.press);
  else if ("scroll" in step) await page.locator(step.scroll.target).first().evaluate(inPage.scrollToPosition, step.scroll.to); else if ("drag" in step) await page.evaluate(inPage.dragFiles, { selector: step.drag.over, names: step.drag.files, ...(step.drag.drop === undefined ? {} : { drop: step.drag.drop }) });
  else if ("waitFor" in step) await page.waitForSelector(step.waitFor, { timeout });
  else if ("signOut" in step) {
    await page.context().clearCookies();
    await page.goto(`${origin}/`);
  } else if ("crop" in step) {
    await page.waitForSelector(step.crop, { timeout });
    return step.crop;
  }
  return undefined;
}

/**
 * 记着页面在途的请求，等它们都回来、再静 SHOT_NETWORK_QUIET_MS 才截：截图关了动效，转圈的加载中连截两张也一样，光比画面会把没加载完的当成画稳了。
 * 补丁故意挂着的请求（heldRequests）不算；WebSocket 不是请求，不算。
 */
function trackRequests(page: Page): { quiet(): Promise<void> } {
  const inflight = new Set<Request>();
  let lastChange = Date.now();
  page.on("request", (r) => {
    inflight.add(r);
    lastChange = Date.now();
  });
  const done = (r: Request) => {
    inflight.delete(r);
    lastChange = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    async quiet() {
      const deadline = Date.now() + SHOT_READY_TIMEOUT_MS;
      for (;;) {
        const busy = [...inflight].filter((r) => !heldRequests.has(r));
        if (busy.length === 0 && Date.now() - lastChange >= SHOT_NETWORK_QUIET_MS) return;
        if (Date.now() > deadline) throw new Error(`${SHOT_READY_TIMEOUT_MS / 1000} 秒内请求一直没停：${busy.map((r) => r.url()).join("、")}`);
        await page.waitForTimeout(50);
      }
    },
  };
}

/** 连截两张一样才算画稳（同 Playwright toHaveScreenshot 的做法），超时说明这一屏一直在动。 */
async function stableScreenshot(page: Page): Promise<Buffer> {
  const deadline = Date.now() + SHOT_READY_TIMEOUT_MS;
  let previous = await page.screenshot({ animations: "disabled", caret: "hide", scale: "device" });
  for (;;) {
    await page.waitForTimeout(SHOT_STABLE_POLL_MS);
    const current = await page.screenshot({ animations: "disabled", caret: "hide", scale: "device" });
    if (current.equals(previous)) return current;
    if (Date.now() > deadline) throw new Error(`${SHOT_READY_TIMEOUT_MS / 1000} 秒内画面一直在变`);
    previous = current;
  }
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function currentCommit(repoRoot: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  return git("status", "--porcelain").length > 0 ? `${head}+dirty` : head;
}

export const readManifest = (outDir: string): CaptureManifest => JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as CaptureManifest;
