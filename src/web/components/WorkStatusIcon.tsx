import type * as React from "react";
import type { WorkStatus } from "../work-status.ts";

/**
 * Postcondition: draws the 14px status mark: green check ring for done, ink pie for running, ink clock for waiting, gray
 * hollow ring for pending, and a gray ring with a slash for cancelled. The mark is decorative (aria-hidden); rows carry
 * the status in their accessible name.
 */
export function WorkStatusIcon(_props: { status: WorkStatus; className?: string }): React.ReactElement {
  throw new Error("Not implemented");
}
