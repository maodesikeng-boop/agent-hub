// 会话里的后台任务（claude 的 system/background_tasks_changed，见 docs/m0-report.md 的“后台任务事件”）和空闲关闭的判断。
// 驱动层只在这里认“有没有后台任务”和“空闲多久后关”，别处不要再自己数。

/** 记一个会话现在有哪些后台任务。事件里的 tasks 是完整的当前名单，每次整个换掉，不靠增减去算。 */
export class BackgroundTasks {
  /** task_id → description。 */
  #tasks = new Map<string, string>();

  /** 有几个任务在跑。 */
  get count(): number {
    return this.#tasks.size;
  }

  get active(): boolean {
    return this.#tasks.size > 0;
  }

  /**
   * 用事件里的名单换掉记的。tasks 不是数组就当没收到（返回 false，记的不动）；名单里不认识的条目跳过，
   * 同一个 task_id 重复只算一个，ambient（Claude Code 自己的、不算会话的活）不算。
   */
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

  /** 现在每个任务的 description（进程被关掉前取，给“后台任务被结束了”的说明用）。 */
  descriptions(): string[] {
    return [...this.#tasks.values()];
  }

  /** 进程起来、退出时都清掉：后台任务跟着进程走，新进程不会带着旧的。 */
  clear(): void {
    this.#tasks.clear();
  }
}

/** 空闲计时的时长：没有后台任务就是 idleCloseMs；有就放宽到 holdMaxMs（卡死的兜底，不会比 idleCloseMs 还短）。 */
export function idleDelayMs(tasks: BackgroundTasks, idleCloseMs: number, holdMaxMs: number): number {
  return tasks.active ? Math.max(idleCloseMs, holdMaxMs) : idleCloseMs;
}
