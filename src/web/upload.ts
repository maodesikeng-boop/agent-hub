import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createStore, type StoreApi } from "zustand";
import {
  ATTACHMENTS_TOO_MANY_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DROPPED_FOLDER_ENTRIES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CLIENT_CONCURRENCY,
  type Attachment,
  type WorkerPick,
} from "../shared/index.ts";
import { registerDraftSource, takeRestoredDraft, trackUpload } from "./auto-reload.ts";
import { localClient, type HubClient } from "./client.ts";
import { ErrorNotice, errorText, newClientId, type ErrorLike } from "./format.ts";

export interface StagedFile {
  key: string;
  file: File;
}

const MB = 1024 * 1024;

export const NOTICE_AUTO_HIDE_MS = 4_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

function rejectionOf(file: File): string | null {
  if (file.size === 0) return "is empty, skipped";
  if (file.size > MAX_UPLOAD_BYTES) return `is over ${MAX_UPLOAD_BYTES / MB} MB, skipped`;
  return null;
}

export function stageFiles(
  current: StagedFile[],
  incoming: File[],
  skipped: string[] = [],
): { files: StagedFile[]; notice: string | null } {
  const files = [...current];
  const problems = [...skipped];
  let dropped = false;
  for (const file of incoming) {
    const reason = rejectionOf(file);
    if (reason !== null) {
      problems.push(`"${file.name}" ${reason}`);
    } else if (files.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      dropped = true;
    } else {
      files.push({ key: newClientId(), file });
    }
  }
  if (dropped) problems.push(`${ATTACHMENTS_TOO_MANY_MESSAGE}; extra files skipped`);
  return { files, notice: problems.length === 0 ? null : problems.join("; ") };
}

type DroppedItem = { file: File } | { folder: FileSystemDirectoryEntry };

// Tests and older browsers may expose files without items.
export type DroppedData = Pick<DataTransfer, "files"> & { items?: DataTransferItemList };

export function readDropped(data: DroppedData, deliver: (files: File[], skipped: string[]) => void): void {
  const items = droppedItems(data);
  if (items.every((item): item is { file: File } => "file" in item)) {
    deliver(
      items.map((item) => item.file),
      [],
    );
    return;
  }
  void readItems(items).then(({ files, skipped }) => deliver(files, skipped));
}

function droppedItems(data: DroppedData): DroppedItem[] {
  const fromItems = Array.from(data.items ?? []).flatMap((item): DroppedItem[] => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) return [{ folder: entry as FileSystemDirectoryEntry }];
    const file = item.getAsFile();
    return file === null ? [] : [{ file }];
  });
  return fromItems.length > 0 ? fromItems : Array.from(data.files, (file) => ({ file }));
}

async function readItems(items: DroppedItem[]): Promise<{ files: File[]; skipped: string[] }> {
  const left = { files: MAX_ATTACHMENTS_PER_MESSAGE + 1, entries: MAX_DROPPED_FOLDER_ENTRIES };
  const files: File[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (left.files <= 0) break;
    if ("file" in item) {
      files.push(item.file);
      left.files--;
      continue;
    }
    try {
      const found = await readFolder(item.folder, left);
      if (found.length === 0) skipped.push(`Folder "${item.folder.name}" is empty, skipped`);
      files.push(...found);
    } catch {
      skipped.push(`Couldn't read folder "${item.folder.name}", skipped`);
    }
  }
  return { files, skipped };
}

async function readFolder(root: FileSystemDirectoryEntry, left: { files: number; entries: number }): Promise<File[]> {
  const files: File[] = [];
  const folders = [root];
  for (let dir = folders.shift(); dir !== undefined; dir = folders.shift()) {
    const reader = dir.createReader();
    // readEntries returns batches (Chrome caps each at 100) until an empty array.
    for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
      for (const entry of batch) {
        if (entry.name.startsWith(".")) continue;
        if (left.files <= 0 || left.entries <= 0) return files;
        left.entries--;
        if (entry.isDirectory) {
          folders.push(entry as FileSystemDirectoryEntry);
        } else if (entry.isFile) {
          files.push(await fileOf(entry as FileSystemFileEntry));
          left.files--;
        }
      }
    }
  }
  return files;
}

const readBatch = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

