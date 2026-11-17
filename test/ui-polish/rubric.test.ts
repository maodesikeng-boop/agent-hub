import { describe, expect, it } from "vitest";
import { MAX_FINDINGS_PER_CARD } from "./limits.ts";
import {
  DIMENSIONS,
  PRINCIPLES,
  RULE_REF_PATTERN,
  SCORE_BANDS,
  SEVERITY_CAPS,
  dimensionOfRule,
  pageScore,
  parseScoreCard,
  scoreBands,
  scoreFromFindings,
  type Finding,
  type ScoreCard,
} from "./rubric.ts";

const SHA = "a".repeat(64);
const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

const makeFinding = (rule: string, severity: Finding["severity"]): Finding => ({
  rule,
  severity,
  box: BOX,
  what: "位置偏了",
  fix: "对齐基线",
});

const makeCard = (overrides: Partial<ScoreCard> = {}): ScoreCard => ({
  shot: "chat.normal@desktop",
  judge: "agy/gemini-4-carbon",
  run: 1,
  imageSha256: SHA,
  findings: [makeFinding("S1", "P3")],
  holistic: { style: 9, standard: 10, aesthetic: 10, ux: 10 },
  summary: "整体干净",
  ...overrides,
});

describe("PRINCIPLES", () => {
  it("id 不重复，四项里 style、aesthetic、ux 各自至少 6 条，每条都写了出处和怎么核对", () => {
    const ids = PRINCIPLES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const dim of ["style", "aesthetic", "ux"] as const) {
      expect(PRINCIPLES.filter((p) => p.dimension === dim).length).toBeGreaterThanOrEqual(6);
    }
    for (const p of PRINCIPLES) {
      expect(p.source.trim().length).toBeGreaterThan(0);
      expect(p.check.trim().length).toBeGreaterThan(0);
    }
  });

  it("每个 id 都合 RULE_REF_PATTERN", () => {
    for (const p of PRINCIPLES) {
      expect(RULE_REF_PATTERN.test(p.id), p.id).toBe(true);
    }
  });
});

describe("dimensionOfRule", () => {
  it("S、A、U 开头的分别算风格一致、美学、使用体验", () => {
    expect(dimensionOfRule("S1")).toBe("style");
    expect(dimensionOfRule("S6")).toBe("style");
    expect(dimensionOfRule("A1")).toBe("aesthetic");
    expect(dimensionOfRule("A8")).toBe("aesthetic");
    expect(dimensionOfRule("U1")).toBe("ux");
    expect(dimensionOfRule("U8")).toBe("ux");
  });

  it("ui-standard、frontend-rules、WCAG、HIG、machine 开头的算行业标准", () => {
    expect(dimensionOfRule("ui-standard §11")).toBe("standard");
    expect(dimensionOfRule("ui-standard §12.1")).toBe("standard");
    expect(dimensionOfRule("frontend-rules §2")).toBe("standard");
    expect(dimensionOfRule("WCAG 1.4.3")).toBe("standard");
    expect(dimensionOfRule("HIG touch-44")).toBe("standard");
    expect(dimensionOfRule("machine:clipped")).toBe("standard");
    expect(dimensionOfRule("machine:truncated-no-title")).toBe("standard");
  });

  it("不合 RULE_REF_PATTERN 的抛 RangeError", () => {
    expect(() => dimensionOfRule("")).toThrow(RangeError);
    expect(() => dimensionOfRule("S7")).toThrow(RangeError);
    expect(() => dimensionOfRule("A9")).toThrow(RangeError);
    expect(() => dimensionOfRule("random-rule")).toThrow(RangeError);
    expect(() => dimensionOfRule("frontend-rules §9")).toThrow(RangeError);
  });
});

