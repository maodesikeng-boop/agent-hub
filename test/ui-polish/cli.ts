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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureAll, diffManifests, type CaptureManifest } from "./capture.ts";
import { MACHINE_CHECKS } from "./checks.ts";
import { ROUND_OUTPUT_DIR } from "./limits.ts";
import { CALIBRATION_BASELINE, CALIBRATION_REAL_SHOTS, MUTATIONS } from "./mutations.ts";
import { SCREEN_INVENTORY, inventoryMarkdown } from "./screens.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROUND_PATTERN = /^[A-Z]\d{1,2}(?:-confirm)?$/;

const USAGE = `用法：pnpm ui:polish <命令>
  inventory
  shots [--round R01] [--only <界面或区域>[,<界面或区域>…]]… [--verify]
  calibrate-shots [--round C1]
  brief --round <id> --judge <厂商/模型> --batch <n> [--batch-size <n>] [--run <n>]
  check-cards --round <id> --judge <厂商/模型>
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
      case "brief":
      case "check-cards":
      case "score":
      case "calibration":
      case "report":
        throw new Error("未实现");
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

function roundDir(round: string | undefined, fallback: string): string {
  const id = round ?? fallback;
  if (!ROUND_PATTERN.test(id)) throw new UsageError(`轮次 ${id} 不对，要像 R01、C1 这样：一个大写字母加一到两位数字`);
  return join(ROUND_OUTPUT_DIR, id);
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
