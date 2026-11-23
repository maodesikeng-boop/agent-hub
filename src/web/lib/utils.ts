import { clsx, type ClassValue } from "clsx";
import { LRUCache } from "lru-cache";
import { extendTailwindMerge } from "tailwind-merge";
import { CN_CLASS_CACHE_MAX } from "../../shared/limits.ts";

// Register custom font-size tokens; tailwind-merge otherwise treats them as text colors and drops one.
const FONT_SIZE_TOKENS = ["display", "title", "body", "minor"] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...FONT_SIZE_TOKENS] } } });
const mergedCache = new LRUCache<string, string>({ max: CN_CLASS_CACHE_MAX });

export function cn(...inputs: ClassValue[]) {
  const joined = clsx(inputs);
  if (joined === "") return "";
  let merged = mergedCache.get(joined);
  if (merged === undefined) {
    merged = twMerge(joined);
    mergedCache.set(joined, merged);
  }
  return merged;
}
