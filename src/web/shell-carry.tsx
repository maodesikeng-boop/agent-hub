import { createContext, useContext, useLayoutEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const ScopeContext = createContext<object | null>(null);

interface Carried {
  value: unknown;
  scope: object;
}

// One entry per mounted carried state: the owner's cleanup deletes it, or the next shell's instance takes it over.
const carried = new Map<string, Carried>();

/** Wraps one shell's tree. The workbench gives it a new key whenever it swaps the one-column and the multi-column shell. */
export function ShellCarryScope({ children }: { children: ReactNode }) {
  const [scope] = useState(() => ({}));
  return <ScopeContext value={scope}>{children}</ScopeContext>;
}

/**
 * Precondition: key names one piece of user input or selection and is unique among mounted components.
 * Postcondition: behaves as useState, except that an instance mounting in a new shell tree starts from the value the same key
 * held in the previous tree when it renders in the same task that swaps the shells. A remount inside one tree starts from
 * initial, and an instance outside a ShellCarryScope is plain useState.
 */
export function useShellCarry<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const scope = useContext(ScopeContext);
  const [value, setValue] = useState<T>(() => {
    const left = carried.get(key);
    if (scope !== null && left !== undefined && left.scope !== scope) return left.value as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useLayoutEffect(() => {
    if (scope === null) return;
    const entry: Carried = { value, scope };
    carried.set(key, entry);
    // Content behind a portal in the new tree mounts in a follow-up render of the same task, after this cleanup.
    return () =>
      queueMicrotask(() => {
        if (carried.get(key) === entry) carried.delete(key);
      });
  }, [key, value, scope]);
  return [value, setValue];
}
