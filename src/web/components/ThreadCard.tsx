import type * as React from "react";
import type { AgentVendor, ConversationId, WorkerMessageMeta } from "../../shared/index.ts";
import type { SlimeLook } from "../../shared/slimes.ts";

export interface ThreadCardProps {
  /** A report, turn_failed, or worktree_failed Worker event. */
  line: WorkerMessageMeta;
  /** The owning PM's look; the card's note sprite takes its color. */
  look: SlimeLook;
  /** The Worker is open in the side panel. */
  open: boolean;
  vendor?: AgentVendor;
  onOpen: (workerConversationId: ConversationId) => void;
}

/**
 * Postcondition: renders one button-like card with the note sprite and status square, the cleaned Piece title, the
 * status word from workerStatusOf, the report time, and the report's first line truncated with its full text in title;
 * failures show describeFailure text; the open card uses the open fill and outline.
 */
export function ThreadCard(props: ThreadCardProps): React.ReactElement {
  throw new Error("Not implemented");
}
