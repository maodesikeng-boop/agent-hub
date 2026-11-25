import type * as React from "react";
import type { Message } from "../../shared/index.ts";
import type { LeanReport } from "../worker-report-view.ts";

/**
 * Postcondition: renders the summary as one paragraph, the question as one bold line when present, and the message's
 * sent files as small file chips; no field labels and no headings. Used for Worker reports inside Worker detail only.
 */
export function WorkerReportText(_props: { report: LeanReport; message: Message }): React.ReactElement {
  throw new Error("Not implemented");
}