describe("scoreFromFindings", () => {
  it("没有发现时四项都是 10", () => {
    expect(scoreFromFindings([])).toEqual({ style: 10, standard: 10, aesthetic: 10, ux: 10 });
  });

  it("一项里只有一两条 P3 是 9，三条 P3 是 8", () => {
    expect(scoreFromFindings([{ rule: "S1", severity: "P3" }]).style).toBe(9);
    expect(
      scoreFromFindings([
        { rule: "S1", severity: "P3" },
        { rule: "S2", severity: "P3" },
      ]).style,
    ).toBe(9);
    expect(
      scoreFromFindings([
        { rule: "S1", severity: "P3" },
        { rule: "S2", severity: "P3" },
        { rule: "S3", severity: "P3" },
      ]).style,
    ).toBe(8);
  });

  it("一条 P2 是 8，两到三条是 7，四条是 6", () => {
    const p2s = (n: number) => Array.from({ length: n }, () => ({ rule: "A1", severity: "P2" as const }));
    expect(scoreFromFindings(p2s(1)).aesthetic).toBe(8);
    expect(scoreFromFindings(p2s(2)).aesthetic).toBe(7);
    expect(scoreFromFindings(p2s(3)).aesthetic).toBe(7);
    expect(scoreFromFindings(p2s(4)).aesthetic).toBe(6);
    expect(scoreFromFindings(p2s(5)).aesthetic).toBe(6);
  });

  it("一条 P1 是 6，两条是 5，三条是 4", () => {
    const p1s = (n: number) => Array.from({ length: n }, () => ({ rule: "U1", severity: "P1" as const }));
    expect(scoreFromFindings(p1s(1)).ux).toBe(6);
    expect(scoreFromFindings(p1s(2)).ux).toBe(5);
    expect(scoreFromFindings(p1s(3)).ux).toBe(4);
    expect(scoreFromFindings(p1s(4)).ux).toBe(4);
  });

  it("一条 P0 把四项都压到 4，两条压到 2，不管它引的是哪一项的规则", () => {
    expect(scoreFromFindings([{ rule: "ui-standard §11", severity: "P0" }])).toEqual({
      style: 4,
      standard: 4,
      aesthetic: 4,
      ux: 4,
    });
    expect(
      scoreFromFindings([
        { rule: "S1", severity: "P0" },
        { rule: "U3", severity: "P0" },
      ]),
    ).toEqual({
      style: 2,
      standard: 2,
      aesthetic: 2,
      ux: 2,
    });
  });

  it("一项里几种严重度都有时取最低的那一档", () => {
    expect(
      scoreFromFindings([
        { rule: "S1", severity: "P3" },
        { rule: "S2", severity: "P2" },
        { rule: "S3", severity: "P1" },
      ]).style,
    ).toBe(6);
    expect(
      scoreFromFindings([
        { rule: "A1", severity: "P2" },
        { rule: "A2", severity: "P3" },
        { rule: "A3", severity: "P3" },
        { rule: "A4", severity: "P3" },
      ]).aesthetic,
    ).toBe(8);
  });

  it("P1 到 P3 的发现只影响自己那一项", () => {
    const scores = scoreFromFindings([
      { rule: "S1", severity: "P1" },
      { rule: "A2", severity: "P2" },
      { rule: "U4", severity: "P3" },
    ]);
    expect(scores).toEqual({ style: 6, standard: 10, aesthetic: 8, ux: 9 });
    for (const dim of DIMENSIONS) expect(scores[dim]).toBeGreaterThanOrEqual(4);
  });

  it("发现的顺序不影响结果", () => {
    const list: Array<Pick<Finding, "rule" | "severity">> = [
      { rule: "WCAG 1.4.3", severity: "P2" },
      { rule: "U6", severity: "P2" },
      { rule: "A5", severity: "P3" },
      { rule: "ui-standard §8", severity: "P3" },
    ];
    expect(scoreFromFindings(list)).toEqual(scoreFromFindings([...list].reverse()));
  });

  const bandCases: ReadonlyArray<{ score: number; findings: Array<Pick<Finding, "rule" | "severity">> }> = [
    { score: 10, findings: [] },
    { score: 9, findings: [{ rule: "S1", severity: "P3" }] },
    { score: 8, findings: [{ rule: "S1", severity: "P2" }] },
    {
      score: 7,
      findings: [
        { rule: "S1", severity: "P2" },
        { rule: "S2", severity: "P2" },
      ],
    },
    { score: 6, findings: [{ rule: "S1", severity: "P1" }] },
    {
      score: 5,
      findings: [
        { rule: "S1", severity: "P1" },
        { rule: "S2", severity: "P1" },
      ],
    },
    { score: 4, findings: [{ rule: "machine:clipped", severity: "P0" }] },
    {
      score: 2,
      findings: [
        { rule: "machine:clipped", severity: "P0" },
        { rule: "machine:overlap", severity: "P0" },
      ],
    },
  ];

  it.each(bandCases)("分档表 $score 分档按对应发现精确算出", ({ score, findings }) => {
    expect(SCORE_BANDS.some((b) => b.score === score)).toBe(true);
    expect(scoreFromFindings(findings).style).toBe(score);
  });

  it("分档表里每一档，算分照它算", () => {
    for (const sev of ["P1", "P2", "P3"] as const) {
      for (const { count, cap } of SEVERITY_CAPS[sev]) {
        expect(scoreFromFindings(Array.from({ length: count }, () => ({ rule: "S1", severity: sev }))).style).toBe(cap);
      }
    }
    for (const { count, cap } of SEVERITY_CAPS.P0) {
      expect(scoreFromFindings(Array.from({ length: count }, () => ({ rule: "machine:clipped", severity: "P0" as const })))).toEqual({ style: cap, standard: cap, aesthetic: cap, ux: cap });
    }
  });

  it("给评委看的分档文字由同一张分档表推出来，改表文字跟着变", () => {
    const band = (bands: ReturnType<typeof scoreBands>, score: number) => bands.find((b) => b.score === score)?.means ?? "";
    expect(SCORE_BANDS).toEqual(scoreBands(SEVERITY_CAPS));
    expect(band(SCORE_BANDS, 7)).toContain("2 到 3 条 P2");
    expect(band(SCORE_BANDS, 6)).toContain("4 条以上 P2");
    const changed = scoreBands({ ...SEVERITY_CAPS, P2: [{ count: 1, cap: 8 }, { count: 2, cap: 7 }, { count: 5, cap: 6 }] });
    expect(band(changed, 7)).toContain("2 到 4 条 P2");
    expect(band(changed, 6)).toContain("5 条以上 P2");
  });

  it("两张示例评分卡的 findings 算出同文件里的 computed", () => {
    const badPicker = scoreFromFindings([
      { rule: "machine:clipped", severity: "P0" },
      { rule: "ui-standard §13", severity: "P2" },
      { rule: "ui-standard §21", severity: "P2" },
      { rule: "A7", severity: "P3" },
    ]);
    expect({ ...badPicker, page: pageScore(badPicker) }).toEqual({
      style: 4,
      standard: 4,
      aesthetic: 4,
      ux: 4,
      page: 4,
    });

    const goodChat = scoreFromFindings([
      { rule: "WCAG 1.4.3", severity: "P2" },
      { rule: "U6", severity: "P2" },
      { rule: "A5", severity: "P3" },
      { rule: "ui-standard §8", severity: "P3" },
    ]);
    expect({ ...goodChat, page: pageScore(goodChat) }).toEqual({
      style: 10,
      standard: 8,
      aesthetic: 9,
      ux: 8,
      page: 8,
    });
  });
});

