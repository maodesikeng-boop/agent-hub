import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerRequestError, SELF_RELOAD_QUIET_MS, SELF_RELOAD_RECHECK_MS } from "../shared/index.ts";
import { createBusySessions, createSelfReload, createStagedWebBuild, type BuildOutcome, type SelfReloadOptions } from "./self-reload.ts";

/** 可控的“全库忙不忙”和账本变化。 */
function harness(overrides: Partial<SelfReloadOptions> = {}) {
  let busy: string[] = [];
  const listeners = new Set<() => void>();
  const restart = vi.fn();
  const lines: string[] = [];
  const reload = createSelfReload({
    busyReasons: () => busy,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart,
    log: (line) => lines.push(line),
    ...overrides,
  });
  return {
    reload,
    restart,
    lines,
    listeners,
    /** 改忙闲并推一条账本变化。 */
    setBusy(reasons: string[], emit = true) {
      busy = reasons;
      if (emit) for (const l of [...listeners]) l();
    },
  };
}

describe("空闲排空热重启（createSelfReload）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("登记立即返回；有会话在跑就一直等，收尾停稳后再静默 SELF_RELOAD_QUIET_MS 才重启，且只重启一次", () => {
    const h = harness();
    h.setBusy(["1 个会话还在跑"], false);
    const result = h.reload.request({ build: false, by: "项目经理会话 1" });
    expect(result.text).toContain("已登记空闲排空热重启");
    expect(result.text).toContain("1 个会话还在跑");
    expect(result.status).toMatchObject({ state: "draining", build: false, busy: ["1 个会话还在跑"] });
    vi.advanceTimersByTime(10 * SELF_RELOAD_RECHECK_MS);
    expect(h.restart).not.toHaveBeenCalled();

    h.setBusy([]);
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS - 1);
    expect(h.restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.reload.status().state).toBe("restarting");
    expect(h.listeners.size).toBe(0);
    vi.advanceTimersByTime(10 * SELF_RELOAD_RECHECK_MS);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(() => h.reload.request({ build: false, by: "x" })).toThrow(LedgerRequestError);
  });

  it("静默窗口里又有新轮次启动：顺延，重新等空闲再完整静默一次", () => {
    const h = harness();
    h.reload.request({ build: false, by: "pm" });
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS - 100);
    h.setBusy(["1 个会话还在跑"]);
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
    expect(h.restart).not.toHaveBeenCalled();
    h.setBusy([]);
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS - 1);
    expect(h.restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("忙碌状态悄悄结束（账本没推变化，如总助在途管线收尾）：靠兜底重查发现", () => {
    const h = harness();
    h.setBusy(["总助分派引擎有规划中或在途分派"], false);
    h.reload.request({ build: false, by: "pm" });
    h.setBusy([], false);
    vi.advanceTimersByTime(SELF_RELOAD_RECHECK_MS + SELF_RELOAD_QUIET_MS);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("多次登记合并成同一次：只有一组定时器、只重启一次，后来补的 --build 也并进来", async () => {
    let finishBuild: (o: BuildOutcome) => void = () => {};
    const build = vi.fn(() => new Promise<BuildOutcome>((resolve) => (finishBuild = resolve)));
    const applyBuild = vi.fn();
    const h = harness({ build, applyBuild });
    h.setBusy(["1 个会话还在跑"], false);
    h.reload.request({ build: false, by: "a" });
    const second = h.reload.request({ build: true, by: "b" });
    const third = h.reload.request({ build: true, by: "c" });
    expect(second.text).toContain("合并");
    expect(third.status).toMatchObject({ state: "building", build: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(1);
    h.setBusy([]);
    vi.advanceTimersByTime(10 * SELF_RELOAD_QUIET_MS);
    expect(h.restart).not.toHaveBeenCalled(); // 构建没完不重启
    finishBuild({ ok: true });
    await vi.waitFor(() => expect(h.reload.status().state).toBe("draining"));
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
    expect(applyBuild).toHaveBeenCalledTimes(1);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(applyBuild.mock.invocationCallOrder[0]!).toBeLessThan(h.restart.mock.invocationCallOrder[0]!);
  });

  it("--build 构建失败：取消本次重启、记日志和失败原因，不换产物；之后能重新登记", async () => {
    const applyBuild = vi.fn();
    const h = harness({ build: async () => ({ ok: false, reason: "退出码 1" }), applyBuild });
    h.reload.request({ build: true, by: "pm" });
    await vi.waitFor(() => expect(h.reload.status().state).toBe("idle"));
    vi.advanceTimersByTime(10 * SELF_RELOAD_RECHECK_MS);
    expect(h.restart).not.toHaveBeenCalled();
    expect(applyBuild).not.toHaveBeenCalled();
    expect(h.reload.status().lastFailure).toContain("构建失败（退出码 1）");
    expect(h.lines.some((l) => l.includes("热重启已取消"))).toBe(true);
    expect(h.listeners.size).toBe(0);
    h.reload.request({ build: false, by: "pm" });
    expect(h.reload.status().lastFailure).toBeNull();
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("换产物失败也取消重启", () => {
    const h = harness({
      build: async () => ({ ok: true }),
      applyBuild: () => {
        throw new Error("rename 失败");
      },
    });
    h.reload.request({ build: true, by: "pm" });
    return vi
      .waitFor(() => expect(h.reload.status().state).toBe("draining"))
      .then(() => {
        vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
        expect(h.restart).not.toHaveBeenCalled();
        expect(h.reload.status()).toMatchObject({ state: "idle", lastFailure: expect.stringContaining("rename 失败") });
      });
  });

  it("不支持 --build（没有 package.json）时直接报 invalid", () => {
    const h = harness();
    expect(() => h.reload.request({ build: true, by: "pm" })).toThrow(/不支持 --build/);
    expect(h.reload.status().state).toBe("idle");
  });

  it("关机：清掉定时器、取消订阅、打断构建，之后不会重启，也不再接受登记", () => {
    const signals: AbortSignal[] = [];
    const h = harness({
      build: (signal) => {
        signals.push(signal);
        return new Promise<BuildOutcome>(() => {});
      },
    });
    h.reload.request({ build: true, by: "pm" });
    h.reload.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * SELF_RELOAD_RECHECK_MS);
    expect(h.restart).not.toHaveBeenCalled();
    expect(() => h.reload.request({ build: false, by: "pm" })).toThrow(/正在关闭/);

    const idle = harness();
    idle.reload.request({ build: false, by: "pm" });
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS - 1);
    idle.reload.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
    expect(idle.restart).not.toHaveBeenCalled();
  });
});

describe("正在干活的会话（createBusySessions）", () => {
  it("按 session.status 的 activity 增删；结束、坏掉的不算", () => {
    const busy = createBusySessions();
    busy.onSessionStatus({ sessionId: 1, activity: "working", status: "running" });
    busy.onSessionStatus({ sessionId: 1, activity: "working", status: "running" });
    busy.onSessionStatus({ sessionId: 2, activity: "background", status: "running" });
    busy.onSessionStatus({ sessionId: 3, activity: "stopping", status: "running" });
    expect(busy.count()).toBe(3);
    busy.onSessionStatus({ sessionId: 1, activity: "idle", status: "idle" });
    busy.onSessionStatus({ sessionId: 2, activity: "background", status: "ended" });
    expect(busy.count()).toBe(1);
  });
});

describe("暂存构建网页（createStagedWebBuild）", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hub-self-reload-")));
    mkdirSync(join(root, "dist", "web"), { recursive: true });
    writeFileSync(join(root, "dist", "web", "index.html"), "old");
    writeFileSync(join(root, "package.json"), "{}");
    // 假的构建命令：读 --outDir，成功时写 index.html，FAIL 时退出码 1
    writeFileSync(
      join(root, "fake-build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--outDir") + 1];
if (process.argv.includes("FAIL")) { console.error("boom"); process.exit(1); }
mkdirSync(out, { recursive: true });
writeFileSync(out + "/index.html", "new");`,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (extra = "") =>
    createStagedWebBuild({
      repoDir: root,
      staticDir: join(root, "dist", "web"),
      logPath: join(root, "logs", "build.log"),
      command: `${JSON.stringify(process.execPath)} fake-build.mjs ${extra}`,
    });

  it("没有 package.json 返回 null（不支持 --build）", () => {
    rmSync(join(root, "package.json"));
    expect(make()).toBeNull();
  });

  it("构建到暂存目录，不碰正在用的那份；apply 才换上线", async () => {
    const build = make()!;
    expect(await build.build(new AbortController().signal)).toEqual({ ok: true });
    expect(readFileSync(join(root, "dist", "web", "index.html"), "utf8")).toBe("old");
    build.apply();
    expect(readFileSync(join(root, "dist", "web", "index.html"), "utf8")).toBe("new");
    expect(existsSync(join(root, "dist", ".web-reload-next"))).toBe(false);
    expect(existsSync(join(root, "dist", ".web-reload-prev"))).toBe(false);
  });

  it("构建失败：返回原因（含日志路径和最后几行），正在用的网页原样，没有可换上的产物", async () => {
    const build = make("FAIL")!;
    const outcome = await build.build(new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("退出码 1");
      expect(outcome.reason).toContain("boom");
    }
    expect(readFileSync(join(root, "dist", "web", "index.html"), "utf8")).toBe("old");
    expect(() => build.apply()).toThrow(/没有构建产物/);
    expect(readFileSync(join(root, "dist", "web", "index.html"), "utf8")).toBe("old");
  });
});
