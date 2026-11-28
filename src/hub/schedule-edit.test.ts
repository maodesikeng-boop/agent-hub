import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../daemon/agent-api/server.ts";
import { createSessionTokens } from "../daemon/agent-api/tokens.ts";
import { createLedger } from "../daemon/ledger/index.ts";
import { HUB_USAGE_PROMPT, WORKER_HUB_USAGE_PROMPT } from "../daemon/prompt.ts";
import { buildRouterSystemPrompt } from "../daemon/router/prompt.ts";
import { openTestDb } from "../daemon/store/test-helpers.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, HUB_EXIT, HUB_HELP_ONLY_COMMANDS } from "../shared/hub.ts";
import { MAX_SCHEDULE_NAME_CHARS } from "../shared/limits.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { runHub } from "./cli.ts";
import { parseCommand } from "./parse.ts";
import { HUB_CLI_REGISTRY, renderHelpIndex, resolveHelpTarget } from "./registry.ts";
import { HUB_USAGE } from "./usage.ts";

async function invokeHub(argv: string[], stdinText = "", env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runHub({
    argv,
    env,
    cwd: "/work/demo",
    stdin: () => Readable.from(stdinText === "" ? [] : [stdinText]),
    stdout: { write: (chunk: string) => { stdout += chunk; } },
    stderr: { write: (chunk: string) => { stderr += chunk; } },
  });
  return { code, stdout, stderr };
}

describe("S1 & S6 (CLI): hub schedule edit argument parsing and diagnostics", () => {
  it("S1.cli: parses partial and combined edit flags with --stdin", () => {
    expect(parseCommand(["schedule", "edit", "7", "--name", "升级日报"], {}, "/work/demo")).toEqual({
      command: "schedule.edit",
      body: { scheduleId: 7, name: "升级日报" },
      textSource: null,
    });
    expect(parseCommand(["schedule", "edit", "7", "--daily", "18:30"], {}, "/work/demo")).toEqual({
      command: "schedule.edit",
      body: { scheduleId: 7, daily: "18:30" },
      textSource: null,
    });
    expect(parseCommand(["schedule", "edit", "7", "--every", "2h"], {}, "/work/demo")).toEqual({
      command: "schedule.edit",
      body: { scheduleId: 7, everyMinutes: 120 },
      textSource: null,
    });
    expect(
      parseCommand(["schedule", "edit", "7", "--name", "巡检v2", "--every", "30m", "--stdin"], {}, "/work/demo"),
    ).toEqual({
      command: "schedule.edit",
      body: { scheduleId: 7, name: "巡检v2", everyMinutes: 30 },
      textSource: { kind: "stdin" },
      textField: "prompt",
    });
  });

  it("S6.cli: rejects invalid schedule edit invocations with actionable errors and never says unknown subcommand", async () => {
    const missingId = await invokeHub(["schedule", "edit"]);
    expect(missingId.code).toBe(HUB_EXIT.usage);
    expect(missingId.stderr).not.toContain("不认识的子命令");

    const noFields = await invokeHub(["schedule", "edit", "7"]);
    expect(noFields.code).toBe(HUB_EXIT.usage);
    expect(noFields.stderr).not.toContain("不认识的子命令");
    expect(noFields.stderr).toContain("至少");

    const badId = await invokeHub(["schedule", "edit", "abc", "--name", "x"]);
    expect(badId.code).toBe(HUB_EXIT.usage);
    expect(badId.stderr).toContain("定时任务编号");

    const zeroId = await invokeHub(["schedule", "edit", "0", "--name", "x"]);
    expect(zeroId.code).toBe(HUB_EXIT.usage);
    expect(zeroId.stderr).toContain("定时任务编号");

    const blankStdin = await invokeHub(
      ["schedule", "edit", "7", "--stdin"],
      "  \n",
      { [ENV_HUB_TOKEN]: "test-token", [ENV_HUB_SOCK]: "tcp://127.0.0.1:1" },
    );
    expect(blankStdin.code).toBe(HUB_EXIT.usage);
    expect(blankStdin.stderr).toContain("标准输入读到的正文是空的");

    const bothCadences = await invokeHub(["schedule", "edit", "7", "--daily", "09:00", "--every", "30m"]);
    expect(bothCadences.code).toBe(HUB_EXIT.usage);
    expect(bothCadences.stderr).toContain("二选一");

    const textFlag = await invokeHub(["schedule", "edit", "7", "--text", "inline"]);
    expect(textFlag.code).toBe(HUB_EXIT.usage);
    expect(textFlag.stderr).toContain("不认 --text");

    const typoFlag = await invokeHub(["schedule", "edit", "7", "--nam", "x"]);
    expect(typoFlag.code).toBe(HUB_EXIT.usage);
    expect(typoFlag.stderr).toContain("--name");

    const badDaily = await invokeHub(["schedule", "edit", "7", "--daily", "9:00"]);
    expect(badDaily.code).toBe(HUB_EXIT.usage);
    expect(badDaily.stderr).toContain("HH:MM");

    const badEvery = await invokeHub(["schedule", "edit", "7", "--every", "10m"]);
    expect(badEvery.code).toBe(HUB_EXIT.usage);
    expect(badEvery.stderr).toContain("15 分钟");

    const extraPos = await invokeHub(["schedule", "edit", "7", "8", "--name", "x"]);
    expect(extraPos.code).toBe(HUB_EXIT.usage);
    expect(extraPos.stderr).not.toContain("不认识的子命令");
  });
});

