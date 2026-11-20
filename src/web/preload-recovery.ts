import { PRELOAD_RELOAD_GUARD_MS } from "../shared/limits.ts";

export const PRELOAD_RELOAD_KEY = "agent-hub.preloadReloadAt";

export interface PreloadRecoveryEnv {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  now: () => number;
}

const browserEnv = (): PreloadRecoveryEnv => ({
  target: window,
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  now: Date.now,
});

function claimReload(env: PreloadRecoveryEnv): boolean {
  try {
    const store = env.storage();
    const last = Number(store.getItem(PRELOAD_RELOAD_KEY));
    if (Number.isFinite(last) && env.now() - last < PRELOAD_RELOAD_GUARD_MS) return false;
    store.setItem(PRELOAD_RELOAD_KEY, String(env.now()));
    return true;
  } catch {
    return false;
  }
}

// After an upgrade an open tab still asks for old hashed chunks; one reload picks up the new index.html, and the guard stops a real outage from looping.
export function installPreloadRecovery(env: PreloadRecoveryEnv = browserEnv()): () => void {
  const onPreloadError = (event: Event) => {
    if (!claimReload(env)) return;
    event.preventDefault();
    env.reload();
  };
  env.target.addEventListener("vite:preloadError", onPreloadError);
  return () => env.target.removeEventListener("vite:preloadError", onPreloadError);
}
