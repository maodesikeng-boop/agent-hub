import { useCallback, useSyncExternalStore } from "react";

const matches = (query: string) => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);

/** Postcondition: returns whether query matches now; reading it during render means a changed query never answers with the old one. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matches(query), () => false);
}

export const MOBILE_SHELL_QUERY = "(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 599px)";
