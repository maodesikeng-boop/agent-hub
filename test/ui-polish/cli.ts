#!/usr/bin/env node
// 界面打磨循环的命令入口（docs/ui-polish-loop-design.md 第 3.8 节），`pnpm ui:polish <命令>`：
//   inventory                                  打印界面清单（Markdown）
//   shots [--round <id>] [--only <id|区域>…] [--verify]   截全部界面；--verify 截两遍，有一张字节不同就失败
//   calibrate-shots [--round <id>]             截校准用的图：基准图、几张真实界面、每个弄坏各一张，另加凑满一批用的真实界面
//   brief --round <id> --judge <厂商/模型> --batch <n> [--batch-size <n>] [--run <n>]   打印这一批的评委任务说明
//   check-cards --round <id> --judge <厂商/模型>    评委自查：评分卡格式对不对、图齐不齐
//   score --round <id> [--dismissals <文件>]      合分，写这一轮的记录，打印下一步
//   calibration --round <id>                   每档批大小各算一份校准报告，选出正式评审用的批大小，写记录
//   report --round <id> [--previous <id>]      生成给用户看的 HTML
// 截图和评分卡默认放 ROUND_OUTPUT_DIR/<轮次>/，记录写进仓库的 RECORD_DIR。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureAll, diffManifests, type CaptureManifest, type CapturedShot } from "./capture.ts";
import { MACHINE_CHECKS } from "./checks.ts";
import { judgeBrief } from "./judge-prompt.ts";
import { CALIBRATION_RUNS, JUDGE_BATCH_CANDIDATES, PASS_SCORE, RECORD_DIR, ROUND_OUTPUT_DIR } from "./limits.ts";
import { CALIBRATION_BASELINE, CALIBRATION_REAL_SHOTS, MUTATIONS } from "./mutations.ts";
import { readRoundRecords, reportHtml, writeRoundRecord, type RoundRecord } from "./record.ts";
import { parseScoreCard, type ScoreCard } from "./rubric.ts";
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
import { SCREEN_AREAS, SCREEN_INVENTORY, batchShots, inventoryMarkdown, type ScreenSpec, type Shot } from "./screens.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROUND_PATTERN = /^[A-Z]\d{1,2}(?:-confirm)?$/;

