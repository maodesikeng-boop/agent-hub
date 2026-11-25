import type * as React from "react";
import type { ConversationId } from "../../shared/index.ts";
import type { CompletedWorkQuery } from "../useCompletedWork.ts";

export interface CompletedTabProps {
  query: CompletedWorkQuery;
  onOpenWorker: (id: ConversationId) => void;
}

/**
 * Postcondition: day groups (`Today`, `Yesterday`, then dates, each with its count) of 30px rows: status icon, title, PR
 * label linking to the PR, and finish time. Rows are virtualized with @tanstack/react-virtual. A graph row toggles its
 * steps below as the vertical list; a Worker row opens the Worker. Reaching the end loads the next page while one is
 * left. Loading, empty, and error states replace the list; a failed next page shows an inline retry row.
 */
export function CompletedTab(_props: CompletedTabProps): React.ReactElement {
  throw new Error("Not implemented");
}
