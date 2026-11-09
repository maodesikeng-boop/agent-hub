// 聊天框的上传逻辑（和输入框组件分开，哪个输入框都能用：项目经理的聊天框、以后别的对话的输入框）：
// 加文件时的检查（stageFiles）、发送时上传（uploadFiles）、待发文件 + 提示 + 发送中状态按对话存的 hook（useStagingStore）。
// 上传接口本身不绑定接收方（见 shared/api.ts 的 API_PATHS.uploads），发消息时再带上上传编号。
import { useCallback, useRef, useState } from "react";
import {
  ATTACHMENTS_TOO_MANY_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
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
 * notice 是给用户看的中文原因（都能加就是 null）。不改传进来的列表。
 */
export function stageFiles(current: StagedFile[], incoming: File[]): { files: StagedFile[]; notice: string | null } {
  const files = [...current];
  const problems: string[] = [];
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

/** 一个输入框的待发状态。 */
export interface StagedFiles {
  files: StagedFile[];
  /** 正在上传、发送：发送键、文字框、加减文件都锁住。 */
  busy: boolean;
  /** 给用户看的提示（加文件被拒、上传失败），下一次操作清掉。 */
  notice: ErrorLike | null;
  add: (incoming: File[]) => void;
  remove: (key: string) => void;
  /** 发出去之后只去掉这几个文件（提交时那一份），传的时候新加的不动。 */
  removeSent: (sent: File[]) => void;
  /**
   * 交给它发送的结果：没返回 Promise（只有文字，立刻发出）什么也不做；返回 Promise 就在等的时候标“发送中”，
   * 失败把原因放进提示（文字和文件都留着）。
   */
  track: (result: void | Promise<void>) => void;
}

interface Slot {
  files: StagedFile[];
  busy: boolean;
  notice: ErrorLike | null;
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
        add: (incoming) => {
          const current = slotsRef.current[key] ?? EMPTY_SLOT;
          if (current.busy || incoming.length === 0) return;
          update(key, (s) => {
            const next = stageFiles(s.files, incoming);
            return { ...s, files: next.files, notice: next.notice };
          });
        },
        remove: (fileKey) => {
          const current = slotsRef.current[key] ?? EMPTY_SLOT;
          if (current.busy) return;
          update(key, (s) => ({ ...s, files: s.files.filter((f) => f.key !== fileKey), notice: null }));
        },
        removeSent: (sent) => update(key, (s) => ({ ...s, files: s.files.filter((f) => !sent.includes(f.file)) })),
        track: (result) => {
          update(key, (s) => (s.notice === null ? s : { ...s, notice: null }));
          if (result === undefined) return;
          update(key, (s) => ({ ...s, busy: true }));
          result
            .catch((err: unknown) => update(key, (s) => ({ ...s, notice: err instanceof ErrorNotice ? err.info : err instanceof Error ? err.message : "上传失败" })))
            .finally(() => update(key, (s) => ({ ...s, busy: false })));
        },
      };
      cacheRef.current.set(key, { slot, staged });
      return staged;
    },
    [update],
  );

  return { of };
}

/** 一个对话的草稿槽：只通知订阅了这个对话的输入框重渲染，打字不会引起 App / 消息列表重渲染。 */
export interface DraftSlot {
  get: () => string;
  set: (value: string) => void;
  /** 发送成功后清理：如果草稿 trim 后仍等于刚发出的文字才清空，用户在中途改过的不动。 */
  clearIfMatch: (trimmed: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export function useDraftStore<K extends string | number>() {
  const valuesRef = useRef(new Map<K, string>());
  const listenersRef = useRef(new Map<K, Set<() => void>>());
  const slotsRef = useRef(new Map<K, DraftSlot>());

  const of = useCallback((key: K): DraftSlot => {
    const existing = slotsRef.current.get(key);
    if (existing) return existing;
    const set = (value: string) => {
      const prev = valuesRef.current.get(key) ?? "";
      if (prev === value) return;
      if (value === "") valuesRef.current.delete(key);
      else valuesRef.current.set(key, value);
      const subs = listenersRef.current.get(key);
      if (subs) for (const fn of subs) fn();
    };
    const slot: DraftSlot = {
      get: () => valuesRef.current.get(key) ?? "",
      set,
      clearIfMatch: (trimmed: string) => {
        if ((valuesRef.current.get(key) ?? "").trim() === trimmed) set("");
      },
      subscribe: (listener: () => void) => {
        let subs = listenersRef.current.get(key);
        if (!subs) {
          subs = new Set();
          listenersRef.current.set(key, subs);
        }
        subs.add(listener);
        return () => {
          subs.delete(listener);
          if (subs.size === 0) listenersRef.current.delete(key);
        };
      },
    };
    slotsRef.current.set(key, slot);
    return slot;
  }, []);

  return { of };
}
