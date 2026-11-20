import {
  AUTO_RELOAD_DRAFT_TTL_MS,
  AUTO_RELOAD_MAX_DRAFT_BYTES,
  AUTO_RELOAD_MAX_DRAFTS,
  AUTO_RELOAD_RECHECK_MS,
  isAgentVendor,
  type WorkerPick,
} from "../shared/index.ts";
import { byteLength } from "./format.ts";

export const DRAFTS_STORAGE_KEY = "agent-hub:drafts:v1";

const OPEN_DIALOG_SELECTOR = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])';

export interface DraftValue {
  text: string;
  pick: WorkerPick | null;
}

interface StoredDraft extends DraftValue {
  key: string;
  savedAt: number;
}

export type DraftSource = () => Iterable<readonly [string, DraftValue]>;

let pendingUploads = 0;
let composing = false;

export function trackUpload(result: Promise<unknown>): void {
  pendingUploads += 1;
  void result.then(
    () => (pendingUploads -= 1),
    () => (pendingUploads -= 1),
  );
}

const sources = new Set<DraftSource>();
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

export function takeRestoredDraft(key: string): DraftValue | null {
  const map = restoredMap();
  const found = map.get(key);
  if (found === undefined) return null;
  map.delete(key);
  if (Date.now() - found.savedAt > AUTO_RELOAD_DRAFT_TTL_MS) return null;
  return { text: found.text, pick: found.pick };
}

export function registerDraftSource(source: DraftSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

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
  }
}

export interface AutoReloadEnv {
  isStreaming: () => boolean;
  hasOpenDialog?: () => boolean;
  isUploading?: () => boolean;
  isComposing?: () => boolean;
  saveDrafts?: () => void;
  reload?: () => void;
  recheckMs?: number;
}

export interface AutoReloader {
  observeBoot(bootId: string | undefined): void;
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

export function installAutoReloadListeners(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("compositionstart", () => (composing = true), true);
  document.addEventListener("compositionend", () => (composing = false), true);
  window.addEventListener("pagehide", () => saveDrafts());
}

export function resetAutoReloadForTests(): void {
  pendingUploads = 0;
  composing = false;
  sources.clear();
  restored = null;
}
