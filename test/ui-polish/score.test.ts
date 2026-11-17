import { describe, expect, it } from "vitest";
import type { CaptureManifest, CapturedShot } from "./capture.ts";
import type { MachineFinding } from "./checks.ts";
import { CALIBRATION_RUNS, MAX_FIX_ROUNDS, PASS_SCORE, STALL_ROUNDS } from "./limits.ts";
import { MUTATIONS, type Mutation } from "./mutations.ts";
import type { Finding, ScoreCard } from "./rubric.ts";
import {
  calibrationReport,
  decideNext,
  mergeRound,
  pickBatchSize,
  regressions,
  sentinelDrift,
  type CalibrationReport,
  type RoundScores,
} from "./score.ts";

const SHA = "b".repeat(64);
const JUDGE_A = "agy/gemini-4-carbon";
const JUDGE_B = "claude/opus";

const makeShot = (key: string, machineFindings: MachineFinding[] = []): CapturedShot => ({
  key,
  screenId: key.split("@")[0]!,
  viewport: "desktop",
  file: `${key}.png`,
  sha256: SHA,
  machineFindings,
});

const makeManifest = (...shots: CapturedShot[]): CaptureManifest => ({
  commit: "1234567890abcdef1234567890abcdef12345678",
  browser: "chromium 159",
  shots,
});

const finding = (
  rule: string,
  severity: Finding["severity"],
  box: Finding["box"] = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
): Finding => ({
  rule,
  severity,
  box,
  what: `${rule} 问题`,
  fix: `修复 ${rule}`,
});

const card = (
  shot: string,
  judge: string,
  findings: Finding[] = [],
  overrides: Partial<ScoreCard> = {},
): ScoreCard => ({
  shot,
  judge,
  run: 1,
  imageSha256: SHA,
  findings,
  holistic: { style: 10, standard: 10, aesthetic: 10, ux: 10 },
  summary: "ok",
  ...overrides,
});

