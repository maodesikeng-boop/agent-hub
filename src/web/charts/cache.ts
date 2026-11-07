// 图表渲染结果缓存（LRU）：块卸载再挂上（切对话再切回来、流式重渲染）直接同步取，不闪转圈、不重画。
import { CHART_CACHE_SIZE } from "./registry.ts";

/** 缓存里的一条：画好的 SVG，或者这段源码渲染失败的原因（失败也缓存，同样的源码不反复报错重试）。 */
export type ChartCacheEntry = { ok: true; svg: string } | { ok: false; message: string };

/** 最久没用的先丢；get 也算用过。Map 的插入顺序就是新旧顺序。 */
export class ChartLruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const chartCache = new ChartLruCache<ChartCacheEntry>(CHART_CACHE_SIZE);

/** 缓存键：语言 + 源码 + 主题版本。用 NUL 隔开，三段不会拼混。 */
export function chartCacheKey(language: string, source: string, themeVersion: string): string {
  return `${language}\0${themeVersion}\0${source}`;
}
