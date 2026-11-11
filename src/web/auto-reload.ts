// 本机守护进程热重启后（hub self-reload，daemon/self-reload.ts）网页无感刷新，草稿不丢：
// - 入口本机的 DeviceHub 每次拿到快照、或 WebSocket 断开重连上后，把这次启动的 bootId（/api/state 的 bootId、/api/auth/status 的
//   instanceId）交给 observeBoot；和页面第一次看到的不一样，说明守护进程重启过（网页可能也换了新构建）→ 刷新整页。
//   别的设备（联机）重启只是那台的连接重连，绝不刷新本机页面：只有入口本机的 hub 接这里（device-hub.ts）。
// - 刷新前先看现在方不方便：有打开的弹窗、有会话在流式输出、有文件在上传、在输入法组词，就隔 AUTO_RELOAD_RECHECK_MS 再看。
// - 草稿：输入框的草稿只在内存里（upload.ts 的 useDraftStore），刷新前写进 sessionStorage（条数、字节有上限），加载后各输入框
//   建草稿槽时认领回来；过期的丢掉。页面被关掉、手动刷新（pagehide）也存一次。
import {
  AUTO_RELOAD_DRAFT_TTL_MS,
  AUTO_RELOAD_MAX_DRAFT_BYTES,
  AUTO_RELOAD_MAX_DRAFTS,
  AUTO_RELOAD_RECHECK_MS,
  isAgentVendor,
  type WorkerPick,
} from "../shared/index.ts";
import { byteLength } from "./format.ts";

/** sessionStorage 里存草稿的键（版本号变了旧的直接不认）。 */
export const DRAFTS_STORAGE_KEY = "agent-hub:drafts:v1";

/** 打开着的弹窗（Radix Dialog / AlertDialog / 抽屉都带 role）。 */
const OPEN_DIALOG_SELECTOR = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])';

export interface DraftValue {
  text: string;
  pick: WorkerPick | null;
}

interface StoredDraft extends DraftValue {
  key: string;
  savedAt: number;
}

/** 一个草稿来源（useDraftStore）：列出现在所有的草稿槽（空的也列，用来盖掉同键的旧存档）。 */
export type DraftSource = () => Iterable<readonly [string, DraftValue]>;

// ---- 进行中的上传、输入法组词：页面级的单例，刷新前看 ----

let pendingUploads = 0;
let composing = false;

/** 发送里带文件（上传 + 发出去）的那段 Promise：没结束前不刷新。 */
export function trackUpload(result: Promise<unknown>): void {
  pendingUploads += 1;
  void result.then(
    () => (pendingUploads -= 1),
    () => (pendingUploads -= 1),
  );
}

// ---- 草稿：存、取 ----

const sources = new Set<DraftSource>();
/** 上次刷新前存下、还没被输入框认领的草稿；第一次用到时从 sessionStorage 读。 */
let restored: Map<string, StoredDraft> | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function validPick(raw: unknown): WorkerPick | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const { vendor, model, effort } = raw as Record<string, unknown>;
  if (!isAgentVendor(vendor)) return undefined;
  if (model !== null && typeof model !== "string") return undefined;
  if (effort !== null && typeof effort !== "string") return undefined;
  return { vendor, model, effort };
}

/** 读出来、丢掉过期和坏的，再把干净的写回去（加载后清理过期项）。 */
function loadRestored(now: number): Map<string, StoredDraft> {
  const map = new Map<string, StoredDraft>();
  const store = storage();
  if (store === null) return map;
  try {
    const raw = store.getItem(DRAFTS_STORAGE_KEY);
    if (raw === null) return map;
    const parsed = JSON.parse(raw) as { drafts?: unknown };
    const list = Array.isArray(parsed.drafts) ? parsed.drafts.slice(0, AUTO_RELOAD_MAX_DRAFTS) : [];
    let bytes = 0;
    for (const item of list as Record<string, unknown>[]) {
      if (typeof item !== "object" || item === null) continue;
      const { key, text, savedAt } = item;
      const pick = validPick(item.pick);
      if (typeof key !== "string" || typeof text !== "string" || typeof savedAt !== "number" || pick === undefined) continue;
      if (now - savedAt > AUTO_RELOAD_DRAFT_TTL_MS || (text === "" && pick === null)) continue;
      const size = byteLength(JSON.stringify({ key, text, pick, savedAt }));
      if (bytes + size > AUTO_RELOAD_MAX_DRAFT_BYTES) continue;
      bytes += size;
      map.set(key, { key, text, pick, savedAt });
    }
    writeDrafts(store, [...map.values()]);
  } catch {
    // 坏了的存档直接扔掉
    store.removeItem(DRAFTS_STORAGE_KEY);
    map.clear();
  }
  return map;
}

function restoredMap(now = Date.now()): Map<string, StoredDraft> {
  restored ??= loadRestored(now);
  return restored;
}

