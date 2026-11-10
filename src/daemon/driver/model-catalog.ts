// 模型名单的通用缓存引擎（createModelCatalogs）：按厂商分别问本机 CLI 它能用哪些模型、这台设备上能不能用。
// 各家怎么问、怎么解析在 src/vendors/<厂商>/catalog.ts（docs/vendor-plugin-design.md 的 C5），这里只认 VendorCatalogSource 接口；
// 下面几个小函数是各家起进程问名单时共用的。
// 第一次有人要（网页打开资料页、新建弹窗）时问一次并缓存，旧了在后台再问；问不到（没装、超时、报错、回的不对）
// 用 vendors.ts 打包的名单，不报错。厂商相关的取值（思考程度、模型名规则）仍以 vendors.ts 为准。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
  KILL_WAIT_MS,
  MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_RETRY_MS,
  VENDOR_RECHECK_BUDGET_MS,
  bundledModelCatalog,
  isSelectable,
  type AgentVendor,
  type ModelCatalog,
  type VendorAvailability,
  vendorFailureOf,
} from "../../shared/index.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { forceKill, killFreshGroup } from "./process.ts";

/** 失败原因里带多少标准错误。 */
export const STDERR_TAIL_CHARS = 500;

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 一项的思考程度：给了列表就按列表（去掉不是字符串的、重复的）；明说不支持是空的；没说是 null。 */
export function effortsOf(entry: Record<string, unknown>): string[] | null {
  if (Array.isArray(entry.supportedEffortLevels)) {
    return [...new Set(entry.supportedEffortLevels.filter((e): e is string => typeof e === "string"))];
  }
  return entry.supportsEffort === false ? [] : null;
}

/**
 * 强制结束 child 连同后代，整组都发完 SIGKILL 之后才调 settle（失败、超时、取消都走这里）。
 * forceKill 先 SIGSTOP 住、隔着异步的 ps 找后代、最后才 SIGKILL：不等它的话调用方（关机、测试收尾）拿到结果时进程组还停在 SIGSTOP，
 * 调用方一退出就成了停住的孤儿。ps 起不来时 forceKill 自己退回只杀组；它整个出错就对刚起的组直接 SIGKILL 兜底。
 */
export function killThenSettle(child: ChildProcessWithoutNullStreams, settle: () => void): void {
  forceKill(child)
    .catch(() => killFreshGroup(child))
    .finally(settle);
}

export function parseJsonOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return { ok: true, value: JSON.parse(lines[i]!) };
      } catch {
        // 跳过非 JSON 行
      }
    }
    return { ok: false };
  }
}

/**
 * 一家厂商的名单从哪来、怎么看它在这台设备上能不能用（各家的实现在 src/vendors/<厂商>/catalog.ts，由各家 daemon.ts 登记，
 * daemon/vendors/index.ts 的 createVendorCatalogSources 按名单装配）。登录状态从名单那次查询的回应里看，不另起进程。
 */
export interface VendorCatalogSource {
  /** 问一次（起进程），返回原样的回应。 */
  query: (signal: AbortSignal) => Promise<unknown>;
  /** 回应 → 名单；认不出是 null（用打包的）。 */
  parse: (raw: unknown) => ModelCatalog | null;
  /** 问到了：同一次回应里的登录状态。不写当 available。 */
  availabilityOf?: (raw: unknown) => VendorAvailability;
  /** 没问到：从错误看。不写按通用的认（defaultAvailabilityOfError）。 */
  availabilityOfError?: (error: unknown) => VendorAvailability;
  /** 上面两步给 unknown 时的补充判断（读凭证文件、跑自带的状态命令）。 */
  confirm?: (signal: AbortSignal) => Promise<VendorAvailability>;
  /** 装没装（只查文件在不在，每次要都查）。不写当装了。 */
  installed?: () => boolean;
  /** 可执行文件及本地凭据/模型缓存文件的轻量 stat 指纹（不起进程）。变化时立即刷新缓存。 */
  fingerprint?: () => string;
}

/** 没问到时通用的认法：程序不存在 → 没装；报错是认证类（VENDOR_FAILURE_SIGNS 的 auth）→ 没登录；别的认不出。 */
export function defaultAvailabilityOfError(vendor: AgentVendor, error: unknown): VendorAvailability {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b/.test(message)) return "not_installed";
  return vendorFailureOf(message, vendor)?.kind === "auth" ? "signed_out" : "unknown";
}

export interface ModelCatalogsOptions {
  /** 每家厂商的来源（守护进程接 vendors/index.ts 的 createVendorCatalogSources）。没给的厂商不问，直接用打包的、状态 unknown。 */
  sources: Partial<Record<AgentVendor, VendorCatalogSource>>;
  now?: () => number;
  log?: (line: string) => void;
  /** ensureUsable 的重问最多等多久，默认 VENDOR_RECHECK_BUDGET_MS；测试里调小。 */
  ensureUsableBudgetMs?: number;
}

