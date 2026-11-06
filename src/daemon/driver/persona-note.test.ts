// claude：性格设定、模式改了不重启（driver.ts 的“两轮之间自动重启”），下一条写进去的前面加说明。
// personaNote 接真账本（persona-fixture.ts），说明的字是 prompt.ts 的 personaUpdateNote 拼的。codex、agy 的在各自的测试文件里。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELAUNCH_NOTE } from "../../shared/index.ts";
import type { FakeScript, FakeTurn } from "../../../test/fake-claude/fake-claude.ts";
import { makePersonaFixture, type PersonaFixture } from "./persona-fixture.ts";
import { makeHarness, realSleep, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
let f: PersonaFixture | undefined;
afterEach(async () => {
  await h?.cleanup();
  f?.cleanup();
  h = undefined;
  f = undefined;
});

const CAPS = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const SELF_NOTE = "【系统】你刚改的性格设定已生效。";
const FULL = "以下面这份为准";

function harness(script: FakeScript = {}, driver: { idleCloseMs?: number } = {}): { t: Harness; f: PersonaFixture } {
  f = makePersonaFixture();
  h = makeHarness({ script, driver: { personaNote: f.personaNote, ...driver } });
  h.launch.personaRevision = f.revision;
  return { t: h, f };
}

/** 发一条，等到第 n 个 turn.ended。 */
async function turn(t: Harness, id: number, text: string, n: number): Promise<void> {
  await t.driver.send(t.store.rows.keys().next().value!, user(id, text));
  await t.waitFor("turn.ended", undefined, n);
}

const release = (t: Harness, name: string) => writeFileSync(join(t.dir, name), "");
/** 一轮：说一句，卡在 name 文件上（模拟正在跑的工具），工具跑完取走中途写进来的，再说一句。 */
const toolTurn = (t: Harness, name: string): FakeTurn => ({
  steps: [{ text: "开始跑" }, { waitFile: join(t.dir, name) }, { tool: { name: "Bash", input: { command: "sleep 8" }, result: "ONE" } }, { text: "收到" }],
});

describe("claude：性格设定、模式改了不重启", () => {
  it("用户在资料页改：不重启，下一条前面带完整的新内容，只带一次", async () => {
    const { t, f } = harness();
    t.addSession();
    await turn(t, 1, "一", 1);
    f.userEdit({ text: "以后回复都用列表。" });
    await turn(t, 2, "二", 2);
    await turn(t, 3, "三", 3);
    expect(t.argvs()).toHaveLength(1);
    const blocks = t.stdinBlocks();
    expect(blocks[1]).toHaveLength(2);
    expect(blocks[1]![0]).toMatch(/^【系统】你的性格设定刚更新了，以下面这份为准：/);
    expect(blocks[1]![0]).toContain("以后回复都用列表。");
    expect(blocks[1]![1]).toBe("二");
    expect(blocks[2]).toEqual(["三"]);
  });

  it("连改两次（正文、模式）：只带最新的一份", async () => {
    const { t, f } = harness();
    t.addSession();
    await turn(t, 1, "一", 1);
    f.userEdit({ text: "第一版" });
    f.userEdit({ text: "第二版" });
    f.userEdit({ mode: "hands_on" });
    await turn(t, 2, "二", 2);
    const note = t.stdinBlocks()[1]![0]!;
    expect(note).toMatch(/^【系统】你的模式和性格设定刚更新了/);
    expect(note).toContain("第二版");
    expect(note).not.toContain("第一版");
    expect(note).toContain("# 怎么干活");
    expect(t.argvs()).toHaveLength(1);
  });

  it("改模型还是重启（--resume）；新进程按最新的拼提示词，同时改的性格设定不再带说明", async () => {
    const { t, f } = harness();
    const s = t.addSession();
    await turn(t, 1, "一", 1);
    f.userEdit({ text: "新习惯" });
    f.userModel("haiku");
    t.store.set(s.id, { model: "haiku" });
    await turn(t, 2, "二", 2);
    expect(t.argvs()).toHaveLength(2);
    expect(t.argvs()[1]).toContain("--resume");
    expect(t.stdinBlocks()[1]).toEqual([RELAUNCH_NOTE, "二"]);
  });

  it("闲置关闭后再起来：按最新的拼提示词（重新 prepareLaunch），不带说明", async () => {
    const { t, f } = harness({}, { idleCloseMs: 50 });
    const s = t.addSession();
    await turn(t, 1, "一", 1);
    await t.waitFor("session.exited");
    const calls = t.prepareCalls.get(s.id)!;
    f.userEdit({ text: "新习惯" });
    await turn(t, 2, "二", 2);
    expect(t.prepareCalls.get(s.id)).toBeGreaterThan(calls);
    expect(t.argvs()).toHaveLength(2);
    expect(t.stdinBlocks()[1]).toEqual(["二"]);
  });

  it("撤销也算一次修改：不重启，带撤销后的内容；改了又撤销回去（agent 没看到过中间那版）不带", async () => {
    const { t, f } = harness();
    t.addSession();
    await turn(t, 1, "一", 1);
    f.userEdit({ text: "新习惯" });
    f.revert();
    await turn(t, 2, "二", 2);
    expect(t.stdinBlocks()[1]).toEqual(["二"]);
    f.userEdit({ text: "新习惯" });
    await turn(t, 3, "三", 3);
    expect(t.stdinBlocks()[2]![0]).toContain("新习惯");
    f.revert();
    await turn(t, 4, "四", 4);
    expect(t.stdinBlocks()[3]![0]).toMatch(new RegExp(FULL));
    expect(t.stdinBlocks()[3]![0]).toContain("小林的习惯");
    expect(t.argvs()).toHaveLength(1);
  });

  it("项目经理自己 hub persona edit 改的：只带一句已生效；之后用户再改，带完整内容", async () => {
    const { t, f } = harness();
    t.addSession();
    await turn(t, 1, "一", 1);
    f.selfEdit("我自己记的");
    await turn(t, 2, "二", 2);
    expect(t.stdinBlocks()[1]).toEqual([SELF_NOTE, "二"]);
    f.selfEdit("我自己又记的");
    f.userEdit({ text: "用户改的" });
    await turn(t, 3, "三", 3);
    expect(t.stdinBlocks()[2]![0]).toMatch(new RegExp(FULL));
    expect(t.stdinBlocks()[2]![0]).toContain("用户改的");
    expect(t.argvs()).toHaveLength(1);
  });

  it("命令那一行不带（/compact 会丢掉前面的块），留给下一条", async () => {
    const { t, f } = harness();
    t.addSession();
    await turn(t, 1, "一", 1);
    f.userEdit({ text: "新习惯" });
    await turn(t, 2, "/compact", 2);
    await turn(t, 3, "三", 3);
    expect(t.stdinBlocks()[1]).toEqual(["/compact"]);
    expect(t.stdinBlocks()[2]![0]).toContain("新习惯");
  });

  it("一轮中途写进去的那条带上；停止时它没被取走（agent 没看到），下一条再带", async () => {
    const { t, f } = harness();
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t, "go1"), toolTurn(t, "go2")], defaultTurn: { steps: [{ text: "好" }] } }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    f.userEdit({ text: "第一版" });
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(t.stdinBlocks()[1]![0]).toContain("第一版");
    release(t, "go1");
    await t.waitFor("turn.ended");
    expect(t.of("turn.ended")[0]!.messageIds).toEqual([1, 2]);
    // 第二轮：中途写的被停止取消，带着的说明退回去
    await t.driver.send(s.id, user(3, "再开始"));
    await t.waitFor("agent.text", undefined, 3);
    f.userEdit({ text: "第二版" });
    await expect(t.driver.send(s.id, user(4, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(t.stdinBlocks()[3]![0]).toContain("第二版");
    await t.driver.interrupt(s.id);
    await t.waitFor("message.cancelled");
    expect(t.of("message.cancelled").at(-1)!.messageIds).toEqual([4]);
    await t.waitFor("turn.ended", undefined, 2);
    await turn(t, 5, "五", 3);
    expect(t.stdinBlocks().at(-1)![0]).toContain("第二版");
    expect(t.stdinBlocks().at(-1)![1]).toBe("五");
    expect(t.argvs()).toHaveLength(1);
  });

  it("忙着时排队的（老 claude 不能中途写）：写进去时比，带上", async () => {
    const { t, f } = harness({ turns: [{ steps: [{ sleepMs: 300 }, { text: "一" }] }] });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    f.userEdit({ text: "新习惯" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()[1]![0]).toContain("新习惯");
    expect(t.argvs()).toHaveLength(1);
  });

  it("claude 自己开的一轮之后的第一条带上", async () => {
    const { t, f } = harness({ turns: [{ steps: [{ text: "在等后台" }], selfTurn: { steps: [{ text: "后台好了" }], afterMs: 100 } }] });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    f.userEdit({ text: "新习惯" });
    await t.waitFor("turn.ended", undefined, 2);
    await realSleep(50);
    await turn(t, 2, "二", 3);
    expect(t.stdinBlocks()[1]![0]).toContain("新习惯");
    expect(t.stdinBlocks()[1]![1]).toBe("二");
    void s;
  });

  it("personaNote 抛错：照常写、不带说明，记 internal_error", async () => {
    f = makePersonaFixture();
    h = makeHarness({
      driver: {
        personaNote: () => {
          throw new Error("坏了");
        },
      },
    });
    h.launch.personaRevision = () => 0;
    const t = h;
    t.addSession();
    await turn(t, 1, "一", 1);
    await turn(t, 2, "二", 2);
    expect(t.stdinBlocks()).toEqual([["一"], ["二"]]);
    expect(t.of("driver.error").map((e) => e.code)).toContain("internal_error");
  });
});
