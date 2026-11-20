// Real-Chromium A/B benchmark for the chat MessageList: builds the harness in src/web/bench against a base ref and the working tree, then alternates runs.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadavg } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS_DIR = "src/web/bench";
const VIEWPORT = { width: 1280, height: 800 };
const SETTLE_MS = 800;
const APPENDS = 10;
const STREAM_CHUNKS = 20;
// Longer than the virtualizer's 150 ms isScrolling reset, so each update starts from an idle frame clock instead of measuring vsync phase.
const UPDATE_GAP_MS = 300;
const WHEEL_STEPS = 30;
const WHEEL_DELTA_PX = -1500;
const WHEEL_GAP_MS = 16;

type SideName = "before" | "after";

interface Side {
  name: SideName;
  root: string;
  dist: string;
  url?: string;
}

interface RunResult {
  side: SideName;
  round: number;
  mountMs: number;
  domNodes: number;
  rows: number;
  appendMs: number;
  appendCommitMs: number;
  streamMs: number;
  streamCommitMs: number;
  blankFrames: number;
  anchorDriftPx: number;
  focusCentered: boolean;
  errors: string[];
}

interface BenchApi {
  mount(count: number, older?: number): Promise<number>;
  focus(id: number): void;
  olderLoads(): number;
  append(): Promise<number>;
  stream(chunk: string): Promise<number>;
  lastCommitMs(): number;
  nodeCount(): number;
  rowCount(): number;
}

interface Box {
  top: number;
  bottom: number;
}

interface PageElement {
  scrollTop: number;
  getBoundingClientRect(): Box;
  getAttribute(name: string): string | null;
}