describe("pageScore", () => {
  it("取四项里最低的", () => {
    expect(pageScore({ style: 10, standard: 8, aesthetic: 9, ux: 7 })).toBe(7);
    expect(pageScore({ style: 9, standard: 9, aesthetic: 9, ux: 9 })).toBe(9);
  });
});

describe("parseScoreCard", () => {
  it("合格的卡原样读出来", () => {
    const card = makeCard();
    const res = parseScoreCard(JSON.stringify(card));
    expect(res).toEqual({ ok: true, card });
  });

  it("rule 写了不能引用的东西时 ok 是 false，原因里点出是第几条发现", () => {
    const bad = makeCard({
      findings: [makeFinding("S1", "P3"), makeFinding("made-up-rule", "P2")],
    });
    const res = parseScoreCard(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/第\s*2\s*条|findings\[1\]/);
      expect(res.reason).toContain("rule");
    }
  });

  it("发现超过 MAX_FINDINGS_PER_CARD 条时 ok 是 false", () => {
    const tooMany = makeCard({
      findings: Array.from({ length: MAX_FINDINGS_PER_CARD + 1 }, () => makeFinding("S1", "P3")),
    });
    const res = parseScoreCard(JSON.stringify(tooMany));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain(String(MAX_FINDINGS_PER_CARD));
    }
  });

  it("不是 JSON 时 ok 是 false，不抛错", () => {
    const res = parseScoreCard("{bad json");
    expect(res.ok).toBe(false);
  });
});
