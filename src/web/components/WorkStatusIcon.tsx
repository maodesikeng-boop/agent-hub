import type * as React from "react";
import { cn } from "../lib/utils.ts";
import type { WorkStatus } from "../work-status.ts";

export function WorkStatusIcon({ status, className }: { status: WorkStatus; className?: string }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-status={status}
      className={cn("work-status-icon", className)}
    >
      {status === "done" && (
        <>
          <circle cx="8" cy="8" r="6.2" fill="#e7f4eb" stroke="#36874e" strokeWidth="1.25" />
          <path d="M5.2 8.2 7.1 10.1 10.8 6.1" stroke="#2d7a44" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "running" && (
        <>
          <circle cx="8" cy="8" r="6.2" stroke="#3b2f25" strokeWidth="1.35" />
          <path d="M8 8 V3.6 A4.4 4.4 0 0 1 12.4 8 A4.4 4.4 0 0 1 8 12.4 Z" fill="#3b2f25" />
        </>
      )}
      {status === "waiting" && (
        <>
          <circle cx="8" cy="8" r="6.2" stroke="#3b2f25" strokeWidth="1.35" />
          <path d="M8 4.6 V8 L10.4 9.4" stroke="#3b2f25" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "pending" && <circle cx="8" cy="8" r="5.5" stroke="#c7bfb4" strokeWidth="1.3" />}
      {status === "cancelled" && (
        <>
          <circle cx="8" cy="8" r="6.2" stroke="#b5ada3" strokeWidth="1.3" />
          <path d="M5.6 10.4 10.4 5.6" stroke="#b5ada3" strokeWidth="1.3" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
