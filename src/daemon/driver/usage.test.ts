import { describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE } from "../../shared/index.ts";
import { TurnUsage } from "./usage.ts";

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});
const assistant = (id: string, u: Record<string, number>, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id, usage: u },
});

describe("TurnUsage（实时 token 累计）", () => {
  it("每条 assistant 消息都更新累计：起点 + 各条消息的用量", () => {
    const t = new TurnUsage();
    const start = { input: 100, cacheRead: 1000, cacheWrite: 10, output: 50, context: 1110 };
    expect(t.observe(assistant("m1", usage(2, 500, 5, 8)), start)).toEqual({ input: 102, cacheRead: 1500, cacheWrite: 15, output: 58, context: 507 });
    // 第二次观察时传进来的 current 已经是实时值，起点仍是第一次的，不叠加
    const live = { input: 102, cacheRead: 1500, cacheWrite: 15, output: 58, context: 507 };
    expect(t.observe(assistant("m2", usage(3, 600, 0, 9)), live)).toEqual({ input: 105, cacheRead: 2100, cacheWrite: 15, output: 67, context: 603 });
  });

  it("同一个 message.id 分几个事件推：只取最后一次，不重复算", () => {
    const t = new TurnUsage();
    t.observe(assistant("m1", usage(2, 500, 5, 1)), EMPTY_TOKEN_USAGE);
    t.observe(assistant("m1", usage(2, 500, 5, 1)), EMPTY_TOKEN_USAGE);
    const live = t.observe(assistant("m1", usage(2, 500, 5, 12)), EMPTY_TOKEN_USAGE);
    expect(live).toEqual({ input: 2, cacheRead: 500, cacheWrite: 5, output: 12, context: 507 });
  });

  it("子 agent 的消息和没带 usage 的消息不更新", () => {
    const t = new TurnUsage();
    expect(t.observe(assistant("s1", usage(9, 99999, 9, 9), "toolu_1"), EMPTY_TOKEN_USAGE)).toBeNull();
    expect(t.observe({ type: "assistant", message: { id: "m1" } }, EMPTY_TOKEN_USAGE)).toBeNull();
  });

  it("轮结束：起点 + result.usage，实时数整个丢掉，不重复计；下一轮重新从库里的数算起", () => {
    const t = new TurnUsage();
    const start = { input: 100, cacheRead: 1000, cacheWrite: 10, output: 50, context: 0 };
    t.observe(assistant("m1", usage(2, 500, 5, 3)), start);
    const live = t.observe(assistant("m2", usage(3, 600, 0, 4)), { ...start, input: 102 });
    expect(live!.output).toBe(57);
    // result：input + 缓存和实时一致，output 是准的（流式快照偏小）
    const done = t.finish(live!, usage(5, 1100, 5, 420));
    expect(done).toEqual({ input: 105, cacheRead: 2100, cacheWrite: 15, output: 470, context: 603 });
    // 下一轮
    t.observe(assistant("m3", usage(1, 10, 0, 1)), done);
    expect(t.finish(done, usage(1, 10, 0, 7))).toEqual({ input: 106, cacheRead: 2110, cacheWrite: 15, output: 477, context: 11 });
  });

  it("一轮里没有 assistant 消息：直接在当前累计上加 result.usage", () => {
    const t = new TurnUsage();
    const cur = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 9 };
    expect(t.finish(cur, usage(1, 1, 1, 1))).toEqual({ input: 2, cacheRead: 3, cacheWrite: 4, output: 5, context: 9 });
  });

  it("进程中途退出（没有 result）：reset 之后下一轮从已推出去的实时数算起", () => {
    const t = new TurnUsage();
    const live = t.observe(assistant("m1", usage(2, 500, 5, 3)), EMPTY_TOKEN_USAGE)!;
    t.reset();
    expect(t.finish(live, usage(1, 1, 1, 1))).toEqual({ input: 3, cacheRead: 501, cacheWrite: 6, output: 4, context: live.context });
  });
});
