import { PRELOAD_RECOVERY_KEYS_MAX } from "../shared/limits.ts";

export const PRELOAD_RECOVERED_KEY = "agent-hub.preloadRecovered";

export interface PreloadRecoveryEnv {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  build: string;
}

const browserEnv = (): PreloadRecoveryEnv => ({
  target: window,
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  build: import.meta.url,
});

function readRecovered(store: Pick<Storage, "getItem">): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(PRELOAD_RECOVERED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function failedResourceOf(event: Event): string {
  const payload = (event as Event & { payload?: unknown }).payload;
  return payload instanceof Error ? payload.message : String(payload);
}

// One reload per build and failing chunk: a timestamp window would let a 404 that arrives after the window loop forever.
function claimReload(env: PreloadRecoveryEnv, resource: string): boolean {
  try {
    const store = env.storage();
    const key = `${env.build} ${resource}`;
    const recovered = readRecovered(store);
    if (recovered.includes(key)) return false;
    store.setItem(PRELOAD_RECOVERED_KEY, JSON.stringify([...recovered, key].slice(-PRELOAD_RECOVERY_KEYS_MAX)));
    return true;
  } catch {
    return false;
  }
}

// After an upgrade an open tab still asks for old hashed chunks; one reload picks up the new index.html.
export function installPreloadRecovery(env: PreloadRecoveryEnv = browserEnv()): () => void {
  const onPreloadError = (event: Event) => {
    if (!claimReload(env, failedResourceOf(event))) return;
    event.preventDefault();
    env.reload();
  };
  env.target.addEventListener("vite:preloadError", onPreloadError);
  return () => env.target.removeEventListener("vite:preloadError", onPreloadError);
}
