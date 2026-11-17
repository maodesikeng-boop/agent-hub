import { describe, expect, it } from "vitest";
import type { CaptureManifest, CapturedShot } from "./capture.ts";
import type { MachineFinding } from "./checks.ts";
import { CALIBRATION_RUNS, MAX_FIX_ROUNDS, PASS_SCORE, STALL_ROUNDS } from "./limits.ts";
import { MUTATIONS, type Mutation } from "./mutations.ts";
import { pageScore, scoreFromFindings, type Finding, type ScoreCard } from "./rubric.ts";
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
        card("chat.normal@desktop", JUDGE_B, [finding("A5", "P2", { x: 0.22, y: 0.22, w: 0.2, h: 0.2 })]),
      ],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(1);
    expect([...res.findings[0]!.by].sort()).toEqual([JUDGE_A, JUDGE_B].sort());
    expect(res.findings[0]!.counted).toBe(true);
  });

  it("同一处并成一条时留下更重的那条的规则和严重度", () => {
    const box = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 };
    const res = mergeRound({
      manifest: makeManifest(makeShot("chat.normal@desktop")),
      cards: [card("chat.normal@desktop", JUDGE_A, [finding("A2", "P2", box)]), card("chat.normal@desktop", JUDGE_B, [finding("A5", "P1", box)])],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ rule: "A5", severity: "P1" });
    expect(res.shots[0]!.byJudge[JUDGE_A]!.aesthetic).toBe(6);
  });

  it("框重叠但记在不同项上的发现不并，合出来的分不高于每家各自算再取低", () => {
    const at = (x: number) => ({ x, y: 0.1, w: 0.1, h: 0.1 });
    const cardA = card("s@desktop", JUDGE_A, [finding("A3", "P2", at(0.1))]);
    const cardB = card("s@desktop", JUDGE_B, [finding("S3", "P2", at(0.1)), finding("S5", "P2", at(0.3)), finding("S1", "P2", at(0.5)), finding("S4", "P2", at(0.7))]);
    const res = mergeRound({ manifest: makeManifest(makeShot("s@desktop")), cards: [cardA, cardB], dismissals: [] });
    const separate = Math.min(pageScore(scoreFromFindings(cardA.findings)), pageScore(scoreFromFindings(cardB.findings)));
    expect(separate).toBe(6);
    expect(res.shots[0]!.page).toBe(separate);
    expect(res.shots[0]!.byJudge[JUDGE_B]!.style).toBe(6);
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

  it("机器量出同一条规则的多处只记一条，留下最重的，不把这一项压穿", () => {
    const contrast = (x: number, severity: Finding["severity"], evidence: string): MachineFinding => ({
      rule: "machine:contrast",
      severity,
      box: { x, y: 0.1, w: 0.05, h: 0.03 },
      what: "对比度不足",
      fix: "加深字色",
      evidence,
    });
    const machine = Array.from({ length: 14 }, (_, i) => contrast(i * 0.06, "P1", "4.1:1"));
    const manifest = makeManifest(makeShot("chat.normal@desktop", machine));
    const res = mergeRound({
      manifest,
      cards: [card("chat.normal@desktop", JUDGE_A, []), card("chat.normal@desktop", JUDGE_B, [])],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(1);
    expect(res.shots[0]!.dimensions.standard).toBe(6);
  });

  it("WCAG 1.4.3 和 machine:contrast、HIG touch-44 和 machine:touch-target 各算同一条规则", () => {
    const mf = (rule: string, x: number): MachineFinding => ({
      rule,
      severity: "P1",
      box: { x, y: 0.1, w: 0.05, h: 0.03 },
      what: rule,
      fix: rule,
      evidence: "量到的数",
    });
    const manifest = makeManifest(makeShot("chat.normal@mobile", [mf("machine:contrast", 0.1), mf("machine:touch-target", 0.5)]));
    const res = mergeRound({
      manifest,
      cards: [
        card("chat.normal@mobile", JUDGE_A, [finding("WCAG 1.4.3", "P1", { x: 0.7, y: 0.7, w: 0.1, h: 0.1 }), finding("WCAG 1.4.3", "P1", { x: 0.3, y: 0.8, w: 0.1, h: 0.1 })]),
        card("chat.normal@mobile", JUDGE_B, [finding("HIG touch-44", "P1", { x: 0.85, y: 0.85, w: 0.1, h: 0.1 })]),
      ],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(2);
    expect(res.shots[0]!.dimensions.standard).toBe(5);
  });

  it("一家评委自己写两条同规则的 P3 只算一家提的，不计分", () => {
    const manifest = makeManifest(makeShot("chat.normal@desktop"));
    const res = mergeRound({
      manifest,
      cards: [
        card("chat.normal@desktop", JUDGE_A, [finding("A4", "P3", { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), finding("A4", "P3", { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })]),
        card("chat.normal@desktop", JUDGE_B, []),
      ],
      dismissals: [],
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.by).toEqual([JUDGE_A]);
    expect(res.findings[0]!.counted).toBe(false);
    expect(res.shots[0]!.page).toBe(10);
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
  const BASE = "chat.normal@desktop";
  const mutClip: Mutation = MUTATIONS.find((m) => m.id === "clip-right")!;
  const mutMisalign: Mutation = MUTATIONS.find((m) => m.id === "misalign")!;
  const mutFont: Mutation = MUTATIONS.find((m) => m.id === "small-preview")!;
  const sampleMutations: readonly Mutation[] = [mutClip, mutMisalign, mutFont];

  const boxForMut: Record<string, Finding["box"]> = {
    "clip-right": { x: 0.81, y: 0.38, w: 0.18, h: 0.12 },
    misalign: { x: 0.01, y: 0.35, w: 0.19, h: 0.08 },
    "small-preview": { x: 0.02, y: 0.22, w: 0.16, h: 0.35 },
  };
  const ruleForMut: Record<string, string> = {
    "clip-right": "ui-standard §11",
    misalign: "A2",
    "small-preview": "S2",
  };
  const baselineFindings = (): Finding[] => [finding("A4", "P1", { x: 0.3, y: 0.3, w: 0.3, h: 0.3 })];

  const buildPassingFixture = () => {
    const reals = ["r1@desktop", "r2@desktop", "r3@desktop", "r4@desktop", "r5@desktop", "r6@desktop"];
    const shots = [makeShot(BASE), ...reals.map((k) => makeShot(k)), ...sampleMutations.map((m) => makeShot(`${BASE}!${m.id}`))];
    const cards: ScoreCard[] = [];
    for (const judge of [JUDGE_A, JUDGE_B]) {
      for (let run = 1; run <= CALIBRATION_RUNS; run++) {
        cards.push(card(BASE, judge, baselineFindings(), { run }));
        for (const r of reals) cards.push(card(r, judge, [finding("S1", "P2")], { run }));
        for (const m of sampleMutations) {
          cards.push(card(`${BASE}!${m.id}`, judge, [...baselineFindings(), finding(ruleForMut[m.id]!, m.expectSeverity, boxForMut[m.id]!)], { run }));
        }
      }
    }
    return { manifest: makeManifest(...shots), cards, baselineKey: BASE, mutations: sampleMutations };
  };
  const cardsOf = (fix: ReturnType<typeof buildPassingFixture>, shot: string, judge = JUDGE_A) =>
    fix.cards.filter((c) => c.shot === shot && c.judge === judge);
  const rowOf = (rep: CalibrationReport, id: string, judge = JUDGE_A) => rep.mutations.find((m) => m.id === id && m.judge === judge)!;

  it("门槛都过时 pass 是 true，failures 是空的", () => {
    const rep = calibrationReport(buildPassingFixture());
    expect(rep.failures).toEqual([]);
    expect(rep.pass).toBe(true);
    expect(rep.baselineSevere).toEqual([]);
    expect(rep.baselinePage).toEqual({ [JUDGE_A]: 6, [JUDGE_B]: 6 });
    expect(rep.agreeShare).toBe(1);
    expect(rep.mutations.every((m) => m.ok)).toBe(true);
  });

  it("页面分三次差 2 分时这张图不算稳", () => {
    const fix = buildPassingFixture();
    cardsOf(fix, "r1@desktop").find((c) => c.run === 3)!.findings = [finding("S1", "P1")];
    const rep = calibrationReport(fix);
    expect(rep.stableShare[JUDGE_A]!).toBeLessThan(1);
  });

  it("某一项三次差 2 分但页面分没变时这张图仍算稳", () => {
    const fix = buildPassingFixture();
    cardsOf(fix, "r1@desktop").find((c) => c.run === 3)!.findings = [finding("S1", "P2"), finding("U3", "P2")];
    const rep = calibrationReport(fix);
    expect(rep.stableShare[JUDGE_A]).toBe(1);
  });

  it("基准图这一项已有 P1 时，P0 弄坏把这一项压到 4 分就算拉开，页面分只差 2 也合格", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, BASE)) c.findings = [finding("WCAG 1.4.3", "P1", { x: 0.3, y: 0.3, w: 0.3, h: 0.3 })];
    for (const c of cardsOf(fix, `${BASE}!clip-right`)) c.findings.push(finding("WCAG 1.4.3", "P1", { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }));
    const row = rowOf(calibrationReport(fix), "clip-right");
    expect(row).toMatchObject({ dimension: "standard", baseScore: 6, mutatedScore: 4, cap: 4, ok: true });
  });

  it("基准图这一项高于封顶时，弄坏图这一项没压到封顶不合格", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, `${BASE}!clip-right`)) c.findings = [...baselineFindings(), finding("ui-standard §11", "P1", boxForMut["clip-right"]!)];
    const rep = calibrationReport(fix);
    expect(rowOf(rep, "clip-right")).toMatchObject({ baseScore: 10, mutatedScore: 6, cap: 4, ok: false });
    expect(rep.failures.some((f) => f.includes("clip-right") && f.includes("要压到 4 分以下"))).toBe(true);
    expect(rep.pass).toBe(false);
  });

  it("基准图这一项已压在封顶时，弄坏图同一项降一档就算拉开", () => {
    const fix = buildPassingFixture();
    const row = rowOf(calibrationReport(fix), "misalign");
    expect(row).toMatchObject({ dimension: "aesthetic", baseScore: 6, mutatedScore: 5, cap: 6, ok: true });
  });

  it("基准图这一项已压在封顶、弄坏图分没再降时，被指出就算合格，没被指出不合格", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot === BASE || c.shot === `${BASE}!small-preview`) c.findings.push(finding("S4", "P1", { x: 0.5, y: 0.9, w: 0.1, h: 0.05 }));
    }
    expect(rowOf(calibrationReport(fix), "small-preview")).toMatchObject({ baseScore: 6, mutatedScore: 6, cap: 8, hits: 3, ok: true });

    for (const c of cardsOf(fix, `${BASE}!small-preview`)) c.findings = c.findings.filter((f) => f.rule !== "S2");
    const rep = calibrationReport(fix);
    expect(rowOf(rep, "small-preview")).toMatchObject({ hits: 0, ok: false });
    expect(rep.failures.some((f) => f.includes("small-preview") && f.includes("要低于基准图"))).toBe(true);
  });

  it("别的项掉分不算拉开：只看弄坏注入的那一项", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, `${BASE}!misalign`)) c.findings = [...baselineFindings(), finding("S3", "P1", boxForMut.misalign!), finding("U1", "P1")];
    const row = rowOf(calibrationReport(fix), "misalign");
    expect(row).toMatchObject({ baseScore: 6, mutatedScore: 6, hits: 0, ok: false });
  });

  it("弄坏的位置三次里只被指出一次时不合格", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, `${BASE}!misalign`)) {
      if (c.run >= 2) c.findings = [...baselineFindings(), finding("A2", "P1", { x: 0.85, y: 0.85, w: 0.1, h: 0.1 })];
    }
    const row = rowOf(calibrationReport(fix), "misalign");
    expect(row.hits).toBe(1);
    expect(row.ok).toBe(false);
  });

  it("两个实心主按钮记成 A1 就算抓到", () => {
    const two = MUTATIONS.find((m) => m.id === "two-primaries")!;
    expect(two.expectDimension).toBe("aesthetic");
    const fix = buildPassingFixture();
    fix.mutations = [...sampleMutations, two];
    fix.manifest.shots.push(makeShot(`${BASE}!two-primaries`));
    for (const judge of [JUDGE_A, JUDGE_B]) {
      for (let run = 1; run <= CALIBRATION_RUNS; run++) {
        fix.cards.push(card(`${BASE}!two-primaries`, judge, [...baselineFindings(), finding("A1", "P1", { x: 0.82, y: 0.39, w: 0.15, h: 0.1 })], { run }));
      }
    }
    expect(rowOf(calibrationReport(fix), "two-primaries")).toMatchObject({ hits: 3, ok: true });
  });

  it("P0 弄坏不看算在哪一项：评委在目标框里引体验规则记 P0 也算抓到", () => {
    const covered = MUTATIONS.find((m) => m.id === "covered-message")!;
    expect(covered.expectSeverity).toBe("P0");
    const fix = buildPassingFixture();
    fix.mutations = [...sampleMutations, covered];
    fix.manifest.shots.push(makeShot(`${BASE}!covered-message`));
    for (const judge of [JUDGE_A, JUDGE_B]) {
      for (let run = 1; run <= CALIBRATION_RUNS; run++) {
        fix.cards.push(card(`${BASE}!covered-message`, judge, [...baselineFindings(), finding("U5", "P0", { x: 0.27, y: 0.78, w: 0.44, h: 0.1 })], { run }));
      }
    }
    expect(rowOf(calibrationReport(fix), "covered-message")).toMatchObject({ dimension: "standard", mutatedScore: 4, hits: 3, ok: true });
  });

  it("单张卡把同一条规则拆成两条时按一条算分，和正式轮口径一致", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, BASE, JUDGE_B)) {
      c.findings = [...baselineFindings(), finding("WCAG 1.4.3", "P1", { x: 0.02, y: 0.2, w: 0.2, h: 0.5 }), finding("WCAG 1.4.3", "P1", { x: 0.8, y: 0.4, w: 0.1, h: 0.05 })];
    }
    const rep = calibrationReport(fix);
    expect(rep.baselinePage[JUDGE_B]).toBe(6);
  });

  it("基准图上的 P1 不算重度发现，不挡校准", () => {
    const rep = calibrationReport(buildPassingFixture());
    expect(rep.baselineSevere).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it("基准图上有 P0 时列进 baselineSevere 并且 pass 是 false", () => {
    const fix = buildPassingFixture();
    cardsOf(fix, BASE, JUDGE_B).find((c) => c.run === 1)!.findings = [finding("machine:overlap", "P0")];
    const rep = calibrationReport(fix);
    expect(rep.baselineSevere).toHaveLength(1);
    expect(rep.baselineSevere[0]!.severity).toBe("P0");
    expect(rep.pass).toBe(false);
  });

  it("基准图评到 9 分以上时 pass 是 false：没立住审美高线", () => {
    const fix = buildPassingFixture();
    for (const c of cardsOf(fix, BASE)) c.findings = [finding("A4", "P3")];
    const rep = calibrationReport(fix);
    expect(rep.baselinePage[JUDGE_A]).toBe(9);
    expect(rep.failures.some((f) => f.includes("基准图页面分") && f.includes(JUDGE_A))).toBe(true);
    expect(rep.pass).toBe(false);
  });

  it("两家页面分差不超过 1 的图不到八成时 pass 是 false", () => {
    const fix = buildPassingFixture();
    for (const c of fix.cards) {
      if (c.shot.startsWith("r") && c.judge === JUDGE_B) c.findings = [finding("S1", "P1"), finding("S2", "P1")];
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
    baselinePage: {},
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