export interface ModelCatalogs {
  /**
   * 每家厂商一份（按 AGENT_VENDORS 的顺序，或只查指定的 vendor），带这台设备上的状态，不会失败。
   * refresh：true 不管新不新都重新问一次；"unusable" 只重问现在不能用（没登录、没装）的那几家。都是问完再回。
   */
  list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]>;
  /** 现在缓存着的那份（不问厂商、不等），还没问到过是 null。账本写系统消息时用。 */
  current(vendor: AgentVendor): ModelCatalog | null;
  /** 现在的状态（不问厂商、不等；装没装每次查文件）。提示词用。 */
  availability(vendor: AgentVendor): VendorAvailability;
  /**
   * hub worker start 用：现在不能用的先重问这一家一次，再给状态；能用的不问。最多等 VENDOR_RECHECK_BUDGET_MS，
   * 没问完就按现在的状态回，重问在后台接着跑（下一次调用看得到新结果）。
   */
  ensureUsable(vendor: AgentVendor): Promise<VendorAvailability>;
  /** 真跑的结果（会话起来了、认证失败、找不到程序）直接更新状态，不用等缓存过期。 */
  report(vendor: AgentVendor, availability: VendorAvailability): void;
  /** 关机：取消在问的那次并等它收尾（最多 KILL_WAIT_MS），之后不再问。 */
  close(): Promise<void>;
}

interface VendorCatalogSlot {
  readonly vendor: AgentVendor;
  readonly source: VendorCatalogSource | undefined;
  cached: ModelCatalog | null;
  cachedAt: number;
  /** 上次问出来的状态，还没问过是 null。 */
  availability: VendorAvailability | null;
  /** 上次没问到、或问出来不能用的时候（之后隔 MODEL_CATALOG_RETRY_MS 才再问）。 */
  failedAt: number | null;
  /** 上次查询后可执行文件与本地配置/凭据/模型缓存文件的 stat 指纹。 */
  fingerprint: string | null;
  /** 最近一次算出来的指纹和算的时间（MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS 内直接用它，不再 stat）。 */
  fingerprintSeen: string | null;
  fingerprintCheckedAt: number;
  inflight: Promise<void> | null;
}

/**
 * 模型名单和厂商状态的缓存（每家厂商各自独立缓存、并行查询；状态和名单同一次问、同一个缓存）：
 * - 没配来源的厂商：不发请求，直接回打包的名单、状态 unknown，current 返回 null；
 * - 没装（只查文件）：不问，状态 not_installed；装上以后下次要时就问；
 * - 还没问到过：第一次要时问，等它问完（同时来的几次只问一次）；
 * - 问到了：直接给；若可执行文件或本地凭据/模型缓存文件 stat 指纹变了（刚登录、换号、CLI 升级或 models_cache.json 更新）则立即重问；
 *   指纹 MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS 内只算一次（高频调用命中缓存时不碰磁盘）；
 *   超过 MODEL_CATALOG_FRESH_MS 在后台再问，先给旧的；后台没问到继续用旧的；
 * - 没问到、或问出来不能用（没登录）：名单用打包的（问到了就用问到的），MODEL_CATALOG_RETRY_MS 之后有人要时再问。
 * 不轮询：都是有人要时才问。
 */
