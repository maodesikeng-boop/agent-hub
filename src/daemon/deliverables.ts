// 守护进程这边认交付物（shared/deliverables.ts）：从 Worker 汇报的“文件”栏、hub ask / router report 的 --file 认出来。
// 不变量：只认已经存好副本的文件（SentFile.status 是 "saved"），这里不再拷文件；拷副本只在 daemon/sent-files.ts 一处。
import type { Deliverable, HubFileArg } from "../shared/deliverables.ts";
import type { Message, MessageId } from "../shared/domain.ts";
import type { SentFile } from "../shared/sent-files.ts";
import type { WorkerReport } from "../shared/worker.ts";

/**
 * 正文里指向本机文件的链接，对上 files 里存好副本的，按出现顺序换成交付物，标签是链接文字；最多 max 个。
 * 没存下副本的（太大、不在可分享的文件夹里、没找到）不算。messageId 是 null 时 origin 是 null。
 */
export function deliverablesFromText(text: string, files: readonly SentFile[], messageId: MessageId | null, max: number): Deliverable[] {
  throw new Error("未实现");
}

/**
 * Worker 汇报的“文件”栏对上这条汇报消息存好的副本，记成该步的交付物（最多 DELIVERABLES_PER_STEP_MAX 个）。
 * 栏里没写、写“无”时返回空数组；“文件”栏以外的链接不算。
 */
export function stepDeliverablesOfReport(report: WorkerReport, message: Pick<Message, "id" | "meta">): Deliverable[] {
  throw new Error("未实现");
}

/** --file 存好的副本（和 args 一一对应，都已存好）换成交付物：标签用 --file 写的，没写用文件名。 */
export function deliverablesOfFileArgs(args: readonly HubFileArg[], files: readonly SentFile[], messageId: MessageId | null): Deliverable[] {
  throw new Error("未实现");
}

/** 第一个没存下副本的 --file 的原因（给 agent 看）；都存好了是 null。 */
export function fileArgsProblem(files: readonly SentFile[]): string | null {
  throw new Error("未实现");
}