interface PageGlobals {
  __bench: BenchApi;
  document: {
    querySelector(selector: string): PageElement | null;
    querySelectorAll(selector: string): Iterable<PageElement>;
  };
  requestAnimationFrame(callback: () => void): number;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const range = (values: number[]) => `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareBefore(base: string, out: string): string {
  const root = join(out, "before-tree");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const archive = execFileSync("git", ["archive", base, "src", "tsconfig.json"], { cwd: REPO_ROOT, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  // The base tree predates the harness, so the current harness mounts the base MessageList.
  cpSync(join(REPO_ROOT, HARNESS_DIR), join(root, HARNESS_DIR), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

async function buildSide(side: Side): Promise<void> {
  const cwd = process.cwd();
  process.chdir(side.root);
  try {
    await build({
      configFile: false,
      root: join(side.root, "src/web"),
      logLevel: "warn",
      plugins: [react(), tailwindcss()],
      build: { outDir: side.dist, emptyOutDir: true, rolldownOptions: { input: join(side.root, HARNESS_DIR, "index.html") } },
    });
  } finally {
    process.chdir(cwd);
  }
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const chartSvg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#eef2f7"/><rect x="40" y="120" width="80" height="160" fill="#7aa2d6"/><rect x="160" y="60" width="80" height="220" fill="#5b8bc9"/><text x="40" y="40" font-size="24" font-family="sans-serif">${label}</text></svg>`;

function serve(dist: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(chartSvg(path.split("/").at(-1)!));
      return;
    }
    const file = normalize(join(dist, path.endsWith("/") ? `${path}index.html` : path));
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function wheelScroll(page: Page): Promise<number> {
  const log = page.getByRole("log");
  const box = (await log.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let blank = 0;
  for (let i = 0; i < WHEEL_STEPS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA_PX);
    await sleep(WHEEL_GAP_MS);
    const visible = await page.evaluate(() => {
      const { document } = globalThis as unknown as PageGlobals;
      const scroller = document.querySelector('[role="log"]')!.getBoundingClientRect();
      return [...document.querySelectorAll('[role="log"] article, [role="log"] [data-turn], [role="log"] [data-side]')].some((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > scroller.top && r.top < scroller.bottom;
      });
    });
    if (!visible) blank += 1;
  }
  return blank;
}

const OLDER_POOL = 1000;
const ANCHOR_START_PX = 1200;
const LOAD_SETTLE_MS = 900;
const FOCUS_TARGET_ID = 7;
const FOCUS_SETTLE_MS = 1500;

async function openHarness(page: Page, side: Side, count: number, older: number): Promise<void> {
  await page.goto(side.url!);
  await page.waitForFunction(() => "__bench" in globalThis);
  await page.evaluate(([n, o]) => (globalThis as unknown as PageGlobals).__bench.mount(n!, o), [count, older]);
  await sleep(SETTLE_MS);
}

/** Scrolls to the top to load an older page and returns how far the first visible message moved. */
async function anchorDrift(page: Page, side: Side, count: number): Promise<number> {
  await openHarness(page, side, count, OLDER_POOL);
  await page.getByRole("log").evaluate((el, top) => (el.scrollTop = top), ANCHOR_START_PX);
  await sleep(SETTLE_MS);
  const before = await page.evaluate(async () => {
    const g = globalThis as unknown as PageGlobals;
    const scroller = g.document.querySelector('[role="log"]')!;
    scroller.scrollTop = 20;
    await new Promise<void>((resolve) => g.requestAnimationFrame(() => g.requestAnimationFrame(resolve)));
    const top = scroller.getBoundingClientRect().top;
    const first = [...g.document.querySelectorAll("[data-message-id]")].find((el) => el.getBoundingClientRect().bottom > top + 1)!;
    return { id: first.getAttribute("data-message-id")!, offset: first.getBoundingClientRect().top - top };
  });
  await sleep(LOAD_SETTLE_MS);
  const after = await page.evaluate((id) => {
    const g = globalThis as unknown as PageGlobals;
    const top = g.document.querySelector('[role="log"]')!.getBoundingClientRect().top;
    const el = g.document.querySelector(`[data-message-id="${id}"]`);
    return { loads: g.__bench.olderLoads(), offset: el === null ? null : el.getBoundingClientRect().top - top };
  }, before.id);
  if (after.loads === 0 || after.offset === null) throw new Error(`${side.name}: older page did not load or the anchor unmounted`);
  return after.offset - before.offset;
}

/** Jumps to an early message (unmounted in a virtual list) and checks it lands centered and highlighted. */
async function focusCentered(page: Page, side: Side, count: number): Promise<boolean> {
  await openHarness(page, side, count, 0);
  await page.evaluate((id) => (globalThis as unknown as PageGlobals).__bench.focus(id), FOCUS_TARGET_ID);
  await sleep(FOCUS_SETTLE_MS);
  return page.evaluate((id) => {
    const g = globalThis as unknown as PageGlobals;
    const scroller = g.document.querySelector('[role="log"]')!.getBoundingClientRect();
    const el = g.document.querySelector(`[data-message-id="${id}"]`);
    if (el === null || el.getAttribute("data-highlighted") !== "true") return false;
    const box = el.getBoundingClientRect();
    return box.top < scroller.bottom && box.bottom > scroller.top;
  }, FOCUS_TARGET_ID);
}

async function sample(page: Page, times: number, kind: "append" | "stream"): Promise<{ total: number[]; commit: number[] }> {
  const total: number[] = [];
  const commit: number[] = [];
  for (let i = 0; i < times; i++) {
    await sleep(UPDATE_GAP_MS);
    const [ms, commitMs] = await page.evaluate(async (which) => {
      const bench = (globalThis as unknown as PageGlobals).__bench;
      const ms = which === "append" ? await bench.append() : await bench.stream(" streamed **markdown** text");
      return [ms, bench.lastCommitMs()] as const;
    }, kind);
    total.push(ms);
    commit.push(commitMs);
  }
  return { total, commit };
}

async function shoot(page: Page, side: SideName, shots: string): Promise<void> {
  const log = page.getByRole("log");
  await page.screenshot({ path: join(shots, `${side}-middle.png`) });
  await log.evaluate((el) => (el.scrollTop = 0));
  await sleep(300);
  await page.screenshot({ path: join(shots, `${side}-top.png`) });
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await sleep(300);
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await sleep(300);
  await page.screenshot({ path: join(shots, `${side}-bottom.png`) });
}

async function runOnce(browser: Browser, side: Side, round: number, count: number, shots: string | null): Promise<RunResult> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(side.url!);
  await page.waitForFunction(() => "__bench" in globalThis);
  const mountMs = await page.evaluate((n) => (globalThis as unknown as PageGlobals).__bench.mount(n), count);
  await sleep(SETTLE_MS);
  const domNodes = await page.evaluate(() => (globalThis as unknown as PageGlobals).__bench.nodeCount());
  const rows = await page.evaluate(() => (globalThis as unknown as PageGlobals).__bench.rowCount());
  const appends = await sample(page, APPENDS, "append");
  const streams = await sample(page, STREAM_CHUNKS, "stream");
  const blankFrames = await wheelScroll(page);
  if (shots !== null) await shoot(page, side.name, shots);
  const anchorDriftPx = await anchorDrift(page, side, count);
  const focusOk = await focusCentered(page, side, count);
  await context.close();
  return {
    side: side.name,
    round,
    mountMs,
    domNodes,
    rows,
    appendMs: median(appends.total),
    appendCommitMs: median(appends.commit),
    streamMs: median(streams.total),
    streamCommitMs: median(streams.commit),
    blankFrames,
    anchorDriftPx,
    focusCentered: focusOk,
    errors,
  };
}

function summaryRow(name: string, unit: string, before: number[], after: number[]): string {
  return `| ${name} | ${median(before).toFixed(1)} ${unit} (${range(before)}) | ${median(after).toFixed(1)} ${unit} (${range(after)}) |`;
}

