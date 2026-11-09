// 聊天框的上传逻辑（和输入框组件分开，哪个输入框都能用：项目经理的聊天框、以后别的对话的输入框）：
// 加文件时的检查（stageFiles）、读拖进来和粘进来的文件夹（readDropped）、发送时上传（uploadFiles）、
// 待发文件 + 提示 + 发送中状态按对话存的 hook（useStagingStore），被拒提示过几秒自己消失（useNoticeAutoHide）。
// 上传接口本身不绑定接收方（见 shared/api.ts 的 API_PATHS.uploads），发消息时再带上上传编号。
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createStore, type StoreApi } from "zustand";
import {
  ATTACHMENTS_TOO_MANY_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DROPPED_FOLDER_ENTRIES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CLIENT_CONCURRENCY,
  type Attachment,
} from "../shared/index.ts";
import { localClient, type HubClient } from "./client.ts";
import { ErrorNotice, errorText, newClientId, type ErrorLike } from "./format.ts";

/** 待发的文件。key 只用来区分列表项（同名文件可以有好几个）。 */
export interface StagedFile {
  key: string;
  file: File;
}

const MB = 1024 * 1024;

/** 加文件被拒的提示显示多久后自己消失。 */
export const NOTICE_AUTO_HIDE_MS = 4_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** 这个文件不能加的话，返回中文原因（不含文件名）；能加返回 null。 */
function rejectionOf(file: File): string | null {
  if (file.size === 0) return "是空文件，没有加入";
  if (file.size > MAX_UPLOAD_BYTES) return `超过 ${MAX_UPLOAD_BYTES / MB} MB，没有加入`;
  return null;
}

/**
 * 把新来的文件加进待发列表：空文件、超过 MAX_UPLOAD_BYTES 的、超出一条消息 MAX_ATTACHMENTS_PER_MESSAGE 个的不加，
 * notice 是给用户看的中文原因（都能加就是 null），skipped（readDropped 给的，比如空文件夹）排在最前面。不改传进来的列表。
 */
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
      problems.push(`「${file.name}」${reason}`);
    } else if (files.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      dropped = true;
    } else {
      files.push({ key: newClientId(), file });
    }
  }
  if (dropped) problems.push(`${ATTACHMENTS_TOO_MANY_MESSAGE}，多出来的没有加入`);
  return { files, notice: problems.length === 0 ? null : problems.join("；") };
}

/** 拖进来、粘进来的一项：直接是文件，或者是文件夹（要再往里读）。 */
type DroppedItem = { file: File } | { folder: FileSystemDirectoryEntry };

/** 拖放、粘贴给的数据：测试和老浏览器里可能没有 items，只有 files。 */
export type DroppedData = Pick<DataTransfer, "files"> & { items?: DataTransferItemList };

/**
 * 读拖进来、粘进来的文件，交给 deliver（一般就是 StagedFiles.add）。文件夹往里读（含子文件夹，跳过 . 开头的隐藏文件），
 * 读出来的文件照样过 stageFiles 的检查；空文件夹、读不出来的文件夹在 skipped 里给一句原因。
 * 浏览器把文件夹也放进 files，样子是一个 0 字节的文件，不这样读就会被当成“空文件”。
 * 必须在事件处理里同步调用（事件结束后 items 就读不到了）；没有文件夹时同步交给 deliver，有文件夹时读完再交。
 */
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
  // 比上限多读一个就够让 stageFiles 报“最多带几个”，再往下读没用
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
      if (found.length === 0) skipped.push(`「${item.folder.name}」文件夹里没有文件，没有加入`);
      files.push(...found);
    } catch {
      skipped.push(`「${item.folder.name}」文件夹读不出来，没有加入`);
    }
  }
  return { files, skipped };
}

