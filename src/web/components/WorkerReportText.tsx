import { useMemo, useState } from "react";
import type * as React from "react";
import { deliverableOriginOfFile, sentFilesOf, sentFileUrl, type Message, type SentFile } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { FileText } from "../ui/icons.ts";
import type { LeanReport } from "../worker-report-view.ts";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { Markdown } from "./Markdown.tsx";

function ReportFileChip({ file, index, messageId }: { file: SentFile; index: number; messageId: number }) {
  const client = useClient();
  const [open, setOpen] = useState(false);

  if (file.status !== "saved" || file.id === null) {
    return (
      <span data-file-chip className="work-report-file-chip text-xs" title={file.name}>
        <FileText className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{file.name}</span>
      </span>
    );
  }

  const origin = deliverableOriginOfFile(file);
  const at = origin ?? { messageId, index };
  const preview: PreviewFile = {
    name: file.name,
    mime: file.mime,
    size: file.size,
    url: client.url(sentFileUrl({ id: file.id, name: file.name })),
    target: { kind: "sent", messageId: at.messageId, index: at.index },
  };

  return (
    <>
      <button
        type="button"
        data-file-chip
        title={file.name}
        onClick={() => setOpen(true)}
        className="work-report-file-chip work-report-file-chip-btn touch-target text-xs"
      >
        <FileText className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{file.name}</span>
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Postcondition: renders the summary as one paragraph, the question as one bold line when present, and the message's
 * sent files as small file chips; no field labels and no headings. Used for Worker reports inside Worker detail only.
 */
export function WorkerReportText({ report, message }: { report: LeanReport; message: Message }): React.ReactElement {
  const files = useMemo(() => sentFilesOf(message), [message]);
  return (
    <div data-worker-report className="w-full min-w-0 text-body leading-relaxed">
      <Markdown text={report.summary} files={files} messageId={message.id} />
      {report.question !== null && (
        <p data-worker-report-question className="mt-2 font-semibold text-foreground [overflow-wrap:anywhere]">
          {report.question}
        </p>
      )}
      {files.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <ReportFileChip key={`${file.href}:${index}`} file={file} index={index} messageId={message.id} />
          ))}
        </div>
      )}
    </div>
  );
}