describe("mergeRound", () => {
  it("两家在同一处提的发现并成一条，by 里是两家", () => {
    const manifest = makeManifest(makeShot("chat.normal@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("chat.normal@desktop", JUDGE_A, [finding("A2", "P2", { x: 0.2, y: 0.2, w: 0.2, h: 0.2 })]),
        card("chat.normal@desktop", JUDGE_B, [finding("S3", "P2", { x: 0.22, y: 0.22, w: 0.2, h: 0.2 })]),
      ],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(1);
    expect([...res.findings[0]!.by].sort()).toEqual([JUDGE_A, JUDGE_B].sort());
    expect(res.findings[0]!.counted).toBe(true);
  });

  it("只有一家提的 P0 到 P2 计分，只有一家提的 P3 不计分", () => {
    const manifest = makeManifest(makeShot("a@desktop"), makeShot("b@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("a@desktop", JUDGE_A, [finding("S1", "P2")]),
        card("a@desktop", JUDGE_B, []),
        card("b@desktop", JUDGE_A, [
          finding("A1", "P3", { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }),
          finding("A2", "P3", { x: 0.3, y: 0.1, w: 0.1, h: 0.1 }),
          finding("A3", "P3", { x: 0.5, y: 0.1, w: 0.1, h: 0.1 }),
        ]),
        card("b@desktop", JUDGE_B, []),
      ],
      dismissals: [],
    });
    const shotA = res.shots.find((s) => s.shotKey === "a@desktop")!;
    const shotB = res.shots.find((s) => s.shotKey === "b@desktop")!;
    expect(shotA.dimensions.style).toBe(8);
    expect(shotB.dimensions.aesthetic).toBe(10);
    expect(res.findings.filter((f) => f.shotKey === "b@desktop").every((f) => !f.counted)).toBe(true);
  });

  it("机器检查的发现计进行业标准这一项", () => {
    const mf: MachineFinding = {
      rule: "machine:contrast",
      severity: "P1",
      box: { x: 0.05, y: 0.1, w: 0.15, h: 0.03 },
      what: "对比度不足",
      fix: "加深字色",
      evidence: "4.1:1",
    };
    const manifest = makeManifest(makeShot("chat.normal@desktop", [mf]));
    const res = mergeRound({
      manifest,
      cards: [card("chat.normal@desktop", JUDGE_A, []), card("chat.normal@desktop", JUDGE_B, [])],
      dismissals: [],
    });
    expect(res.shots[0]!.dimensions.standard).toBe(6);
    expect(res.findings[0]!.by).toContain("machine");
    expect(res.findings[0]!.counted).toBe(true);
  });

  it("被驳回的发现带上理由、不计分", () => {
    const box = { x: 0.8, y: 0.4, w: 0.1, h: 0.05 };
    const manifest = makeManifest(makeShot("chat.normal@desktop"));
    const res = mergeRound({
      manifest,
      cards: [card("chat.normal@desktop", JUDGE_A, [finding("WCAG 1.4.3", "P1", box)]), card("chat.normal@desktop", JUDGE_B, [])],
      dismissals: [{ shotKey: "chat.normal@desktop", rule: "WCAG 1.4.3", box, reason: "实测对比度 4.8:1 达标" }],
    });
    expect(res.findings[0]!.counted).toBe(false);
    expect(res.findings[0]!.dismissed).toBe("实测对比度 4.8:1 达标");
    expect(res.shots[0]!.page).toBe(10);
  });

  it("每项取两家里低的，页面分取四项里最低的", () => {
    const manifest = makeManifest(makeShot("chat.normal@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("chat.normal@desktop", JUDGE_A, [finding("S1", "P1")]),
        card("chat.normal@desktop", JUDGE_B, [
          finding("U1", "P1", { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }),
          finding("U2", "P1", { x: 0.7, y: 0.5, w: 0.1, h: 0.1 }),
        ]),
      ],
      dismissals: [],
    });
    expect(res.shots[0]!.dimensions).toEqual({ style: 6, standard: 10, aesthetic: 10, ux: 5 });
    expect(res.shots[0]!.page).toBe(5);
  });

  it("低于 PASS_SCORE 的图进 below", () => {
    const manifest = makeManifest(makeShot("pass@desktop"), makeShot("fail@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("pass@desktop", JUDGE_A, []),
        card("pass@desktop", JUDGE_B, []),
        card("fail@desktop", JUDGE_A, [finding("S1", "P2")]),
        card("fail@desktop", JUDGE_B, []),
      ],
      dismissals: [],
    });
    expect(PASS_SCORE).toBe(9);
    expect(res.below).toEqual(["fail@desktop"]);
  });

  it("评委整体印象分和算出来的分差 2 分以上的图进 disagreements", () => {
    const manifest = makeManifest(makeShot("agree@desktop"), makeShot("diff@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("agree@desktop", JUDGE_A, [], { holistic: { style: 9, standard: 10, aesthetic: 10, ux: 10 } }),
        card("agree@desktop", JUDGE_B, []),
        card("diff@desktop", JUDGE_A, [], { holistic: { style: 10, standard: 10, aesthetic: 7, ux: 10 } }),
        card("diff@desktop", JUDGE_B, []),
      ],
      dismissals: [],
    });
    expect(res.disagreements).toEqual(["diff@desktop"]);
  });

  it("缺卡或 sha256 对不上时抛 Error，列出是哪张图哪家评委", () => {
    const manifest = makeManifest(makeShot("a@desktop"), makeShot("b@desktop"));
    expect(() =>
      mergeRound({
        manifest,
        cards: [
          card("a@desktop", JUDGE_A, [], { imageSha256: "c".repeat(64) }),
          card("a@desktop", JUDGE_B, []),
          card("b@desktop", JUDGE_A, []),
        ],
        dismissals: [],
      }),
    ).toThrow(/a@desktop[\s\S]*agy\/gemini-4-carbon[\s\S]*b@desktop[\s\S]*claude\/opus/);
  });
});

