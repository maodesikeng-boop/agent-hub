// 变化序号和内存里的变化缓冲区（changesSince 用），规则见 src/shared/ledger.ts 的 ChangesSince。
import type { Change, ChangeDataMap, ChangeType } from "../../shared/api.ts";
import type { ChangesSince } from "../../shared/ledger.ts";

export type ChangeInput = { [T in ChangeType]: { type: T; data: ChangeDataMap[T] } }[ChangeType];

export interface ChangeLog {
  readonly seq: number;
  append(input: ChangeInput): Change;
  since(seq: number): ChangesSince;
}

export function createChangeLog(initialSeq: number, bufferSize: number): ChangeLog {
  let seq = initialSeq;
  const buffer: Change[] = [];
  return {
    get seq() {
      return seq;
    },
    append(input) {
      seq += 1;
      const change = { seq, ...input } as Change;
      buffer.push(change);
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
      return change;
    },
    since(since) {
      if (!Number.isFinite(since) || since < initialSeq || since > seq) return { kind: "resync" };
      const oldest = buffer[0];
      if (oldest !== undefined && since < oldest.seq - 1) return { kind: "resync" };
      return { kind: "ok", changes: buffer.filter((c) => c.seq > since) };
    },
  };
}