function writeDrafts(store: Storage, drafts: StoredDraft[]): void {
  if (drafts.length === 0) store.removeItem(DRAFTS_STORAGE_KEY);
  else store.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ drafts }));
}

/** 输入框建草稿槽时认领上次存下的草稿（拿走就从存档里删，之后以输入框里的为准）。 */
export function takeRestoredDraft(key: string): DraftValue | null {
  const map = restoredMap();
  const found = map.get(key);
  if (found === undefined) return null;
  map.delete(key);
  if (Date.now() - found.savedAt > AUTO_RELOAD_DRAFT_TTL_MS) return null;
  return { text: found.text, pick: found.pick };
}

/** useDraftStore 登记自己；返回注销。 */
export function registerDraftSource(source: DraftSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

/**
 * 把现在所有没发出去的草稿（加上还没认领的旧存档）写进 sessionStorage：最近的优先，最多 AUTO_RELOAD_MAX_DRAFTS 条、
 * 合计 AUTO_RELOAD_MAX_DRAFT_BYTES 字节，超了的丢掉；写不进去（配额满、隐私模式）不报错。
 */
export function saveDrafts(now = Date.now()): void {
  const store = storage();
  if (store === null) return;
  const byKey = new Map<string, StoredDraft>();
  for (const [key, old] of restoredMap(now)) {
    if (now - old.savedAt <= AUTO_RELOAD_DRAFT_TTL_MS) byKey.set(key, old);
  }
  for (const source of sources) {
    for (const [key, value] of source()) {
      if (value.text === "" && value.pick === null) byKey.delete(key);
      else byKey.set(key, { key, text: value.text, pick: value.pick, savedAt: now });
    }
  }
  const kept: StoredDraft[] = [];
  let bytes = 0;
  for (const draft of [...byKey.values()].sort((a, b) => b.savedAt - a.savedAt)) {
    if (kept.length >= AUTO_RELOAD_MAX_DRAFTS) break;
    const size = byteLength(JSON.stringify(draft));
    if (bytes + size > AUTO_RELOAD_MAX_DRAFT_BYTES) continue;
    bytes += size;
    kept.push(draft);
  }
  try {
    writeDrafts(store, kept);
  } catch {
    // 写不进去就算了：刷新照常
  }
}

// ---- 刷新时机 ----

export interface AutoReloadEnv {
  /** 现在有会话在流式输出（入口本机的 hub 状态）。 */
  isStreaming: () => boolean;
  /** 页面上有打开的弹窗；默认查 DOM 里的 [role="dialog"]。 */
  hasOpenDialog?: () => boolean;
  /** 默认按 trackUpload 记的数。 */
  isUploading?: () => boolean;
  /** 默认按 document 上的 compositionstart / compositionend。 */
  isComposing?: () => boolean;
  /** 默认 saveDrafts()。 */
  saveDrafts?: () => void;
  /** 默认 location.reload()。 */
  reload?: () => void;
  recheckMs?: number;
}

export interface AutoReloader {
  /** 入口本机这次连上的 bootId（老服务端没有就是 undefined，不管）。 */
  observeBoot(bootId: string | undefined): void;
  /** 停掉在等的重查（页面卸载时）；之后 observeBoot 照常能用（React 严格模式会先卸再装）。 */
  dispose(): void;
}

function hasOpenDialog(): boolean {
  return typeof document !== "undefined" && document.querySelector(OPEN_DIALOG_SELECTOR) !== null;
}

export function createAutoReloader(env: AutoReloadEnv): AutoReloader {
  const recheckMs = env.recheckMs ?? AUTO_RELOAD_RECHECK_MS;
  const dialogOpen = env.hasOpenDialog ?? hasOpenDialog;
  const uploading = env.isUploading ?? (() => pendingUploads > 0);
  const isComposing = env.isComposing ?? (() => composing);
  const save = env.saveDrafts ?? (() => saveDrafts());
  const reload = env.reload ?? (() => window.location.reload());
  let firstBootId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const attempt = () => {
    timer = undefined;
    if (env.isStreaming() || dialogOpen() || uploading() || isComposing()) {
      timer = setTimeout(attempt, recheckMs);
      return;
    }
    save();
    reload();
  };

  return {
    observeBoot(bootId) {
      if (bootId === undefined || bootId === "") return;
      if (firstBootId === null) {
        firstBootId = bootId;
        return;
      }
      if (bootId === firstBootId || pending) return;
      pending = true;
      attempt();
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
  };
}

let installed = false;

/** 页面级的监听（输入法组词、关页面前存草稿），只装一次。 */
export function installAutoReloadListeners(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("compositionstart", () => (composing = true), true);
  document.addEventListener("compositionend", () => (composing = false), true);
  window.addEventListener("pagehide", () => saveDrafts());
}

/** 只给测试：清掉页面级的单例状态。 */
export function resetAutoReloadForTests(): void {
  pendingUploads = 0;
  composing = false;
  sources.clear();
  restored = null;
}
