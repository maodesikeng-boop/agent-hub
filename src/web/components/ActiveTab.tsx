import type * as React from "react";
import type { ConversationId, MessageId, TaskGraph } from "../../shared/index.ts";
import type { WorkerEntry } from "../selectors.ts";
import type { ActiveWork } from "../work-panel-model.ts";

export interface ActiveTabProps {
  work: ActiveWork;
  /** Every Worker of the PM, so steps can resolve their bound Worker. */
  workers: readonly WorkerEntry[];
  onOpenWorker: (id: ConversationId) => void;
  onOpenAsk: (id: MessageId) => void;
  /** The expand icon on a graph section. */
  onExpandGraph: (graph: TaskGraph) => void;
}

/**
 * Postcondition: one section per active graph (13.5px 500 title, `done/total`, expand icon, then its GraphCanvas on
 * paper), parted by thin lines, then a `Workers` heading with one 26px row per standalone Worker. With no graphs and no
 * Workers it shows the empty state.
 */
export function ActiveTab(_props: ActiveTabProps): React.ReactElement {
  throw new Error("Not implemented");
}
