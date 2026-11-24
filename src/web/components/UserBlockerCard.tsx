import { useMutation } from "@tanstack/react-query";
import { Check, Loader2 } from "../ui/icons.ts";
import { useRef, useState } from "react";
import type { UserBlockerId } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Markdown } from "./Markdown.tsx";
import { decisionFrame } from "./OptionRow.tsx";

export function UserBlockerCard({
  blockerId,
  text,
  answered = false,
  showStatus = true,
  compact = false,
  className,
}: {
  blockerId: UserBlockerId;
  text: string;
  answered?: boolean;
  showStatus?: boolean;
  /** Task Graph canvas: secondary text size and the narrower inset. */
  compact?: boolean;
  className?: string;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [err, setErr] = useState<ErrorLike | null>(null);
  const inFlightRef = useRef(false);
  const recheck = useMutation(
    {
      mutationFn: () => client.postRecheckUserBlocker(blockerId),
      onMutate: () => setErr(null),
      onError: (error) => setErr(errorText(error)),
      onSettled: () => {
        inFlightRef.current = false;
      },
    },
    qc,
  );

  return (
    <div
      data-testid="user-blocker-card"
      className={cn(compact ? "px-3.5 py-3" : "p-4", decisionFrame(!answered), className)}
    >
      {showStatus && (
        <div className="mb-1.5 flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", answered ? "bg-muted-foreground" : "bg-status-active")} />
          <span className={cn("text-xs font-medium", answered ? "text-muted-foreground" : "text-foreground")}>
            {answered ? "Done" : "Waiting on you"}
          </span>
        </div>
      )}
      <div className={cn("leading-relaxed text-foreground", compact ? "text-minor" : "text-body")}>
        <Markdown text={text} />
      </div>
      {!answered && (
        <div className={cn("mt-3 border-t border-border", compact ? "-mx-3.5 -mb-3" : "-mx-4 -mb-4")}>
          <button
            type="button"
            disabled={recheck.isPending}
            className={cn(
              "group/done flex w-full cursor-pointer items-center gap-3 rounded-none text-left font-medium text-foreground transition-colors duration-150 outline-none hover:bg-hover active:bg-open focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:min-h-11 motion-reduce:transition-none",
              compact ? "min-h-9 px-3.5 py-2 text-minor leading-5" : "min-h-10 px-4 py-2 text-body leading-6",
            )}
            onClick={() => {
              if (inFlightRef.current) return;
              inFlightRef.current = true;
              recheck.mutate();
            }}
          >
            <span className="flex w-4 shrink-0 justify-center text-muted-foreground group-hover/done:text-foreground">
              {recheck.isPending ? <Loader2 className="size-pixel-sm" aria-hidden="true" /> : <Check className="size-pixel-sm" aria-hidden="true" />}
            </span>
            {recheck.isPending ? "Checking…" : "Done"}
          </button>
        </div>
      )}
      {err !== null && (
        <p role="alert" title={errorTitle(err)} className="mt-2 text-xs text-danger">
          {errorLine(err)}
        </p>
      )}
    </div>
  );
}