describe("calibrationReport", () => {
  const mutClip: Mutation = MUTATIONS.find((m) => m.id === "clip-right")!;
  const mutMisalign: Mutation = MUTATIONS.find((m) => m.id === "misalign")!;
  const mutFont: Mutation = MUTATIONS.find((m) => m.id === "off-scale-font")!;
  const sampleMutations: readonly Mutation[] = [mutClip, mutMisalign, mutFont];

  const boxForMut: Record<string, Finding["box"]> = {
    "clip-right": { x: 0.81, y: 0.38, w: 0.18, h: 0.12 },
    misalign: { x: 0.01, y: 0.35, w: 0.19, h: 0.08 },
    "off-scale-font": { x: 0.02, y: 0.22, w: 0.16, h: 0.35 },
  };
  const ruleForMut: Record<string, string> = {
    "clip-right": "ui-standard §11",
    misalign: "A2",
    "off-scale-font": "S2",
  };

  const buildPassingFixture = () => {
    const base = "chat.normal@desktop";
    const reals = ["r1@desktop", "r2@desktop", "r3@desktop", "r4@desktop", "r5@desktop", "r6@desktop"];
    const shots = [
      makeShot(base),
      ...reals.map((k) => makeShot(k)),
      ...sampleMutations.map((m) => makeShot(`${base}!${m.id}`)),
    ];
    const cards: ScoreCard[] = [];
    for (const judge of [JUDGE_A, JUDGE_B]) {
      for (let run = 1; run <= CALIBRATION_RUNS; run++) {
        cards.push(card(base, judge, [], { run }));
        for (const r of reals) cards.push(card(r, judge, [finding("S1", "P2")], { run }));
        for (const m of sampleMutations) {
          cards.push(
            card(`${base}!${m.id}`, judge, [finding(ruleForMut[m.id]!, m.expectSeverity, boxForMut[m.id]!)], { run }),
          );
        }
      }
    }
    return { manifest: makeManifest(...shots), cards, baselineKey: base, mutations: sampleMutations };
  };

  it("四条门槛都过时 pass 是 true，failures 是空的", () => {
    const rep = calibrationReport(buildPassingFixture());
    expect(rep.pass).toBe(true);
    expect(rep.failures).toEqual([]);
    expect(rep.baselineSevere).toEqual([]);
    expect(rep.agreeShare).toBe(1);
    expect(rep.mutations.every((m) => m.ok)).toBe(true);
  });

  it("同一张图同一项三次评分差 2 分时这张图不算稳", () => {
    const fix = buildPassingFixture();
    const target = fix.cards.find((c) => c.shot === "r1@desktop" && c.judge === JUDGE_A && c.run === 3)!;
    target.findings = [finding("S1", "P1")];
    const rep = calibrationReport(fix);
    expect(rep.stableShare[JUDGE_A]!).toBeLessThan(1);
  });

  it("P0 的弄坏比基准图只低 2 分时这个弄坏不合格", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot === "chat.normal@desktop" && c.judge === JUDGE_A) {
        c.findings = [finding("S1", "P2"), finding("S2", "P2"), finding("S3", "P2"), finding("S4", "P2")];
      }
    }
    const rep = calibrationReport(fix);
    const entry = rep.mutations.find((m) => m.id === "clip-right" && m.judge === JUDGE_A)!;
    expect(entry.gap).toBe(2);
    expect(entry.ok).toBe(false);
    expect(rep.pass).toBe(false);
  });

  it("弄坏的位置三次里只被指出一次时不合格", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot === "chat.normal@desktop!misalign" && c.judge === JUDGE_A && c.run >= 2) {
        c.findings = [finding("A2", "P1", { x: 0.85, y: 0.85, w: 0.1, h: 0.1 })];
      }
    }
    const rep = calibrationReport(fix);
    const entry = rep.mutations.find((m) => m.id === "misalign" && m.judge === JUDGE_A)!;
    expect(entry.hits).toBe(1);
    expect(entry.ok).toBe(false);
    expect(rep.pass).toBe(false);
  });

  it("指出的位置对但记在别的项上不算指出", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot === "chat.normal@desktop!misalign" && c.judge === JUDGE_A) {
        c.findings = [finding("U1", "P1", boxForMut.misalign!)];
      }
    }
    const rep = calibrationReport(fix);
    const entry = rep.mutations.find((m) => m.id === "misalign" && m.judge === JUDGE_A)!;
    expect(entry.hits).toBe(0);
    expect(entry.ok).toBe(false);
  });

  it("基准图上有 P1 时列进 baselineSevere 并且 pass 是 false", () => {
    const fix = buildPassingFixture();
    const baseCard = fix.cards.find((c) => c.shot === "chat.normal@desktop" && c.judge === JUDGE_B && c.run === 1)!;
    baseCard.findings = [finding("S4", "P1")];
    const rep = calibrationReport(fix);
    expect(rep.baselineSevere.length).toBeGreaterThan(0);
    expect(rep.baselineSevere[0]!.severity).toBe("P1");
    expect(rep.pass).toBe(false);
  });

  it("两家页面分差不超过 1 的图不到八成时 pass 是 false", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot.startsWith("r") && c.judge === JUDGE_B) {
        c.findings = [finding("S1", "P1"), finding("S2", "P1")];
      }
    }
    const rep = calibrationReport(fix);
    expect(rep.agreeShare).toBeLessThan(0.8);
    expect(rep.pass).toBe(false);
  });
});

