// 输入框“/”列表的命令（跟厂商无关的部分；问法在 daemon/vendors/）：
// - 会话正在跑：直接问它（驱动层的 Driver.queryCommands，claude 是再发一次 initialize，约 10 毫秒，会重新读目录）；
// - 没在跑：按（厂商、目录）缓存，第一次另起一个进程问（厂商实现的 queryCommands，约 0.9 秒）；
//   超过 COMMANDS_FRESH_MS 先给旧的，后台再问；没问到给空列表，COMMANDS_RETRY_MS 之后有人要时再问；
// - 会话中途推来的完整名单（驱动层的 commands.changed）直接更新缓存。
// 返回前去掉厂商的隐藏名单（isHiddenCommand）。问不到一律空列表，不报错。
import { COMMANDS_FRESH_MS, COMMANDS_RETRY_MS, type AgentVendor, type ComposerCommand, type SessionId } from "../shared/index.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import type { VendorComposer } from "./vendors/index.ts";

/** 要哪个会话的命令列表。 */
export interface CommandsRequest {
  sessionId: SessionId;
  vendor: string;
  cwd: string;
  addDirs: readonly string[];
}

export interface CommandCatalogsOptions {
  /** 每家厂商的实现（vendors/index.ts 的 createVendorComposers）。 */
  vendors: Readonly<Record<AgentVendor, VendorComposer>>;
  /** 问正在跑的会话（Driver.queryCommands）：没在跑、没问到返回 null。 */
  queryRunning: (sessionId: SessionId) => Promise<ComposerCommand[] | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CommandCatalogs {
  /** 去掉隐藏的命令列表，不会失败。 */
  list(request: CommandsRequest): Promise<ComposerCommand[]>;
  /** 会话推来了完整的新名单（驱动层的 commands.changed）。 */
  update(request: Omit<CommandsRequest, "sessionId">, commands: ComposerCommand[]): void;
  /** 关机：取消在问的，之后不再问。 */
  close(): void;
}

interface Entry {
  commands: ComposerCommand[] | null;
  at: number;
  failedAt: number | null;
  inflight: Promise<void> | null;
}

/** 缓存的键：厂商 + 工作目录 + 附加文件夹（项目里的命令、skill 跟着目录走）。 */
function keyOf(request: Omit<CommandsRequest, "sessionId">): string {
  return JSON.stringify([request.vendor, request.cwd, ...request.addDirs]);
}

export function createCommandCatalogs(options: CommandCatalogsOptions): CommandCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const entries = new Map<string, Entry>();
  const controller = new AbortController();
  let closed = false;

  const vendorOf = (vendor: string): VendorComposer | null =>
    Object.hasOwn(options.vendors, vendor) ? options.vendors[vendor as AgentVendor] : null;

  const entryOf = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { commands: null, at: 0, failedAt: null, inflight: null };
      entries.set(key, entry);
    }
    return entry;
  };

  const store = (entry: Entry, commands: ComposerCommand[]) => {
    entry.commands = commands;
    entry.at = now();
    entry.failedAt = null;
  };

  /** 另起一个进程问（同一个键同时只问一次）。 */
  const ask = (vendor: VendorComposer, request: CommandsRequest, entry: Entry): Promise<void> => {
    entry.inflight ??= (async () => {
      try {
        store(entry, await vendor.queryCommands({ cwd: request.cwd, addDirs: request.addDirs }, controller.signal));
      } catch (error) {
        entry.failedAt = now();
        if (!closed) log(`${LOG_PREFIX} 没问到 ${request.vendor} 在 ${request.cwd} 的命令列表（${error instanceof Error ? error.message : String(error)}），先给空列表`);
      }
    })().finally(() => {
      entry.inflight = null;
    });
    return entry.inflight;
  };

  const visible = (vendor: VendorComposer, commands: ComposerCommand[] | null) =>
    (commands ?? []).filter((c) => !vendor.isHiddenCommand(c.name));

  return {
    async list(request) {
      const vendor = vendorOf(request.vendor);
      if (vendor === null) return [];
      const entry = entryOf(keyOf(request));
      if (closed) return visible(vendor, entry.commands);
      // 正在跑的会话问得快、又是最新的：每次都问它，问到就顺手更新缓存
      const running = await options.queryRunning(request.sessionId).catch(() => null);
      if (running !== null) {
        store(entry, running);
        return visible(vendor, running);
      }
      const retryOk = entry.failedAt === null || now() - entry.failedAt >= COMMANDS_RETRY_MS;
      if (entry.commands === null) {
        if (entry.inflight || retryOk) await ask(vendor, request, entry);
      } else if (!entry.inflight && now() - entry.at >= COMMANDS_FRESH_MS && retryOk) {
        void ask(vendor, request, entry);
      }
      return visible(vendor, entry.commands);
    },
    update(request, commands) {
      if (closed || vendorOf(request.vendor) === null) return;
      store(entryOf(keyOf(request)), commands);
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