function uploadFailure(name: string, err: unknown): ErrorNotice {
  const reason = errorText(err);
  return new ErrorNotice({ ...reason, text: `"${name}" failed to upload: ${reason.text}` });
}

export async function uploadFiles(files: File[], client: HubClient = localClient): Promise<Attachment[]> {
  const results: Attachment[] = new Array(files.length);
  let next = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (failure === null && next < files.length) {
      const index = next++;
      const file = files[index]!;
      try {
        results[index] = await client.postUpload(file, file.name);
      } catch (err) {
        failure ??= uploadFailure(file.name, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CLIENT_CONCURRENCY, files.length) }, worker));
  if (failure !== null) throw failure;
  return results;
}

export interface ComposerNotice {
  message: ErrorLike;
  kind: "skipped" | "failed";
}

export interface StagedFiles {
  files: StagedFile[];
  busy: boolean;
  notice: ComposerNotice | null;
  add: (incoming: File[], skipped?: string[]) => void;
  remove: (key: string) => void;
  removeSent: (sent: File[]) => void;
  dismissNotice: () => void;
  track: (result: void | Promise<void>) => void;
}

interface Slot {
  files: StagedFile[];
  busy: boolean;
  notice: ComposerNotice | null;
}
const EMPTY_SLOT: Slot = { files: [], busy: false, notice: null };

export function useStagingStore<K extends string | number>() {
  const [slots, setSlots] = useState<Partial<Record<K, Slot>>>({});
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const cacheRef = useRef(new Map<K, { slot: Slot; staged: StagedFiles }>());

  const update = useCallback((key: K, change: (slot: Slot) => Slot) => {
    setSlots((all) => ({ ...all, [key]: change(all[key] ?? EMPTY_SLOT) }));
  }, []);

  const of = useCallback(
    (key: K): StagedFiles => {
      const slot = slotsRef.current[key] ?? EMPTY_SLOT;
      const cached = cacheRef.current.get(key);
      if (cached && cached.slot === slot) return cached.staged;
      const staged: StagedFiles = {
        files: slot.files,
        busy: slot.busy,
        notice: slot.notice,
        add: (incoming, skipped = []) => {
          const current = slotsRef.current[key] ?? EMPTY_SLOT;
          if (current.busy || (incoming.length === 0 && skipped.length === 0)) return;
          update(key, (s) => {
            const next = stageFiles(s.files, incoming, skipped);
            return { ...s, files: next.files, notice: next.notice === null ? null : { message: next.notice, kind: "skipped" } };
          });
        },
        remove: (fileKey) => {
          const current = slotsRef.current[key] ?? EMPTY_SLOT;
          if (current.busy) return;
          update(key, (s) => ({ ...s, files: s.files.filter((f) => f.key !== fileKey), notice: null }));
        },
        removeSent: (sent) => update(key, (s) => ({ ...s, files: s.files.filter((f) => !sent.includes(f.file)) })),
        dismissNotice: () => {
          if ((slotsRef.current[key] ?? EMPTY_SLOT).notice === null) return;
          update(key, (s) => ({ ...s, notice: null }));
        },
        track: (result) => {
          update(key, (s) => (s.notice === null ? s : { ...s, notice: null }));
          if (result === undefined) return;
          trackUpload(result);
          update(key, (s) => ({ ...s, busy: true }));
          result
            .catch((err: unknown) => {
              const message = err instanceof ErrorNotice ? err.info : err instanceof Error ? err.message : "Upload failed";
              update(key, (s) => ({ ...s, notice: { message, kind: "failed" } }));
            })
            .finally(() => update(key, (s) => ({ ...s, busy: false })));
        },
      };
      cacheRef.current.set(key, { slot, staged });
      return staged;
    },
    [update],
  );

  return useMemo(() => ({ of }), [of]);
}