describe("pickBatchSize", () => {
  const fakeReport = (pass: boolean): CalibrationReport => ({
    pass,
    stableShare: {},
    mutations: [],
    baselineSevere: [],
    agreeShare: pass ? 1 : 0,
    failures: pass ? [] : ["未达标"],
  });

  it("14 和 28 两档都过时返回 28", () => {
    expect(
      pickBatchSize(
        new Map([
          [14, fakeReport(true)],
          [28, fakeReport(true)],
        ]),
      ),
    ).toBe(28);
  });

  it("只有 14 过时返回 14", () => {
    expect(
      pickBatchSize(
        new Map([
          [14, fakeReport(true)],
          [28, fakeReport(false)],
        ]),
      ),
    ).toBe(14);
  });

  it("都没过时返回 null", () => {
    expect(
      pickBatchSize(
        new Map([
          [14, fakeReport(false)],
          [28, fakeReport(false)],
        ]),
      ),
    ).toBeNull();
  });
});

describe("sentinelDrift", () => {
  const cal = [
    card("s1@desktop", JUDGE_A, [finding("S1", "P2")], { run: 1 }),
    card("s1@desktop", JUDGE_A, [finding("S1", "P2")], { run: 2 }),
    card("s1@desktop", JUDGE_A, [finding("S1", "P2")], { run: 3 }),
    card("s2@desktop", JUDGE_A, [], { run: 1 }),
    card("s2@desktop", JUDGE_A, [], { run: 2 }),
    card("s2@desktop", JUDGE_A, [], { run: 3 }),
  ];

  it("哨兵图的页面分和校准中位数差 2 分时返回它的 key", () => {
    const round = [
      card("s1@desktop", JUDGE_A, [finding("S1", "P1")]),
      card("s2@desktop", JUDGE_A, []),
    ];
    expect(sentinelDrift(cal, round, ["s1@desktop", "s2@desktop"])).toEqual(["s1@desktop"]);
  });

  it("差 1 分以内返回空数组", () => {
    const round = [
      card("s1@desktop", JUDGE_A, [finding("S1", "P3")]),
      card("s2@desktop", JUDGE_A, [finding("S1", "P3")]),
    ];
    expect(sentinelDrift(cal, round, ["s1@desktop", "s2@desktop"])).toEqual([]);
  });
});

