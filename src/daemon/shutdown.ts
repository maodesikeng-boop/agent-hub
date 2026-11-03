// 关机的总上限：daemon.ts 里每一步各有上限，但 await stopped、界面服务关闭、db.close() 合起来没有，
// 一步卡住就只能靠第二次信号兜底。main.ts 用 stopWithinLimit 包一层，到点就记日志、以非 0 退出码退出。
/** 返回退出码：在 ms 内关完是 0；出错或超时记一条日志，是 1。 */
export async function stopWithinLimit(stop: () => Promise<void>, ms: number, log: (line: string) => void): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
  try {
    const result = await Promise.race([stop().then(() => "stopped" as const), timeout]);
    if (result === "timeout") {
      log(`agent-hub: 关机 ${ms / 1000} 秒还没关完，不再等，直接退出。`);
      return 1;
    }
    return 0;
  } catch (error) {
    log(`agent-hub: 关闭时出错：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
