// 合分和判断（docs/ui-polish-loop-design.md 第 3.4 到 3.6 节）：把两家评委的评分卡和机器检查合成每张图的分数，
// 算校准够不够格，判断这一轮之后是接着修、做确认评审还是停。
// 不变量：都是纯函数，同样的输入同样的输出；取低不取高（两家评委取低的、四项取最低的），任何一家都抬不了分。
import type { CaptureManifest } from "./capture.ts";
import {
  CALIBRATION_AGREE_SHARE,
  CALIBRATION_DETECT_SHARE,
  CALIBRATION_MAX_SPREAD,
  CALIBRATION_MIN_GAP_MINOR,
  CALIBRATION_MIN_GAP_SEVERE,
  CALIBRATION_MIN_HITS,
  CALIBRATION_STABLE_SHARE,
  FINDING_MATCH_IOU,
  MAX_FIX_ROUNDS,
  PASS_SCORE,
  PASS_STREAK,
  SENTINEL_MAX_DRIFT,
  STALL_ROUNDS,
} from "./limits.ts";
import type { Mutation } from "./mutations.ts";
import {
  DIMENSIONS,
  dimensionOfRule,
  pageScore,
  scoreFromFindings,
  type DimensionScores,
  type Finding,
  type ScoreCard,
  type Severity,
} from "./rubric.ts";

/** 合并后的一条发现。 */
export interface MergedFinding extends Finding {
  shotKey: string;
  /** 哪几家评委提了它；机器量出来的是 ["machine"]。 */
  by: readonly string[];
  /** 计不计分：P0 到 P2 任何一家提了就计，P3 要两家都提才计，机器量出来的都计，被驳回的不计。 */
  counted: boolean;
  /** 被驳回的理由（见 Dismissal）。 */
  dismissed?: string;
}

/** 归因的人驳回一条发现：必须带证据（量到的数，或标准里允许这样做的条款）。评委下一轮看得到，可以再提。 */
export interface Dismissal {
  shotKey: string;
  rule: string;
  box: Finding["box"];
  reason: string;
}

export interface ShotScore {
  shotKey: string;
  /** 每家评委各自算出来的四项。 */
  byJudge: Readonly<Record<string, DimensionScores>>;
  /** 四项各取两家里低的。 */
  dimensions: DimensionScores;
  /** 四项里最低的。 */
  page: number;
}

export interface RoundScores {
  commit: string;
  judges: readonly string[];
  shots: ShotScore[];
  findings: MergedFinding[];
  /** 低于 PASS_SCORE 的图。 */
  below: string[];
  /** 评委整体印象分和算出来的分差 2 分以上的图：标准可能没覆盖到评委看见的问题，归因时要看。 */
  disagreements: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const DEFAULT_MUTATION_BOXES: Readonly<Record<string, Finding["box"]>> = {
  "clip-right": { x: 0.8, y: 0.22, w: 0.2, h: 0.33 },
  "covered-message": { x: 0.26, y: 0.78, w: 0.46, h: 0.1 },
  "low-contrast": { x: 0.26, y: 0.09, w: 0.46, h: 0.76 },
  misalign: { x: 0.008, y: 0.35, w: 0.2, h: 0.08 },
  "gradient-shadow": { x: 0.675, y: 0.905, w: 0.045, h: 0.065 },
  cramped: { x: 0.76, y: 0, w: 0.24, h: 0.65 },
  "two-primaries": { x: 0.81, y: 0.38, w: 0.17, h: 0.11 },
  "small-preview": { x: 0.008, y: 0.18, w: 0.2, h: 0.52 },
  "dot-suffix": { x: 0.24, y: 0.015, w: 0.35, h: 0.045 },
  "radius-mix": { x: 0.26, y: 0.54, w: 0.46, h: 0.31 },
};

function intersectionArea(a: Finding["box"], b: Finding["box"]): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  return iw * ih;
}

