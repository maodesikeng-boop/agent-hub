import { deliverableOfSentFile, type Deliverable, type HubFileArg } from "../shared/deliverables.ts";
import type { Message, MessageId } from "../shared/domain.ts";
import { DELIVERABLES_PER_STEP_MAX } from "../shared/limits.ts";
import { SENT_FILE_REASONS, sentFilesOf, type SentFile } from "../shared/sent-files.ts";
import type { WorkerReport } from "../shared/worker.ts";
import { markdownLinksOf } from "./sent-files.ts";

export function deliverablesFromText(text: string, files: readonly SentFile[], messageId: MessageId | null, max: number): Deliverable[] {
  const out: Deliverable[] = [];
  const taken = new Set<string>();
  for (const { href, label } of markdownLinksOf(text)) {
    if (out.length === max) break;
    const index = files.findIndex((f) => f.href === href && f.status === "saved");
    if (index === -1) continue;
    const file = files[index]!;
    if (taken.has(file.id!)) continue;
    taken.add(file.id!);
    out.push(deliverableOfSentFile(file, label, messageId === null ? null : { messageId, index }));
  }
  return out;
}

export function stepDeliverablesOfReport(report: WorkerReport, message: Pick<Message, "id" | "meta">): Deliverable[] {
  if (report.files === "") return [];
  return deliverablesFromText(report.files, sentFilesOf(message), message.id, DELIVERABLES_PER_STEP_MAX);
}

export function deliverablesOfFileArgs(args: readonly HubFileArg[], files: readonly SentFile[], messageId: MessageId | null): Deliverable[] {
  return args.map((arg, index) => deliverableOfSentFile(files[index]!, arg.label ?? "", messageId === null ? null : { messageId, index }));
}

export function fileArgsProblem(files: readonly SentFile[]): string | null {
  const bad = files.find((f) => f.status !== "saved");
  return bad === undefined || bad.status === "saved" ? null : `--file ${bad.path}：${SENT_FILE_REASONS[bad.status]}`;
}
