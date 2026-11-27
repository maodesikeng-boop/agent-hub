// Run directory naming and bounded retention helpers for pnpm eval.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isActive } from "./lifecycle.ts";
import { EVAL_KEEP_FAILED_WORK, EVAL_KEEP_RUN_DAYS, EVAL_KEEP_RUNS } from "./limits.ts";
import type { ScenarioId, TrialResult } from "./types.ts";

export interface VersionInfo {
  label: string;
  ref: string;
  commit: string;
  subject: string;
}

export interface Summary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  versions: VersionInfo[];
  scenarios: Array<{ id: ScenarioId; title: string; source: string }>;
  trials: TrialResult[];
}

export function runIdOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function pruneRuns(runsDir: string, now = Date.now()): string[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((n) => /^\d{8}-\d{6}(?:-\d{3}(?:-[a-f0-9]+)?)?$/.test(n))
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const [i, name] of runs.entries()) {
    const path = join(runsDir, name);
    if (isActive(path)) continue;
    const tooOld = now - statSync(path).mtimeMs > EVAL_KEEP_RUN_DAYS * 86_400_000;
    if (i < EVAL_KEEP_RUNS && !tooOld) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export function pruneFailedWork(workRoot: string): string[] {
  if (!existsSync(workRoot)) return [];
  const dirs = readdirSync(workRoot)
    .filter((n) => n.startsWith("ah-eval-"))
    .map((n) => ({ path: join(workRoot, n), mtime: statSync(join(workRoot, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const d of dirs.slice(EVAL_KEEP_FAILED_WORK)) {
    if (isActive(d.path)) continue;
    rmSync(d.path, { recursive: true, force: true });
    removed.push(d.path);
  }
  return removed;
}
