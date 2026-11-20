// Each shutdown step has its own limit, but their sum does not, so the whole shutdown is capped here.
import { LOG_PREFIX } from "../shared/names.ts";

export async function stopWithinLimit(stop: () => Promise<void>, ms: number, log: (line: string) => void): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
  try {
    const result = await Promise.race([stop().then(() => "stopped" as const), timeout]);
    if (result === "timeout") {
      log(`${LOG_PREFIX} 关机 ${ms / 1000} 秒还没关完，不再等，直接退出。`);
      return 1;
    }
    return 0;
  } catch (error) {
    log(`${LOG_PREFIX} 关闭时出错：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
