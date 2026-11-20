import { describe, expect, it, vi } from "vitest";
import { PRELOAD_RECOVERY_KEYS_MAX } from "../shared/limits.ts";
import { PRELOAD_RECOVERED_KEY, installPreloadRecovery, type PreloadRecoveryEnv } from "./preload-recovery.ts";

function memoryStore(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

function setup(store = memoryStore(), build = "/assets/index-A.js") {
  const target = new EventTarget();
  const env: PreloadRecoveryEnv = { target, storage: () => store, reload: vi.fn(), build };
  const uninstall = installPreloadRecovery(env);
  const fire = (chunk = "/assets/highlight-X.js") => {
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: new TypeError(`Failed to fetch dynamically imported module: ${chunk}`) });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { env, store, fire, uninstall };
}

describe("preload recovery", () => {
  it("swallows a stale chunk error and reloads once", () => {
    const { env, store, fire } = setup();
    expect(fire()).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.getItem(PRELOAD_RECOVERED_KEY)!)).toEqual(["/assets/index-A.js Failed to fetch dynamically imported module: /assets/highlight-X.js"]);
  });

  it("lets the same chunk failure surface after the reload, however late it arrives", () => {
    const store = memoryStore();
    const before = setup(store);
    expect(before.fire()).toBe(true);
    const after = setup(store);
    expect(after.fire()).toBe(false);
    expect(after.fire()).toBe(false);
    expect(after.env.reload).not.toHaveBeenCalled();
  });

  it("recovers again for a different chunk or a newer build", () => {
    const store = memoryStore();
    const first = setup(store);
    expect(first.fire()).toBe(true);
    expect(first.fire("/assets/mermaid-Y.js")).toBe(true);
    expect(setup(store, "/assets/index-B.js").fire()).toBe(true);
  });

  it("keeps the recovery record bounded", () => {
    const { store, fire } = setup();
    for (let i = 0; i <= PRELOAD_RECOVERY_KEYS_MAX; i++) fire(`/assets/chunk-${i}.js`);
    expect(JSON.parse(store.getItem(PRELOAD_RECOVERED_KEY)!)).toHaveLength(PRELOAD_RECOVERY_KEYS_MAX);
  });

  it("does not reload when sessionStorage is unavailable, and stops listening once uninstalled", () => {
    const blocked = { getItem: () => null, setItem: () => { throw new DOMException("denied", "SecurityError"); } };
    const denied = setup(blocked);
    expect(denied.fire()).toBe(false);
    expect(denied.env.reload).not.toHaveBeenCalled();
    const { env, fire, uninstall } = setup();
    uninstall();
    expect(fire()).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
  });
});
