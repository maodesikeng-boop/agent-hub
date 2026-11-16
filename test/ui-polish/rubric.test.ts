import { describe, it } from "vitest";

describe("PRINCIPLES", () => {
  it.todo("id 不重复，四项里 style、aesthetic、ux 各自至少 6 条，每条都写了出处和怎么核对");
  it.todo("每个 id 都合 RULE_REF_PATTERN");
});

describe("dimensionOfRule", () => {
  it.todo("S、A、U 开头的分别算风格一致、美学、使用体验");
  it.todo("ui-standard、frontend-rules、WCAG、HIG、machine 开头的算行业标准");
  it.todo("不合 RULE_REF_PATTERN 的抛 RangeError");
});

describe("scoreFromFindings", () => {
  it.todo("没有发现时四项都是 10");
  it.todo("一项里只有一两条 P3 是 9，三条 P3 是 8");
  it.todo("一条 P2 是 8，两到三条是 7，四条是 6");
  it.todo("一条 P1 是 6，两条是 5，三条是 4");
  it.todo("一条 P0 把四项都压到 4，两条压到 2，不管它引的是哪一项的规则");
  it.todo("一项里几种严重度都有时取最低的那一档");
  it.todo("P1 到 P3 的发现只影响自己那一项");
  it.todo("发现的顺序不影响结果");
});

describe("pageScore", () => {
  it.todo("取四项里最低的");
});

describe("parseScoreCard", () => {
  it.todo("合格的卡原样读出来");
  it.todo("rule 写了不能引用的东西时 ok 是 false，原因里点出是第几条发现");
  it.todo("发现超过 MAX_FINDINGS_PER_CARD 条时 ok 是 false");
  it.todo("不是 JSON 时 ok 是 false，不抛错");
});
