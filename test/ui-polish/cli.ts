#!/usr/bin/env node
// Entry point of the UI polish loop (docs/ui-polish-loop-design.md section 3.8), `pnpm ui:polish <command>`:
//   inventory                                  print the screen inventory (Markdown)
//   shots [--round <id>] [--only <id|area>…] [--verify] [--engine chromium|webkit]   capture every screen; --verify captures twice and fails if any image differs; WebKit images go under <round>/webkit/
//   calibrate-shots [--round <id>]             capture calibration images: the baseline, a few real screens, one per breakage, plus real screens to fill a batch
//   brief --round <id> --judge <vendor/model> --batch <n> [--batch-size <n>] [--run <n>]   print the judge brief for this batch
//   check-cards --round <id> --judge <vendor/model>    judge self-check: scorecard format and image coverage
//   score --round <id> [--dismissals <file>]   merge scores, write this round's record, print the next step
//   calibration --round <id>                   write one calibration report per batch size, pick the batch size for real reviews, write the record
//   report --round <id> [--previous <id>]      build the HTML report for the user
// Screenshots and scorecards default to ROUND_OUTPUT_DIR/<round>/; records go to the repository's RECORD_DIR.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { planMatches, readBlindPlan, unblindCard, writeBlindPlan, type BlindItem, type BlindPlan, type SentinelSource } from "./blind.ts";
import { CAPTURE_ENGINES, captureAll, diffManifests, type CaptureEngine, type CaptureManifest } from "./capture.ts";
import { MACHINE_CHECKS } from "./checks.ts";
import { assertIsolated } from "./isolation.ts";
import { judgeBrief } from "./judge-prompt.ts";
import { CALIBRATION_RUNS, JUDGE_BATCH_CANDIDATES, PASS_SCORE, RECORD_DIR, ROUND_OUTPUT_DIR, SENTINEL_MAX_DRIFT } from "./limits.ts";
import { CALIBRATION_BASELINE, CALIBRATION_REAL_SHOTS, MUTATIONS, SENTINEL_MUTATIONS } from "./mutations.ts";
import { readRoundRecords, reportHtml, writeRoundRecord, type RoundRecord } from "./record.ts";
import { DIMENSION_TITLES, parseScoreCard, type ScoreCard } from "./rubric.ts";
import {
  calibrationReport,
  decideNext,
  mergeRound,
  pickBatchSize,
  regressions,
  sentinelDrift,
  type CalibrationReport,
  type Dismissal,
  type RoundScores,
} from "./score.ts";
import { SCREEN_AREAS, SCREEN_INVENTORY, batchShots, inventoryMarkdown, type ScreenSpec } from "./screens.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROUND_PATTERN = /^[A-Z]\d{1,2}(?:-confirm)?$/;

const USAGE = `用法：pnpm ui:polish <命令>
  inventory
  shots [--round R01] [--only <界面或区域>[,<界面或区域>…]]… [--verify] [--engine chromium|webkit]
  calibrate-shots [--round C1]
  brief --round <id> --judge <厂商/模型> --batch <n> [--batch-size <n>] [--run <n>]
  check-cards --round <id> --judge <厂商/模型> [--batch <n>] [--batch-size <n>] [--run <n>]
  score --round <id> [--dismissals <文件>]
  calibration --round <id>
  report --round <id> [--previous <id>]`;

class UsageError extends Error {}

