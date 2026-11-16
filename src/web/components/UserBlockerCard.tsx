// 系统挂的“要你动手”的提醒卡（docs/user-blockers-design.md）：写明在哪台设备做什么，点 Done 让那台守护进程重查，
// 能用就把卡住的步骤和 Worker 接着派出去。任务图步骤上和对话里是同一张卡，样式同拍板卡（docs/ui-standard.md 第 12.1 条）。
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
  /** 外面已经写了状态词（放大弹窗的步骤标题行）就不再写一遍。 */
  showStatus?: boolean;
  className?: string;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [err, setErr] = useState<ErrorLike | null>(null);
  // 同步防重入：isPending 要等下一次渲染才变
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
        "rounded-2xl border px-3.5 py-3",
        answered ? "border-border bg-card" : "border-primary bg-jelly",
        className,
      )}
    >
      {showStatus && (
        <div className="mb-1.5 flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", answered ? "bg-muted-foreground" : "bg-status-active")} />
          <span className={cn("text-xs font-medium", answered ? "text-muted-foreground" : "text-primary")}>
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
            {recheck.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
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
