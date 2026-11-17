import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CATALOG_FILE_MAX_CHARS } from "../../shared/limits.ts";
import type { CatalogFailure, CatalogJob, LedgerProjectCatalogWork, ProjectCatalog } from "../../shared/project-catalog.ts";
import type { RouterModelResolution } from "../../shared/router-model.ts";
import type { RouterTurnRequest, RouterTurnResult } from "../router/single-turn.ts";
import { createProjectCatalogRunner, readColdStartFiles, type ProjectCatalogRunnerOptions } from "./runner.ts";

const catalog: ProjectCatalog = { oneLiner: "做导出", aliases: ["core"], focus: "重构", modules: [], decisions: [], openItems: [] };
const resolved = { ok: true, vendor: "claude", model: "haiku", effort: "low", source: "preset" } as unknown as RouterModelResolution;

const jobOf = (projectId: number, previous: ProjectCatalog | null = null): CatalogJob => ({
  projectId,
  cutMessageId: 10,
  input: {
    project: { id: projectId, name: `p${projectId}`, description: null, mainFolder: `/work/p${projectId}`, otherFolders: [] },
    previous,
    handover: null,
    dialog: "用户：你好",
    dialogTruncated: false,
    graphs: [],
    workerReports: [],
    files: [],
  },
});

/** 假账本：按顺序给出 jobs，记下报回来的结果。 */
function fakeLedger(jobs: CatalogJob[]) {
  const queue = [...jobs];
  const written: Array<{ job: CatalogJob; catalog: ProjectCatalog }> = [];
  const failed: Array<{ job: CatalogJob; failure: CatalogFailure }> = [];
  const ledger: LedgerProjectCatalogWork & { claims: number } = {
    claims: 0,
    claimCatalog: () => {
      ledger.claims++;
      return queue.shift() ?? null;
    },
    catalogWritten: (job, value) => void written.push({ job, catalog: value }),
    catalogFailed: (job, failure) => void failed.push({ job, failure }),
  };
  return { ledger, written, failed, queue };
}

/** 假单轮：每次调用登记一份，测试按需放行。 */
function fakeTurns() {
  const calls: Array<{ request: RouterTurnRequest; resolve: (r: RouterTurnResult) => void }> = [];
  const runTurn = vi.fn(
    (request: RouterTurnRequest) =>
      new Promise<RouterTurnResult>((resolve) => {
        calls.push({ request, resolve });
        request.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "被打断了", partialText: "", durationMs: 1 }));
      }),
  );
  const reply = (i: number, text: string) => calls[i]!.resolve({ ok: true, text, usage: null, durationMs: 5 });
  return { runTurn, calls, reply };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await flush();
  expect(check()).toBe(true);
};

function runnerWith(ledger: LedgerProjectCatalogWork, overrides: Partial<ProjectCatalogRunnerOptions> = {}) {
  const turns = fakeTurns();
  const readFiles = vi.fn(async () => [{ name: "README.md", text: "说明" }]);
  const runner = createProjectCatalogRunner({
    ledger,
    runTurn: turns.runTurn,
    resolveModel: async () => resolved,
    readFiles,
    log: () => {},
    tickMs: 60_000,
    ...overrides,
  });
  return { runner, turns, readFiles };
}

