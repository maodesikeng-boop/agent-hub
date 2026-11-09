import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** styles.css 的 @theme 里自定义的字号（text-title、text-body……）。不告诉 tailwind-merge 的话，它会把它们当成文字颜色，和 text-muted-foreground 合并时被删掉。 */
const FONT_SIZE_TOKENS = ["display", "title", "body", "label", "minor", "small"] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...FONT_SIZE_TOKENS] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
