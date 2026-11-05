import { useEffect, useState } from "react";

/** 窄屏：左栏收成抽屉（docs/ui-standard.md 第 15 条）。和 CSS 里的 max-[1100px] 是同一个断点。 */
export const NARROW_QUERY = "(max-width: 1100px)";
/** 太窄、右栏放不下并排：改成顶栏下面的一块（第 12 条）。 */
export const COMPACT_QUERY = "(max-width: 719px)";

const matches = (query: string) => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);

/** 媒体查询现在成不成立，窗口大小变了跟着变。没有 matchMedia 的环境（测试）当不成立。 */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return value;
}
