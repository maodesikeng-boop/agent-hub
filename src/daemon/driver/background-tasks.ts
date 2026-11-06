// 会话里的后台任务（claude 的 system/background_tasks_changed，见 docs/m0-report.md 的“后台任务事件”）和空闲关闭的判断。
// 驱动层只在这里认“有没有后台任务”和“空闲多久后关”，别处不要再自己数。

/** 记一个会话现在有哪些后台任务。事件里的 tasks 是完整的当前名单，每次整个换掉，不靠增减去算。 */
export class BackgroundTasks {
  #ids = new Set<string>();

  /** 有几个任务在跑。 */
  get count(): number {
    return this.#ids.size;
  }

  get active(): boolean {
    return this.#ids.size > 0;
  }

  /**
   * 用事件里的名单换掉记的。tasks 不是数组就当没收到（返回 false，记的不动）；名单里不认识的条目跳过，
   * 同一个 task_id 重复只算一个，ambient（Claude Code 自己的、不算会话的活）不算。
   */
  replace(tasks: unknown): boolean {
    if (!Array.isArray(tasks)) return false;
    const ids = new Set<string>();
    for (const t of tasks) {
      if (typeof t !== "object" || t === null) continue;
      const { task_id: id, ambient } = t as { task_id?: unknown; ambient?: unknown };
      if (typeof id === "string" && id !== "" && ambient !== true) ids.add(id);
    }
    this.#ids = ids;
    return true;
  }

  /** 进程起来、退出时都清掉：后台任务跟着进程走，新进程不会带着旧的。 */
  clear(): void {
    this.#ids.clear();
  }
}

/** 空闲计时的时长：没有后台任务就是 idleCloseMs；有就放宽到 holdMaxMs（卡死的兜底，不会比 idleCloseMs 还短）。 */
export function idleDelayMs(tasks: BackgroundTasks, idleCloseMs: number, holdMaxMs: number): number {
  return tasks.active ? Math.max(idleCloseMs, holdMaxMs) : idleCloseMs;
}
