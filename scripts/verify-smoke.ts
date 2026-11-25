// 本机端到端冒烟（.agents/skills/verify/SKILL.md）：构建网页，在一次性的临时数据目录里用随机端口起真守护进程，
// 查免密登录、健康状态和 /api/state，用无头 Chromium 打开工作台截图（console.error、pageerror 必须是 0），
// 打开设置页确认木头顶栏照样能拖窗和双击缩放，最后正常关机、核对守护进程记过的子进程都退出了，再删掉临时目录。
// 用法：node scripts/verify-smoke.ts [--runs <次数>] [--out <目录>]
// 截图和每次的耗时写到 --out（默认 /tmp/bellwood-verify-smoke）：workbench-smoke.png、smoke-runs.txt。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readLedgerFile } from "../src/daemon/process-ledger.ts";
import { API_PATHS, DEFAULT_AGENT_VENDOR, ENV_HOME, ENV_PORT, ENV_SESSION_OWNER_TAG, VENDOR_LIST, type StateSnapshot } from "../src/shared/index.ts";
import { VERIFY_SMOKE_BUDGET_MS, VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import { resolveHubPaths } from "../src/shared/paths.ts";
import { wrapScriptAsPlatformCli } from "../test/fake-cli-shim.ts";
import { verifyComposerInteractions } from "./verify-composer-interactions.ts";
import { verifyComposerLayout } from "./verify-composer-layout.ts";
import { verifyTopBarUnderSettings } from "./verify-window-drag.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../test/fake-claude/fake-claude.ts", import.meta.url));
const VITE_BIN = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
const DAEMON_MAIN = join(REPO_ROOT, "src", "daemon", "main.ts");
const LOGIN_URL = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;
const SCREENSHOT = "workbench-smoke.png";
const RUNS_LOG = "smoke-runs.txt";

interface RunResult {
  ok: boolean;
  totalMs: number;
  phases: Array<[string, number]>;
  error?: string;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** admin.sock 的路径有长度上限（macOS 104 字节），macOS 的 tmpdir() 太长时用 /tmp。 */
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

/** 守护进程看到的环境只给这几项：用户主目录换成临时目录（各家配置同步只落在这里），默认厂商用假 claude，别家指到不存在的路径。 */
function daemonEnv(home: string, scratch: string): Record<string, string> {
  const userHome = join(scratch, "user-home");
  mkdirSync(userHome, { recursive: true });
  const passthrough = ["PATH", "Path", "SystemRoot", "PATHEXT", "ComSpec", "TMPDIR", "TEMP", "TMP", ENV_SESSION_OWNER_TAG].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!] as const]));
  return {
    ...Object.fromEntries(passthrough),
    LANG: "en_US.UTF-8",
    HOME: userHome,
    USERPROFILE: userHome,
    [ENV_HOME]: home,
    [ENV_PORT]: "0",
    ...Object.fromEntries(
      VENDOR_LIST.map(({ id, cli }) => [cli.envVar, id === DEFAULT_AGENT_VENDOR ? wrapScriptAsPlatformCli(FAKE_CLAUDE, scratch, "fake-claude") : join(scratch, `no-${id}`)]),
    ),
    FAKE_CLAUDE_LOG: join(scratch, "fake-claude.log"),
    FAKE_CLAUDE_STATE: scratch,
  };
}

/** 正常关机：POSIX 发 SIGTERM，Windows 经 admin 命名管道发 /admin/shutdown（和桌面外壳一样）。 */
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

