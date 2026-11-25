import type { BackgroundTaskInfo } from "../../shared/driver.ts";

// Invariant: tracked background tasks per session are bounded by MAX_BACKGROUND_TASKS_TRACKED, labels are clipped to BACKGROUND_TASK_LABEL_MAX_CHARS, and first-seen startedAt is preserved across list updates.

/**
 * Precondition: rawTasks is the vendor-supplied background task array (or arbitrary malformed payload); previous holds the previously tracked tasks for this session; at is epoch ms.
 * Postcondition: returns null when rawTasks is not an array; otherwise returns a new map excluding ambient and invalid entries, bounded by MAX_BACKGROUND_TASKS_TRACKED, preserving previous startedAt (or using valid vendor started_at) and clipping labels to BACKGROUND_TASK_LABEL_MAX_CHARS.
 */
export function normalizeBackgroundTasks(
  _rawTasks: unknown,
  _previous: ReadonlyMap<string, BackgroundTaskInfo>,
  _at: number,
): Map<string, BackgroundTaskInfo> | null {
  throw new Error("Not implemented");
}

export class BackgroundTasks {
  #tasks = new Map<string, string>();

  get count(): number {
    return this.#tasks.size;
  }

  get active(): boolean {
    return this.#tasks.size > 0;
  }

  replace(tasks: unknown): boolean {
    if (!Array.isArray(tasks)) return false;
    const next = new Map<string, string>();
    for (const t of tasks) {
      if (typeof t !== "object" || t === null) continue;
      const { task_id: id, ambient, description } = t as { task_id?: unknown; ambient?: unknown; description?: unknown };
      if (typeof id === "string" && id !== "" && ambient !== true) next.set(id, typeof description === "string" ? description : "");
    }
    this.#tasks = next;
    return true;
  }

  descriptions(): string[] {
    return [...this.#tasks.values()];
  }

  clear(): void {
    this.#tasks.clear();
  }
}

export function idleDelayMs(tasks: BackgroundTasks, idleCloseMs: number, holdMaxMs: number): number {
  return tasks.active ? Math.max(idleCloseMs, holdMaxMs) : idleCloseMs;
}
