import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit, type Locator, type Page, type WebSocketRoute } from "playwright";
import { bundledModelCatalog, emptyRouterSlice, type DeviceInfo, type ProviderStatusItem, type ProvidersStatusResponse, type RouterDecisionItem, type StateSnapshot } from "../src/shared/index.ts";
import { applyPatch, blockWrites } from "../test/ui-polish/patches.ts";

const engines = { chromium, webkit } as const;
type Engine = keyof typeof engines;

interface BrowserGlobals {
  open: () => unknown;
  location: { hash: string };
  history: { state: unknown; length: number };
}
function currentHistory() {
  const { location, history } = globalThis as unknown as BrowserGlobals;
  return { hash: location.hash, state: history.state, length: history.length };
}

interface Source {
  origin: string;
  loginUrl: string;
}

interface CaseContext {
  page: Page;
  open: (hash: string) => Promise<void>;
  rounds: (check: (narrow: boolean) => Promise<void>) => Promise<void>;
  screenshot: (step: string) => Promise<void>;
  requests: Array<{ path: string; body: unknown }>;
}

interface LayoutSwitchOptions extends Source {
  outDir: string;
  label: string;
  engines: readonly Engine[];
  scenarios: readonly string[];
}

const ROUTER_DRAFT = "Review this project after resizing";
const PERSONA_DRAFT = "Keep this draft behind Settings";
const LOCAL: DeviceInfo = { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Office Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
const REMOTE: DeviceInfo = { ...LOCAL, id: "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f", name: "Tokyo", self: false, link: "relay" };

function settings(page: Page) {
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

async function enterSetting(page: Page, tab: string): Promise<void> {
  await page.getByRole("button", { name: /^Settings(?: \(attention needed\))?$/ }).click();
  await settings(page).getByRole("tab", { name: tab, exact: true }).click();
}

async function remember(locator: Locator) {
  const original = await locator.elementHandle();
  return async () => {
    await locator.waitFor();
    assert.ok(await locator.evaluate((node, before) => node === before, original), "the control was rebuilt");
  };
}

async function setRouterDraft(page: Page) {
  const composer = page.getByPlaceholder(/^Tell Router/);
  await composer.fill("@agent");
  await page.getByRole("option", { name: /agent-hub/ }).click();
  await composer.fill(ROUTER_DRAFT);
  await page.getByRole("button", { name: "Remove target agent-hub" }).waitFor();
  return composer;
}

async function routerTarget(ctx: CaseContext, sendNarrow = false) {
  const { page, open, rounds, screenshot, requests } = ctx;
  await open("#/router");
  const input = await setRouterDraft(page);
  const same = await remember(input);
  await rounds(async () => {
    assert.equal(await input.inputValue(), ROUTER_DRAFT);
    await page.getByRole("button", { name: "Remove target agent-hub" }).waitFor();
    await same();
  });
  if (sendNarrow) await page.setViewportSize({ width: 675, height: 800 });
  const sentRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/router/commands"));
  await input.press("Enter");
  await sentRequest;
  const sent = requests.find((request) => request.path === "/api/router/commands")?.body;
  assert.deepEqual(sent, { ...sent as object, text: ROUTER_DRAFT, target: { pmId: 1, projectId: 1 } });
  await screenshot("sent");
}

async function personaBehind(ctx: CaseContext, closeNarrow = false) {
  const { page, open, rounds, screenshot } = ctx;
  await open("#/pm/1/persona");
  const persona = page.getByRole("textbox", { name: "Persona", exact: true });
  const samePersona = await remember(persona);
  await persona.fill(PERSONA_DRAFT);
  await screenshot("persona");
  await enterSetting(page, "Capabilities");
  const choice = page.getByRole("radio", { name: "Router", exact: true });
  await choice.click();
  const sameChoice = await remember(choice);
  await rounds(async () => {
    assert.equal(new URL(page.url()).hash, "#/settings/capabilities");
    assert.equal(await choice.getAttribute("aria-checked"), "true");
    await sameChoice();
  });
  if (closeNarrow) {
    await page.setViewportSize({ width: 675, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForURL(/#\/settings$/);
    await page.goBack();
  } else {
    await settings(page).getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.locator('[role="dialog"][data-page]').waitFor({ state: "hidden" });
  await screenshot("returned");
  assert.equal(new URL(page.url()).hash, "#/pm/1/persona");
  assert.equal(await persona.inputValue(), PERSONA_DRAFT);
  await samePersona();
  assert.ok(await page.getByRole("button", { name: "Save", exact: true }).isEnabled());
}

async function installDevices(page: Page) {
  await page.route("**/api/devices", (route) => route.fulfill({ json: { devices: [LOCAL, REMOTE] } }));
  await page.route(`**/d/${REMOTE.id}/api/state`, async (route) => {
    await route.fulfill({ response: await route.fetch({ url: new URL("/api/state", route.request().url()).href }) });
  });
  await page.routeWebSocket(/\/d\/[^/]+\/api\/ws/, () => {});
  await page.route("**/api/account", (route) => route.fulfill({ json: { state: "signed_out", lastError: null } }));
}

const DEMO_AUTH = {
  flowId: "layout-switch-flow",
  methodId: "browser",
  phase: "waiting_browser",
  authorizeUrl: "https://example.test/authorize",
  verificationUrl: null,
  userCode: null,
  manualInput: "code",
  ownedByOtherClient: false,
  error: null,
  expiresAt: Date.now() + 60_000,
} as const;

async function providerSignIn(ctx: CaseContext, method: "API key" | "Browser") {
  const { page, open, rounds, requests } = ctx;
  let started = false;
  function provider(): ProviderStatusItem {
    return {
      vendor: "claude",
      label: "Claude Code",
      installed: true,
      version: "1.0",
      availability: "signed_out",
      accountSummary: null,
      canInstall: false,
      canUpdate: false,
      canSignOut: false,
      authMethods: [
        { id: "browser", kind: "browser_oauth", label: "Browser", manualInput: "code" },
        { id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-test" },
      ],
      job: null,
      authFlow: started ? DEMO_AUTH : null,
    };
  }
  await page.route(/\/api\/providers(?:\?|$)/, (route) => {
    const body: ProvidersStatusResponse = { platform: "darwin", gitInstalled: true, canInstallGit: false, gitJob: null, providers: [provider()] };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/providers/claude/auth/*", (route) => {
    started = route.request().url().endsWith("/start");
    return route.fulfill({ json: provider() });
  });
  await page.addInitScript(() => { (globalThis as unknown as BrowserGlobals).open = () => null; });
  await open("#/settings/providers");
  await page.getByTestId("provider-row-claude").getByRole("button", { name: /Sign in/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Claude Code" });
  let input: Locator;
  if (method === "API key") {
    await dialog.getByRole("radio", { name: method }).click();
    input = dialog.getByLabel("API key", { exact: true });
  } else {
    await dialog.getByRole("button", { name: "Continue in browser" }).click();
    input = dialog.getByPlaceholder("Paste code or redirect URL…");
  }
  await input.fill("temporary-test-credential");
  const same = await remember(input);
  await rounds(async () => {
    assert.equal(await input.inputValue(), "temporary-test-credential");
    assert.equal(await dialog.getByRole("radio", { name: method }).getAttribute("aria-checked"), "true");
    await same();
  });
  const cancellations = () => requests.filter((x) => x.path.endsWith("/auth/cancel"));
  assert.equal(cancellations().length, 0);
  if (await dialog.isVisible()) {
    const cancelled = method === "Browser"
      ? page.waitForRequest((request) => request.url().endsWith("/auth/cancel"))
      : undefined;
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await cancelled;
  }
  assert.equal(cancellations().length, method === "Browser" ? 1 : 0);
}

async function computerRename({ page, open, rounds }: CaseContext) {
  await installDevices(page);
  await open("#/settings/computers");
  await page.getByRole("button", { name: "Rename Office Mac" }).click();
  await page.getByRole("textbox", { name: "Device name" }).fill("Renamed Test Mac");
  await rounds(async (narrow) => {
    const input = page.getByRole("textbox", { name: narrow ? "Computer name" : "Device name" });
    assert.equal(await input.inputValue(), "Renamed Test Mac");
  });
}

function decision(id: number): RouterDecisionItem {
  const time = Date.now();
  return {
    id, kind: "decision", status: "pending", pmId: 1, projectId: 1, conversationId: 1,
    question: id === 100 ? "Ship the cache today?" : "Keep the old flag?", context: "", options: ["Yes", "No"],
    askMessageId: null, resolution: null, createdAt: time - id, updatedAt: time - id,
  };
}

async function routerTray({ page, open, rounds }: CaseContext, closeElsewhere = false) {
  let seq = 0;
  let stream: WebSocketRoute | null = null;
  if (closeElsewhere) await page.routeWebSocket(/\/api\/ws/, (socket) => { stream = socket; });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json() as StateSnapshot;
    seq = state.seq;
    await route.fulfill({ response, json: { ...state, router: { ...state.router, items: [decision(100), decision(101)] } } });
  });
  await open("#/router");
  const tray = page.getByRole("region", { name: "Needs You" });
  await tray.getByRole("button", { name: /Keep the old flag/ }).click();
  const note = tray.getByLabel("Your reply");
  await note.fill("Only for one release");
  if (closeElsewhere) {
    const connected = stream as WebSocketRoute | null;
    assert.ok(connected, "the workbench did not subscribe to daemon changes");
    connected.send(JSON.stringify({ seq: seq + 1, type: "router.item.updated", data: { item: { ...decision(101), status: "superseded" } } }));
  }
  const preserved = closeElsewhere ? tray.locator("[data-closed-draft-card]") : note;
  const same = await remember(preserved);
  await rounds(async () => {
    if (closeElsewhere) assert.match(await preserved.innerText(), /Only for one release/);
    else assert.equal(await note.inputValue(), "Only for one release");
    await same();
  });
}

async function listSearch({ page, open, rounds }: CaseContext) {
  await open("#/c/1");
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.fill("小林");
  const sameSearch = await remember(search);
  await rounds(async (narrow) => {
    if (narrow) {
      assert.ok(!(await search.isVisible()));
    } else {
      assert.equal(await search.inputValue(), "小林");
      await sameSearch();
    }
  });
}

async function pmSettings({ page, open, rounds }: CaseContext, section: string) {
  if (section === "memory") await applyPatch(page, "memory-files");
  await open(`#/pm/1/${section}`);
  let input: Locator;
  switch (section) {
    case "memory":
      await page.getByRole("button", { name: "Edit conventions.md" }).click();
      input = page.getByRole("textbox", { name: "conventions.md content" });
      break;
    case "schedules":
      await page.getByRole("button", { name: "New", exact: true }).click();
      input = page.getByRole("textbox", { name: "Task" });
      break;
    case "capabilities":
      input = page.getByRole("searchbox", { name: "Search capabilities" });
      break;
    default:
      input = page.getByRole("textbox", { name: "Worktree setup", exact: true });
  }
  await input.fill("Unsaved PM settings draft");
  const same = await remember(input);
  await rounds(async () => {
    assert.equal(await input.inputValue(), "Unsaved PM settings draft");
    await same();
  });
}

async function installModels(page: Page) {
  await page.route(/\/api\/models(?:\?|$)/, (route) => route.fulfill({ json: { catalogs: [
    { ...bundledModelCatalog("claude"), availability: "available", models: [{ id: "opus", label: "Opus", description: "Fixture", efforts: ["low", "high"] }] },
    { ...bundledModelCatalog("codex"), availability: "available", models: [{ id: "example", label: "Example Model", description: "Fixture", efforts: ["low", "high"] }] },
  ] } }));
}

async function pmModel({ page, open, rounds }: CaseContext) {
  await installModels(page);
  await open("#/pm/1/model");
  const choices = [["Provider", "Codex"], ["Model", "Example Model"], ["Effort", "High"]] as const;
  const checks: Array<() => Promise<void>> = [];
  for (const [name, value] of choices) {
    const control = page.getByRole("combobox", { name, exact: true });
    await control.click();
    await page.getByRole("option", { name: value, exact: true }).click();
    const same = await remember(control);
    checks.push(async () => {
      assert.equal((await control.innerText()).trim(), value);
      await same();
    });
  }
  await rounds(async () => {
    for (const check of checks) await check();
    assert.ok(await page.getByRole("button", { name: "Save", exact: true }).isEnabled());
  });
}

async function settingsChoice({ page, open, rounds }: CaseContext, choice: "resources" | "relay" | "capabilities") {
  if (choice !== "capabilities") await installDevices(page);
  await open(choice === "relay" ? "#/settings/computers" : `#/settings/${choice}`);
  let input: Locator;
  if (choice === "resources") {
    input = page.getByRole("combobox", { name: "Computer" });
    await input.click();
    await page.getByRole("option", { name: "Tokyo" }).click();
  } else if (choice === "relay") {
    await page.getByRole("button", { name: "Relay…" }).click();
    input = page.getByLabel("Relay URL");
    await input.fill("https://custom.example.test");
  } else {
    input = page.getByRole("radio", { name: "Router", exact: true });
    await input.click();
  }
  const same = await remember(input);
  await rounds(async () => {
    if (choice === "resources") assert.equal((await input.innerText()).trim(), "Tokyo");
    else if (choice === "relay") assert.equal(await input.inputValue(), "https://custom.example.test");
    else assert.equal(await input.getAttribute("aria-checked"), "true");
    await same();
  });
}

async function scaleSetting({ page, open, rounds, screenshot }: CaseContext) {
  await page.setViewportSize({ width: 700, height: 800 });
  await open("#/c/1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings(page).getByRole("radio", { name: "Large", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Interface scale", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "#/settings/scale");
  await screenshot("scale-triggered-switch");
  await page.setViewportSize({ width: 900, height: 800 });
  await rounds(async (narrow) => {
    const area = narrow ? page.getByTestId("mobile-settings") : settings(page);
    assert.equal(new URL(page.url()).hash, "#/settings/scale");
    assert.equal(await area.getByRole("radio", { name: "Large", exact: true }).getAttribute("aria-checked"), "true");
  });
}

async function composerDrafts({ page, open, rounds }: CaseContext, worker = false) {
  const composer = worker ? page.getByRole("complementary", { name: "排查只读 Worker 超时", exact: true }) : page.getByRole("main");
  let hash = "#/c/1";
  if (worker) {
    await open("#/router");
    const state = await page.request.get(new URL("/api/state", page.url()).href);
    const snapshot = await state.json() as StateSnapshot;
    const id = snapshot.conversations.find((entry) => entry.conversation.title === "排查只读 Worker 超时")?.conversation.id;
    assert.ok(id, "the seeded Worker was not found");
    hash = `#/w/${id}`;
  } else await installModels(page);
  await open(hash);
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  if (!worker) {
    await input.pressSequentially("/hub:worker claude opus hi");
    await page.getByRole("option", { name: "High", exact: true }).click();
  }
  await input.fill("Draft with attachment");
  await composer.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("draft notes") });
  const same = await remember(input);
  await rounds(async () => {
    assert.equal(await input.inputValue(), "Draft with attachment");
    await composer.getByText("notes.txt", { exact: true }).waitFor();
    if (!worker) await page.getByRole("button", { name: "Worker model: Claude Code Opus High" }).waitFor();
    await same();
  });
}

async function automaticReload({ page, open, rounds, screenshot }: CaseContext) {
  let stream: WebSocketRoute | null = null;
  let nextBoot: string | null = null;
  await page.routeWebSocket(/\/api\/ws/, (socket) => { stream = socket; });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as StateSnapshot;
    await route.fulfill({ response, json: { ...snapshot, router: emptyRouterSlice(), ...(nextBoot === null ? {} : { bootId: nextBoot }) } });
  });
  await open("#/router");
  const input = await setRouterDraft(page);
  const same = await remember(input);
  await rounds(async () => {
    assert.equal(await input.inputValue(), ROUTER_DRAFT);
    await same();
  });
  await page.waitForLoadState("networkidle");
  const connected = stream as WebSocketRoute | null;
  assert.ok(connected, "the workbench did not subscribe to daemon changes");
  const loaded = page.waitForEvent("load");
  nextBoot = randomUUID();
  connected.send(JSON.stringify({ type: "resync" }));
  await loaded;
  assert.equal(await input.inputValue(), ROUTER_DRAFT);
  await page.getByRole("button", { name: "Remove target agent-hub" }).waitFor();
  await screenshot("reloaded");
}

async function navigation({ page, open, rounds }: CaseContext) {
  await open("#/c/1");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const same = await remember(input);
  await enterSetting(page, "Capabilities");
  const before = await page.evaluate(currentHistory);
  await rounds(async () => {
    assert.deepEqual(await page.evaluate(currentHistory), before);
  });
  await page.goBack();
  assert.equal(new URL(page.url()).hash, "#/c/1");
  await same();
}

const cases: Record<string, (context: CaseContext) => Promise<void>> = {
  "router-target": routerTarget,
  "router-target-mobile": (ctx) => routerTarget(ctx, true),
  "persona-behind-settings": personaBehind,
  "persona-back-mobile": (ctx) => personaBehind(ctx, true),
  "router-tray": routerTray,
  "router-closed-reply": (ctx) => routerTray(ctx, true),
  "list-search": listSearch,
  "pm-model": pmModel,
  "pm-schedules": (ctx) => pmSettings(ctx, "schedules"),
  "pm-memory": (ctx) => pmSettings(ctx, "memory"),
  "pm-worktree": (ctx) => pmSettings(ctx, "worktree"),
  "pm-capabilities": (ctx) => pmSettings(ctx, "capabilities"),
  "settings-capabilities": (ctx) => settingsChoice(ctx, "capabilities"),
  "settings-scale": scaleSetting,
  "settings-resources": (ctx) => settingsChoice(ctx, "resources"),
  "settings-relay": (ctx) => settingsChoice(ctx, "relay"),
  "composer-drafts": composerDrafts,
  "worker-drafts": (ctx) => composerDrafts(ctx, true),
  "auto-reload": automaticReload,
  navigation,
  "provider-api-key": (ctx) => providerSignIn(ctx, "API key"),
  "provider-browser-code": (ctx) => providerSignIn(ctx, "Browser"),
  "computer-rename": computerRename,
};

export async function verifyLayoutSwitch(options: LayoutSwitchOptions) {
  await mkdir(options.outDir, { recursive: true });
  const selected = options.scenarios.length === 0 ? Object.keys(cases) : options.scenarios;
  for (const name of selected) if (!(name in cases)) throw new Error(`Unknown layout switch scenario: ${name}`);
  const results = [];
  for (const engine of options.engines) {
    const browser = await engines[engine].launch();
    try {
      for (const scenario of selected) {
        const context = await browser.newContext({ viewport: { width: 900, height: 800 }, serviceWorkers: "block", reducedMotion: "reduce" });
        const page = await context.newPage();
        page.setDefaultTimeout(4_000);
        await page.addInitScript(() => {
          localStorage.setItem("agent-hub.uiScale", "md");
          localStorage.setItem("agent-hub.rightRail", "closed");
        });
        await blockWrites(page);
        const requests: CaseContext["requests"] = [];
        const screenshots: string[] = [];
        const errors: string[] = [];
        const failures: string[] = [];
        page.on("pageerror", (err) => errors.push(err.message));
        page.on("request", (request) => {
          const path = new URL(request.url()).pathname;
          if (request.method() === "POST" && /\/api\/(router\/commands|providers\/[^/]+\/auth\/)/.test(path)) requests.push({ path, body: request.postDataJSON() });
        });
        const screenshot = async (step: string) => {
          const path = join(options.outDir, `${options.label}-${engine}-${scenario}-${step}.png`);
          await page.screenshot({ path, animations: "disabled" });
          screenshots.push(path);
        };
        const start = await context.request.get(options.loginUrl, { maxRedirects: 0 });
        assert.equal(start.status(), 302);
        const open = async (hash: string) => { await page.goto(`${options.origin}/${hash}`); };
        const rounds: CaseContext["rounds"] = async (check) => {
          await screenshot("wide-0");
          for (const [index, width] of [675, 900, 675, 900].entries()) {
            const narrow = width < 676;
            for (const step of narrow ? [800, 700, width] : [700, 800, width]) {
              await page.mouse.move(step - 2, 420);
              await page.setViewportSize({ width: step, height: 800 });
            }
            await page.locator(`[data-shell="${narrow ? "mobile" : "desktop"}"]`).waitFor();
            try {
              await check(narrow);
            } catch (err) {
              failures.push(`width ${width}: ${err instanceof Error ? err.message : String(err)}`);
            }
            await screenshot(`${narrow ? "narrow" : "wide"}-${Math.floor(index / 2) + 1}`);
          }
        };
        try {
          await cases[scenario]!({ page, open, rounds, screenshot, requests });
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
          await screenshot("failure").catch(() => {});
        } finally {
          await context.close();
        }
        const result = { engine, scenario, passed: failures.length === 0 && errors.length === 0, failures, errors, screenshots, requests };
        results.push(result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    } finally {
      await browser.close();
    }
  }
  await writeFile(join(options.outDir, `${options.label}-requests.json`), JSON.stringify(results, null, 2));
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: process.cwd() },
      out: { type: "string", default: join(tmpdir(), "bellwood-layout-switch") },
      label: { type: "string", default: "after" },
      engine: { type: "string", multiple: true },
      scenario: { type: "string", multiple: true },
    },
  });
  const repoRoot = resolve(values.repo!);
  const selected = values.engine ?? ["chromium", "webkit"];
  if (selected.some((engine) => !(engine in engines))) throw new Error("Choose chromium or webkit");
  const seed = await import(pathToFileURL(join(repoRoot, "test/ui-polish/seed.ts")).href) as typeof import("../test/ui-polish/seed.ts");
  const root = await mkdtemp(join(tmpdir(), "bellwood-layout-switch-"));
  try {
    const home = join(root, "home");
    await seed.seedScenario({ home, projectsDir: join(root, "projects"), scenario: "standard" });
    const daemon = await seed.startIsolatedDaemon({ home, repoRoot });
    try {
      const results = await verifyLayoutSwitch({ ...daemon, outDir: values.out!, label: values.label!, engines: selected as Engine[], scenarios: values.scenario ?? [] });
      if (results.some((result) => !result.passed)) process.exitCode = 1;
    } finally {
      await daemon.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