/**
 * 后置：返回进程退出码。0 = 做完了；1 = 命令本身失败（界面到不了、两遍不一致、评分卡不合格、校准没过）；2 = 参数不对，用法打到标准错误。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "inventory":
        parse(rest, {});
        process.stdout.write(inventoryMarkdown(SCREEN_INVENTORY));
        return 0;
      case "shots": {
        const { values } = parse(rest, {
          round: { type: "string" },
          only: { type: "string", multiple: true },
          verify: { type: "boolean" },
          engine: { type: "string" },
        });
        const round = values.round ?? "R00";
        const engine = requireEngine(values.engine);
        const dir = engine === "chromium" ? roundDir(round, round) : join(roundDir(round, round), engine);
        return await shots(round, dir, values.only?.flatMap((v) => v.split(",")), values.verify === true, engine);
      }
      case "calibrate-shots": {
        const { values } = parse(rest, { round: { type: "string" } });
        const round = values.round ?? "C1";
        return await calibrateShots(round, roundDir(round, round));
      }
      case "brief": {
        const { values } = parse(rest, {
          round: { type: "string" },
          judge: { type: "string" },
          batch: { type: "string" },
          "batch-size": { type: "string" },
          run: { type: "string" },
          "repo-root": { type: "string" },
          "out-root": { type: "string" },
        });
        return runBrief({
          roundId: requireRound(values.round),
          judge: requireJudge(values.judge),
          batch: requirePositiveInt(values.batch, "batch"),
          explicitBatchSize: values["batch-size"] === undefined ? undefined : requirePositiveInt(values["batch-size"], "batch-size"),
          run: values.run === undefined ? 1 : requirePositiveInt(values.run, "run"),
          repoRoot: values["repo-root"] ?? REPO_ROOT,
          outRoot: values["out-root"] ?? ROUND_OUTPUT_DIR,
        });
      }
      case "check-cards": {
        const { values } = parse(rest, {
          round: { type: "string" },
          judge: { type: "string" },
          batch: { type: "string" },
          "batch-size": { type: "string" },
          run: { type: "string" },
          "repo-root": { type: "string" },
          "out-root": { type: "string" },
        });
        return runCheckCards({
          roundId: requireRound(values.round),
          judge: requireJudge(values.judge),
          batch: values.batch === undefined ? undefined : requirePositiveInt(values.batch, "batch"),
          explicitBatchSize: values["batch-size"] === undefined ? undefined : requirePositiveInt(values["batch-size"], "batch-size"),
          run: values.run === undefined ? undefined : requirePositiveInt(values.run, "run"),
          repoRoot: values["repo-root"] ?? REPO_ROOT,
          outRoot: values["out-root"] ?? ROUND_OUTPUT_DIR,
        });
      }
      case "score": {
        const { values } = parse(rest, {
          round: { type: "string" },
          dismissals: { type: "string" },
          "repo-root": { type: "string" },
          "out-root": { type: "string" },
        });
        return runScore({
          roundId: requireRound(values.round),
          dismissalsFile: values.dismissals,
          repoRoot: values["repo-root"] ?? REPO_ROOT,
          outRoot: values["out-root"] ?? ROUND_OUTPUT_DIR,
        });
      }
      case "calibration": {
        const { values } = parse(rest, {
          round: { type: "string" },
          "repo-root": { type: "string" },
          "out-root": { type: "string" },
        });
        return runCalibration({
          roundId: requireRound(values.round),
          repoRoot: values["repo-root"] ?? REPO_ROOT,
          outRoot: values["out-root"] ?? ROUND_OUTPUT_DIR,
        });
      }
      case "report": {
        const { values } = parse(rest, {
          round: { type: "string" },
          previous: { type: "string" },
          "repo-root": { type: "string" },
          "out-root": { type: "string" },
        });
        return runReport({
          roundId: requireRound(values.round),
          previousId: values.previous === undefined ? undefined : requireRound(values.previous),
          repoRoot: values["repo-root"] ?? REPO_ROOT,
          outRoot: values["out-root"] ?? ROUND_OUTPUT_DIR,
        });
      }
      default:
        throw new UsageError(command === undefined ? "缺命令" : `不认识的命令 ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: string[], options: T) {
  return parseArgs({ args, options, allowPositionals: false, strict: true });
}

/** 这一轮的截图、评分卡放哪。每个命令都从这里拿目录，拿到之前先判隔离。 */
function roundDir(round: string | undefined, fallback: string, outRoot = ROUND_OUTPUT_DIR): string {
  const id = round ?? fallback;
  if (!ROUND_PATTERN.test(id)) throw new UsageError(`轮次 ${id} 不对，要像 R01、C1 这样：一个大写字母加一到两位数字`);
  const dir = join(outRoot, id);
  assertIsolated(dir);
  return dir;
}

function requireEngine(engine: string | undefined): CaptureEngine {
  if (engine === undefined) return "chromium";
  if (!Object.hasOwn(CAPTURE_ENGINES, engine)) throw new UsageError(`--engine 只能是 ${Object.keys(CAPTURE_ENGINES).join(" 或 ")}`);
  return engine as CaptureEngine;
}

function requireRound(round: string | undefined): string {
  if (round === undefined) throw new UsageError("缺 --round");
  if (!ROUND_PATTERN.test(round)) throw new UsageError(`轮次 ${round} 不对，要像 R01、C1 这样：一个大写字母加一到两位数字`);
  return round;
}