describe("S6 & S4 (Agent API): POST /v1/schedule.edit validation and round-trip", () => {
  let root: string;
  let db: ReturnType<typeof openTestDb>;
  let app: ReturnType<typeof createAgentApi>;
  let tokenLin: string;
  let tokenZhou: string;
  let tokenRouter: string;
  let scheduleId: number;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-api-schedule-edit-")));
    mkdirSync(join(root, "pm-home"), { recursive: true });
    db = openTestDb();
    const now = new Date(2026, 10, 4, 8, 0).getTime();
    const ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(root, "pm-home"),
      dataHome: join(root, ".agent-hub"),
    });
    const lin = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
    const zhou = ledger.createPm({ name: "阿周", mode: "manage_only", persona: "" });
    scheduleId = ledger.hubCall(lin.sessionId, "schedule.add", { name: "日报", prompt: "v1", daily: "09:00" }).data.schedule.id;
    const routerSessionId = Number(
      db.run(
        "INSERT INTO agent_sessions (role, vendor_session_id, cwd, created_at, updated_at) VALUES ('assistant', 'vs-router', ?, ?, ?)",
        root,
        now,
        now,
      ).lastInsertRowid,
    );

    const tokens = createSessionTokens();
    tokenLin = tokens.issue(lin.sessionId);
    tokenZhou = tokens.issue(zhou.sessionId);
    tokenRouter = tokens.issue(routerSessionId);
    app = createAgentApi({ ledger, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const postEdit = (payload: object, token = tokenLin) =>
    app.inject({
      method: "POST",
      url: "/v1/schedule.edit",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("S6.api: updates in place with HTTP 200 and rejects empty patch, unknown keys, limit overflow, cross-PM, and Router edits", async () => {
    const okRes = await postEdit({ scheduleId, name: "新日报", everyMinutes: 45, prompt: "v2" });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toMatchObject({
      ok: true,
      data: { schedule: { id: scheduleId, name: "新日报", kind: "interval", everyMinutes: 45, prompt: "v2" } },
    });

    expect((await postEdit({ scheduleId })).statusCode).toBe(400);
    expect((await postEdit({ scheduleId, name: "x", extra: 1 })).statusCode).toBe(400);
    expect((await postEdit({ scheduleId, name: "a\nb" })).statusCode).toBe(400);
    expect((await postEdit({ scheduleId, name: "长".repeat(MAX_SCHEDULE_NAME_CHARS + 1) })).statusCode).toBe(400);
    expect((await postEdit({ scheduleId, name: "越权" }, tokenZhou)).statusCode).toBe(403);
    const routerRes = await postEdit({ scheduleId, name: "总助改" }, tokenRouter);
    expect(routerRes.statusCode).toBe(403);
    expect(routerRes.json()).toMatchObject({ ok: false, code: "forbidden" });
    expect((await postEdit({ scheduleId: 99_999, name: "无" })).statusCode).toBe(404);
  });
});

describe("S7: CLI help discovery, limits line, and zero prompt-cache impact", () => {
  it("S7.1: registers schedule.edit in HUB_CLI_REGISTRY, scoped help, --help, compact index, and HUB_USAGE with limits", async () => {
    expect(HUB_CLI_REGISTRY.some((entry) => entry.id === "schedule.edit")).toBe(true);
    expect(resolveHelpTarget(["help", "schedule", "edit"])?.kind).toBe("entries");
    expect(resolveHelpTarget(["schedule", "edit", "--help"])?.kind).toBe("entries");

    const index = renderHelpIndex();
    expect(Buffer.byteLength(index, "utf8")).toBeLessThan(4_096);
    expect(index).toContain("schedule edit");

    const groupHelp = await invokeHub(["help", "schedule"]);
    expect(groupHelp.code).toBe(HUB_EXIT.ok);
    expect(groupHelp.stdout).toContain(`${HUB_COMMAND} schedule edit <编号>`);

    const scopedHelp = await invokeHub(["schedule", "edit", "--help"]);
    expect(scopedHelp.code).toBe(HUB_EXIT.ok);
    expect(scopedHelp.stdout).toContain(`${HUB_COMMAND} schedule edit <编号>`);
    expect(scopedHelp.stdout).toContain("上限：定时任务名称 40 字；任务说明 100 KB");
    expect(scopedHelp.stdout).not.toContain(`${HUB_COMMAND} schedule remove`);

    expect(HUB_USAGE).toContain(`${HUB_COMMAND} schedule edit <编号>`);
  });

  it("S7.2 (regression): schedule.edit stays out of pinned system prompts across all roles", () => {
    expect(HUB_HELP_ONLY_COMMANDS["schedule.edit"]).toContain(`${HUB_COMMAND} schedule edit`);
    expect(HUB_USAGE_PROMPT).not.toContain(`${HUB_COMMAND} schedule edit`);
    expect(WORKER_HUB_USAGE_PROMPT).not.toContain(`${HUB_COMMAND} schedule edit`);
    expect(buildRouterSystemPrompt()).not.toContain(`${HUB_COMMAND} schedule edit`);
  });
});