/** 一层一层往下读（先读完上层的文件），读到 left 用完为止；left 在几个文件夹之间共用。 */
async function readFolder(root: FileSystemDirectoryEntry, left: { files: number; entries: number }): Promise<File[]> {
  const files: File[] = [];
  const folders = [root];
  for (let dir = folders.shift(); dir !== undefined; dir = folders.shift()) {
    const reader = dir.createReader();
    // readEntries 一次只给一批（Chrome 每批最多 100 项），给空数组才算读完
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

/** 一个文件传失败了，给用户看的话：带文件名，原因和怎么办都来自 errorText（不露英文代码）。 */
function uploadFailure(name: string, err: unknown): ErrorNotice {
  const reason = errorText(err);
  return new ErrorNotice({ ...reason, text: `「${name}」上传失败：${reason.text}` });
}

/**
 * 把文件都传上去（同时最多 UPLOAD_CLIENT_CONCURRENCY 个），按原来的顺序返回上传结果。任何一个失败整个抛错（message 是中文），
 * 抛错后不再开始新的上传，已经传上去的留在磁盘上不管。发送时才传：去掉的文件、没发出去的文件不会占磁盘。
 */
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

/** 输入框上方的一条提示。 */
export interface ComposerNotice {
  message: ErrorLike;
  /**
   * skipped：加文件被拒，NOTICE_AUTO_HIDE_MS 后自己消失（useNoticeAutoHide）；
   * failed：发送失败，文字和文件都留着，提示也留到用户再动手（打字、再发、点 ×）。
   */
  kind: "skipped" | "failed";
}

/** 一个输入框的待发状态。 */
export interface StagedFiles {
  files: StagedFile[];
  /** 正在上传、发送：发送键、文字框、加减文件都锁住。 */
  busy: boolean;
  /** 给用户看的提示（加文件被拒、上传失败）：打字、发送、去掉文件、再加文件、点 × 都会清掉。 */
  notice: ComposerNotice | null;
  /** skipped 是 readDropped 读文件夹时给的原因，和被拒的文件一起显示。 */
  add: (incoming: File[], skipped?: string[]) => void;
  remove: (key: string) => void;
  /** 发出去之后只去掉这几个文件（提交时那一份），传的时候新加的不动。 */
  removeSent: (sent: File[]) => void;
  /** 清掉提示；没有提示时什么也不做（不引起重渲染），所以每次打字都能调。 */
  dismissNotice: () => void;
  /**
   * 交给它发送的结果：没返回 Promise（只有文字，立刻发出）什么也不做；返回 Promise 就在等的时候标“发送中”，
   * 失败把原因放进提示（文字和文件都留着）。
   */
  track: (result: void | Promise<void>) => void;
}

interface Slot {
  files: StagedFile[];
  busy: boolean;
  notice: ComposerNotice | null;
}
const EMPTY_SLOT: Slot = { files: [], busy: false, notice: null };

/**
 * 待发文件、提示、发送中，按 key（对话编号等）存在调用者那一层（App）：切到别的对话再切回来，待发文件还在、
 * 发送中的还是发送中（不会重复发），传完的清理也落在对的对话上。输入框组件只拿 of(key) 这一份，不认识 key 是什么。
 */
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
          update(key, (s) => ({ ...s, busy: true }));
          result
            .catch((err: unknown) => {
              const message = err instanceof ErrorNotice ? err.info : err instanceof Error ? err.message : "上传失败";
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

/**
 * 加文件被拒的提示（kind 是 skipped）过 NOTICE_AUTO_HIDE_MS 自己消失；期间来了新提示重新计时，输入框不在了就停。
 * 发送失败的提示不自己消失。
 */
export function useNoticeAutoHide({ notice, dismissNotice }: Pick<StagedFiles, "notice" | "dismissNotice">): void {
  const dismiss = useEffectEvent(dismissNotice);
  useEffect(() => {
    if (notice?.kind !== "skipped") return;
    const timer = setTimeout(dismiss, NOTICE_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
}

/** 一个对话的草稿槽：只通知订阅了这个对话的输入框重渲染，打字不会引起 App / 消息列表重渲染。 */
export interface DraftSlot {
  store: StoreApi<string>;
  get: () => string;
  set: (value: string) => void;
  /** 发送成功后清理：如果草稿 trim 后仍等于刚发出的文字才清空，用户在中途改过的不动。 */
  clearIfMatch: (trimmed: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export function useDraftStore<K extends string | number>() {
  const slotsRef = useRef(new Map<K, DraftSlot>());

  const of = useCallback((key: K): DraftSlot => {
    const existing = slotsRef.current.get(key);
    if (existing) return existing;
    const store = createStore<string>(() => "");
    const set = (value: string) => {
      if (store.getState() !== value) store.setState(value, true);
    };
    const slot: DraftSlot = {
      store,
      get: () => store.getState(),
      set,
      clearIfMatch: (trimmed: string) => {
        if (store.getState().trim() === trimmed) set("");
      },
      subscribe: (listener: () => void) => store.subscribe(listener),
    };
    slotsRef.current.set(key, slot);
    return slot;
  }, []);

  return useMemo(() => ({ of }), [of]);
}
