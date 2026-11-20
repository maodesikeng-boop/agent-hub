import { describe, expect, it, vi } from "vitest";
import { PRELOAD_RELOAD_GUARD_MS } from "../shared/limits.ts";
import { PRELOAD_RELOAD_KEY, installPreloadRecovery, type PreloadRecoveryEnv } from "./preload-recovery.ts";

function memoryStore(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

function setup(store = memoryStore()) {
  const target = new EventTarget();
  const clock = { t: 100_000 };
  const env: PreloadRecoveryEnv = { target, storage: () => store, reload: vi.fn(), now: () => clock.t };
  const uninstall = installPreloadRecovery(env);
  const fire = () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { env, store, clock, fire, uninstall };
}

describe("preload recovery", () => {
  it("swallows a stale chunk error and reloads once", () => {
    const { env, store, clock, fire } = setup();
    expect(fire()).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(store.getItem(PRELOAD_RELOAD_KEY)).toBe(String(clock.t));
  });

  it("lets the error surface instead of looping when it repeats within the guard window", () => {
    const { env, clock, fire } = setup();
    fire();
    clock.t += PRELOAD_RELOAD_GUARD_MS - 1;
    expect(fire()).toBe(false);
    expect(env.reload).toHaveBeenCalledTimes(1);
    clock.t += 1;
    expect(fire()).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(2);
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