function requireJudge(judge: string | undefined): string {
  if (judge === undefined || !/^[^/\s]+\/[^/\s]+$/.test(judge)) {
    throw new UsageError(`--judge 要写成 <厂商>/<模型>（收到：${judge ?? "空"}）`);
  }
  return judge;
}

function requirePositiveInt(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--${name} 要是正整数（收到：${raw ?? "空"}）`);
  }
  return Number(raw);
}

function judgeSlug(judge: string): string {
  return judge.replaceAll(/[^a-zA-Z0-9._-]/g, "__");
}

function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function resolveBatchSize(repoRoot: string, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const calDoc = join(repoRoot, RECORD_DIR, "calibration.md");
  if (existsSync(calDoc)) {
    const match = /正式评审批大小：`(\d+)`/.exec(readFileSync(calDoc, "utf8"));
    if (match !== null) return Number(match[1]);
  }
  return Math.max(...JUDGE_BATCH_CANDIDATES);
}

function readManifest(outDir: string): CaptureManifest {
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到截图清单 ${manifestPath}，请先运行 shots 或 calibrate-shots`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureManifest;
}

function screenOf(screenId: string, viewport: BlindItem["viewport"]): ScreenSpec {
  const found = SCREEN_INVENTORY.find((s) => s.id === screenId);
  if (found !== undefined) return found;
  const area = SCREEN_AREAS.find((a) => screenId.startsWith(`${a}.`)) ?? "shell";
  return { id: screenId, area, title: screenId, viewports: [viewport], state: "normal", scenario: "standard", how: "" };
}

/** 最近一次校准的基准图和 SENTINEL_MUTATIONS 那几张弄坏的图。校准轮自己、还没校准过时不混哨兵。 */
function sentinelSource(roundId: string, repoRoot: string, outRoot: string): SentinelSource | undefined {
  if (roundId.startsWith("C")) return undefined;
  const calibration = [...readRoundRecords(repoRoot)].reverse().find((r) => r.kind === "calibration");
  if (calibration === undefined) return undefined;
  const dir = join(outRoot, calibration.id);
  const keys = [CALIBRATION_BASELINE, ...SENTINEL_MUTATIONS.map((id) => `${CALIBRATION_BASELINE}!${id}`)];
  const manifest = existsSync(join(dir, "manifest.json")) ? readManifest(dir) : undefined;
  const shots = keys.map((key) => manifest?.shots.find((s) => s.key === key));
  const missing = keys.filter((_, i) => shots[i] === undefined);
  if (missing.length > 0) {
    throw new Error(`最近一次校准是 ${calibration.id}，但 ${dir} 里没有这几张图：${missing.join("、")}，没法混进哨兵图。重跑 calibrate-shots --round ${calibration.id} 或把那一轮的截图放回去`);
  }
  return { roundId: calibration.id, dir, shots: shots as NonNullable<(typeof shots)[number]>[] };
}

/** 这一轮的盲测对照表：已有且和清单对得上就用；没有或重截过就重新编号（评审轮混进哨兵图）。 */
function blindPlanFor(outDir: string, roundId: string, repoRoot: string, outRoot: string): BlindPlan {
  const manifest = readManifest(outDir);
  const existing = readBlindPlan(outDir);
  if (existing !== null && planMatches(existing, manifest)) return existing;
  return writeBlindPlan(outDir, manifest, hashSeed(roundId), sentinelSource(roundId, repoRoot, outRoot));
}

function requireBlindPlan(outDir: string): BlindPlan {
  const plan = readBlindPlan(outDir);
  if (plan === null) throw new Error(`${outDir} 里没有盲测对照表，先运行 brief`);
  return plan;
}

function planBatches(plan: BlindPlan, manifest: CaptureManifest, roundId: string, judge: string, run: number, batchSize: number): BlindItem[][] {
  const regular = new Map(plan.items.filter((i) => !i.sentinel).map((i) => [i.key, i]));
  const asShot = (item: BlindItem) => ({ item, screen: screenOf(item.screenId, item.viewport), viewport: item.viewport });
  const shots = manifest.shots.map((s) => asShot(regular.get(s.key)!));
  const sentinels = plan.items.filter((i) => i.sentinel).map(asShot);
  return batchShots(shots, sentinels, hashSeed(`${roundId}:${judge}:${run}`), batchSize).map((batch) => batch.map((s) => s.item));
}