async function runOnce(outDir: string, checkComposer: boolean): Promise<RunResult> {
  const started = performance.now();
  const phases: Array<[string, number]> = [];
  let mark = started;
  const phase = (name: string) => {
    const now = performance.now();
    phases.push([name, now - mark]);
    mark = now;
  };

  const root = mkdtempSync(join(shortTmp(), "bellwood-verify-"));
  const home = join(root, "home");
  const scratch = join(root, "scratch");
  let daemon: { child: ChildProcess; exited: Promise<Exit> } | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const build = spawnSync(process.execPath, [VITE_BIN, "build", "--logLevel", "error"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`构建网页失败（退出码 ${build.status}）：${build.stderr}`);
    phase("构建网页");

    const child = spawn(process.execPath, [DAEMON_MAIN], { cwd: REPO_ROOT, env: daemonEnv(home, scratch), stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<Exit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    daemon = { child, exited };
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
    );
    const origin = `http://127.0.0.1:${login[1]}`;
    const uiToken = login[2]!;
    const loginUrl = `${origin}${API_PATHS.auth}?token=${uiToken}`;
    phase("起守护进程");

    const auth = await fetch(loginUrl, { redirect: "manual" });
    const cookie = (auth.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    if (auth.status !== 302 || cookie === "") throw new Error(`免密登录没跳转或没给 cookie：HTTP ${auth.status}`);
    const headers = { cookie, origin };
    const health = await fetch(`${origin}${API_PATHS.health}`, { headers });
    const healthBody = (await health.json()) as { ok?: boolean };
    if (health.status !== 200 || healthBody.ok !== true) throw new Error(`健康检查不对：HTTP ${health.status} ${JSON.stringify(healthBody)}`);
    const state = await fetch(`${origin}${API_PATHS.state}`, { headers });
    const stateBody = (await state.json()) as Partial<StateSnapshot>;
    if (state.status !== 200 || !Array.isArray(stateBody.conversations)) throw new Error(`/api/state 不对：HTTP ${state.status}`);
    phase("登录、健康检查、/api/state");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    // 输入框出来了说明快照已经拉到、主界面画完，不只是挂上了加载页
    await page.locator("#root textarea").first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
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

    const rootText = (await page.locator("#root").innerText()).trim();
    if (rootText === "") throw new Error("工作台渲染出来是空的");
    await page.screenshot({ path: join(outDir, SCREENSHOT) });
    if (pageErrors.length > 0) throw new Error(`页面报错 ${pageErrors.length} 条：\n${pageErrors.join("\n")}`);
    phase("浏览器渲染工作台、截图");

    await verifyTopBarUnderSettings(page);
    if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
    phase("设置页打开时顶栏照样拖窗");

    if (checkComposer) {
      const id = stateBody.conversations[0]?.conversation.id;
      if (id === undefined) throw new Error("Composer layout check requires a conversation");
      await verifyComposerLayout(loginUrl, id, outDir);
      phase("WebKit composer layout");
      await page.goto(new URL(`/#/c/${id}`, loginUrl).href);
      await verifyComposerInteractions(page, "Chromium", outDir);
      if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
      phase("Chromium composer interactions");
    }
    await browser.close();
    browser = null;

    requestShutdown(child, home, uiToken);
    const exit = await withTimeout("等守护进程正常关机", exited);
    daemon = null;
    if (exit.code !== 0) throw new Error(`守护进程关机退出码 ${exit.code}（信号 ${exit.signal}）：${err}`);
    const leftovers = readLedgerFile(resolveHubPaths({ [ENV_HOME]: home }, home).childProcessesFile).filter((e) => isAlive(e.pid));
    if (leftovers.length > 0) throw new Error(`关机后还有子进程没退出：${leftovers.map((e) => `${e.pid}（${e.purpose}）`).join("、")}`);
    phase("正常关机");

    rmSync(root, { recursive: true });
    if (existsSync(root)) throw new Error(`临时目录没删掉：${root}`);
    phase("删临时目录");
    return { ok: true, totalMs: performance.now() - started, phases };
  } catch (error) {
    return { ok: false, totalMs: performance.now() - started, phases, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close();
    if (daemon !== null) {
      daemon.child.kill("SIGKILL");
      await daemon.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

function describeRun(i: number, r: RunResult): string {
  const phases = r.phases.map(([name, ms]) => `${name} ${seconds(ms)}`).join("，");
  const status = r.ok ? "通过" : `失败：${r.error}`;
  const over = r.totalMs > VERIFY_SMOKE_BUDGET_MS ? `（超过 ${seconds(VERIFY_SMOKE_BUDGET_MS)} 的目标）` : "";
  return `第 ${i} 次：${seconds(r.totalMs)}${over}，${status}\n  ${phases}`;
}

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
    const line = describeRun(i, r);
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

process.exitCode = await main();
