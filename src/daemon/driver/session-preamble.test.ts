// claude：换代后的新会话，开场说明拼在第一条真正写进去的消息前面（DriverOptions.sessionPreamble，session-preamble.ts）。
// sessionPreamble 接一个假账本：agent 开始处理（message.processing）之前一直给，之后返回 null（同 ledger/handover.ts）。codex、agy 的在各自的测试文件里。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeScript } from "../../../test/fake-claude/fake-claude.ts";
import { fakePreambleLedger, PREAMBLE } from "./preamble-fixture.ts";
import { makeHarness, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const system = (id: number, text: string) => ({ messageIds: [id], source: "system" as const, text });

/** 启动超时用默认的；要等它超时的（进程起不来）用 8 秒，同 process.test.ts（太短了并行跑会偶发 start_timeout）。 */
function harness(script: FakeScript = {}, startTimeoutMs?: number) {
  const ledger = fakePreambleLedger();
  h = makeHarness({ script, driver: { sessionPreamble: ledger.sessionPreamble, ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }) } });
  ledger.watch(h.driver);
  return { t: h, ledger };
}

describe("claude：换代后的开场说明", () => {
  it("第一条写进去的前面带一次（单独一个 text 块），之后不带；新会话不多跑一轮", async () => {
    const { t } = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "接着说"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, system(2, "【Worker #1 的汇报】做完了"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()).toEqual([[PREAMBLE, "接着说"], ["【Worker #1 的汇报】做完了"]]);
    expect(t.of("message.processing").map((e) => e.preamble ?? false)).toEqual([true, false]);
    expect(t.of("turn.ended")).toHaveLength(2);
  });

  it("写进去还没开始处理时又排了一条：只有第一条带", async () => {
    const { t } = harness({ turns: [{ steps: [{ sleepMs: 300 }, { text: "一" }] }] });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.driver.send(s.id, system(2, "汇报"));
    await t.waitFor("turn.ended", undefined, 2);
    const blocks = t.stdinBlocks();
    expect(blocks[0]).toEqual([PREAMBLE, "一"]);
    expect(blocks.slice(1).flat()).not.toContain(PREAMBLE);
  });

  it("命令那一行不带（/compact 会丢掉前面的块），留给下一条", async () => {
    const { t } = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "/compact"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()).toEqual([["/compact"], [PREAMBLE, "二"]]);
  });

  it("写进去了、进程没起来（agent 没读到）：重写时再带；读到了的那一行开始处理时带 preamble 标记", async () => {
    const { t } = harness({ noInit: true }, 8_000);
    h = t;
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "接着说"))).rejects.toThrow();
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({}));
    await t.driver.send(s.id, user(1, "接着说"));
    await t.waitFor("turn.ended");
    expect(t.stdinBlocks().at(-1)).toEqual([PREAMBLE, "接着说"]);
    expect(t.of("message.processing").at(-1)).toMatchObject({ messageIds: [1], preamble: true });
  });

  it("不是新会话（账本给 null）：什么也不加", async () => {
    h = makeHarness({ driver: { sessionPreamble: () => null } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "一"));
    await h.waitFor("turn.ended");
    expect(h.stdinBlocks()).toEqual([["一"]]);
  });
});
