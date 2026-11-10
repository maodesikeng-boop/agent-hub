import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRow, TokenUsage } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { ForkHandle, ForkerKind, HandoverCleanJob, HandoverFailure, HandoverId, HandoverJob, LedgerHandoverWork } from "../../shared/handover.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { AGENT_VENDORS, type AgentVendor } from "../../shared/vendors.ts";
import { ForkUnsupportedError } from "./forker.ts";
import type { ForkerRegistry, ForkSource, ForkWriteResult, SessionForker } from "./forker.ts";
import { createHandoverRunner } from "./runner.ts";
import type { HandoverRunner } from "./runner.ts";

const USAGE: TokenUsage = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 5 };

const session = (over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  id: 7,
  role: "pm",
  conversationId: 1,
  pmId: 1,
  workerId: null,
  vendor: "claude",
  vendorSessionId: "v-7",
  cwd: "/code/foo",
  addDirs: [],
  generation: 1,
  model: null,
  effort: null,
  pid: null,
  status: "idle",
  hasCompletedTurn: true,
  lastEventAt: null,
  rateLimit: null,
  usage: { ...USAGE, context: 210_000 },
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const job = (id: number, over: Partial<AgentSessionRow> = {}): HandoverJob => ({
  handoverId: id,
  conversationId: id,
  session: session({ id: 100 + id, conversationId: id, ...over }),
  auto: true,
  prompt: `写交接 ${id}`,
});

/** 假账本：claim 按顺序吐 queue 里的活，其余方法只记调用（calls 里是“方法名:编号”，按发生顺序）。 */
function fakeLedger(queue: HandoverJob[] = [], over: Partial<LedgerHandoverWork> = {}) {
  const calls: string[] = [];
  const forked: Array<{ id: HandoverId; fork: { kind: ForkerKind; ref: { forker: string; handle: ForkHandle } } }> = [];
  const written: Array<{ id: HandoverId; text: string; usage: TokenUsage }> = [];
  const failed: Array<{ id: HandoverId; failure: HandoverFailure }> = [];
  const ledger: LedgerHandoverWork = {
    claimHandover: vi.fn(() => {
      const next = queue.shift() ?? null;
      if (next) calls.push(`claim:${next.handoverId}`);
      return next;
    }),
    handoverForked: vi.fn((id, fork) => {
      calls.push(`forked:${id}`);
      forked.push({ id, fork });
      return true;
    }),
    handoverWritten: vi.fn((id, result) => {
      calls.push(`written:${id}`);
      written.push({ id, ...result });
    }),
    handoverFailed: vi.fn((id, failure) => {
      calls.push(`failed:${id}`);
      failed.push({ id, failure });
    }),
    handoverCleaned: vi.fn((id) => void calls.push(`cleaned:${id}`)),
    uncleanedHandovers: vi.fn((): HandoverCleanJob[] => []),
    ...over,
  };
  return { ledger, calls, queue, forked, written, failed };
}

interface FakeForkerOptions {
  id?: string;
  kind?: ForkerKind;
  fork?: (src: ForkSource, signal: AbortSignal) => Promise<ForkHandle>;
  write?: (src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal) => Promise<ForkWriteResult>;
  remove?: (fork: ForkHandle) => Promise<void>;
}

function fakeForker(calls: string[], o: FakeForkerOptions = {}): SessionForker {
  const id = o.id ?? "claude-native";
  return {
    id,
    kind: o.kind ?? "native",
    fork: vi.fn(async (src, signal) => {
      calls.push(`fork:${id}`);
      return o.fork ? o.fork(src, signal) : { forkId: `f-${src.sessionId}` };
    }),
    write: vi.fn(async (src, handle, prompt, signal) => {
      calls.push(`write:${id}`);
      return o.write ? o.write(src, handle, prompt, signal) : { text: `交接 ${prompt}`, usage: USAGE };
    }),
    remove: vi.fn(async (handle) => {
      calls.push(`remove:${handle.forkId}`);
      if (o.remove) await o.remove(handle);
    }),
  };
}

const EMPTY_REGISTRY = Object.fromEntries(AGENT_VENDORS.map((v) => [v, []])) as unknown as ForkerRegistry;
const registryOf = (claude: SessionForker[], others: Partial<ForkerRegistry> = {}): ForkerRegistry => ({ ...EMPTY_REGISTRY, claude, ...others } as ForkerRegistry);

const PATHS = Object.fromEntries(AGENT_VENDORS.map((v) => [v, `/bin/${v}`])) as Record<AgentVendor, string>;
const LAUNCH: LaunchFiles = { promptFile: "/p.md", env: { [ENV_HUB_TOKEN]: "t", [ENV_HUB_SOCK]: "/s", PATH: "/bin" }, fingerprint: "fp" };

/** 一直等到 predicate 成立（事件循环轮几圈），超时抛错。 */
async function until(predicate: () => boolean, what = "条件"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${what}`);
}

/** 永远挂着，直到 signal abort 才拒绝（模拟杀进程组后 write 抛错）。 */
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

describe("handover runner", () => {
  let runner: HandoverRunner | undefined;
  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    vi.useRealTimers();
  });

  const make = (ledger: LedgerHandoverWork, registry: ForkerRegistry, extra: Partial<Parameters<typeof createHandoverRunner>[0]> = {}) => {
    const logs: string[] = [];
    runner = createHandoverRunner({
      ledger,
      registry,
      prepareLaunch: async () => LAUNCH,
      executablePaths: PATHS,
      log: (line) => logs.push(line),
      tickMs: 3_600_000,
      ...extra,
    });
    return { runner, logs };
  };

  describe("一次活", () => {
    it("领 → 复制 → 报复制好 → 写 → 报写好 → 清理 → 报清完，按这个顺序", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls);
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(f.calls).toEqual(["claim:1", "fork:claude-native", "forked:1", "write:claude-native", "written:1", "remove:f-101", "cleaned:1"]);
      expect(f.forked[0]).toEqual({ id: 1, fork: { kind: "native", ref: { forker: "claude-native", handle: { forkId: "f-101" } } } });
      expect(f.written[0]).toEqual({ id: 1, text: "交接 写交接 1", usage: USAGE });
      expect(f.failed).toEqual([]);
    });

    it("fork 和 write 拿到的是 forkSourceOf 拼的来源：凭证已去掉，提示词是账本给的", async () => {
      const f = fakeLedger([job(1, { model: "opus", cwd: "/c" })]);
      const seen: { src?: ForkSource; prompt?: string } = {};
      const forker = fakeForker(f.calls, {
        write: async (src, _h, prompt) => {
          seen.src = src;
          seen.prompt = prompt;
          return { text: "x", usage: USAGE };
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(seen.src?.model).toBe("opus");
      expect(seen.src?.cwd).toBe("/c");
      expect(seen.src?.launch.env).toEqual({ PATH: "/bin" });
      expect(seen.prompt).toBe("写交接 1");
    });

    it("ForkSource.executablePath 按旧会话的厂商从 executablePaths 填", async () => {
      const f = fakeLedger([job(1), job(2, { vendor: "codex" })]);
      const seen: Record<number, string> = {};
      const spy = (id: string) =>
        fakeForker(f.calls, {
          id,
          write: async (src) => {
            seen[src.sessionId] = src.executablePath;
            return { text: "x", usage: USAGE };
          },
        });
      const { runner } = make(f.ledger, registryOf([spy("c")], { codex: [spy("x")] }));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1") && f.calls.includes("cleaned:2"));
      expect(seen).toEqual({ 101: "/bin/claude", 102: "/bin/codex" });
    });

    it("prepareLaunch 拿到的是旧会话", async () => {
      const f = fakeLedger([job(1)]);
      const prepareLaunch = vi.fn(async () => LAUNCH);
      const { runner } = make(f.ledger, registryOf([fakeForker(f.calls)]), { prepareLaunch });
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: 101, vendor: "claude" }));
    });

    it("prepareLaunch 抛错 → 报 error，没复制过就没东西可清", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls);
      const { runner } = make(f.ledger, registryOf([forker]), {
        prepareLaunch: async () => {
          throw new Error("写不了设置文件");
        },
      });
      runner.wake();
      await until(() => f.failed.length === 1);
      expect(f.failed[0]).toEqual({ id: 1, failure: { kind: "error", detail: expect.stringContaining("写不了设置文件") } });
      expect(forker.fork).not.toHaveBeenCalled();
      expect(f.ledger.handoverCleaned).not.toHaveBeenCalled();
    });
  });

  describe("按办法清单试", () => {
    it("第一个抛 ForkUnsupportedError → 换第二个；存的是第二个的 kind 和 id", async () => {
      const f = fakeLedger([job(1)]);
      const first = fakeForker(f.calls, {
        id: "claude-native",
        fork: async () => {
          throw new ForkUnsupportedError("没这能力");
        },
      });
      const second = fakeForker(f.calls, { id: "claude-copy", kind: "copy" });
      const { runner } = make(f.ledger, registryOf([first, second]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(f.calls.slice(0, 4)).toEqual(["claim:1", "fork:claude-native", "fork:claude-copy", "forked:1"]);
      expect(f.forked[0]?.fork).toMatchObject({ kind: "copy", ref: { forker: "claude-copy" } });
      expect(f.failed).toEqual([]);
    });

    it("第一个就成功，不再试第二个", async () => {
      const f = fakeLedger([job(1)]);
      const second = fakeForker(f.calls, { id: "claude-copy", kind: "copy" });
      const { runner } = make(f.ledger, registryOf([fakeForker(f.calls), second]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(second.fork).not.toHaveBeenCalled();
    });

    it("清单是空的 → 报 unsupported（账本退回本会话写交接）", async () => {
      const f = fakeLedger([job(1)]);
      const { runner } = make(f.ledger, registryOf([]));
      runner.wake();
      await until(() => f.failed.length === 1);
      expect(f.failed[0]?.failure.kind).toBe("unsupported");
      expect(f.ledger.handoverForked).not.toHaveBeenCalled();
    });

    it("清单里每个都不支持 → 报 unsupported，detail 里有各个办法和原因", async () => {
      const f = fakeLedger([job(1)]);
      const no = (id: string, why: string) =>
        fakeForker(f.calls, {
          id,
          fork: async () => {
            throw new ForkUnsupportedError(why);
          },
        });
      const { runner } = make(f.ledger, registryOf([no("a", "格式不认识"), no("b", "找不到")]));
      runner.wake();
      await until(() => f.failed.length === 1);
      const { kind, detail } = f.failed[0]!.failure;
      expect(kind).toBe("unsupported");
      expect(detail).toContain("a");
      expect(detail).toContain("格式不认识");
      expect(detail).toContain("b");
      expect(detail).toContain("找不到");
    });

    it("厂商不认识 → forkSourceOf 抛 ForkUnsupportedError → 报 unsupported", async () => {
      const f = fakeLedger([job(1, { vendor: "someone-new" })]);
      const { runner } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.wake();
      await until(() => f.failed.length === 1);
      expect(f.failed[0]?.failure.kind).toBe("unsupported");
    });

    it("按旧会话的厂商选清单", async () => {
      const f = fakeLedger([job(1, { vendor: "codex" })]);
      const claude = fakeForker(f.calls, { id: "claude-native" });
      const codex = fakeForker(f.calls, { id: "codex-native" });
      const { runner } = make(f.ledger, registryOf([claude], { codex: [codex] }));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(claude.fork).not.toHaveBeenCalled();
      expect(codex.fork).toHaveBeenCalled();
    });
  });

  describe("出错", () => {
    it("fork 出错（不是不支持）→ 报 error，不试下一个办法，没 handle 不清理", async () => {
      const f = fakeLedger([job(1)]);
      const first = fakeForker(f.calls, {
        fork: async () => {
          throw new Error("进程起不来");
        },
      });
      const second = fakeForker(f.calls, { id: "claude-copy", kind: "copy" });
      const { runner } = make(f.ledger, registryOf([first, second]));
      runner.wake();
      await until(() => f.failed.length === 1);
      expect(f.failed[0]?.failure).toEqual({ kind: "error", detail: expect.stringContaining("进程起不来") });
      expect(second.fork).not.toHaveBeenCalled();
      expect(f.ledger.handoverCleaned).not.toHaveBeenCalled();
    });

    it("write 出错 → 报 error，复制那份照样清理并报清完", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls, {
        write: async () => {
          throw new Error("退出码 1");
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(f.failed[0]).toEqual({ id: 1, failure: { kind: "error", detail: expect.stringContaining("退出码 1") } });
      expect(f.calls.slice(-3)).toEqual(["failed:1", "remove:f-101", "cleaned:1"]);
      expect(f.written).toEqual([]);
    });

    it("write 抛的是 ForkUnsupportedError 也只当 error（办法已经复制出来了，不再换办法）", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls, {
        write: async () => {
          throw new ForkUnsupportedError("半路发现不行");
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(f.failed[0]?.failure.kind).toBe("error");
    });

    it("handoverForked 返回 false（被作废了）→ 不写，直接清理并报清完，不再报失败", async () => {
      const f = fakeLedger([job(1)], { handoverForked: vi.fn(() => false) });
      const forker = fakeForker(f.calls);
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => vi.mocked(f.ledger.handoverCleaned).mock.calls.length === 1);
      expect(forker.write).not.toHaveBeenCalled();
      expect(f.calls).toContain("remove:f-101");
      expect(f.ledger.handoverFailed).not.toHaveBeenCalled();
      expect(f.ledger.handoverWritten).not.toHaveBeenCalled();
    });

    it("清理失败 → 记日志，不报清完（下次启动再清），也不影响已经报的结果", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls, {
        remove: async () => {
          throw new Error("删不掉");
        },
      });
      const { runner, logs } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => logs.some((l) => l.includes("删不掉")));
      expect(f.written).toHaveLength(1);
      expect(f.ledger.handoverCleaned).not.toHaveBeenCalled();
    });

    it("账本报告时抛错（比如库已经关了）→ 记日志，不崩，后面的活照常", async () => {
      const f = fakeLedger([job(1), job(2)], {
        handoverWritten: vi.fn((id) => {
          if (id === 1) throw new Error("db closed");
        }),
      });
      const { runner, logs } = make(f.ledger, registryOf([fakeForker(f.calls)]), { concurrency: 1 });
      runner.wake();
      await until(() => f.calls.includes("cleaned:2"));
      expect(logs.some((l) => l.includes("db closed"))).toBe(true);
    });

    it("报写好时账本抛错 → 改报 error（行不卡在 writing，账本按失败退避再来），复制那份照样清理", async () => {
      const f = fakeLedger([job(1)], {
        handoverWritten: vi.fn(() => {
          throw new Error("SQLITE_BUSY");
        }),
      });
      const { runner, logs } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(f.failed).toHaveLength(1);
      expect(f.failed[0]?.failure.kind).toBe("error");
      expect(f.failed[0]?.failure.detail).toContain("SQLITE_BUSY");
      expect(f.calls).toEqual(["claim:1", "fork:claude-native", "forked:1", "write:claude-native", "failed:1", "remove:f-101", "cleaned:1"]);
      expect(logs.some((l) => l.includes("SQLITE_BUSY"))).toBe(true);
    });

    it("报复制好时账本抛错 → 不写，改报 error（行不卡在 forking），复制那份照样清理", async () => {
      const f = fakeLedger([job(1)], {
        handoverForked: vi.fn(() => {
          throw new Error("SQLITE_BUSY");
        }),
      });
      const forker = fakeForker(f.calls);
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(forker.write).not.toHaveBeenCalled();
      expect(f.failed.map((x) => [x.id, x.failure.kind])).toEqual([[1, "error"]]);
      expect(f.failed[0]?.failure.detail).toContain("SQLITE_BUSY");
      expect(f.calls).toContain("remove:f-101");
    });
  });

  describe("超时和取消", () => {
    it("write 超过 timeoutMs → abort 它的 signal，报 timeout，复制那份照样清理", async () => {
      const f = fakeLedger([job(1)]);
      let writeSignal: AbortSignal | undefined;
      const forker = fakeForker(f.calls, {
        write: (_s, _h, _p, signal) => {
          writeSignal = signal;
          return hangUntilAborted(signal);
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]), { timeoutMs: 30 });
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
      expect(writeSignal?.aborted).toBe(true);
      expect(f.failed[0]?.failure.kind).toBe("timeout");
      expect(f.written).toEqual([]);
    });

    it("fork 也算在超时里（从领到起算）", async () => {
      const f = fakeLedger([job(1)]);
      const forker = fakeForker(f.calls, { fork: (_s, signal) => hangUntilAborted(signal) });
      const { runner } = make(f.ledger, registryOf([forker]), { timeoutMs: 30 });
      runner.wake();
      await until(() => f.failed.length === 1);
      expect(f.failed[0]?.failure.kind).toBe("timeout");
    });

    it("每个活各计各的时，一个超时不影响另一个", async () => {
      const f = fakeLedger([job(1), job(2)]);
      const forker = fakeForker(f.calls, {
        write: (src, _h, _p, signal) => (src.sessionId === 101 ? hangUntilAborted(signal) : Promise.resolve({ text: "ok", usage: USAGE })),
      });
      const { runner } = make(f.ledger, registryOf([forker]), { timeoutMs: 40 });
      runner.wake();
      await until(() => f.calls.includes("cleaned:1") && f.calls.includes("cleaned:2"));
      expect(f.written.map((w) => w.id)).toEqual([2]);
      expect(f.failed.map((x) => [x.id, x.failure.kind])).toEqual([[1, "timeout"]]);
    });

    it("stop：在写的活被 abort，报 shutdown，清理完才返回；之后不再领活", async () => {
      const f = fakeLedger([job(1)]);
      let writing = false;
      const forker = fakeForker(f.calls, {
        write: (_s, _h, _p, signal) => {
          writing = true;
          return hangUntilAborted(signal);
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => writing);
      await runner.stop();
      expect(f.failed[0]).toEqual({ id: 1, failure: { kind: "shutdown", detail: expect.any(String) } });
      expect(f.calls).toContain("cleaned:1");
      f.queue.push(job(2));
      runner.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.calls).not.toContain("claim:2");
    });

    it("stop 多次调用返回同一件事，不重复报", async () => {
      const f = fakeLedger([job(1)]);
      let writing = false;
      const forker = fakeForker(f.calls, {
        write: (_s, _h, _p, signal) => {
          writing = true;
          return hangUntilAborted(signal);
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => writing);
      await Promise.all([runner.stop(), runner.stop()]);
      expect(f.failed).toHaveLength(1);
    });

    it("超时的计时器在活做完后清掉（不留着拖住进程、不在做完后再 abort）", async () => {
      vi.useFakeTimers();
      const f = fakeLedger([job(1)]);
      let signal: AbortSignal | undefined;
      const forker = fakeForker(f.calls, {
        write: async (_s, _h, _p, s) => {
          signal = s;
          return { text: "ok", usage: USAGE };
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]), { timeoutMs: 1_000 });
      runner.wake();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toContain("cleaned:1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signal?.aborted).toBe(false);
      expect(f.failed).toEqual([]);
    });
  });

  describe("并发和叫醒", () => {
    it("最多同时 concurrency 个，领到 null 就停；一个做完再领下一个", async () => {
      const f = fakeLedger([job(1), job(2), job(3)]);
      const release: Array<() => void> = [];
      const forker = fakeForker(f.calls, {
        write: () => new Promise<ForkWriteResult>((resolve) => release.push(() => resolve({ text: "ok", usage: USAGE }))),
      });
      const { runner } = make(f.ledger, registryOf([forker]), { concurrency: 2 });
      runner.wake();
      await until(() => release.length === 2);
      expect(f.calls.filter((c) => c.startsWith("claim:"))).toEqual(["claim:1", "claim:2"]);
      release[0]!();
      await until(() => release.length === 3);
      expect(f.calls).toContain("claim:3");
      release[1]!();
      release[2]!();
      await until(() => f.calls.includes("cleaned:3") && f.calls.includes("cleaned:2"));
    });

    it("默认并发是 HANDOVER_CONCURRENCY（2）", async () => {
      const f = fakeLedger([job(1), job(2), job(3)]);
      const release: Array<() => void> = [];
      const forker = fakeForker(f.calls, {
        write: () => new Promise<ForkWriteResult>((resolve) => release.push(() => resolve({ text: "ok", usage: USAGE }))),
      });
      const { runner } = make(f.ledger, registryOf([forker]));
      runner.wake();
      await until(() => release.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(release).toHaveLength(2);
      release.forEach((r) => r());
    });

    it("领到的活失败（不是出错就是不支持）也释放位置，接着领", async () => {
      const f = fakeLedger([job(1), job(2)]);
      const forker = fakeForker(f.calls, {
        fork: async (src) => {
          if (src.sessionId === 101) throw new Error("boom");
          return { forkId: "f2" };
        },
      });
      const { runner } = make(f.ledger, registryOf([forker]), { concurrency: 1 });
      runner.wake();
      await until(() => f.calls.includes("cleaned:2"));
      expect(f.failed.map((x) => x.id)).toEqual([1]);
    });

    it("wake 不在调用栈里领（账本可能在事务里叫它）：同步调完 claim 还没被调，下一个微任务才领；连叫几次只领一轮", async () => {
      const f = fakeLedger([]);
      const { runner } = make(f.ledger, registryOf([]));
      runner.wake();
      runner.wake();
      runner.wake();
      expect(f.ledger.claimHandover).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(f.ledger.claimHandover).toHaveBeenCalledTimes(1);
    });

    it("tickMs 到了自己领一次兜底（没人叫也领）", async () => {
      vi.useFakeTimers();
      const f = fakeLedger([]);
      const { runner } = make(f.ledger, registryOf([]), { tickMs: 5_000 });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = vi.mocked(f.ledger.claimHandover).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.ledger.claimHandover).toHaveBeenCalledTimes(afterStart + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.ledger.claimHandover).toHaveBeenCalledTimes(afterStart + 3);
    });

    it("stop 之后 tick 不再领", async () => {
      vi.useFakeTimers();
      const f = fakeLedger([]);
      const { runner } = make(f.ledger, registryOf([]), { tickMs: 5_000 });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      await runner.stop();
      const n = vi.mocked(f.ledger.claimHandover).mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.ledger.claimHandover).toHaveBeenCalledTimes(n);
    });

    it("claimHandover 抛错 → 记日志，不崩，下次叫醒照常", async () => {
      const f = fakeLedger([job(1)]);
      let first = true;
      const realClaim = f.ledger.claimHandover;
      f.ledger.claimHandover = vi.fn(() => {
        if (first) {
          first = false;
          throw new Error("SQLITE_BUSY");
        }
        return realClaim();
      });
      const { runner, logs } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.wake();
      await until(() => logs.some((l) => l.includes("SQLITE_BUSY")));
      runner.wake();
      await until(() => f.calls.includes("cleaned:1"));
    });
  });

  describe("启动补清", () => {
    const cleanJob = (id: number, forker: string, vendor = "claude"): HandoverCleanJob => ({ handoverId: id, vendor, ref: { forker, handle: { forkId: `old-${id}`, extra: { path: "/x" } } } });

    it("start 时对 uncleanedHandovers 每一行：凭 forker id 找回办法，remove(handle)，报清完", async () => {
      const f = fakeLedger([], { uncleanedHandovers: vi.fn(() => [cleanJob(1, "claude-native"), cleanJob(2, "codex-native", "codex")]) });
      const claude = fakeForker(f.calls, { id: "claude-native" });
      const codex = fakeForker(f.calls, { id: "codex-native" });
      const { runner } = make(f.ledger, registryOf([claude], { codex: [codex] }));
      runner.start();
      await until(() => f.calls.includes("cleaned:1") && f.calls.includes("cleaned:2"));
      expect(claude.remove).toHaveBeenCalledWith({ forkId: "old-1", extra: { path: "/x" } });
      expect(codex.remove).toHaveBeenCalledWith({ forkId: "old-2", extra: { path: "/x" } });
    });

    it("remove 失败 → 记日志，不报清完（下次启动再试），别的行照清", async () => {
      const f = fakeLedger([], { uncleanedHandovers: vi.fn(() => [cleanJob(1, "bad"), cleanJob(2, "good")]) });
      const bad = fakeForker(f.calls, {
        id: "bad",
        remove: async () => {
          throw new Error("权限不够");
        },
      });
      const good = fakeForker(f.calls, { id: "good" });
      const { runner, logs } = make(f.ledger, registryOf([bad, good]));
      runner.start();
      await until(() => f.calls.includes("cleaned:2"));
      expect(f.calls).not.toContain("cleaned:1");
      expect(logs.some((l) => l.includes("权限不够"))).toBe(true);
    });

    it("办法已经不在清单里 → 没法清了：记日志、报清完，免得每次启动都试", async () => {
      const f = fakeLedger([], { uncleanedHandovers: vi.fn(() => [cleanJob(1, "gone"), cleanJob(2, "x", "someone-new")]) });
      const { runner, logs } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.start();
      await until(() => f.calls.includes("cleaned:1") && f.calls.includes("cleaned:2"));
      expect(logs.filter((l) => l.includes("gone") || l.includes("someone-new")).length).toBeGreaterThanOrEqual(2);
    });

    it("uncleanedHandovers 抛错 → 记日志，不崩，领活照常", async () => {
      const f = fakeLedger([job(1)], {
        uncleanedHandovers: vi.fn(() => {
          throw new Error("表不存在");
        }),
      });
      const { runner, logs } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.start();
      await until(() => f.calls.includes("cleaned:1"));
      expect(logs.some((l) => l.includes("表不存在"))).toBe(true);
    });

    it("不 start 就不补清（wake 只领活）", async () => {
      const f = fakeLedger([]);
      const { runner } = make(f.ledger, registryOf([]));
      runner.wake();
      await Promise.resolve();
      expect(f.ledger.uncleanedHandovers).not.toHaveBeenCalled();
    });

    it("start 也领一次（重启前留在 queued / 可以接着做的）", async () => {
      const f = fakeLedger([job(1)]);
      const { runner } = make(f.ledger, registryOf([fakeForker(f.calls)]));
      runner.start();
      await until(() => f.calls.includes("cleaned:1"));
    });

    it("补清中 stop：不再等没做完的 remove 之外的新活；stop 等得到补清收尾", async () => {
      const f = fakeLedger([], { uncleanedHandovers: vi.fn(() => [cleanJob(1, "slow")]) });
      let removeStarted = false;
      let finishRemove: () => void = () => {};
      const slow = fakeForker(f.calls, {
        id: "slow",
        remove: () =>
          new Promise<void>((resolve) => {
            removeStarted = true;
            finishRemove = resolve;
          }),
      });
      const { runner } = make(f.ledger, registryOf([slow]));
      runner.start();
      await until(() => removeStarted);
      const stopped = runner.stop();
      let done = false;
      void stopped.then(() => (done = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(done).toBe(false);
      finishRemove();
      await stopped;
      expect(f.calls).toContain("cleaned:1");
    });
  });
});