function report(results: RunResult[], meta: { base: string; head: string; count: number; rounds: number; load: string }): string {
  const of = (side: SideName, key: Exclude<keyof RunResult, "side" | "round" | "errors" | "focusCentered">) => results.filter((r) => r.side === side).map((r) => r[key]);
  const line = (label: string, key: Parameters<typeof of>[1], unit: string) => summaryRow(label, unit, of("before", key), of("after", key));
  const passes = (side: SideName) => results.filter((r) => r.side === side && r.focusCentered).length;
  const errors = (side: SideName) => results.filter((r) => r.side === side).reduce((n, r) => n + r.errors.length, 0);
  return [
    "# MessageList virtual scrolling benchmark",
    "",
    `Base \`${meta.base}\` vs working tree \`${meta.head}\`, ${meta.count} mixed rich messages, ${meta.rounds} alternating rounds per side, headless Chromium ${VIEWPORT.width}x${VIEWPORT.height}, production \`vite build\`. Load average at start: ${meta.load}.`,
    "",
    "Median per side with the range across rounds in parentheses.",
    "",
    "| Metric | Before | After |",
    "| --- | --- | --- |",
    line("DOM nodes (`document.querySelectorAll('*').length`)", "domNodes", ""),
    line("Rendered message elements", "rows", ""),
    line("First render to painted frame", "mountMs", "ms"),
    line("Append one message: React commit (median of 10 per run)", "appendCommitMs", "ms"),
    line("Append one message: to painted frame", "appendMs", "ms"),
    line("Streaming chunk: React commit (median of 20 per run)", "streamCommitMs", "ms"),
    line("Streaming chunk: to painted frame", "streamMs", "ms"),
    line("Blank viewport samples during 30 fast wheel steps", "blankFrames", ""),
    line("Load-older anchor drift of the first visible message", "anchorDriftPx", "px"),
    `| Jump to message #${FOCUS_TARGET_ID} lands in view and highlighted | ${passes("before")}/${meta.rounds} | ${passes("after")}/${meta.rounds} |`,
    `| Console errors and page errors (total) | ${errors("before")} | ${errors("after")} |`,
    "",
    "## Runs",
    "",
    "| Round | Side | DOM nodes | Rows | First render ms | Append commit / frame ms | Stream commit / frame ms | Blank samples | Anchor drift px | Jump ok | Errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.round} | ${r.side} | ${r.domNodes} | ${r.rows} | ${r.mountMs.toFixed(1)} | ${r.appendCommitMs.toFixed(1)} / ${r.appendMs.toFixed(1)} | ${r.streamCommitMs.toFixed(1)} / ${r.streamMs.toFixed(1)} | ${r.blankFrames} | ${r.anchorDriftPx.toFixed(1)} | ${r.focusCentered ? "yes" : "no"} | ${r.errors.length === 0 ? 0 : r.errors.join("; ")} |`,
    ),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      rounds: { type: "string", default: "5" },
      messages: { type: "string", default: "500" },
      out: { type: "string", default: "/tmp/bellwood-virtual-list-bench" },
      report: { type: "string", default: "/tmp/bellwood-virtual-list-bench.md" },
    },
  });
  const out = values.out!;
  const rounds = Number(values.rounds);
  const count = Number(values.messages);
  const shots = join(out, "screens");
  mkdirSync(shots, { recursive: true });
  const load = loadavg().map((n) => n.toFixed(2)).join(" ");
  const sides: Side[] = [
    { name: "before", root: prepareBefore(values.base!, out), dist: join(out, "before-dist") },
    { name: "after", root: REPO_ROOT, dist: join(out, "after-dist") },
  ];
  for (const side of sides) await buildSide(side);
  const servers: Server[] = [];
  for (const side of sides) {
    const server = await serve(side.dist);
    servers.push(server);
    side.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bench/index.html`;
  }
  const browser = await chromium.launch();
  const results: RunResult[] = [];
  try {
    for (let round = 1; round <= rounds; round++) {
      const order = round % 2 === 1 ? sides : [...sides].reverse();
      for (const side of order) {
        const result = await runOnce(browser, side, round, count, round === rounds ? shots : null);
        results.push(result);
        console.log(`round ${round} ${side.name}: nodes=${result.domNodes} mount=${result.mountMs.toFixed(1)}ms append=${result.appendCommitMs.toFixed(1)}/${result.appendMs.toFixed(1)}ms stream=${result.streamCommitMs.toFixed(1)}/${result.streamMs.toFixed(1)}ms blank=${result.blankFrames} drift=${result.anchorDriftPx.toFixed(1)}px jump=${result.focusCentered} errors=${result.errors.length}`);
      }
    }
  } finally {
    await browser.close();
    for (const server of servers) server.close();
  }
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  writeFileSync(values.report!, report(results, { base: values.base!, head: `${head}+worktree`, count, rounds, load }));
  console.log(`report: ${values.report}\nscreenshots: ${shots}`);
}

await main();
