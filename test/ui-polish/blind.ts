// 盲测编号（docs/ui-polish-loop-design.md 第 3.3、3.5 节）：评委看到的图和评分卡只用不透明的编号 item-NNN，
// 看不出哪张是基准图、哪张弄坏过、哪张是哨兵。编号和真实界面的对照只存在轮次目录的 blind.json，
// check-cards、score、calibration 拿它把评分卡换回真实的 key。
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureManifest, CapturedShot } from "./capture.ts";
import type { MachineFinding } from "./checks.ts";
import type { ViewportName } from "./limits.ts";
import type { ScoreCard } from "./rubric.ts";
import { seededShuffle } from "./screens.ts";

export const BLIND_PLAN_FILE = "blind.json";
/** 评委看的图按编号复制在轮次目录的这个子目录里。 */
const JUDGE_DIR = "judge";

export interface BlindItem {
  id: string;
  /** 真实的图：平常的图是这一轮清单里的 key；哨兵是校准轮清单里的 key。 */
  key: string;
  sentinel: boolean;
  screenId: string;
  viewport: ViewportName;
  sha256: string;
  /** 评委看的那一份，相对轮次目录。 */
  file: string;
  focusFile?: string;
  machineFindings: MachineFinding[];
}

export interface BlindPlan {
  /** 哨兵图取自哪个校准轮；没混哨兵是 null。 */
  sentinelsFrom: string | null;
  items: BlindItem[];
}

/** 混进这一轮的哨兵图：校准轮的目录和那几张图在校准轮清单里的条目。 */
export interface SentinelSource {
  roundId: string;
  dir: string;
  shots: readonly CapturedShot[];
}

/**
 * 后置：manifest 里的每张图和每张哨兵图各编一个号，编号按 seed 打乱（同样的输入同样的编号）；
 * 图复制到 outDir/judge/<编号>.png（局部图是 <编号>.focus.png），对照表写进 outDir/blind.json。旧的 judge/ 先清掉。
 */
export function writeBlindPlan(outDir: string, manifest: CaptureManifest, seed: number, sentinels?: SentinelSource): BlindPlan {
  const sources = [
    ...manifest.shots.map((shot) => ({ shot, dir: outDir, sentinel: false })),
    ...(sentinels?.shots ?? []).map((shot) => ({ shot, dir: sentinels!.dir, sentinel: true })),
  ];
  const width = Math.max(3, String(sources.length).length);
  rmSync(join(outDir, JUDGE_DIR), { recursive: true, force: true });
  mkdirSync(join(outDir, JUDGE_DIR), { recursive: true });
  const copy = (from: string, name: string) => {
    const file = join(JUDGE_DIR, name);
    copyFileSync(from, join(outDir, file), constants.COPYFILE_FICLONE);
    return file;
  };
  const items = seededShuffle(sources, seed).map(({ shot, dir, sentinel }, i): BlindItem => {
    const id = `item-${String(i + 1).padStart(width, "0")}`;
    return {
      id,
      key: shot.key,
      sentinel,
      screenId: shot.screenId,
      viewport: shot.viewport,
      sha256: shot.sha256,
      file: copy(join(dir, shot.file), `${id}.png`),
      ...(shot.focusFile === undefined ? {} : { focusFile: copy(join(dir, shot.focusFile), `${id}.focus.png`) }),
      machineFindings: shot.machineFindings,
    };
  });
  const plan: BlindPlan = { sentinelsFrom: sentinels?.roundId ?? null, items };
  writeFileSync(join(outDir, BLIND_PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

/** 读 outDir/blind.json；还没有返回 null。 */
export function readBlindPlan(outDir: string): BlindPlan | null {
  const path = join(outDir, BLIND_PLAN_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BlindPlan) : null;
}

/** 对照表里平常的图和清单一张不差（重截过就对不上了）。 */
export function planMatches(plan: BlindPlan, manifest: CaptureManifest): boolean {
  const fingerprint = (s: { key: string; sha256: string }) => `${s.key}|${s.sha256}`;
  const planned = plan.items.filter((i) => !i.sentinel).map(fingerprint).sort();
  const captured = manifest.shots.map(fingerprint).sort();
  return planned.length === captured.length && planned.every((p, i) => p === captured[i]);
}

/** 评分卡上写的是编号：换回真实的 key，带上它是哪一项。编号不在对照表里返回 undefined。 */
export function unblindCard(plan: BlindPlan, card: ScoreCard): { card: ScoreCard; item: BlindItem } | undefined {
  const item = plan.items.find((i) => i.id === card.shot);
  return item === undefined ? undefined : { card: { ...card, shot: item.key }, item };
}
