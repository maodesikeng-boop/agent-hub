import { truncateChars } from "../../shared/domain.ts";
import type { BackgroundTaskInfo } from "../../shared/driver.ts";
import { BACKGROUND_TASK_ID_MAX_CHARS, BACKGROUND_TASK_LABEL_MAX_CHARS, MAX_BACKGROUND_TASKS_TRACKED } from "../../shared/limits.ts";
import { redactSecrets } from "../ledger/redact.ts";

export function normalizeBackgroundTasks(
  rawTasks: unknown,
  previous: ReadonlyMap<string, BackgroundTaskInfo>,
  at: number,
): Map<string, BackgroundTaskInfo> | null {
  if (!Array.isArray(rawTasks)) return null;
  const next = new Map<string, BackgroundTaskInfo>();
  for (const raw of rawTasks) {
    const task: unknown = raw;
    if (typeof task !== "object" || task === null || !("task_id" in task)) continue;
    const id = task.task_id;
    if (typeof id !== "string" || id === "" || id.length > BACKGROUND_TASK_ID_MAX_CHARS || ("ambient" in task && task.ambient === true)) continue;
    const command = "command" in task && typeof task.command === "string" ? task.command.trim() : "";
    const description = "description" in task && typeof task.description === "string" ? task.description.trim() : "";
    const rawStart = "started_at" in task ? task.started_at : null;
    const startedAt = typeof rawStart === "number" && Number.isFinite(rawStart) && rawStart > 0 && rawStart <= at ? rawStart : at;
    next.set(id, {
      id,
      label: truncateChars(redactSecrets(command || description).replace(/\s+/g, " "), BACKGROUND_TASK_LABEL_MAX_CHARS) || previous.get(id)?.label || "",
      startedAt: previous.get(id)?.startedAt ?? startedAt,
    });
    if (next.size === MAX_BACKGROUND_TASKS_TRACKED) break;
  }
  return next;
}

export class BackgroundTasks {
  #tasks = new Map<string, BackgroundTaskInfo>();

  get count(): number {
    return this.#tasks.size;
  }

  get active(): boolean {
    return this.count > 0;
  }

  replace(tasks: unknown, at = Date.now()): boolean {
    const next = normalizeBackgroundTasks(tasks, this.#tasks, at);
    if (next === null) return false;
    this.#tasks = next;
    return true;
  }

  snapshot(): BackgroundTaskInfo[] {
    return [...this.#tasks.values()];
  }

  descriptions(): string[] {
    return this.snapshot().map((task) => task.label);
  }

  clear(): void {
    this.#tasks.clear();
  }
}

export function idleDelayMs(tasks: BackgroundTasks, idleCloseMs: number, holdMaxMs: number): number {
  return tasks.active ? Math.max(idleCloseMs, holdMaxMs) : idleCloseMs;
}