export function useNoticeAutoHide({ notice, dismissNotice }: Pick<StagedFiles, "notice" | "dismissNotice">): void {
  const dismiss = useEffectEvent(dismissNotice);
  useEffect(() => {
    if (notice?.kind !== "skipped") return;
    const timer = setTimeout(dismiss, NOTICE_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
}

export interface DraftSlot {
  store: StoreApi<string>;
  get: () => string;
  set: (value: string) => void;
  clearIfMatch: (trimmed: string) => void;
  subscribe: (listener: () => void) => () => void;
  pick: StoreApi<WorkerPick | null>;
  getPick: () => WorkerPick | null;
  setPick: (pick: WorkerPick | null) => void;
  clearPickIfMatch: (sent: WorkerPick | null) => void;
  /** Key of the project Router's draft is addressed to, picked with @. */
  target: StoreApi<string | null>;
  getTarget: () => string | null;
  setTarget: (key: string | null) => void;
  clearTargetIfMatch: (sent: string | null) => void;
  focusRev: StoreApi<number>;
  restore: (text: string, workerPick: WorkerPick | null) => void;
}

export function useDraftStore<K extends string | number>() {
  const slotsRef = useRef(new Map<K, { slot: DraftSlot; gc: () => void }>());

  const of = useCallback((key: K): DraftSlot => {
    const existing = slotsRef.current.get(key);
    if (existing) return existing.slot;
    for (const [k, prev] of slotsRef.current) {
      if (k !== key) prev.gc();
    }
    const restored = takeRestoredDraft(String(key));
    const store = createStore<string>(() => restored?.text ?? "");
    const pick = createStore<WorkerPick | null>(() => restored?.pick ?? null);
    const target = createStore<string | null>(() => restored?.target ?? null);
    const focusRev = createStore<number>(() => 0);
    let subs = 0;
    const gc = () => {
      if (subs === 0 && store.getState() === "" && pick.getState() === null && target.getState() === null) {
        slotsRef.current.delete(key);
      }
    };
    const trackSub =
      <T,>(rawSubscribe: StoreApi<T>["subscribe"]): StoreApi<T>["subscribe"] =>
      (listener) => {
        subs += 1;
        const unsub = rawSubscribe(listener);
        return () => {
          unsub();
          subs -= 1;
          gc();
        };
      };
    store.subscribe = trackSub(store.subscribe);
    pick.subscribe = trackSub(pick.subscribe);
    target.subscribe = trackSub(target.subscribe);
    focusRev.subscribe = trackSub(focusRev.subscribe);
    const keepIf = (held: boolean) => {
      if (held) slotsRef.current.set(key, entry);
      else gc();
    };
    const set = (value: string) => {
      if (store.getState() !== value) store.setState(value, true);
      keepIf(value !== "");
    };
    const setPick = (next: WorkerPick | null) => {
      if (pick.getState() !== next) pick.setState(next, true);
      keepIf(next !== null);
    };
    const setTarget = (next: string | null) => {
      if (target.getState() !== next) target.setState(next, true);
      keepIf(next !== null);
    };
    const slot: DraftSlot = {
      store,
      get: () => store.getState(),
      set,
      clearIfMatch: (trimmed: string) => {
        if (store.getState().trim() === trimmed) set("");
      },
      subscribe: (listener: () => void) => store.subscribe(listener),
      pick,
      getPick: () => pick.getState(),
      setPick,
      clearPickIfMatch: (sent) => {
        if (sent !== null && pick.getState() === sent) setPick(null);
      },
      target,
      getTarget: () => target.getState(),
      setTarget,
      clearTargetIfMatch: (sent) => {
        if (sent !== null && target.getState() === sent) setTarget(null);
      },
      focusRev,
      restore: (text, workerPick) => {
        if (text !== "") {
          const current = store.getState();
          set(current.trim() === "" || current === text ? text : `${text}\n${current}`);
        }
        if (workerPick !== null && pick.getState() === null) setPick(workerPick);
        focusRev.setState(focusRev.getState() + 1, true);
      },
    };
    const entry = { slot, gc };
    slotsRef.current.set(key, entry);
    return slot;
  }, []);

  useEffect(
    () =>
      registerDraftSource(() =>
        [...slotsRef.current].map(
          ([key, { slot }]) => [String(key), { text: slot.get(), pick: slot.getPick(), target: slot.getTarget() }] as const,
        ),
      ),
    [],
  );

  const retain = useCallback((keep: (key: K) => boolean) => {
    for (const key of slotsRef.current.keys()) {
      if (!keep(key)) slotsRef.current.delete(key);
    }
  }, []);

  return useMemo(() => ({ of, retain }), [of, retain]);
}
