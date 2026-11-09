import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HUB_COMMANDS,
  HUB_MAX_BODY_BYTES,
  HUB_REQUEST_TIMEOUT_MS,
  HUB_TIMEOUT_CHECK_MS,
  LedgerRequestError,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  MAX_TASK_BYTES,
  MAX_SETUP_COMMAND_BYTES,
  MAX_WORKER_TITLE_CHARS,
  hubPath,
  type HubArgsMap,
  type HubCommand,
  type HubResponse,
  type SessionTokens,
  type WorkspaceProbe,
} from "../../shared/index.ts";
import { API_ERRORS } from "../../shared/errors.ts";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "../../shared/paths.ts";
import { createModelCatalogs } from "../driver/model-catalog.ts";
import { FakeHubLedger } from "./fake-ledger.ts";
import { createAgentApi, startAgentApi, type RunningAgentApi } from "./server.ts";
import { createSessionTokens } from "./tokens.ts";

/** 测试的 socket 放在 /tmp 下，路径短，远低于 macOS 的 103 字节上限。 */
function shortTempDir(): string {
  return mkdtempSync("/tmp/ah-");
}

const VALID_ARGS: { [C in HubCommand]: HubArgsMap[C] } = {
  status: {},
  "project.create": { folder: "/x", name: "foo", description: "一个项目" },
  "project.attach": { folder: "/y" },
  "project.detach": { folder: "/y" },
  "project.setup": { command: "pnpm install --frozen-lockfile --ignore-scripts" },
  "persona.show": {},
  "persona.edit": { text: "新的性格设定", mode: "hands_on", reason: "用户要求" },
  models: { vendor: "claude", refresh: true },
  "worker.start": { title: "修 X", task: "把 X 修好，测试要过", model: "claude-haiku-5-5", readonly: true, noWorktree: true },
  "worker.send": { workerId: 3, text: "再改一下" },
  "worker.end": { workerId: 3 },
  "worker.list": {},
  "worker.show": { workerId: 3 },
  "worker.log": { workerId: 3, last: 10 },
  "worker.search": { keywords: ["登录", "bug"], limit: 5 },
  ask: { text: "用 A 还是 B？" },
  "schedule.add": { name: "每日汇报", prompt: "汇报昨天的进展", daily: "09:00" },
  "schedule.list": {},
  "schedule.pause": { scheduleId: 3 },
  "schedule.resume": { scheduleId: 3 },
  "schedule.remove": { scheduleId: 3 },
};

