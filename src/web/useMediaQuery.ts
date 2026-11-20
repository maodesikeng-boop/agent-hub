import { useEffect, useState } from "react";

export const NARROW_QUERY = "(max-width: 1100px)";
export const COMPACT_QUERY = "(max-width: 719px)";

const matches = (query: string) => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);

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

export const MOBILE_SHELL_QUERY = "(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 599px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_SHELL_QUERY);
}
