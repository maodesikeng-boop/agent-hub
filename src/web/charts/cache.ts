import { CHART_CACHE_SIZE } from "./registry.ts";

export type ChartCacheEntry = { ok: true; svg: string } | { ok: false; message: string };

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

export function chartCacheKey(language: string, source: string, themeVersion: string): string {
  return `${language}\0${themeVersion}\0${source}`;
}