const USAGE = `用法：pnpm ui:polish <命令>
  inventory
  shots [--round R01] [--only <界面或区域>[,<界面或区域>…]]… [--verify]
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
        const { values } = parse(rest, { round: { type: "string" }, only: { type: "string", multiple: true }, verify: { type: "boolean" } });
        return await shots(roundDir(values.round, "R00"), values.only?.flatMap((v) => v.split(",")), values.verify === true);
      }
      case "calibrate-shots": {
        const { values } = parse(rest, { round: { type: "string" } });
        return await calibrateShots(roundDir(values.round, "C1"));
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

function roundDir(round: string | undefined, fallback: string, outRoot = ROUND_OUTPUT_DIR): string {
  const id = round ?? fallback;
  if (!ROUND_PATTERN.test(id)) throw new UsageError(`轮次 ${id} 不对，要像 R01、C1 这样：一个大写字母加一到两位数字`);
  return join(outRoot, id);
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

function toShot(captured: CapturedShot): Shot {
  const found = SCREEN_INVENTORY.find((s) => s.id === captured.screenId);
  const fallbackArea = SCREEN_AREAS.find((a) => captured.screenId.startsWith(`${a}.`)) ?? "shell";
  const screen: ScreenSpec = found ?? {
    id: captured.screenId,
    area: fallbackArea,
    title: captured.screenId,
    viewports: [captured.viewport],
    state: "normal",
    scenario: "standard",
    how: "",
  };
  return { key: captured.key, screen, viewport: captured.viewport };
}

function planBatches(manifest: CaptureManifest, roundId: string, judge: string, run: number, batchSize: number): Shot[][] {
  const allShots = manifest.shots.map(toShot);
  const seed = hashSeed(`${roundId}:${judge}:${run}`);
  if (roundId.startsWith("C")) {
    return batchShots(allShots, [], seed, batchSize);
  }
  const sentinels = allShots.filter((s) => s.key.includes("!"));
  const regular = allShots.filter((s) => !s.key.includes("!"));
  return batchShots(regular, sentinels, seed, batchSize);
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
  const manifest = readManifest(outDir);
  const batchSize = resolveBatchSize(opts.repoRoot, opts.explicitBatchSize);
  const batches = planBatches(manifest, opts.roundId, opts.judge, opts.run, batchSize);
  if (opts.batch > batches.length) {
    throw new UsageError(`第 ${opts.batch} 批超出范围（共 ${batches.length} 批，每批最多 ${batchSize} 张）`);
  }

  const picked = batches[opts.batch - 1]!;
  const capturedMap = new Map(manifest.shots.map((s) => [s.key, s]));
  const records = readRoundRecords(opts.repoRoot);
  const prevReview = [...records].reverse().find((r) => r.kind === "review" || r.kind === "confirm");
  const dismissed =
    prevReview?.findings
      .filter((f): f is typeof f & { dismissed: string } => f.dismissed !== undefined)
      .map((f) => ({ shotKey: f.shotKey, what: f.what, reason: f.dismissed })) ?? [];

  const cardsDir = cardsDirForBatch(outDir, opts.roundId, opts.judge, batchSize, opts.explicitBatchSize, opts.run, opts.batch);
  const text = judgeBrief({
    judge: opts.judge,
    run: opts.run,
    baselineImage: join(opts.repoRoot, RECORD_DIR, "baseline", "baseline.png"),
    styleBrief: join(opts.repoRoot, RECORD_DIR, "baseline", "style-brief.md"),
    shots: picked.map((shot) => {
      const cs = capturedMap.get(shot.key)!;
      return {
        shot,
        file: join(outDir, cs.file),
        ...(cs.focusFile === undefined ? {} : { focusFile: join(outDir, cs.focusFile) }),
        sha256: cs.sha256,
        machineFacts: cs.machineFindings.map((mf) => `${mf.rule}（${mf.severity}）：${mf.what}`),
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
  const manifest = readManifest(outDir);
  const capturedMap = new Map(manifest.shots.map((s) => [s.key, s]));
  const errors: string[] = [];

  if (opts.batch !== undefined) {
    const run = opts.run ?? 1;
    const batchSize = resolveBatchSize(opts.repoRoot, opts.explicitBatchSize);
    const batches = planBatches(manifest, opts.roundId, opts.judge, run, batchSize);
    if (opts.batch > batches.length) {
      throw new UsageError(`第 ${opts.batch} 批超出范围（共 ${batches.length} 批）`);
    }
    const picked = batches[opts.batch - 1]!;
    const cardsDir = cardsDirForBatch(outDir, opts.roundId, opts.judge, batchSize, opts.explicitBatchSize, run, opts.batch);

    for (const shot of picked) {
      const filePath = join(cardsDir, `${shot.key}.json`);
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
      const cs = capturedMap.get(shot.key)!;
      if (card.shot !== shot.key) errors.push(`${filePath}：shot 写成了 ${card.shot}，应为 ${shot.key}`);
      if (card.judge !== opts.judge) errors.push(`${filePath}：judge 写成了 ${card.judge}，应为 ${opts.judge}`);
      if (card.run !== run) errors.push(`${filePath}：run 写成了 ${card.run}，应为 ${run}`);
      if (card.imageSha256 !== cs.sha256) errors.push(`${filePath}：imageSha256 与清单不一致（应为 ${cs.sha256}）`);
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
  const seen = new Map<string, ScoreCard>();

  for (const filePath of files) {
    const parsed = parseScoreCard(readFileSync(filePath, "utf8"));
    if (!parsed.ok) {
      errors.push(`${filePath}：${parsed.reason}`);
      continue;
    }
    const card = parsed.card;
    if (opts.run !== undefined && card.run !== opts.run) continue;
    if (card.judge !== opts.judge) errors.push(`${filePath}：judge 写成了 ${card.judge}，应为 ${opts.judge}`);
    const cs = capturedMap.get(card.shot);
    if (cs === undefined) {
      errors.push(`${filePath}：清单里没有 ${card.shot}`);
    } else if (card.imageSha256 !== cs.sha256) {
      errors.push(`${filePath}：imageSha256 与清单不一致（应为 ${cs.sha256}）`);
    }
    const id = `${card.shot}#${card.run}`;
    if (seen.has(id)) errors.push(`${filePath}：${card.shot}（run ${card.run}）重复交卡`);
    seen.set(id, card);
  }

  const expectedRuns =
    opts.run !== undefined
      ? [opts.run]
      : opts.roundId.startsWith("C")
        ? Array.from({ length: CALIBRATION_RUNS }, (_, i) => i + 1)
        : [1];
  for (const r of expectedRuns) {
    for (const cs of manifest.shots) {
      if (!seen.has(`${cs.key}#${r}`)) {
        errors.push(`缺评分卡：${cs.key}（run ${r}）`);
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`自查未通过（${errors.length} 处问题）：\n${errors.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`自查通过：${seen.size} 张评分卡全部合格\n`);
  return 0;
}

function loadCardsFromDir(dir: string): ScoreCard[] {
  const files = collectJsonFiles(dir);
  const cards: ScoreCard[] = [];
  const bad: string[] = [];
  for (const filePath of files) {
    const parsed = parseScoreCard(readFileSync(filePath, "utf8"));
    if (!parsed.ok) {
      bad.push(`${filePath}：${parsed.reason}`);
    } else {
      cards.push(parsed.card);
    }
  }
  if (bad.length > 0) {
    throw new Error(`发现格式不合格的评分卡：\n${bad.join("\n")}`);
  }
  return cards;
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
  const allCards = loadCardsFromDir(join(outDir, "cards"));
  const dismissals: Dismissal[] =
    opts.dismissalsFile === undefined ? [] : (JSON.parse(readFileSync(opts.dismissalsFile, "utf8")) as Dismissal[]);

  const sentinelShots = manifest.shots.filter((s) => s.key.includes("!"));
  if (sentinelShots.length > 0) {
    const records = readRoundRecords(opts.repoRoot);
    const calRec = [...records].reverse().find((r) => r.kind === "calibration");
    if (calRec !== undefined) {
      const calDir = join(opts.outRoot, calRec.id, "cards");
      const calCards = loadCardsFromDir(calDir);
      if (calCards.length > 0) {
        const drifted = sentinelDrift(
          calCards,
          allCards,
          sentinelShots.map((s) => s.key),
        );
        if (drifted.length > 0) {
          process.stderr.write(`哨兵图漂移超标，本轮评审作废需重评：${drifted.join("、")}\n`);
          return 1;
        }
      }
    }
  }

  const evalShots = manifest.shots.filter((s) => !s.key.includes("!"));
  const evalKeys = new Set(evalShots.map((s) => s.key));
  const evalManifest: CaptureManifest = { ...manifest, shots: evalShots };
  const evalCards = allCards.filter((c) => evalKeys.has(c.shot));
  const scores = mergeRound({ manifest: evalManifest, cards: evalCards, dismissals });

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

  const shaMap = new Map(evalShots.map((s) => [s.key, s.sha256]));
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
      `- 基准图重度发现（P0/P1）：${rep.baselineSevere.length} 条`,
      ...Object.entries(rep.stableShare).map(([j, s]) => `- 复评稳定率（${j}）：${(s * 100).toFixed(1)}%`),
      "",
      "| 弄坏 | 评委 | 分差（基准 - 弄坏） | 命中次数 | 结果 |",
      "| --- | --- | --- | --- | --- |",
      ...rep.mutations.map((m) => `| \`${m.id}\` | ${m.judge} | ${m.gap} | ${m.hits}/${CALIBRATION_RUNS} | ${m.ok ? "合格" : "不合格"} |`),
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
  const cardsRoot = join(outDir, "cards");
  const reports = new Map<number, CalibrationReport>();
  let allJudges = new Set<string>();

  for (const size of JUDGE_BATCH_CANDIDATES) {
    const dir = join(cardsRoot, `batch-size-${size}`);
    if (!existsSync(dir)) continue;
    const cards = loadCardsFromDir(dir);
    if (cards.length === 0) continue;
    for (const c of cards) allJudges.add(c.judge);
    reports.set(size, calibrationReport({ manifest, cards, baselineKey: CALIBRATION_BASELINE, mutations: MUTATIONS }));
  }

  if (reports.size === 0) {
    const fallbackCards = loadCardsFromDir(cardsRoot);
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

async function shots(outDir: string, only: readonly string[] | undefined, verify: boolean): Promise<number> {
  const started = Date.now();
  const first = await captureAll({ repoRoot: REPO_ROOT, outDir, ...(only === undefined ? {} : { only }) });
  report(first, outDir, started);
  if (!verify) return 0;
  const again = mkdtempSync(join(ROUND_OUTPUT_DIR, ".verify-"));
  const second = await captureAll({ repoRoot: REPO_ROOT, outDir: again, ...(only === undefined ? {} : { only }) });
  const diff = diffManifests(first, second);
  process.stdout.write(`两遍 ${diff.length} 张不同${diff.length > 0 ? `：${diff.join("、")}` : ""}，两遍共用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒\n`);
  if (diff.length === 0) {
    rmSync(again, { recursive: true, force: true });
    return 0;
  }
  process.stdout.write(`第二遍的图留在 ${again}，和 ${outDir} 里同名的图对比\n`);
  return 1;
}

async function calibrateShots(outDir: string): Promise<number> {
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
