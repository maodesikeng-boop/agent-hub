import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "../ui/icons.ts";
import { useRef, useState } from "react";
import type { UserBlockerId } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Markdown } from "./Markdown.tsx";

export function UserBlockerCard({
  blockerId,
  text,
  answered = false,
  showStatus = true,
  className,
}: {
  blockerId: UserBlockerId;
  text: string;
  answered?: boolean;
  showStatus?: boolean;
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
      className={cn(
        "border px-3.5 py-3",
        answered ? "border-border bg-background" : "border-select-line bg-open",
        className,
      )}
    >
      {showStatus && (
        <div className="mb-1.5 flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", answered ? "bg-muted-foreground" : "bg-status-active")} />
          <span className={cn("text-xs font-medium", answered ? "text-muted-foreground" : "text-foreground")}>
            {answered ? "Done" : "Waiting on you"}
          </span>
        </div>
      )}
      <div className="text-minor leading-relaxed text-foreground">
        <Markdown text={text} />
      </div>
      {!answered && (
        <div className="mt-2.5 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={recheck.isPending}
            onClick={() => {
              if (inFlightRef.current) return;
              inFlightRef.current = true;
              recheck.mutate();
            }}
          >
            {recheck.isPending && <Loader2 className="size-pixel-sm" aria-hidden="true" />}
            {recheck.isPending ? "Checking…" : "Done"}
          </Button>
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