describe("regressions", () => {
  const roundScores = (findings: RoundScores["findings"]): RoundScores => ({
    commit: "abc",
    judges: [JUDGE_A, JUDGE_B],
    shots: [{ shotKey: "a@desktop", byJudge: {}, dimensions: { style: 9, standard: 9, aesthetic: 9, ux: 9 }, page: 9 }],
    findings,
    below: [],
    disagreements: [],
  });

  it("出现上一轮没有的 P2 算变坏，带上新出现的发现", () => {
    const prev = roundScores([]);
    const addedFinding = {
      ...finding("S3", "P2", { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }),
      shotKey: "a@desktop",
      by: [JUDGE_A],
      counted: true,
    };
    const next = roundScores([addedFinding]);
    expect(regressions(prev, next)).toEqual([{ shotKey: "a@desktop", added: [addedFinding] }]);
  });

  it("只多了 P3 不算变坏", () => {
    const prev = roundScores([]);
    const next = roundScores([
      {
        ...finding("A8", "P3"),
        shotKey: "a@desktop",
        by: [JUDGE_A, JUDGE_B],
        counted: true,
      },
    ]);
    expect(regressions(prev, next)).toEqual([]);
  });

  it("上一轮就有的发现还在不算变坏", () => {
    const existing = {
      ...finding("S3", "P2", { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }),
      shotKey: "a@desktop",
      by: [JUDGE_A],
      counted: true,
    };
    const samePlace = {
      ...finding("S3", "P2", { x: 0.41, y: 0.41, w: 0.1, h: 0.1 }),
      shotKey: "a@desktop",
      by: [JUDGE_B],
      counted: true,
    };
    expect(regressions(roundScores([existing]), roundScores([samePlace]))).toEqual([]);
  });
});

describe("decideNext", () => {
  const makeScores = (commit: string, pages: Record<string, number>): RoundScores => {
    const shots = Object.entries(pages).map(([shotKey, page]) => ({
      shotKey,
      byJudge: {},
      dimensions: { style: page, standard: page, aesthetic: page, ux: page },
      page,
    }));
    return {
      commit,
      judges: [JUDGE_A, JUDGE_B],
      shots,
      findings: [],
      below: shots.filter((s) => s.page < PASS_SCORE).map((s) => s.shotKey),
      disagreements: [],
    };
  };

  it("有图低于 PASS_SCORE 时是 fix，带上这些图", () => {
    expect(decideNext([{ fixRound: 0, scores: makeScores("c1", { "a@desktop": 9, "b@desktop": 7 }) }])).toEqual({
      action: "fix",
      below: ["b@desktop"],
    });
  });

  it("第一次全部达标是 confirm", () => {
    expect(decideNext([{ fixRound: 1, scores: makeScores("c1", { "a@desktop": 9, "b@desktop": 10 }) }])).toEqual({
      action: "confirm",
    });
  });

  it("同一个提交连续两次全部达标是 done", () => {
    expect(
      decideNext([
        { fixRound: 1, scores: makeScores("c1", { "a@desktop": 9 }) },
        { fixRound: 1, scores: makeScores("c1", { "a@desktop": 9 }) },
      ]),
    ).toEqual({ action: "done" });
  });

  it("两次达标之间提交变了，重新从 confirm 算", () => {
    expect(
      decideNext([
        { fixRound: 1, scores: makeScores("c1", { "a@desktop": 9 }) },
        { fixRound: 2, scores: makeScores("c2", { "a@desktop": 9 }) },
      ]),
    ).toEqual({ action: "confirm" });
  });

  it("修满 MAX_FIX_ROUNDS 轮还有不达标的是 ask-user、max-rounds", () => {
    expect(
      decideNext([
        { fixRound: MAX_FIX_ROUNDS, scores: makeScores("c6", { "a@desktop": 8, "b@desktop": 9 }) },
      ]),
    ).toEqual({
      action: "ask-user",
      why: "max-rounds",
      below: ["a@desktop"],
    });
  });

  it("连续 STALL_ROUNDS 轮不达标图数没少、最低分没涨是 ask-user、stalled", () => {
    expect(STALL_ROUNDS).toBe(2);
    const stalled = Array.from({ length: STALL_ROUNDS + 1 }, (_, i) => ({
      fixRound: i,
      scores: makeScores(`c${i}`, { "a@desktop": 6, "b@desktop": 8 }),
    }));
    expect(decideNext(stalled)).toEqual({
      action: "ask-user",
      why: "stalled",
      below: ["a@desktop", "b@desktop"],
    });
  });
});
