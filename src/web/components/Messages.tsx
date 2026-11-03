import { Check, ChevronRight, Clock, Loader2, Square, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import type { Message } from "../../shared/index.ts";
import { describeError, formatTime, STATUS_LABELS } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { PendingMessage } from "../state.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";

interface AgentIdentity {
  name: string;
  avatarKey: number;
}

const BUBBLE = "w-fit max-w-full rounded-[22px] px-4 py-2.5 text-[15px] leading-relaxed";

/** agent 一连串消息的第一条带头像和名字，后面的只留头像的位置。 */
function AgentRow({
  identity,
  head,
  as: Tag = "div",
  title,
  children,
}: {
  identity: AgentIdentity;
  head: boolean;
  as?: "div" | "article";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag className={cn("flex gap-3", head ? "mt-5" : "mt-1.5")} data-side="left" data-head={head} title={title}>
      <div className="w-9 shrink-0">{head && <Avatar colorKey={identity.avatarKey} size={36} />}</div>
      <div className="min-w-0 max-w-[85%] space-y-1.5">
        {head && <div className="text-[13px] font-medium text-muted-foreground">{identity.name}</div>}
        {children}
      </div>
    </Tag>
  );
}

export function MessageBubble({
  message,
  identity,
  head,
}: {
  message: Message;
  identity: AgentIdentity;
  head: boolean;
}) {
  const time = formatTime(message.createdAt);
  if (message.sender === "system") {
    return (
      <div className="mt-5 flex justify-center" data-side="center">
        <div className="rounded-full bg-muted px-3 py-1 text-[12.5px] text-muted-foreground">{message.text}</div>
      </div>
    );
  }
  if (message.sender === "user") {
    return (
      <article className="mt-5 flex flex-col items-end" data-side="right" data-status={message.status ?? undefined} title={time}>
        <div className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
          {message.text}
        </div>
        {message.status && <DeliveryStatus status={message.status} reason={message.failureReason} />}
      </article>
    );
  }
  return (
    <AgentRow identity={identity} head={head} as="article" title={time}>
      <div className={cn(BUBBLE, "bg-bubble-agent")}>
        <Markdown text={message.text} />
      </div>
    </AgentRow>
  );
}

function StatusIcon({ status }: { status: NonNullable<Message["status"]> }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "queued":
      return <Clock className={className} aria-hidden="true" />;
    case "delivered":
      return <Check className={className} aria-hidden="true" />;
    case "processing":
      return <Loader2 className={cn(className, "animate-spin")} aria-hidden="true" />;
    case "replied":
      return <Check className={cn(className, "text-success")} aria-hidden="true" />;
    case "stopped":
      return <Square className={cn(className, "fill-current")} aria-hidden="true" />;
    case "failed":
      return <X className={className} aria-hidden="true" />;
  }
}

function DeliveryStatus({ status, reason }: { status: NonNullable<Message["status"]>; reason: string | null }) {
  const failure = status === "failed" && reason ? describeError(reason) : null;
  return (
    <div
      className={cn("mt-1 flex items-center gap-1 pr-1 text-xs", status === "failed" ? "text-danger" : "text-muted-foreground")}
      data-status={status}
    >
      <StatusIcon status={status} />
      <span>{STATUS_LABELS[status]}</span>
      {failure && (
        <>
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span title={reason ?? undefined}>{failure.label}</span>
        </>
      )}
    </div>
  );
}

/** 网页先显示出来、服务端还没确认的用户消息。 */
export function PendingBubble({ pending, onRetry }: { pending: PendingMessage; onRetry: (clientId: string) => void }) {
  const failed = pending.phase === "failed";
  return (
    <article className="mt-5 flex flex-col items-end" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      <div className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
        {pending.text}
      </div>
      <div
        className={cn("mt-1 flex items-center gap-1.5 pr-1 text-xs", failed ? "text-danger" : "text-muted-foreground")}
        data-status={failed ? "failed" : "queued"}
      >
        {failed ? <X className="size-3.5 shrink-0" aria-hidden="true" /> : <Clock className="size-3.5 shrink-0" aria-hidden="true" />}
        <span>{failed ? "发送失败" : STATUS_LABELS.queued}</span>
        {failed && (
          <button
            type="button"
            className="cursor-pointer font-medium text-primary underline underline-offset-2"
            onClick={() => onRetry(pending.clientId)}
          >
            重试
          </button>
        )}
      </div>
    </article>
  );
}

/** 一轮里连续的工具调用，折叠成一行“执行了 N 个操作”，点开看每一步。 */
export function ToolGroup({
  messages,
  identity,
  head,
}: {
  messages: Message[];
  identity: AgentIdentity;
  head: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AgentRow identity={identity} head={head}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-2 rounded-full bg-muted px-3.5 py-1.5 text-[13.5px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <TerminalSquare className="size-4" aria-hidden="true" />
          执行了 {messages.length} 个操作
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1.5 space-y-1 pl-3 font-mono text-[12.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {messages.map((m) => (
              <li key={m.id}>{m.text}</li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </AgentRow>
  );
}
