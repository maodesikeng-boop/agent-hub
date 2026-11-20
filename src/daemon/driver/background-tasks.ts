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