describe("agent api over inject", () => {
  let ledger: FakeHubLedger;
  let tokens: SessionTokens;
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
    tokenA = tokens.issue(11);
    tokenB = tokens.issue(22);
    app = createAgentApi({ ledger, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (command: string, body: unknown, token: string | null = tokenA, extraHeaders: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/${command}`,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extraHeaders },
      payload: body as object,
    });

  describe("tokens", () => {
    it("rejects a request without Authorization with 401 and never calls the ledger", async () => {
      const res = await call("status", {}, null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ ok: false, code: "unauthorized", message: expect.any(String) });
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects a wrong token with 401", async () => {
      const res = await call("status", {}, "not-a-real-token");
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("unauthorized");
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects a revoked token with 401", async () => {
      tokens.revoke(11);
      const res = await call("status", {}, tokenA);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("unauthorized");
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects other auth schemes and an empty bearer", async () => {
      for (const authorization of [`Basic ${tokenA}`, "Bearer", "Bearer ", `Bearer ${tokenA} extra`, tokenA]) {
        const res = await app.inject({ method: "POST", url: hubPath("status"), headers: { authorization }, payload: {} });
        expect(res.statusCode, authorization).toBe(401);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("checks the token before the route and the body (unknown command, oversized body)", async () => {
      expect((await call("nope", {}, null)).statusCode).toBe(401);
      const huge = { text: "x".repeat(HUB_MAX_BODY_BYTES + 10) };
      expect((await call("persona.edit", huge, "bad")).statusCode).toBe(401);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("identity", () => {
    it("passes the session resolved from the token to the ledger", async () => {
      const resA = await call("status", {}, tokenA);
      const resB = await call("status", {}, tokenB);
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(ledger.calls.map((c) => c.sessionId)).toEqual([11, 22]);
    });

    it("does not accept a self-declared identity in the body", async () => {
      const res = await call("status", { sessionId: 22 }, tokenA);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid");
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("commands", () => {
    it.each(HUB_COMMANDS)("routes %s to ledger.hubCall with the body as args", async (command) => {
      const res = await call(command, VALID_ARGS[command]);
      expect(res.statusCode).toBe(200);
      const body = res.json() as HubResponse;
      expect(body).toEqual({ ok: true, text: expect.stringContaining(command), data: expect.anything() });
      expect(ledger.calls).toEqual([{ sessionId: 11, command, args: VALID_ARGS[command] }]);
    });

    it("accepts optional fields being absent", async () => {
      expect((await call("project.create", { folder: "/x" })).statusCode).toBe(200);
      expect((await call("persona.edit", { mode: "manage_only" })).statusCode).toBe(200);
      expect((await call("persona.edit", { text: "只改正文" })).statusCode).toBe(200);
      expect(ledger.calls).toHaveLength(3);
    });

    it("accepts a field exactly at its byte limit", async () => {
      const text = "a".repeat(MAX_PERSONA_BYTES);
      expect((await call("persona.edit", { text })).statusCode).toBe(200);
    });
  });

  describe("error mapping", () => {
    it.each([
      ["invalid", 400],
      ["not_found", 404],
      ["forbidden", 403],
      ["conflict", 409],
    ] as const)("maps LedgerRequestError(%s) to %i", async (code, status) => {
      ledger.failWith = new LedgerRequestError(code, `账本说：${code}`);
      const res = await call("project.attach", VALID_ARGS["project.attach"]);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ ok: false, code, message: `账本说：${code}` });
    });

    it("reports agent-api health: each 500 counts, one success clears", async () => {
      ledger.failWith = new Error("database is locked");
      for (let i = 0; i < 3; i++) expect((await call("status", {})).statusCode).toBe(500);
      ledger.failWith = null;
      expect((await call("status", {})).statusCode).toBe(200);
      expect(ledger.healthReports).toEqual([
        ["agent-api", "database is locked"],
        ["agent-api", "database is locked"],
        ["agent-api", "database is locked"],
        ["agent-api", null],
      ]);
    });

    it("400/401/403/404/409 neither count as failures nor clear the count", async () => {
      await call("status", {}, null); // 401
      await call("status", { x: 1 }); // 400
      for (const code of ["invalid", "forbidden", "not_found", "conflict"] as const) {
        ledger.failWith = new LedgerRequestError(code, code);
        await call("status", {});
      }
      await app.inject({ method: "POST", url: "/v1/%", payload: {} });
      expect(ledger.healthReports).toEqual([]);
    });

    it("a throwing reportHealth does not change the answer", async () => {
      ledger.healthFailWith = new Error("health store broken");
      ledger.failWith = new Error("database is locked");
      const failed = await call("status", {});
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ ok: false, code: "internal", message: API_ERRORS.internal.text });
      ledger.failWith = null;
      const ok = await call("status", {});
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);
      expect(ledger.healthReports).toHaveLength(2);
    });

    it("500s and a throwing reportHealth go to the log option (the daemon's log)", async () => {
      const lines: string[] = [];
      const logged = createAgentApi({ ledger, tokens, log: (line) => lines.push(line) });
      ledger.healthFailWith = new Error("health store broken");
      ledger.failWith = new Error("database is locked");
      const res = await logged.inject({
        method: "POST",
        url: "/v1/status",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {},
      });
      expect(res.statusCode).toBe(500);
      expect(lines).toEqual([expect.stringMatching(/status.*database is locked/), expect.stringContaining("health store broken")]);
      await logged.close();
    });

    it("maps any other ledger error to 500 internal: the answer is the table's sentence, never the exception text", async () => {
      ledger.failWith = new Error("SQLITE_BUSY: database is locked at /secret/path");
      const res = await call("status", {});
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ ok: false, code: "internal", message: API_ERRORS.internal.text });
      expect(res.body).not.toMatch(/SQLITE|locked|secret/);
      // 原文只进 reportHealth（和日志）
      expect(ledger.healthReports).toEqual([["agent-api", "SQLITE_BUSY: database is locked at /secret/path"]]);
    });

    it("git_failed（账本说 git 没跑成）：409，原因原样给项目经理，不记接口故障", async () => {
      ledger.failWith = new LedgerRequestError("git_failed", "git 没跑成：fatal: not a git repository");
      const res = await call("worker.start", VALID_ARGS["worker.start"]);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ ok: false, code: "git_failed", message: "git 没跑成：fatal: not a git repository" });
      expect(ledger.healthReports).toEqual([]);
    });
  });

  describe("hub worker start：调 hubCall 之前先异步探主文件夹的 git", () => {
    const ok = { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } as const;
    const withProbe = async (probe: (folder: string) => Promise<WorkspaceProbe>) => {
      await app.close();
      app = createAgentApi({ ledger, tokens, probeWorkspace: probe });
      await app.ready();
    };

    it("探的是账本给的主文件夹，结果作为 context 交给 hubCall", async () => {
      ledger.startFolder = "/code/foo";
      const probed: string[] = [];
      await withProbe(async (folder) => {
        probed.push(folder);
        return ok;
      });
      expect((await call("worker.start", { title: "修 X", task: "任务" })).statusCode).toBe(200);
      expect(probed).toEqual(["/code/foo"]);
      expect(ledger.contexts).toEqual([{ workspace: ok }]);
    });

    it("探失败也交给账本（由账本拒绝、记 hub_calls）", async () => {
      ledger.startFolder = "/code/foo";
      await withProbe(async () => ({ kind: "failed", error: "找不到 git 程序" }));
      await call("worker.start", { title: "修 X", task: "任务" });
      expect(ledger.contexts).toEqual([{ workspace: { kind: "failed", error: "找不到 git 程序" } }]);
    });

    it("带 noWorktree、没有项目（账本给 null）、别的命令：不探", async () => {
      ledger.startFolder = "/code/foo";
      let probes = 0;
      await withProbe(async () => {
        probes += 1;
        return ok;
      });
      await call("worker.start", { title: "修 X", task: "任务", noWorktree: true });
      await call("worker.list", {});
      ledger.startFolder = null;
      await call("worker.start", { title: "修 X", task: "任务" });
      expect(probes).toBe(0);
      expect(ledger.contexts).toEqual([{}, {}, {}]);
    });

    it("带 --vendor：先问守护进程这家在这台设备上能不能用（不能用的会先重问一次），结果连同设备名交给账本；不带不问", async () => {
      const asked: string[] = [];
      await app.close();
      app = createAgentApi({
        ledger,
        tokens,
        deviceName: () => "东京",
        vendorUsable: async (vendor) => {
          asked.push(vendor);
          return "signed_out";
        },
      });
      await app.ready();
      await call("worker.start", { title: "修 X", task: "任务", noWorktree: true, vendor: "codex" });
      await call("worker.start", { title: "修 X", task: "任务", noWorktree: true });
      expect(asked).toEqual(["codex"]);
      expect(ledger.contexts).toEqual([{ vendorStatus: { vendor: "codex", availability: "signed_out", device: "东京" } }, {}]);
    });

    it("带 --vendor、这家重问一直不回：预算内就带着“没登录”交给账本，不是请求超时；很快回 available 的照常派", async () => {
      const codexQuery = [() => Promise.resolve({ models: [], account: { account: null, requiresOpenaiAuth: true } }), () => new Promise<never>(() => {})];
      const hangingCatalogs = createModelCatalogs({
        sources: {
          codex: {
            parse: () => null,
            query: () => codexQuery.shift()?.() ?? Promise.resolve({ models: [], account: { account: { type: "chatgpt" } } }),
            availabilityOf: (raw) => ((raw as { account: { account: unknown } }).account.account === null ? "signed_out" : "available"),
          },
        },
        ensureUsableBudgetMs: 50,
        log: () => {},
      });
      await hangingCatalogs.list();
      await app.close();
      app = createAgentApi({ ledger, tokens, deviceName: () => "东京", vendorUsable: (vendor) => hangingCatalogs.ensureUsable(vendor), requestTimeoutMs: 2_000, timeoutCheckMs: 50 });
      await app.ready();
      const started = Date.now();
      const res = await call("worker.start", { title: "修 X", task: "任务", noWorktree: true, vendor: "codex" });
      expect(res.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(ledger.contexts).toEqual([{ vendorStatus: { vendor: "codex", availability: "signed_out", device: "东京" } }]);
      hangingCatalogs.close();

      const fast = createModelCatalogs({
        sources: {
          codex: {
            parse: () => null,
            query: async () => ({ models: [], account: { account: { type: "chatgpt" } } }),
            availabilityOf: () => "available",
          },
        },
        log: () => {},
      });
      await fast.list();
      await app.close();
      app = createAgentApi({ ledger, tokens, deviceName: () => "东京", vendorUsable: (vendor) => fast.ensureUsable(vendor) });
      await app.ready();
      await call("worker.start", { title: "修 Y", task: "任务", noWorktree: true, vendor: "codex" });
      expect(ledger.contexts[1]).toEqual({ vendorStatus: { vendor: "codex", availability: "available", device: "东京" } });
    });

    it("探的时候令牌作废了：401，不调账本", async () => {
      ledger.startFolder = "/code/foo";
      await withProbe(async () => {
        tokens.revoke(11);
        return ok;
      });
      const res = await call("worker.start", { title: "修 X", task: "任务" });
      expect(res.statusCode).toBe(401);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("hub worker show：调 hubCall 之前先异步查分支上的 PR", () => {
    const pr = { number: 97, state: "OPEN", url: "https://github.com/o/r/pull/97" };
    const withPr = async (probePr: (cwd: string, branch: string) => Promise<typeof pr | null>) => {
      await app.close();
      app = createAgentApi({ ledger, tokens, probePr });
      await app.ready();
    };

    it("查的是账本给的 worktree 和分支，结果作为 context.pr 交给 hubCall", async () => {
      ledger.prTarget = { cwd: "/wt/1/5", branch: "hub/5-x" };
      const probed: string[][] = [];
      await withPr(async (cwd, branch) => {
        probed.push([cwd, branch]);
        return pr;
      });
      expect((await call("worker.show", { workerId: 5 })).statusCode).toBe(200);
      expect(probed).toEqual([["/wt/1/5", "hub/5-x"]]);
      expect(ledger.contexts).toEqual([{ pr, transcript: null }]);
    });

    it("查不到、账本说不用查（别人的 Worker、没在 worktree 里）、别的命令：context 是空的，不查", async () => {
      let probes = 0;
      await withPr(async () => {
        probes += 1;
        return null;
      });
      ledger.prTarget = { cwd: "/wt/1/5", branch: "hub/5-x" };
      await call("worker.show", { workerId: 5 });
      ledger.prTarget = null;
      await call("worker.show", { workerId: 6 });
      await call("worker.log", { workerId: 5 });
      expect(probes).toBe(1);
      expect(ledger.contexts).toEqual([{ transcript: null }, { transcript: null }, {}]);
    });
  });

  describe("hub worker show：调 hubCall 之前找厂商那边的原始记录", () => {
    it("账本给的索引交给 findTranscript，结果作为 context.transcript；找不到是 null", async () => {
      const asked: unknown[] = [];
      await app.close();
      app = createAgentApi({
        ledger,
        tokens,
        findTranscript: (ref) => {
          asked.push(ref);
          return ref.vendorSessionId === "v-1" ? "/vendor/v-1.jsonl" : null;
        },
      });
      await app.ready();
      ledger.transcriptTarget = { vendor: "claude", vendorSessionId: "v-1", cwd: "/wt/1/5" };
      await call("worker.show", { workerId: 5 });
      ledger.transcriptTarget = { vendor: "claude", vendorSessionId: "v-2", cwd: "/wt/1/5" };
      await call("worker.show", { workerId: 5 });
      ledger.transcriptTarget = null;
      await call("worker.show", { workerId: 6 });
      expect(asked).toEqual([
        { vendor: "claude", vendorSessionId: "v-1", cwd: "/wt/1/5" },
        { vendor: "claude", vendorSessionId: "v-2", cwd: "/wt/1/5" },
      ]);
      expect(ledger.contexts).toEqual([{ transcript: "/vendor/v-1.jsonl" }, { transcript: null }, { transcript: null }]);
    });
  });

  describe("hub models：调 hubCall 之前先异步取模型目录", () => {
    it("把 refresh 和可选的 vendor 传给 models.list，拿到的目录作为 context.modelCatalogs 交给 hubCall", async () => {
      const listCalls: unknown[] = [];
      const fakeCatalogs = createModelCatalogs({ sources: {}, log: () => {} });
      const snapshot = await fakeCatalogs.list();
      await app.close();
      app = createAgentApi({
        ledger,
        tokens,
        models: {
          list: async (opts) => {
            listCalls.push(opts);
            return opts?.vendor ? snapshot.filter((c) => c.vendor === opts.vendor) : snapshot;
          },
        },
      });
      await app.ready();
      expect((await call("models", {})).statusCode).toBe(200);
      expect((await call("models", { vendor: "claude", refresh: true })).statusCode).toBe(200);
      expect(listCalls).toEqual([{ refresh: false }, { refresh: true, vendor: "claude" }]);
      expect(ledger.contexts[0]?.modelCatalogs).toHaveLength(3);
      expect(ledger.contexts[1]?.modelCatalogs?.map((c) => c.vendor)).toEqual(["claude"]);
    });
  });

  describe("request body", () => {
    const expectInvalid = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, code: "invalid", message: expect.any(String) });
      expect(ledger.calls).toHaveLength(0);
    };

    it("unknown command → invalid（含 11-03 拿掉的 pm.list、project.assign）", async () => {
      await expectInvalid(await call("project.archive", {}));
      await expectInvalid(await call("worker.create", {}));
      await expectInvalid(await call("pm.list", {}));
      await expectInvalid(await call("project.assign", { project: "foo", to: "阿周", handoff: "交接" }));
    });

    it("wrong method → invalid", async () => {
      await expectInvalid(await app.inject({ method: "GET", url: hubPath("status"), headers: { authorization: `Bearer ${tokenA}` } }));
    });

    it("参数错的话是中文，写出字段名，不带英文原文", async () => {
      const message = async (command: string, body: unknown) => {
        const res = await call(command, body);
        expect(res.statusCode).toBe(400);
        const answer = res.json() as { code: string; message: string };
        expect(answer.code).toBe("invalid");
        expect(answer.message).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{2,}/); // 没有英文句子（字段名、值除外）
        return answer.message;
      };
      expect(await message("worker.start", { task: "x" })).toBe("参数不对：缺 title");
      expect(await message("project.create", { name: "foo", folder: "/x", extra: 1 })).toBe("参数不对：多了 extra");
      expect(await message("project.create", { name: 123, folder: "/x" })).toBe("参数不对：name 必须是文字");
      expect(await message("worker.send", { workerId: "3", text: "x" })).toBe("参数不对：workerId 必须是整数");
      expect(await message("project.create", { name: "", folder: "/x" })).toBe("参数不对：name 不能是空的");
      expect(await message("worker.send", { workerId: 0, text: "x" })).toBe("参数不对：workerId 不能小于 1");
      expect(await message("persona.edit", { mode: "boss" })).toBe("参数不对：mode 只能是 manage_only、hands_on");
      expect(await message("persona.edit", {})).toBe("参数不对：缺 text 或 mode");
      expect(await message("status", [])).toBe("参数不对：请求体必须是对象（JSON）");
      expect(await message("project.create", { name: "n".repeat(MAX_NAME_CHARS + 1), folder: "/x" })).toBe(
        `参数不对：name 不能超过 ${MAX_NAME_CHARS} 个字`,
      );
    });

    it("JSON 坏了、内容类型不对、网址解不开：也是中文，不带英文原文", async () => {
      const bad = async (res: Awaited<ReturnType<typeof call>>) => {
        expect(res.statusCode).toBe(400);
        const message = (res.json() as { message: string }).message;
        expect(message).toMatch(/^参数不对：/);
        expect(message.replace(/JSON|application\/json/g, "")).not.toMatch(/[A-Za-z]{4,}/);
      };
      await bad(await call("status", "{not json", tokenA, { "content-type": "application/json" }));
      await bad(await call("status", "hello", tokenA, { "content-type": "text/plain" }));
      await bad(await app.inject({ method: "POST", url: "/v1/%", payload: {} }));
    });

    it("missing required parameters → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "foo" }));
      await expectInvalid(await call("project.attach", {}));
      await expectInvalid(await call("project.detach", {}));
      await expectInvalid(await call("persona.edit", {}));
      await expectInvalid(await call("persona.edit", { reason: "只有理由" }));
    });

    it("extra parameters → invalid (not silently dropped)", async () => {
      await expectInvalid(await call("project.create", { name: "foo", folder: "/x", extra: 1 }));
      await expectInvalid(await call("project.attach", { project: "foo", folder: "/x" }));
      await expectInvalid(await call("status", { verbose: true }));
    });

    it("wrong types are not coerced → invalid", async () => {
      await expectInvalid(await call("project.create", { name: 123, folder: "/x" }));
      await expectInvalid(await call("persona.edit", { mode: "boss" }));
      await expectInvalid(await call("status", []));
      await expectInvalid(await call("status", "null", tokenA, { "content-type": "application/json" }));
    });

    it("empty required strings → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "", folder: "/x" }));
      await expectInvalid(await call("project.create", { folder: "" }));
    });

    it("fields over their limits → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "n".repeat(MAX_NAME_CHARS + 1), folder: "/x" }));
      await expectInvalid(
        await call("project.create", { name: "foo", folder: "/x", description: "d".repeat(MAX_DESCRIPTION_CHARS + 1) }),
      );
      await expectInvalid(await call("project.attach", { folder: `/${"p".repeat(MAX_PATH_BYTES)}` }));
      await expectInvalid(await call("persona.edit", { mode: "hands_on", reason: "r".repeat(MAX_REASON_CHARS + 1) }));
    });

    it("byte limits count UTF-8 bytes, not characters", async () => {
      // 字符数没超、字节数超了
      const text = "性".repeat(Math.floor(MAX_PERSONA_BYTES / 3) + 1);
      expect(text.length).toBeLessThan(MAX_PERSONA_BYTES);
      await expectInvalid(await call("persona.edit", { text }));
      const folder = `/${"路".repeat(Math.floor(MAX_PATH_BYTES / 3) + 1)}`;
      await expectInvalid(await call("project.create", { folder }));
    });

    it("a whole body over HUB_MAX_BODY_BYTES → 400 invalid, not 413", async () => {
      // 字段本身都合法，只在后面补空白把整个请求体撑过上限：挡住它的只能是 bodyLimit，不是字段的长度上限。
      const payload = `${JSON.stringify({ mode: "hands_on" })}${" ".repeat(HUB_MAX_BODY_BYTES)}`;
      const res = await call("persona.edit", payload, tokenA, { "content-type": "application/json" });
      await expectInvalid(res);
      expect(res.json().message).toContain(`请求体不能超过 ${HUB_MAX_BODY_BYTES} 字节`);
      // 同样的请求体不补空白就能过
      expect((await call("persona.edit", { mode: "hands_on" })).statusCode).toBe(200);
    });

    it("path fields must be absolute and free of NUL", async () => {
      for (const folder of ["../../etc", "etc/passwd", "./x", "~/x", "/x\u0000y", "\u0000"]) {
        await expectInvalid(await call("project.create", { folder }));
        await expectInvalid(await call("project.attach", { folder }));
        await expectInvalid(await call("project.detach", { folder }));
      }
    });

    it("project names must be free of NUL and control characters", async () => {
      for (const bad of ["a\u0000b", "a\nb", "a\rb", "a\tb", "\u001b[31m红", "a\u007fb", "a\u0085b", "../../etc\u0000"]) {
        await expectInvalid(await call("project.create", { name: bad, folder: "/x" }));
      }
    });

    it("hub worker：缺参数、类型不对、编号不是正整数、标题带控制字符、正文超字节 → invalid", async () => {
      await expectInvalid(await call("worker.start", { title: "修 X" }));
      await expectInvalid(await call("worker.start", { task: "任务" }));
      await expectInvalid(await call("worker.start", { title: "修 X", task: "" }));
      await expectInvalid(await call("worker.start", { title: "a\nb", task: "任务" }));
      await expectInvalid(await call("worker.start", { title: "修 X", task: "任务", readonly: "yes" }));
      await expectInvalid(await call("worker.start", { title: "修 X", task: "任务", model: "" }));
      await expectInvalid(await call("worker.start", { title: "修 X", task: "任".repeat(Math.floor(MAX_TASK_BYTES / 3) + 1) }));
      await expectInvalid(await call("worker.start", { title: "修 X", task: "任务", worktree: false }));
      for (const workerId of ["3", 0, -1, 1.5, null]) {
        await expectInvalid(await call("worker.send", { workerId, text: "再改" }));
        await expectInvalid(await call("worker.end", { workerId }));
      }
      await expectInvalid(await call("worker.send", { workerId: 3, text: "" }));
      await expectInvalid(await call("worker.end", {}));
      await expectInvalid(await call("worker.list", { all: true }));
    });

    it("hub ask：正文缺、空、超字节、多余字段 → invalid；可选 options 数组转发给账本", async () => {
      await expectInvalid(await call("ask", {}));
      await expectInvalid(await call("ask", { text: "" }));
      await expectInvalid(await call("ask", { text: "问".repeat(Math.floor(MAX_TASK_BYTES / 3) + 1) }));
      await expectInvalid(await call("ask", { text: "问", workerId: 3 }));
      await expectInvalid(await call("ask", { text: "问", options: "not-array" }));
      await expectInvalid(await call("ask", { text: "问", options: [123] }));
      expect((await call("ask", { text: "选哪个？", options: ["方案 A", "方案 B"] })).statusCode).toBe(200);
      expect(ledger.calls.at(-1)).toEqual({
        sessionId: 11,
        command: "ask",
        args: { text: "选哪个？", options: ["方案 A", "方案 B"] },
      });
    });

    it("30 hub project setup：command 可以是多行字符串或 null（清除）；缺、类型不对、超字节 → invalid", async () => {
      await expectInvalid(await call("project.setup", {}));
      await expectInvalid(await call("project.setup", { command: 3 }));
      await expectInvalid(await call("project.setup", { command: "x", clear: true }));
      await expectInvalid(await call("project.setup", { command: "中".repeat(Math.floor(MAX_SETUP_COMMAND_BYTES / 3) + 1) }));
      expect((await call("project.setup", { command: "a\n\tb" })).statusCode).toBe(200);
      expect((await call("project.setup", { command: null })).statusCode).toBe(200);
      expect((await call("project.setup", { command: "a".repeat(MAX_SETUP_COMMAND_BYTES) })).statusCode).toBe(200);
      expect(ledger.calls).toHaveLength(3);
    });

    it("hub worker：标题太长不拒（账本截断），任务说明可以多行", async () => {
      const title = "长".repeat(MAX_WORKER_TITLE_CHARS + 10);
      expect((await call("worker.start", { title, task: "第一行\n\t第二行" })).statusCode).toBe(200);
      expect(ledger.calls.at(-1)).toEqual({ sessionId: 11, command: "worker.start", args: { title, task: "第一行\n\t第二行" } });
    });

    it("multi-line free text (persona text) may still contain newlines and tabs", async () => {
      expect((await call("persona.edit", { text: "第一行\n\t第二行\r\n" })).statusCode).toBe(200);
    });

    it("a malformed URL without a token → 400 invalid in HubResponse shape", async () => {
      for (const url of ["/v1/%", "/v1/%zz", "/%"]) {
        const res = await app.inject({ method: "POST", url, payload: {} });
        expect(res.statusCode, url).toBe(400);
        expect(res.json(), url).toEqual({ ok: false, code: "invalid", message: expect.any(String) });
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("malformed JSON and non-JSON content types → invalid", async () => {
      await expectInvalid(await call("status", "{not json", tokenA, { "content-type": "application/json" }));
      await expectInvalid(await call("status", "hello", tokenA, { "content-type": "text/plain" }));
      await expectInvalid(await call("status", '{"__proto__":{"x":1}}', tokenA, { "content-type": "application/json" }));
    });
  });
});

describe("startAgentApi on a unix socket", () => {
  let dir: string;
  let running: RunningAgentApi | null;
  let ledger: FakeHubLedger;
  let tokens: SessionTokens;

  beforeEach(() => {
    dir = shortTempDir();
    running = null;
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
  });

  afterEach(async () => {
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = () => ({ runDir: join(dir, "run"), hubSock: join(dir, "run", "hub.sock") });

  const post = (socketPath: string, command: HubCommand, body: unknown, token: string) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method: "POST",
          path: hubPath(command),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  it("creates run/ as 0700 and hub.sock as 0600, and returns the real path", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    expect(statSync(paths().runDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(running.socketPath).isSocket()).toBe(true);
    expect(statSync(running.socketPath).mode & 0o777).toBe(0o600);
    expect(running.socketPath).toBe(realpathSync(paths().hubSock));
    // macOS 上 /tmp 是 /private/tmp 的链接：返回的必须是解析过的
    if (process.platform === "darwin") expect(running.socketPath.startsWith("/private/")).toBe(true);
    const res = await post(running.socketPath, "status", {}, tokens.issue(5));
    expect(res).toEqual({ status: 200, body: { ok: true, text: expect.any(String), data: expect.anything() } });
    expect(ledger.calls).toEqual([{ sessionId: 5, command: "status", args: {} }]);
  });

  it("tightens an existing run/ that is too open", async () => {
    mkdirSync(paths().runDir, { mode: 0o755 });
    chmodSync(paths().runDir, 0o755);
    running = await startAgentApi({ ledger, tokens, ...paths() });
    expect(statSync(paths().runDir).mode & 0o777).toBe(0o700);
  });

  it("replaces a stale hub.sock left behind by a dead process", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    // 另一个进程 listen 之后不 close 直接退出：socket 文件留在盘上，没人监听
    const child = spawnSync(
      process.execPath,
      ["-e", `require("node:net").createServer().listen(${JSON.stringify(paths().hubSock)}, () => process.exit(0))`],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(lstatSync(paths().hubSock).isSocket()).toBe(true);

    running = await startAgentApi({ ledger, tokens, ...paths() });
    const res = await post(running.socketPath, "status", {}, tokens.issue(1));
    expect(res.status).toBe(200);
  });

  it("refuses to delete something at the socket path that is not a socket", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    writeFileSync(paths().hubSock, "not a socket");
    await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/不是 socket|not a socket/);
    expect(existsSync(paths().hubSock)).toBe(true);
  });

  it("rejects a socket path over the macOS limit before listening, with a clear message", async () => {
    const deep = join(dir, "d".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
    await expect(startAgentApi({ ledger, tokens, runDir: deep, hubSock: join(deep, "hub.sock") })).rejects.toThrow(
      /AGENT_HUB_HOME/,
    );
  });

  it("refuses to start when a live process is already listening on hub.sock, and leaves it alone", async () => {
    const first = await startAgentApi({ ledger, tokens, ...paths() });
    running = first;
    await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/已有守护进程在跑/);
    // 第一个实例的 socket 还在、还能用
    expect(lstatSync(first.socketPath).isSocket()).toBe(true);
    expect((await post(first.socketPath, "status", {}, tokens.issue(3))).status).toBe(200);
  });

  it("refuses to start when another kind of server is listening on hub.sock", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    const other = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => other.listen(paths().hubSock, resolve));
    try {
      await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/已有守护进程在跑/);
      expect(lstatSync(paths().hubSock).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("a token revoked while the request body is still arriving → 401, ledger never called", async () => {
    const app = createAgentApi({ ledger, tokens });
    const token = tokens.issue(7);
    let authed!: () => void;
    const passedAuth = new Promise<void>((resolve) => (authed = resolve));
    // 排在认人的钩子后面：走到这里说明令牌已经认过了
    app.addHook("onRequest", async () => authed());
    mkdirSync(paths().runDir, { mode: 0o700 });
    await app.listen({ path: paths().hubSock });
    running = { app, socketPath: paths().hubSock, close: () => app.close() };

    const payload = JSON.stringify({ folder: "/x" });
    const res = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath: paths().hubSock,
          method: "POST",
          path: hubPath("project.attach"),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (r) => {
          let data = "";
          r.setEncoding("utf8");
          r.on("data", (chunk: string) => (data += chunk));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.flushHeaders();
      req.write(payload.slice(0, 5));
      void passedAuth.then(() => {
        tokens.revoke(7);
        req.end(payload.slice(5));
      });
    });
    expect(await res).toEqual({ status: 401, body: { ok: false, code: "unauthorized", message: expect.any(String) } });
    expect(ledger.calls).toHaveLength(0);
  });

  it("defaults the request timeout and its check interval to limits.ts", () => {
    const app = createAgentApi({ ledger, tokens });
    expect(app.server.requestTimeout).toBe(HUB_REQUEST_TIMEOUT_MS);
    expect(app.server.headersTimeout).toBe(HUB_REQUEST_TIMEOUT_MS);
    expect((app.server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval).toBe(HUB_TIMEOUT_CHECK_MS);
    void app.close();
  });

  it("half-sent request: the server really drops the connection at requestTimeoutMs (headersTimeout must not exceed requestTimeout)", async () => {
    // Node 的 ConnectionsList::Expired：headersTimeout > requestTimeout 时两个对调，请求头收完后的上限就成了 headersTimeout（默认 60 秒）。
    // Fastify 只设 requestTimeout，所以 headersTimeout 要自己压到一样；检查间隔默认 30 秒，也要调小。
    // 这里用 2 秒和 100 毫秒，几秒内跑完；默认值（15 秒、1 秒）上一条测。
    running = await startAgentApi({ ledger, tokens, ...paths(), requestTimeoutMs: 2_000, timeoutCheckMs: 100 });
    const token = tokens.issue(9);
    const socket = createConnection(running.socketPath);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const t0 = Date.now();
    // 请求头发完、请求体只发一半
    socket.write(`POST ${hubPath("status")} HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`);
    // 不读的话收不到 end，也就等不到 close
    socket.resume();
    const closed = new Promise<"closed">((resolve) => socket.once("close", () => resolve("closed")));
    const guard = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 8_000).unref());
    const result = await Promise.race([closed, guard]);
    socket.destroy();
    expect(result).toBe("closed");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
    expect(ledger.calls).toHaveLength(0);
  });

  it("close() returns promptly while a half-sent request is hanging", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    const token = tokens.issue(8);
    const sockets: Socket[] = [];
    // 一个请求头写完、请求体只写了一半；一个连请求头都没写完
    for (const raw of [
      `POST ${hubPath("status")} HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`,
      `POST ${hubPath("status")} HTTP/1.1\r\nhost: x\r\n`,
    ]) {
      const socket = createConnection(running.socketPath);
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.on("connect", resolve));
      socket.write(raw);
      sockets.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const closed = running.close().then(() => "closed" as const);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000).unref());
    const result = await Promise.race([closed, timeout]);
    for (const socket of sockets) socket.destroy();
    expect(result).toBe("closed");
    expect(Date.now() - started).toBeLessThan(3_000);
    running = null;
    expect(ledger.calls).toHaveLength(0);
  });

  it("removes the socket on close", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    const socketPath = running.socketPath;
    await running.close();
    running = null;
    expect(existsSync(socketPath)).toBe(false);
  });
});