export function createModelCatalogs(options: ModelCatalogsOptions): ModelCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const ensureUsableBudgetMs = options.ensureUsableBudgetMs ?? VENDOR_RECHECK_BUDGET_MS;
  let closed = false;
  const controller = new AbortController();

  const slots = new LRUCache<AgentVendor, VendorCatalogSlot>({ max: AGENT_VENDORS.length });
  for (const vendor of AGENT_VENDORS) {
    slots.set(vendor, {
      vendor,
      source: options.sources[vendor],
      cached: null,
      cachedAt: 0,
      availability: null,
      failedAt: null,
      fingerprint: null,
      fingerprintSeen: null,
      fingerprintCheckedAt: 0,
      inflight: null,
    });
  }
  const slotOf = (vendor: AgentVendor): VendorCatalogSlot => slots.get(vendor)!;

  const installed = (slot: VendorCatalogSlot) => slot.source?.installed?.() ?? true;
  /** 现在的指纹：force 或过了冷却期才真算（stat 磁盘），否则用上次算的。没配指纹是 null。 */
  const fingerprintOf = (slot: VendorCatalogSlot, force: boolean): string | null => {
    const compute = slot.source?.fingerprint;
    if (!compute) return null;
    if (force || slot.fingerprintSeen === null || now() - slot.fingerprintCheckedAt >= MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS) {
      slot.fingerprintSeen = compute();
      slot.fingerprintCheckedAt = now();
    }
    return slot.fingerprintSeen;
  };
  const fingerprintChanged = (slot: VendorCatalogSlot): boolean => {
    if (slot.fingerprint === null) return false;
    const current = fingerprintOf(slot, false);
    return current !== null && current !== slot.fingerprint;
  };
  const settle = (slot: VendorCatalogSlot, availability: VendorAvailability) => {
    slot.availability = availability;
    if (!isSelectable(availability)) slot.failedAt = now();
  };

  const ask = (slot: VendorCatalogSlot): Promise<void> => {
    const source = slot.source;
    if (!source) return Promise.resolve();
    slot.inflight ??= (async () => {
      if (!installed(slot)) {
        slot.fingerprint = fingerprintOf(slot, true);
        return; // 没装不问（状态看 installed，每次都查）
      }
      let availability: VendorAvailability;
      let reason: string | null = null;
      try {
        const raw = await source.query(controller.signal);
        availability = source.availabilityOf?.(raw) ?? "available";
        const catalog = source.parse(raw);
        if (catalog !== null) {
          slot.cached = catalog;
          slot.cachedAt = now();
          slot.failedAt = null;
        } else {
          reason = "回的名单是空的或者认不出";
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        availability = source.availabilityOfError?.(error) ?? defaultAvailabilityOfError(slot.vendor, error);
      }
      if (availability === "unknown" && source.confirm && !closed) availability = await source.confirm(controller.signal);
      if (reason !== null) {
        slot.failedAt = now();
        if (!closed) log(`${LOG_PREFIX} 没问到 ${slot.vendor} 的模型名单（${reason}），先用打包的`);
      }
      slot.fingerprint = fingerprintOf(slot, true);
      settle(slot, availability);
    })().finally(() => {
      slot.inflight = null;
    });
    return slot.inflight;
  };

  const availabilityOf = (slot: VendorCatalogSlot): VendorAvailability => {
    if (!slot.source) return "unknown";
    if (!installed(slot)) return "not_installed";
    return slot.availability ?? "unknown";
  };
  const retryDue = (slot: VendorCatalogSlot) => slot.failedAt === null || now() - slot.failedAt >= MODEL_CATALOG_RETRY_MS;
  const result = (slot: VendorCatalogSlot): ModelCatalog => ({ ...(slot.cached ?? bundledModelCatalog(slot.vendor)), availability: availabilityOf(slot) });

  const catalogOf = async (slot: VendorCatalogSlot, refresh: boolean | "unusable"): Promise<ModelCatalog> => {
    if (!slot.source || closed || !installed(slot)) return result(slot);
    const changed = fingerprintChanged(slot);
    if (changed) slot.failedAt = null;
    const usable = slot.availability === null || isSelectable(slot.availability);
    if (refresh === true || (refresh === "unusable" && !usable) || changed) await ask(slot);
    else if (slot.cached === null) {
      if (slot.inflight || slot.availability === null || retryDue(slot)) await ask(slot);
    } else if (!slot.inflight && (now() - slot.cachedAt >= MODEL_CATALOG_FRESH_MS || !usable) && retryDue(slot)) {
      void ask(slot);
    }
    return result(slot);
  };

  return {
    async list(opts = {}) {
      const refresh = opts.refresh ?? false;
      const vendors = opts.vendor !== undefined ? [opts.vendor] : AGENT_VENDORS;
      return Promise.all(vendors.map((vendor) => catalogOf(slotOf(vendor), refresh)));
    },
    current(vendor) {
      return slotOf(vendor)?.cached ?? null;
    },
    availability(vendor) {
      return availabilityOf(slotOf(vendor));
    },
    async ensureUsable(vendor) {
      const slot = slotOf(vendor);
      if (slot.source && !closed && installed(slot) && (!isSelectable(availabilityOf(slot)) || fingerprintChanged(slot))) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ensureUsableBudgetMs);
        });
        // ask 自己不会失败；没等完就放着它跑（inflight 还在，下一次调用接着用同一个）
        await Promise.race([ask(slot), timedOut]);
        clearTimeout(timer);
      }
      return availabilityOf(slot);
    },
    report(vendor, availability) {
      const slot = slotOf(vendor);
      if (slot.availability === availability) return;
      slot.availability = availability;
      slot.failedAt = isSelectable(availability) ? null : now();
    },
    async close() {
      closed = true;
      controller.abort();
      const pending = [...slots.values()].map((s) => s.inflight).filter((p): p is Promise<void> => p !== null);
      if (pending.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, KILL_WAIT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
