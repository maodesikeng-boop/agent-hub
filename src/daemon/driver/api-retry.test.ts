// 驱动层认 system/api_retry（断网、服务过载时 claude 一直在重试）：出 api_retry 事件，脏事件跳过，
// 重试中停止、关机、重试用完以出错的 result 结束，都按平时的路径走。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
const gateDirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const dir of gateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(...args: Parameters<typeof makeHarness>): Harness {
  h = makeHarness(...args);
  return h;
}

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const rawRetry = (over: Record<string, unknown>) =>
  JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown", ...over });

describe("system/api_retry", () => {
  it("收到就出 api_retry 事件：第几次 / 共几次、下次重试的时间点、状态码、error；连续几条各出一个", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [
            { apiRetry: { attempt: 1, maxRetries: 10, retryDelayMs: 1_000, errorStatus: null, error: "unknown" } },
            { apiRetry: { attempt: 2, maxRetries: 10, retryDelayMs: 2_000, errorStatus: 529, error: "overloaded" } },
            { text: "好了" },
          ],
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    const retries = t.of("api_retry");
    expect(retries.map((e) => e.info)).toEqual([
      { attempt: 1, maxRetries: 10, retryAt: retries[0]!.at + 1_000, errorStatus: null, error: "unknown" },
      { attempt: 2, maxRetries: 10, retryAt: retries[1]!.at + 2_000, errorStatus: 529, error: "overloaded" },
    ]);
    // 先重试、后输出：事件顺序和 claude 发的一样
    expect(t.events.map((e) => e.event.type).filter((x) => x === "api_retry" || x === "agent.text")).toEqual(["api_retry", "api_retry", "agent.text"]);
    expect(t.of("driver.error")).toEqual([]);
  });

  it("脏的 api_retry（缺字段、类型不对）：不崩、不出事件、不报 driver.error，这一轮照常", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [
            { raw: JSON.stringify({ type: "system", subtype: "api_retry" }) },
            { raw: rawRetry({ attempt: "3" }) },
            { raw: rawRetry({ max_retries: null }) },
            { raw: rawRetry({ retry_delay_ms: "soon" }) },
            { raw: JSON.stringify({ type: "system", subtype: "api_retry", attempt: { a: 1 }, max_retries: [], retry_delay_ms: true }) },
            { text: "好了" },
          ],
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(t.of("api_retry")).toEqual([]);
    expect(t.of("driver.error")).toEqual([]);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["好了"]);
  });

  it("重试用完：result 是出错的，turn.ended ok=false、带 claude 给的原因；重试事件之前都出过", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [{ apiRetry: { attempt: 9, maxRetries: 9, errorStatus: null, error: "unknown" } }],
          result: { subtype: "success", isError: true, result: "API Error: Unable to connect to API (ConnectionRefused)" },
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({
      ok: false,
      interrupted: false,
      messageIds: [1],
      error: { subtype: "success", message: "API Error: Unable to connect to API (ConnectionRefused)" },
    });
    const types = t.events.map((e) => e.event.type);
    expect(types.indexOf("api_retry")).toBeLessThan(types.indexOf("turn.ended"));
  });

  it("重试中点停止：照常打断，这一轮以 interrupted 结束", async () => {
    const t = harness({ script: { turns: [{ steps: [{ apiRetry: { attempt: 2 } }, { sleepMs: 30_000 }, { text: "不会到这" }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("api_retry");
    await t.driver.interrupt(s.id);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ interrupted: true, messageIds: [1] });
    expect(t.of("session.exited")).toEqual([]);
  });

  it("重试中关机：发 SIGINT，这一轮以 turn.ended(shutdown) 结束，再 session.exited(shutdown)", async () => {
    const dir = makeGateDir();
    const gate = join(dir, "never");
    const t = harness({ dir, script: { defaultTurn: { steps: [{ apiRetry: { attempt: 1 } }, { waitFile: gate }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("api_retry");
    await t.driver.shutdown();
    expect(t.of("turn.ended")[0]).toMatchObject({ ok: false, interrupted: true, shutdown: true, messageIds: [1] });
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "shutdown" });
    expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
  });

  it("重试中进程被杀：session.exited(crash)，没有 result", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ apiRetry: { attempt: 1 } }, { sleepMs: 200 }, { exit: 137 }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("api_retry");
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "crash", exitCode: 137, hadResult: false, messageIds: [1] });
    expect(t.of("turn.ended")).toEqual([]);
  });

  it("放行后（重试成功）继续：api_retry 之后的文字照常出", async () => {
    const dir = makeGateDir();
    const gate = join(dir, "go");
    const t = harness({ dir, script: { defaultTurn: { steps: [{ apiRetry: { attempt: 1 } }, { waitFile: gate }, { text: "接上了" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("api_retry");
    writeFileSync(gate, "");
    await t.waitFor("turn.ended");
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["接上了"]);
  });
});

function makeGateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-retry-gate-"));
  gateDirs.push(dir);
  return dir;
}