describe("createProjectCatalogRunner", () => {
  it("wake 后领活、跑一轮 purpose 为 catalog 的单轮、把取出的档案报给 catalogWritten", async () => {
    const { ledger, written } = fakeLedger([jobOf(1)]);
    const { runner, turns } = runnerWith(ledger);
    runner.wake();
    await waitFor(() => turns.calls.length === 1);
    expect(turns.calls[0]!.request).toMatchObject({ purpose: "catalog", vendor: "claude", model: "haiku", effort: "low" });
    turns.reply(0, `好的\n\`\`\`json\n${JSON.stringify(catalog)}\n\`\`\``);
    await waitFor(() => written.length === 1);
    expect(written[0]).toEqual({ job: jobOf(1), catalog });
    await runner.stop();
  });

  it("连叫几次 wake 只领一轮，不在调用栈里同步领", async () => {
    const { ledger } = fakeLedger([]);
    const { runner } = runnerWith(ledger);
    runner.wake();
    runner.wake();
    runner.wake();
    expect(ledger.claims).toBe(0);
    await flush();
    expect(ledger.claims).toBe(1);
    await runner.stop();
  });

  it("同时在写的不超过 concurrency 份", async () => {
    const { ledger } = fakeLedger([jobOf(1), jobOf(2), jobOf(3)]);
    const { runner, turns } = runnerWith(ledger, { concurrency: 2 });
    runner.wake();
    await waitFor(() => turns.calls.length === 2);
    await flush();
    expect(turns.calls).toHaveLength(2);
    turns.reply(0, JSON.stringify(catalog));
    await waitFor(() => turns.calls.length === 3);
    await runner.stop();
  });

  it("到 timeoutMs 打断这一轮并报 timeout", async () => {
    const { ledger, failed } = fakeLedger([jobOf(1)]);
    const { runner } = runnerWith(ledger, { timeoutMs: 20 });
    runner.wake();
    await waitFor(() => failed.length === 1);
    expect(failed[0]!.failure.reason).toBe("timeout");
    await runner.stop();
  });

  it("模型选不出来时报 model_unavailable，不起会话", async () => {
    const { ledger, failed } = fakeLedger([jobOf(1)]);
    const unavailable = { ok: false, code: "no_vendor", preferredVendor: null, vendors: [], message: "没有能用的厂商" } as unknown as RouterModelResolution;
    const { runner, turns } = runnerWith(ledger, { resolveModel: async () => unavailable });
    runner.wake();
    await waitFor(() => failed.length === 1);
    expect(failed[0]!.failure).toEqual({ reason: "model_unavailable", detail: "没有能用的厂商" });
    expect(turns.runTurn).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("回复取不出合格档案时报 invalid_reply", async () => {
    const { ledger, failed, written } = fakeLedger([jobOf(1)]);
    const { runner, turns } = runnerWith(ledger);
    runner.wake();
    await waitFor(() => turns.calls.length === 1);
    turns.reply(0, "我写不出来");
    await waitFor(() => failed.length === 1);
    expect(failed[0]!.failure.reason).toBe("invalid_reply");
    expect(written).toEqual([]);
    await runner.stop();
  });

  it("首次建档（previous 为 null）读说明文件放进输入，增量刷新不读文件", async () => {
    const { ledger, written } = fakeLedger([jobOf(1), jobOf(2, catalog)]);
    const { runner, turns, readFiles } = runnerWith(ledger);
    runner.wake();
    await waitFor(() => turns.calls.length === 1);
    expect(readFiles).toHaveBeenCalledWith("/work/p1");
    expect(turns.calls[0]!.request.text).toContain('<file name="README.md">\n说明\n</file>');
    turns.reply(0, JSON.stringify(catalog));
    await waitFor(() => turns.calls.length === 2);
    expect(readFiles).toHaveBeenCalledTimes(1);
    expect(turns.calls[1]!.request.text).not.toContain("<files>");
    turns.reply(1, JSON.stringify(catalog));
    await waitFor(() => written.length === 2);
    await runner.stop();
  });

  it("stop 打断在写的并报 shutdown，之后 wake 不再领活", async () => {
    const { ledger, failed } = fakeLedger([jobOf(1), jobOf(2)]);
    const { runner, turns } = runnerWith(ledger);
    runner.wake();
    await waitFor(() => turns.calls.length === 1);
    const claims = ledger.claims;
    await runner.stop();
    expect(failed.map((f) => f.failure.reason)).toEqual(["shutdown"]);
    runner.wake();
    await flush();
    expect(ledger.claims).toBe(claims);
    expect(runner.stop()).toBe(runner.stop());
  });

  it("busy 在有活在写时为 true", async () => {
    const { ledger, written } = fakeLedger([jobOf(1)]);
    const { runner, turns } = runnerWith(ledger);
    expect(runner.busy()).toBe(false);
    runner.wake();
    await waitFor(() => turns.calls.length === 1);
    expect(runner.busy()).toBe(true);
    turns.reply(0, JSON.stringify(catalog));
    await waitFor(() => written.length === 1);
    await waitFor(() => !runner.busy());
    await runner.stop();
  });
});

describe("readColdStartFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hub-coldstart-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("按 README.md、AGENTS.md、CLAUDE.md 的顺序读存在的文件", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "claude");
    writeFileSync(join(dir, "README.md"), "readme");
    writeFileSync(join(dir, "OTHER.md"), "other");
    expect(await readColdStartFiles(dir)).toEqual([
      { name: "README.md", text: "readme" },
      { name: "CLAUDE.md", text: "claude" },
    ]);
  });

  it("每个文件最多 PROJECT_CATALOG_FILE_MAX_CHARS 个字", async () => {
    writeFileSync(join(dir, "README.md"), "说".repeat(PROJECT_CATALOG_FILE_MAX_CHARS + 500));
    const [file] = await readColdStartFiles(dir);
    expect([...file!.text]).toHaveLength(PROJECT_CATALOG_FILE_MAX_CHARS);
  });

  it("文件夹不存在、文件不可读、是文件夹、软链指到主文件夹外时跳过，不抛错", async () => {
    expect(await readColdStartFiles(join(dir, "missing"))).toEqual([]);
    const project = join(dir, "project");
    mkdirSync(project);
    mkdirSync(join(project, "README.md"));
    writeFileSync(join(dir, "secret.md"), "外面的");
    symlinkSync(join(dir, "secret.md"), join(project, "AGENTS.md"));
    writeFileSync(join(project, "inside.md"), "里面的");
    symlinkSync(join(project, "inside.md"), join(project, "CLAUDE.md"));
    expect(await readColdStartFiles(project)).toEqual([{ name: "CLAUDE.md", text: "里面的" }]);
  });
});