function boxIou(a: Finding["box"], b: Finding["box"]): number {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function sameSpot(a: Pick<Finding, "rule" | "box">, b: Pick<Finding, "rule" | "box">): boolean {
  return a.rule === b.rule || boxIou(a.box, b.box) >= FINDING_MATCH_IOU;
}

function coversTarget(findingBox: Finding["box"], targetBox: Finding["box"]): boolean {
  if (boxIou(findingBox, targetBox) >= FINDING_MATCH_IOU) return true;
  const fArea = findingBox.w * findingBox.h;
  const tArea = targetBox.w * targetBox.h;
  if (fArea > 0.5 || fArea <= 0 || tArea <= 0) return false;
  const inter = intersectionArea(findingBox, targetBox);
  return inter / Math.min(fArea, tArea) >= 0.5;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface MutableFinding {
  shotKey: string;
  rule: string;
  severity: Severity;
  box: Finding["box"];
  what: string;
  fix: string;
  by: string[];
}

function mergeFindingsForShot(
  shotKey: string,
  sources: ReadonlyArray<{ by: string; findings: readonly Finding[] }>,
): MutableFinding[] {
  const merged: MutableFinding[] = [];
  for (const source of sources) {
    for (const f of source.findings) {
      let bestIndex = -1;
      let bestIou = -1;
      const dimension = dimensionOfRule(f.rule);
      for (let i = 0; i < merged.length; i++) {
        const candidate = merged[i]!;
        if (candidate.by.includes(source.by) || dimensionOfRule(candidate.rule) !== dimension) continue;
        const iou = boxIou(candidate.box, f.box);
        if (iou >= FINDING_MATCH_IOU && iou > bestIou) {
          bestIndex = i;
          bestIou = iou;
        } else if (bestIndex === -1 && candidate.rule === f.rule) {
          bestIndex = i;
        }
      }
      if (bestIndex === -1) {
        merged.push({
          shotKey,
          rule: f.rule,
          severity: f.severity,
          box: f.box,
          what: f.what,
          fix: f.fix,
          by: [source.by],
        });
      } else {
        const target = merged[bestIndex]!;
        target.by.push(source.by);
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[target.severity]) {
          target.severity = f.severity;
          target.rule = f.rule;
          target.box = f.box;
          target.what = f.what;
          target.fix = f.fix;
        }
      }
    }
  }
  return merged;
}

/**
 * 前置：cards 里每张图每家评委各有一张卡，卡的 imageSha256 和 manifest 对得上。
 * 后置：两家的发现按“同一张图、同一项、框的交并比不低于 FINDING_MATCH_IOU 或引了同一条规则”并成一条，留下更重的那条；
 * 机器检查的发现并进去；被 dismissals 命中的标上理由、不计分；分数按 rubric.scoreFromFindings 算。
 * 缺卡、sha256 对不上抛 Error 并列出是哪些图哪家评委。
 */
export function mergeRound(input: { manifest: CaptureManifest; cards: readonly ScoreCard[]; dismissals: readonly Dismissal[] }): RoundScores {
  const judges = [...new Set(input.cards.map((c) => c.judge))].sort();
  if (input.manifest.shots.length > 0 && judges.length === 0) {
    throw new Error(`没有任何评分卡，待评图：${input.manifest.shots.map((s) => s.key).join("、")}`);
  }

  const cardMap = new Map<string, ScoreCard>();
  const problems: string[] = [];
  for (const card of input.cards) {
    const key = `${card.shot}\0${card.judge}`;
    if (cardMap.has(key)) problems.push(`${card.shot}（${card.judge} 重复交卡）`);
    cardMap.set(key, card);
  }
  for (const shot of input.manifest.shots) {
    for (const judge of judges) {
      const card = cardMap.get(`${shot.key}\0${judge}`);
      if (card === undefined) {
        problems.push(`${shot.key}（缺 ${judge}）`);
      } else if (card.imageSha256 !== shot.sha256) {
        problems.push(`${shot.key}（${judge} 的 sha256 不一致）`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`评分卡不完整或 sha256 对不上：${problems.join("；")}`);
  }

  const allFindings: MergedFinding[] = [];
  const shots: ShotScore[] = [];
  const below: string[] = [];
  const disagreements: string[] = [];

  for (const shot of input.manifest.shots) {
    const sources: Array<{ by: string; findings: readonly Finding[] }> = [
      { by: "machine", findings: shot.machineFindings },
      ...judges.map((judge) => ({ by: judge, findings: cardMap.get(`${shot.key}\0${judge}`)!.findings })),
    ];
    const rawMerged = mergeFindingsForShot(shot.key, sources);
    const shotDismissals = input.dismissals.filter((d) => d.shotKey === shot.key);

    const shotFindings: MergedFinding[] = rawMerged.map((m) => {
      const hitDismissal = shotDismissals.find((d) => sameSpot(d, m));
      if (hitDismissal !== undefined) {
        return { ...m, counted: false, dismissed: hitDismissal.reason };
      }
      const isMachine = m.by.includes("machine");
      const humanCount = m.by.filter((b) => b !== "machine").length;
      const counted = isMachine || m.severity !== "P3" || humanCount >= 2;
      return { ...m, counted };
    });
    allFindings.push(...shotFindings);

    const countedFindings = shotFindings.filter((f) => f.counted);
    const byJudge: Record<string, DimensionScores> = {};
    let hasDisagreement = false;

    for (const judge of judges) {
      const judgeCounted = countedFindings.filter((f) => f.by.includes(judge) || f.by.includes("machine"));
      const computed = scoreFromFindings(judgeCounted);
      byJudge[judge] = computed;

      const card = cardMap.get(`${shot.key}\0${judge}`)!;
      const cardComputed = scoreFromFindings([...shot.machineFindings.filter((mf) => !shotDismissals.some((d) => sameSpot(d, mf))), ...card.findings]);
      for (const dim of DIMENSIONS) {
        if (Math.abs(cardComputed[dim] - card.holistic[dim]) >= 2) {
          hasDisagreement = true;
        }
      }
    }

    const dimensions: DimensionScores = {
      style: judges.length === 0 ? 10 : Math.min(...judges.map((j) => byJudge[j]!.style)),
      standard: judges.length === 0 ? 10 : Math.min(...judges.map((j) => byJudge[j]!.standard)),
      aesthetic: judges.length === 0 ? 10 : Math.min(...judges.map((j) => byJudge[j]!.aesthetic)),
      ux: judges.length === 0 ? 10 : Math.min(...judges.map((j) => byJudge[j]!.ux)),
    };
    const page = pageScore(dimensions);
    shots.push({ shotKey: shot.key, byJudge, dimensions, page });
    if (page < PASS_SCORE) below.push(shot.key);
    if (hasDisagreement) disagreements.push(shot.key);
  }

  return {
    commit: input.manifest.commit,
    judges,
    shots,
    findings: allFindings,
    below,
    disagreements,
  };
}

export interface CalibrationReport {
  /** 四条门槛都过才是 true。 */
  pass: boolean;
  /** 同一张图同一项多次评分的最大差不超过 CALIBRATION_MAX_SPREAD 的图占几成，分评委。 */
  stableShare: Readonly<Record<string, number>>;
  /** 每个弄坏：基准图的页面分减去弄坏图的页面分（各取多次的中位数），3 次里被指出几次，分评委。 */
  mutations: ReadonlyArray<{ id: string; judge: string; gap: number; hits: number; ok: boolean }>;
  /** 基准图上被提过的 P0、P1（应该没有）。 */
  baselineSevere: readonly MergedFinding[];
  /** 两家评委页面分差不超过 1 的图占几成。 */
  agreeShare: number;
  /** 没过的门槛，一条一句，给人看。 */
  failures: string[];
}

/**
 * 前置：cards 是校准那批图（基准图、几张真实界面、每个弄坏各一张）每家评委各评 CALIBRATION_RUNS 次的卡，都是同一档批大小下评的。
 * 后置：按 limits.ts 的校准门槛算出报告。“被指出”= 那次的卡里有一条发现的框盖住弄坏的位置，且记在预期的那一项、不轻于预期的严重度。
 */
export function calibrationReport(input: {
  manifest: CaptureManifest;
  cards: readonly ScoreCard[];
  baselineKey: string;
  mutations: readonly Mutation[];
}): CalibrationReport {
  const judges = [...new Set(input.cards.map((c) => c.judge))].sort();
  const shotKeys = input.manifest.shots.map((s) => s.key);
  const failures: string[] = [];

  if (judges.length === 0 || shotKeys.length === 0) {
    return {
      pass: false,
      stableShare: {},
      mutations: [],
      baselineSevere: [],
      agreeShare: 0,
      failures: ["缺少校准截图或评分卡"],
    };
  }

  const cardsOf = (shotKey: string, judge: string): ScoreCard[] =>
    input.cards.filter((c) => c.shot === shotKey && c.judge === judge).sort((a, b) => a.run - b.run);

  const stableShare: Record<string, number> = {};
  for (const judge of judges) {
    let stableCount = 0;
    for (const shotKey of shotKeys) {
      const runs = cardsOf(shotKey, judge);
      if (runs.length === 0) continue;
      const runScores = runs.map((c) => scoreFromFindings(c.findings));
      const isStable = DIMENSIONS.every((dim) => {
        const vals = runScores.map((s) => s[dim]);
        return Math.max(...vals) - Math.min(...vals) <= CALIBRATION_MAX_SPREAD;
      });
      if (isStable) stableCount++;
    }
    const share = stableCount / shotKeys.length;
    stableShare[judge] = share;
    if (share < CALIBRATION_STABLE_SHARE) {
      failures.push(`复评稳定未过：${judge} 稳定占比 ${(share * 100).toFixed(1)}%，低于 ${(CALIBRATION_STABLE_SHARE * 100).toFixed(0)}%`);
    }
  }

  const mutationRows: Array<{ id: string; judge: string; gap: number; hits: number; ok: boolean }> = [];
  for (const judge of judges) {
    const baseCards = cardsOf(input.baselineKey, judge);
    const baseMedian = median(baseCards.map((c) => pageScore(scoreFromFindings(c.findings))));

    for (const m of input.mutations) {
      const mutKey = `${input.baselineKey}!${m.id}`;
      const mutCards = cardsOf(mutKey, judge);
      const mutMedian = median(mutCards.map((c) => pageScore(scoreFromFindings(c.findings))));
      const gap = baseMedian - mutMedian;
      const minGap = m.expectSeverity === "P0" || m.expectSeverity === "P1" ? CALIBRATION_MIN_GAP_SEVERE : CALIBRATION_MIN_GAP_MINOR;

      const customBox = (m as Mutation & { box?: Finding["box"] }).box;
      const targetBox = customBox ?? DEFAULT_MUTATION_BOXES[m.id];

      let hits = 0;
      for (const c of mutCards) {
        const detected = c.findings.some((f) => {
          const dimOk = dimensionOfRule(f.rule) === m.expectDimension;
          const sevOk = SEVERITY_RANK[f.severity] <= SEVERITY_RANK[m.expectSeverity];
          const boxOk = targetBox === undefined ? true : coversTarget(f.box, targetBox);
          return dimOk && sevOk && boxOk;
        });
        if (detected) hits++;
      }

      const ok = gap >= minGap && hits >= CALIBRATION_MIN_HITS;
      mutationRows.push({ id: m.id, judge, gap, hits, ok });
      if (gap < minGap) {
        failures.push(`分差未拉开：${judge} 在 ${m.id}（${m.expectSeverity}）上分差 ${gap}，至少要 ${minGap}`);
      }
    }

    const severeMutations = input.mutations.filter((m) => m.expectSeverity === "P0" || m.expectSeverity === "P1");
    const checkSet = severeMutations.length > 0 ? severeMutations : input.mutations;
    if (checkSet.length > 0) {
      const caught = checkSet.filter((m) => {
        const row = mutationRows.find((r) => r.id === m.id && r.judge === judge)!;
        return row.hits >= CALIBRATION_MIN_HITS;
      }).length;
      const detectShare = caught / checkSet.length;
      if (detectShare < CALIBRATION_DETECT_SHARE) {
        failures.push(`检出率未过：${judge} 抓到 ${caught}/${checkSet.length}（${(detectShare * 100).toFixed(1)}%），低于 ${(CALIBRATION_DETECT_SHARE * 100).toFixed(0)}%`);
      }
    }
  }

  const baseSources = input.cards
    .filter((c) => c.shot === input.baselineKey)
    .sort((a, b) => a.judge.localeCompare(b.judge) || a.run - b.run)
    .map((c) => ({
      by: `${c.judge}#${c.run}`,
      judge: c.judge,
      findings: c.findings.filter((f) => f.severity === "P0" || f.severity === "P1"),
    }));
  const mergedBaseSevere = mergeFindingsForShot(
    input.baselineKey,
    baseSources.map((s) => ({ by: s.by, findings: s.findings })),
  ).map<MergedFinding>((m) => ({
    shotKey: m.shotKey,
    rule: m.rule,
    severity: m.severity,
    box: m.box,
    what: m.what,
    fix: m.fix,
    by: [...new Set(m.by.map((b) => b.split("#")[0]!))],
    counted: true,
  }));
  if (mergedBaseSevere.length > 0) {
    failures.push(`基准图上出现 ${mergedBaseSevere.length} 条 P0/P1 发现`);
  }

  let agreeCount = 0;
  for (const shotKey of shotKeys) {
    const medians = judges.map((judge) => {
      const runs = cardsOf(shotKey, judge);
      return median(runs.map((c) => pageScore(scoreFromFindings(c.findings))));
    });
    if (Math.max(...medians) - Math.min(...medians) <= 1) agreeCount++;
  }
  const agreeShare = agreeCount / shotKeys.length;
  if (agreeShare < CALIBRATION_AGREE_SHARE) {
    failures.push(`两家一致性未过：页面分差不超过 1 的图占 ${(agreeShare * 100).toFixed(1)}%，低于 ${(CALIBRATION_AGREE_SHARE * 100).toFixed(0)}%`);
  }

  return {
    pass: failures.length === 0,
    stableShare,
    mutations: mutationRows,
    baselineSevere: mergedBaseSevere,
    agreeShare,
    failures,
  };
}

/**
 * 校准时每档批大小各有一份报告：返回过了门槛的最大一档；都没过返回 null。
 * 用了较小一档时，一次评审的 Worker 会超过 JUDGE_MAX_WORKERS_PER_REVIEW，照 judgeWaves 分波次串行跑。
 */
export function pickBatchSize(reports: ReadonlyMap<number, CalibrationReport>): number | null {
  let best: number | null = null;
  for (const [size, report] of reports.entries()) {
    if (report.pass && (best === null || size > best)) {
      best = size;
    }
  }
  return best;
}

/** 哨兵图这一次的页面分和校准时的中位数差得超过 SENTINEL_MAX_DRIFT 的，返回它们的 key；有就说明这一次评审不可信，要重评。 */
export function sentinelDrift(calibration: readonly ScoreCard[], round: readonly ScoreCard[], sentinelKeys: readonly string[]): string[] {
  const drifted: string[] = [];
  for (const key of sentinelKeys) {
    const roundCards = round.filter((c) => c.shot === key);
    const calAll = calibration.filter((c) => c.shot === key);
    if (calAll.length === 0 || roundCards.length === 0) continue;

    const hitDrift = roundCards.some((rc) => {
      const calSameJudge = calAll.filter((c) => c.judge === rc.judge);
      const refCards = calSameJudge.length > 0 ? calSameJudge : calAll;
      const calMed = median(refCards.map((c) => pageScore(scoreFromFindings(c.findings))));
      const currPage = pageScore(scoreFromFindings(rc.findings));
      return Math.abs(currPage - calMed) > SENTINEL_MAX_DRIFT;
    });
    if (hitDrift) drifted.push(key);
  }
  return drifted;
}

/**
 * 这一轮比上一轮变坏的图：出现了上一轮没有的、计分的 P0 到 P2 发现。只是 P3 多了少了不算变坏。
 * 后置：每张变坏的图带上新出现的那几条发现，给修的人定位该撤哪一处修改。
 */
export function regressions(previous: RoundScores, next: RoundScores): Array<{ shotKey: string; added: MergedFinding[] }> {
  const prevSerious = previous.findings.filter((f) => f.counted && f.severity !== "P3");
  const addedByShot = new Map<string, MergedFinding[]>();

  for (const nf of next.findings) {
    if (!nf.counted || nf.severity === "P3") continue;
    const existed = prevSerious.some(
      (pf) => pf.shotKey === nf.shotKey && sameSpot(pf, nf) && SEVERITY_RANK[nf.severity] >= SEVERITY_RANK[pf.severity],
    );
    if (!existed) {
      const list = addedByShot.get(nf.shotKey) ?? [];
      list.push(nf);
      addedByShot.set(nf.shotKey, list);
    }
  }

  return [...addedByShot.entries()].map(([shotKey, added]) => ({ shotKey, added }));
}

export type NextStep =
  /** 还有不达标的，接着修。 */
  | { action: "fix"; below: string[] }
  /** 这一次全部达标，但还没连续 PASS_STREAK 次：同一个提交上再做一次独立评审。 */
  | { action: "confirm" }
  /** 连续 PASS_STREAK 次全部达标。 */
  | { action: "done" }
  /** 修满 MAX_FIX_ROUNDS 轮，或连续 STALL_ROUNDS 轮没进展：停下来把剩下的列给用户。 */
  | { action: "ask-user"; why: "max-rounds" | "stalled"; below: string[] };

function minPageScore(scores: RoundScores): number {
  return scores.shots.length === 0 ? 10 : Math.min(...scores.shots.map((s) => s.page));
}

/**
 * history 按时间从早到晚，每项是一次评审的结果和它之前修了第几轮。
 * 后置：按 limits.ts 的 PASS_SCORE、PASS_STREAK、MAX_FIX_ROUNDS、STALL_ROUNDS 给出下一步。
 * “没进展”= 不达标的图数没减少，并且全部图里的最低页面分没升高。提交变了连续达标次数从头算。
 */
export function decideNext(history: ReadonlyArray<{ fixRound: number; scores: RoundScores }>): NextStep {
  if (history.length === 0) throw new RangeError("history 不能为空");
  const latest = history[history.length - 1]!;
  const below = [...latest.scores.below];

  if (below.length === 0) {
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]!;
      if (entry.scores.below.length === 0 && entry.scores.commit === latest.scores.commit) {
        streak++;
      } else {
        break;
      }
    }
    return streak >= PASS_STREAK ? { action: "done" } : { action: "confirm" };
  }

  if (latest.fixRound >= MAX_FIX_ROUNDS) {
    return { action: "ask-user", why: "max-rounds", below };
  }

  let stallStreak = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    const prev = history[i - 1]!.scores;
    const curr = history[i]!.scores;
    const noFewerBelow = curr.below.length >= prev.below.length;
    const noHigherMin = minPageScore(curr) <= minPageScore(prev);
    if (noFewerBelow && noHigherMin) {
      stallStreak++;
    } else {
      break;
    }
  }
  if (stallStreak >= STALL_ROUNDS) {
    return { action: "ask-user", why: "stalled", below };
  }

  return { action: "fix", below };
}