function cardsDirForBatch(outDir: string, roundId: string, judge: string, batchSize: number, explicitBatchSize: number | undefined, run: number, batch: number): string {
  const slug = judgeSlug(judge);
  if (roundId.startsWith("C") || explicitBatchSize !== undefined || run > 1) {
    return join(outDir, "cards", `batch-size-${batchSize}`, slug, `run-${run}`, `batch-${batch}`);
  }
  return join(outDir, "cards", slug, `batch-${batch}`);
}

function collectJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectJsonFiles(full));
    } else if (name.endsWith(".json")) {
      results.push(full);
    }
  }
  return results;
}

function runBrief(opts: {
  roundId: string;
  judge: string;
  batch: number;
  explicitBatchSize: number | undefined;
  run: number;
  repoRoot: string;
  outRoot: string;
}): number {
  const outDir = roundDir(opts.roundId, opts.roundId, opts.outRoot);
  const plan = blindPlanFor(outDir, opts.roundId, opts.repoRoot, opts.outRoot);
  const batchSize = resolveBatchSize(opts.repoRoot, opts.explicitBatchSize);
  const batches = planBatches(plan, readManifest(outDir), opts.roundId, opts.judge, opts.run, batchSize);
  if (opts.batch > batches.length) {
    throw new UsageError(`第 ${opts.batch} 批超出范围（共 ${batches.length} 批，每批最多 ${batchSize} 张）`);
  }

  const picked = batches[opts.batch - 1]!;
  const idOf = new Map(plan.items.filter((i) => !i.sentinel).map((i) => [i.key, i.id]));
  const records = readRoundRecords(opts.repoRoot);
  const prevReview = [...records].reverse().find((r) => r.kind === "review" || r.kind === "confirm");
  const dismissed =
    prevReview?.findings.flatMap((f) => {
      const id = idOf.get(f.shotKey);
      return f.dismissed === undefined || id === undefined ? [] : [{ id, what: f.what, reason: f.dismissed }];
    }) ?? [];

  const cardsDir = cardsDirForBatch(outDir, opts.roundId, opts.judge, batchSize, opts.explicitBatchSize, opts.run, opts.batch);
  const text = judgeBrief({
    judge: opts.judge,
    run: opts.run,
    baselineImage: join(opts.repoRoot, RECORD_DIR, "baseline", "baseline.png"),
    styleBrief: join(opts.repoRoot, RECORD_DIR, "baseline", "style-brief.md"),
    items: picked.map((item) => {
      const screen = screenOf(item.screenId, item.viewport);
      return {
        id: item.id,
        title: screen.title,
        viewport: item.viewport,
        ...(screen.focus === undefined ? {} : { focus: screen.focus }),
        file: join(outDir, item.file),
        ...(item.focusFile === undefined ? {} : { focusFile: join(outDir, item.focusFile) }),
        sha256: item.sha256,
        machineFacts: item.machineFindings.map((mf) => `${mf.rule}（${mf.severity}）：${mf.what}`),
      };
    }),
    cardsDir,
    dismissed,
  });
  process.stdout.write(text);
  return 0;
}

