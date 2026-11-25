import type * as React from "react";
import type { WorkStatus } from "../work-status.ts";

export interface WorkerMenuFacts {
  /** `Opus 5.5 Max`, or null when unknown. */
  model: string | null;
  /** `12m`, or null before the Worker starts. */
  duration: string | null;
  branch: string | null;
}

export interface WorkerDetailHeaderProps {
  title: string;
  status: WorkStatus;
  facts: WorkerMenuFacts;
  /** Null hides Stop (nothing running). */
  onStop: (() => void) | null;
  /** Null hides End (already ended or read-only). */
  onEnd: (() => void) | null;
  onBack: () => void;
  backLabel: string;
  onClose: () => void;
}

/**
 * Postcondition: back arrow, status icon, title, a `⋯` popover holding model and effort, duration, branch, Stop, and
 * End, then Close; no meta line under the header. The body below is the existing WorkerConversation, whose message list
 * and composer are the main chat's.
 */
export function WorkerDetailHeader(_props: WorkerDetailHeaderProps): React.ReactElement {
  throw new Error("Not implemented");
}
