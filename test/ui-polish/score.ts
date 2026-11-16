// 合分和判断（docs/ui-polish-loop-design.md 第 3.4 到 3.6 节）：把两家评委的评分卡和机器检查合成每张图的分数，
// 算校准够不够格，判断这一轮之后是接着修、做确认评审还是停。
// 不变量：都是纯函数，同样的输入同样的输出；取低不取高（两家评委取低的、四项取最低的），任何一家都抬不了分。
import type { CaptureManifest } from "./capture.ts";
import type { Mutation } from "./mutations.ts";
import type { DimensionScores, Finding, ScoreCard } from "./rubric.ts";

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

/**
 * 前置：cards 里每张图每家评委各有一张卡，卡的 imageSha256 和 manifest 对得上。
 * 后置：两家的发现按“同一张图、框的交并比不低于 FINDING_MATCH_IOU 或引了同一条规则”并成一条；
 * 机器检查的发现并进去；被 dismissals 命中的标上理由、不计分；分数按 rubric.scoreFromFindings 算。
 * 缺卡、sha256 对不上抛 Error 并列出是哪些图哪家评委。
 */
export function mergeRound(input: { manifest: CaptureManifest; cards: readonly ScoreCard[]; dismissals: readonly Dismissal[] }): RoundScores {
  throw new Error("未实现");
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
  throw new Error("未实现");
}

/**
 * 校准时每档批大小各有一份报告：返回过了门槛的最大一档；都没过返回 null。
 * 用了较小一档时，一次评审的 Worker 会超过 JUDGE_MAX_WORKERS_PER_REVIEW，照 judgeWaves 分波次串行跑。
 */
export function pickBatchSize(reports: ReadonlyMap<number, CalibrationReport>): number | null {
  throw new Error("未实现");
}

/** 哨兵图这一次的页面分和校准时的中位数差得超过 SENTINEL_MAX_DRIFT 的，返回它们的 key；有就说明这一次评审不可信，要重评。 */
export function sentinelDrift(calibration: readonly ScoreCard[], round: readonly ScoreCard[], sentinelKeys: readonly string[]): string[] {
  throw new Error("未实现");
}

/**
 * 这一轮比上一轮变坏的图：出现了上一轮没有的、计分的 P0 到 P2 发现。只是 P3 多了少了不算变坏。
 * 后置：每张变坏的图带上新出现的那几条发现，给修的人定位该撤哪一处修改。
 */
export function regressions(previous: RoundScores, next: RoundScores): Array<{ shotKey: string; added: MergedFinding[] }> {
  throw new Error("未实现");
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

/**
 * history 按时间从早到晚，每项是一次评审的结果和它之前修了第几轮。
 * 后置：按 limits.ts 的 PASS_SCORE、PASS_STREAK、MAX_FIX_ROUNDS、STALL_ROUNDS 给出下一步。
 * “没进展”= 不达标的图数没减少，并且全部图里的最低页面分没升高。提交变了连续达标次数从头算。
 */
export function decideNext(history: ReadonlyArray<{ fixRound: number; scores: RoundScores }>): NextStep {
  throw new Error("未实现");
}