function runCheckCards(opts: {
  roundId: string;
  judge: string;
  batch: number | undefined;
  explicitBatchSize: number | undefined;
  run: number | undefined;
  repoRoot: string;
  outRoot: string;
}): number {
  const outDir = roundDir(opts.roundId, opts.roundId, opts.outRoot);
  const plan = requireBlindPlan(outDir);
  const errors: string[] = [];

  if (opts.batch !== undefined) {
    const run = opts.run ?? 1;
    const batchSize = resolveBatchSize(opts.repoRoot, opts.explicitBatchSize);
    const batches = planBatches(plan, readManifest(outDir), opts.roundId, opts.judge, run, batchSize);
    if (opts.batch > batches.length) {
      throw new UsageError(`第 ${opts.batch} 批超出范围（共 ${batches.length} 批）`);
    }
    const picked = batches[opts.batch - 1]!;
    const cardsDir = cardsDirForBatch(outDir, opts.roundId, opts.judge, batchSize, opts.explicitBatchSize, run, opts.batch);

    for (const item of picked) {
      const filePath = join(cardsDir, `${item.id}.json`);
      if (!existsSync(filePath)) {
        errors.push(`缺评分卡：${filePath}`);
        continue;
      }
      const parsed = parseScoreCard(readFileSync(filePath, "utf8"));
      if (!parsed.ok) {
        errors.push(`${filePath}：${parsed.reason}`);
        continue;
      }
      const card = parsed.card;
      if (card.shot !== item.id) errors.push(`${filePath}：shot 写成了 ${card.shot}，应为 ${item.id}`);
      if (card.judge !== opts.judge) errors.push(`${filePath}：judge 写成了 ${card.judge}，应为 ${opts.judge}`);
      if (card.run !== run) errors.push(`${filePath}：run 写成了 ${card.run}，应为 ${run}`);
      if (card.imageSha256 !== item.sha256) errors.push(`${filePath}：imageSha256 和这张图对不上（应为 ${item.sha256}）`);
    }

    if (errors.length > 0) {
      process.stderr.write(`自查未通过（${errors.length} 处问题）：\n${errors.join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`自查通过：第 ${opts.batch} 批共 ${picked.length} 张评分卡全部合格\n`);
    return 0;
  }

  const slug = judgeSlug(opts.judge);
  const rootSearchDir =
    opts.explicitBatchSize !== undefined
      ? join(outDir, "cards", `batch-size-${opts.explicitBatchSize}`, slug)
      : join(outDir, "cards", slug);
  const files = collectJsonFiles(rootSearchDir);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const seen = new Set<string>();

  for (const filePath of files) {
    const parsed = parseScoreCard(readFileSync(filePath, "utf8"));
    if (!parsed.ok) {
      errors.push(`${filePath}：${parsed.reason}`);
      continue;
    }
    const card = parsed.card;
    if (opts.run !== undefined && card.run !== opts.run) continue;
    if (card.judge !== opts.judge) errors.push(`${filePath}：judge 写成了 ${card.judge}，应为 ${opts.judge}`);
    const item = byId.get(card.shot);
    if (item === undefined) {
      errors.push(`${filePath}：这一轮没有编号 ${card.shot} 的图`);
    } else if (card.imageSha256 !== item.sha256) {
      errors.push(`${filePath}：imageSha256 和这张图对不上（应为 ${item.sha256}）`);
    }
    const id = `${card.shot}#${card.run}`;
    if (seen.has(id)) errors.push(`${filePath}：${card.shot}（run ${card.run}）重复交卡`);
    seen.add(id);
  }

  const expectedRuns =
    opts.run !== undefined
      ? [opts.run]
      : opts.roundId.startsWith("C")
        ? Array.from({ length: CALIBRATION_RUNS }, (_, i) => i + 1)
        : [1];
  for (const r of expectedRuns) {
    for (const item of plan.items) {
      if (!seen.has(`${item.id}#${r}`)) errors.push(`缺评分卡：${item.id}（run ${r}）`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`自查未通过（${errors.length} 处问题）：\n${errors.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`自查通过：${seen.size} 张评分卡全部合格\n`);
  return 0;
}

/** 读一个目录下的全部评分卡，按这一轮的对照表把编号换回真实的 key。格式不对、编号不认识都抛 Error。 */
function loadCards(dir: string, plan: BlindPlan): Array<{ card: ScoreCard; item: BlindItem }> {
  const loaded: Array<{ card: ScoreCard; item: BlindItem }> = [];
  const bad: string[] = [];
  for (const filePath of collectJsonFiles(dir)) {
    const parsed = parseScoreCard(readFileSync(filePath, "utf8"));
    const unblinded = parsed.ok ? unblindCard(plan, parsed.card) : undefined;
    if (!parsed.ok) bad.push(`${filePath}：${parsed.reason}`);
    else if (unblinded === undefined) bad.push(`${filePath}：这一轮没有编号 ${parsed.card.shot} 的图`);
    else loaded.push(unblinded);
  }
  if (bad.length > 0) {
    throw new Error(`发现不合格的评分卡：\n${bad.join("\n")}`);
  }
  return loaded;
}

/**
 * 哨兵图这一次的分和它们在校准时的分比，漂得太远的返回它们的 key。
 * 每家评委都要评过每张哨兵图，校准轮的评分卡也要在；缺了抛 Error，不悄悄跳过。
 */
function driftedSentinels(plan: BlindPlan, loaded: ReadonlyArray<{ card: ScoreCard; item: BlindItem }>, outRoot: string): string[] {
  const sentinels = plan.items.filter((i) => i.sentinel);
  if (sentinels.length === 0) return [];
  const judges = [...new Set(loaded.map((l) => l.card.judge))];
  const missing = sentinels.flatMap((s) => judges.filter((j) => !loaded.some((l) => l.item.id === s.id && l.card.judge === j)).map((j) => `${s.id}（缺 ${j}）`));
  if (missing.length > 0) throw new Error(`评分卡不完整：${missing.join("；")}`);
  const calDir = join(outRoot, plan.sentinelsFrom!);
  const calCards = loadCards(join(calDir, "cards"), requireBlindPlan(calDir)).map((l) => l.card);
  const noBaseline = sentinels.filter((s) => !calCards.some((c) => c.shot === s.key)).map((s) => s.key);
  if (noBaseline.length > 0) throw new Error(`校准轮 ${plan.sentinelsFrom} 里找不到这几张图的评分卡：${noBaseline.join("、")}`);
  const roundCards = loaded.filter((l) => l.item.sentinel).map((l) => l.card);
  return sentinelDrift(calCards, roundCards, sentinels.map((s) => s.key));
}

function recordToScores(record: RoundRecord): RoundScores {
  return {
    commit: record.commit,
    judges: record.judges,
    shots: record.shots.map(({ sha256: _sha, ...rest }) => rest),
    findings: [...record.findings],
    below: record.shots.filter((s) => s.page < PASS_SCORE).map((s) => s.shotKey),
    disagreements: [],
  };
}

function runScore(opts: { roundId: string; dismissalsFile: string | undefined; repoRoot: string; outRoot: string }): number {
  const outDir = roundDir(opts.roundId, opts.roundId, opts.outRoot);
  const manifest = readManifest(outDir);
  const plan = requireBlindPlan(outDir);
  const loaded = loadCards(join(outDir, "cards"), plan);
  const dismissals: Dismissal[] =
    opts.dismissalsFile === undefined ? [] : (JSON.parse(readFileSync(opts.dismissalsFile, "utf8")) as Dismissal[]);

  const drifted = driftedSentinels(plan, loaded, opts.outRoot);
  if (drifted.length > 0) {
    process.stderr.write(`哨兵图的分和校准时差得超过 ${SENTINEL_MAX_DRIFT} 分，这次评审作废，重评：${drifted.join("、")}\n`);
    return 1;
  }

  const cards = loaded.filter((l) => !l.item.sentinel).map((l) => l.card);
  const scores = mergeRound({ manifest, cards, dismissals });

  const existing = readRoundRecords(opts.repoRoot);
  const reviewRecords = existing.filter((r) => r.kind === "review" || r.kind === "confirm");
  let fixesSoFar = 0;
  const pastHistory = reviewRecords.map((r) => {
    const entry = { fixRound: fixesSoFar, scores: recordToScores(r) };
    if (r.kind === "review") fixesSoFar++;
    return entry;
  });

  const kind: RoundRecord["kind"] = opts.roundId.endsWith("-confirm") ? "confirm" : "review";
  const next = decideNext([...pastHistory, { fixRound: fixesSoFar, scores }]);
  const prevScores = pastHistory.at(-1)?.scores;
  const regressed = prevScores === undefined ? [] : regressions(prevScores, scores);

  const shaMap = new Map(manifest.shots.map((s) => [s.key, s.sha256]));
  const record: RoundRecord = {
    id: opts.roundId,
    kind,
    commit: manifest.commit,
    browser: manifest.browser,
    finishedAt: new Date().toISOString(),
    judges: scores.judges,
    shots: scores.shots.map((s) => ({ ...s, sha256: shaMap.get(s.shotKey)! })),
    findings: scores.findings,
    fixGroups: [],
    pr: null,
    next,
    calibration: null,
  };

  const jsonPath = writeRoundRecord(opts.repoRoot, record);
  const minScore = scores.shots.length === 0 ? 10 : Math.min(...scores.shots.map((s) => s.page));
  process.stdout.write(
    `轮次 ${opts.roundId} 合分完成：共 ${scores.shots.length} 张图，不达标 ${scores.below.length} 张，最低分 ${minScore}，` +
      `变坏 ${regressed.length} 张，印象分歧 ${scores.disagreements.length} 张\n` +
      `下一步：${next.action}${next.action === "ask-user" ? `（${next.why}）` : ""}\n记录：${jsonPath}\n`,
  );
  return 0;
}

function calibrationMarkdown(
  roundId: string,
  manifest: CaptureManifest,
  reports: ReadonlyMap<number, CalibrationReport>,
  chosen: number | null,
): string {
  const lines = [
    "# 评委校准报告",
    "",
    `- 校准轮次：\`${roundId}\``,
    `- 截图提交：\`${manifest.commit}\`（${manifest.browser}）`,
    `- 正式评审批大小：${chosen === null ? "未通过" : `\`${chosen}\``}`,
    "",
  ];

  for (const [size, rep] of [...reports.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(
      `## 批大小 ${size} 张（${rep.pass ? "通过" : "未通过"}）`,
      "",
      `- 两家页面分一致率（差 ≤ 1）：${(rep.agreeShare * 100).toFixed(1)}%`,
      `- 基准图 P0 发现：${rep.baselineSevere.length} 条`,
      ...Object.entries(rep.baselinePage).map(([j, p]) => `- 基准图页面分（${j}）：${p}`),
      ...Object.entries(rep.stableShare).map(([j, s]) => `- 复评稳定率（${j}）：${(s * 100).toFixed(1)}%`),
      "",
      "| 弄坏 | 评委 | 注入的项 | 这一项 基准 → 弄坏（封顶） | 命中次数 | 结果 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rep.mutations.map(
        (m) => `| \`${m.id}\` | ${m.judge} | ${DIMENSION_TITLES[m.dimension]} | ${m.baseScore} → ${m.mutatedScore}（${m.cap}） | ${m.hits}/${CALIBRATION_RUNS} | ${m.ok ? "合格" : "不合格"} |`,
      ),
      "",
    );
    if (rep.failures.length > 0) {
      lines.push("### 未过门槛", "", ...rep.failures.map((f) => `- ${f}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function runCalibration(opts: { roundId: string; repoRoot: string; outRoot: string }): number {
  const outDir = roundDir(opts.roundId, opts.roundId, opts.outRoot);
  const manifest = readManifest(outDir);
  const plan = requireBlindPlan(outDir);
  const cardsRoot = join(outDir, "cards");
  const reports = new Map<number, CalibrationReport>();
  let allJudges = new Set<string>();

  for (const size of JUDGE_BATCH_CANDIDATES) {
    const dir = join(cardsRoot, `batch-size-${size}`);
    if (!existsSync(dir)) continue;
    const cards = loadCards(dir, plan).map((l) => l.card);
    if (cards.length === 0) continue;
    for (const c of cards) allJudges.add(c.judge);
    reports.set(size, calibrationReport({ manifest, cards, baselineKey: CALIBRATION_BASELINE, mutations: MUTATIONS }));
  }

  if (reports.size === 0) {
    const fallbackCards = loadCards(cardsRoot, plan).map((l) => l.card);
    if (fallbackCards.length === 0) {
      throw new Error(`找不到任何校准评分卡：${cardsRoot}`);
    }
    for (const c of fallbackCards) allJudges = new Set([...allJudges, c.judge]);
    const defaultSize = Math.max(...JUDGE_BATCH_CANDIDATES);
    reports.set(defaultSize, calibrationReport({ manifest, cards: fallbackCards, baselineKey: CALIBRATION_BASELINE, mutations: MUTATIONS }));
  }

  const chosen = pickBatchSize(reports);
  const representativeSize = chosen ?? Math.max(...reports.keys());
  const representative = reports.get(representativeSize)!;

  const record: RoundRecord = {
    id: opts.roundId,
    kind: "calibration",
    commit: manifest.commit,
    browser: manifest.browser,
    finishedAt: new Date().toISOString(),
    judges: [...allJudges].sort(),
    shots: [],
    findings: representative.baselineSevere,
    fixGroups: [],
    pr: null,
    next: null,
    calibration: representative,
  };

  const jsonPath = writeRoundRecord(opts.repoRoot, record);
  const mdPath = join(opts.repoRoot, RECORD_DIR, "calibration.md");
  mkdirSync(join(opts.repoRoot, RECORD_DIR), { recursive: true });
  writeFileSync(mdPath, calibrationMarkdown(opts.roundId, manifest, reports, chosen));

  process.stdout.write(
    `校准 ${opts.roundId}：${chosen !== null ? `通过，选定批大小 ${chosen} 张` : "未通过校准门槛"}\n` +
      `报告：${mdPath}\n记录：${jsonPath}\n`,
  );
  return chosen !== null ? 0 : 1;
}

function loadRoundOrManifestRecord(roundId: string, repoRoot: string, outRoot: string): { record: RoundRecord; shotsDir: string } {
  const shotsDir = roundDir(roundId, roundId, outRoot);
  const recordFile = join(repoRoot, RECORD_DIR, "rounds", `${roundId}.json`);
  if (existsSync(recordFile)) {
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as RoundRecord;
    return { record, shotsDir };
  }
  const manifest = readManifest(shotsDir);
  const unjudged: RoundRecord = {
    id: roundId,
    kind: "review",
    commit: manifest.commit,
    browser: manifest.browser,
    finishedAt: new Date().toISOString(),
    judges: [],
    shots: manifest.shots.map((s) => ({
      shotKey: s.key,
      sha256: s.sha256,
      byJudge: {},
      dimensions: { style: 0, standard: 0, aesthetic: 0, ux: 0 },
      page: 0,
    })),
    findings: [],
    fixGroups: [],
    pr: null,
    next: null,
    calibration: null,
  };
  return { record: unjudged, shotsDir };
}

function runReport(opts: { roundId: string; previousId: string | undefined; repoRoot: string; outRoot: string }): number {
  const current = loadRoundOrManifestRecord(opts.roundId, opts.repoRoot, opts.outRoot);
  const previous =
    opts.previousId === undefined ? undefined : loadRoundOrManifestRecord(opts.previousId, opts.repoRoot, opts.outRoot);
  const html = reportHtml({
    record: current.record,
    shotsDir: current.shotsDir,
    ...(previous === undefined ? {} : { previous }),
  });
  const htmlPath = join(current.shotsDir, "report.html");
  mkdirSync(current.shotsDir, { recursive: true });
  writeFileSync(htmlPath, html);
  process.stdout.write(`总览已生成：${htmlPath}\n`);
  return 0;
}

async function shots(roundId: string, outDir: string, only: readonly string[] | undefined, verify: boolean, engine: CaptureEngine): Promise<number> {
  const started = Date.now();
  const first = await captureAll({ repoRoot: REPO_ROOT, outDir, engine, ...(only === undefined ? {} : { only }) });
  writeBlindPlan(outDir, first, hashSeed(roundId), sentinelSource(roundId, REPO_ROOT, ROUND_OUTPUT_DIR));
  report(first, outDir, started);
  if (!verify) return 0;
  const again = mkdtempSync(join(ROUND_OUTPUT_DIR, ".verify-"));
  const second = await captureAll({ repoRoot: REPO_ROOT, outDir: again, engine, ...(only === undefined ? {} : { only }) });
  const diff = diffManifests(first, second);
  process.stdout.write(`两遍 ${diff.length} 张不同${diff.length > 0 ? `：${diff.join("、")}` : ""}，两遍共用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒\n`);
  if (diff.length === 0) {
    rmSync(again, { recursive: true, force: true });
    return 0;
  }
  process.stdout.write(`第二遍的图留在 ${again}，和 ${outDir} 里同名的图对比\n`);
  return 1;
}

async function calibrateShots(roundId: string, outDir: string): Promise<number> {
  const started = Date.now();
  const keys: readonly string[] = [CALIBRATION_BASELINE, ...CALIBRATION_REAL_SHOTS];
  const manifest = await captureAll({
    repoRoot: REPO_ROOT,
    outDir,
    only: [...new Set(keys.map((k) => k.split("@")[0]!))],
    mutate: { [CALIBRATION_BASELINE]: MUTATIONS.map((m) => m.id) },
  });
  const keep = manifest.shots.filter((s) => keys.includes(s.key.split("!")[0]!));
  for (const s of manifest.shots) if (!keep.includes(s)) for (const f of [s.file, s.focusFile]) if (f !== undefined) rmSync(join(outDir, f), { force: true });
  const trimmed: CaptureManifest = { ...manifest, shots: keep };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(trimmed, null, 2)}\n`);
  writeBlindPlan(outDir, trimmed, hashSeed(roundId));
  report(trimmed, outDir, started);
  return 0;
}

function report(manifest: CaptureManifest, outDir: string, started: number): void {
  const counts = MACHINE_CHECKS.map((c) => `${c.id} ${manifest.shots.reduce((n, s) => n + s.machineFindings.filter((f) => f.rule === `machine:${c.id}`).length, 0)}`);
  const focus = manifest.shots.filter((s) => s.focusFile !== undefined).length;
  process.stdout.write(
    `截了 ${manifest.shots.length} 张（另有 ${focus} 张局部图），用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒，提交 ${manifest.commit}，${manifest.browser}\n` +
      `机器检查：${counts.join("，")}\n清单：${join(outDir, "manifest.json")}\n`,
  );
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
