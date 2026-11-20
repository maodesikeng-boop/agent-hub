import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register custom font-size tokens; tailwind-merge otherwise treats them as text colors and drops one.
const FONT_SIZE_TOKENS = ["display", "title", "body", "minor"] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...FONT_SIZE_TOKENS] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
