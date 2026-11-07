// 原话截取（handover-recent.ts，docs/background-handover-design.md 第 3 节）：切点之后的全带，切点之前从新往旧取到字数上限，
// 边界那条留后半截，跨代插一行说明；够数就不再往下取（游标停下）。
import { describe, expect, it } from "vitest";
import { OMITTED_MARK, generationMark, pickRecent, recentText } from "./handover-recent.ts";
import type { RecentMessage } from "./handover-recent.ts";

const m = (id: number, sender: "user" | "agent", text: string, generation = 1): RecentMessage => ({ id, sender, text, generation });

/** 从新到旧，记下被取了几条（看游标有没有停）。 */
function newestFirst(list: RecentMessage[]): { rows: Iterable<RecentMessage>; taken: () => number } {
  let taken = 0;
  const sorted = [...list].sort((a, b) => b.id - a.id);
  return {
    rows: (function* () {
      for (const row of sorted) {
        taken++;
        yield row;
      }
    })(),
    taken: () => taken,
  };
}

describe("pickRecent", () => {
  it("切点之前从新往旧取到上限为止，按时间正序返回；够数就不再往下取", () => {
    const list = [m(1, "user", "aaaa"), m(2, "agent", "bbbb"), m(3, "user", "cccc"), m(4, "agent", "dddd")];
    const { rows, taken } = newestFirst(list);
    const { picked, postCutChars } = pickRecent(rows, 4, 8);
    expect(picked.map((r) => r.text)).toEqual(["cccc", "dddd"]);
    expect(postCutChars).toBe(0);
    expect(taken()).toBe(2);
  });

  it("跨过边界的那一条只留后半截，前面标（前面略）", () => {
    const { rows } = newestFirst([m(1, "user", "一二三四五六"), m(2, "agent", "七八")]);
    const { picked } = pickRecent(rows, 2, 5);
    expect(picked.map((r) => r.text)).toEqual([`${OMITTED_MARK}四五六`, "七八"]);
  });

  it("切点之后的全带，不算在上限里（哪怕自己就超过上限），postCutChars 是它们的字数", () => {
    const { rows } = newestFirst([m(1, "user", "前面的"), m(2, "agent", "切点"), m(3, "user", "之后一"), m(4, "agent", "之后之后之后")]);
    const { picked, postCutChars } = pickRecent(rows, 2, 2);
    expect(picked.map((r) => r.text)).toEqual(["切点", "之后一", "之后之后之后"]);
    expect(postCutChars).toBe(9);
  });

  it("中文一个字算 1（String.length）", () => {
    const { rows } = newestFirst([m(1, "user", "你好"), m(2, "agent", "世界")]);
    expect(pickRecent(rows, 2, 4).picked).toHaveLength(2);
  });

  it("没有消息：空", () => {
    expect(pickRecent([], 0, 100)).toEqual({ picked: [], postCutChars: 0 });
  });
});

describe("recentText", () => {
  it("每条前面标“用户：”“你：”，空一行隔开", () => {
    expect(recentText([m(1, "user", "问"), m(2, "agent", "答")])).toBe("用户：问\n\n你：答");
  });

  it("跨代的地方插一行“（这之前是第 N 个会话）”，两代、三代都标", () => {
    const text = recentText([m(1, "user", "一代", 1), m(2, "agent", "二代", 2), m(3, "user", "还是二代", 2), m(4, "agent", "三代", 3)]);
    expect(text).toBe(`用户：一代\n\n${generationMark(1)}\n\n你：二代\n\n用户：还是二代\n\n${generationMark(2)}\n\n你：三代`);
  });

  it("没有：空字符串", () => {
    expect(recentText([])).toBe("");
  });
});
