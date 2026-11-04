import {
  Archive,
  Check,
  CircleCheck,
  CircleHelp,
  CirclePlay,
  CircleX,
  ChevronRight,
  Clock,
  Loader2,
  MessageSquare,
  Square,
  TerminalSquare,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  attachmentsOf,
  sentFilesOf,
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  workerLineText,
  type ConversationId,
  type Message,
  type MessageId,
  type PersonaChangeId,
  type WorkerMessageMeta,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { describeError, formatTime, STATUS_LABELS } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { PendingMessage, RetryPhase } from "../state.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";

interface AgentIdentity {
  name: string;
  avatarKey: number;
}

/** 消息上能点的操作：重试服务端标了失败的用户消息、撤销项目经理对自己性格设定的修改、点开 Worker。 */
export interface MessageActions {
  /** 点项目经理会话里的 Worker 那一行：打开这个 Worker 自己的对话。 */
  onOpenWorker: (workerConversationId: ConversationId) => void;
  /** 点过“重试”的消息的状态。 */
  retry: Record<MessageId, RetryPhase | undefined>;
  onRetryMessage: (messageId: MessageId) => void;
  /** 撤销失败就 reject（ApiError，409 是“不是最近一次”）。 */
  onRevertPersona: (changeId: PersonaChangeId) => Promise<void>;
}

const BUBBLE = "w-fit max-w-full rounded-[22px] px-4 py-2.5 text-[15px] leading-relaxed";

/** agent 一连串消息的第一条在正文上方带一行小头像和名字，后面的只有正文；正文从最左边开始、占满整行。 */
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
    <Tag className={cn("flex flex-col", head ? "mt-5" : "mt-1.5")} data-side="left" data-head={head} title={title}>
      {head && (
        <div className="mb-1.5 flex items-center gap-2">
          <Avatar colorKey={identity.avatarKey} size={24} />
          <div className="text-[13px] font-medium text-muted-foreground">{identity.name}</div>
        </div>
      )}
      <div className="w-full min-w-0 space-y-1.5">{children}</div>
    </Tag>
  );
}

type RevertPhase = "idle" | "busy" | "done" | "conflict" | "error";

/** 撤销按钮：只有项目经理改了性格设定的系统消息有。只有最近一次能撤销，别的服务端回 409。 */
function RevertButton({ changeId, onRevert }: { changeId: PersonaChangeId; onRevert: MessageActions["onRevertPersona"] }) {
  const [phase, setPhase] = useState<RevertPhase>("idle");
  if (phase === "done") return <span>已撤销</span>;
  const revert = () => {
    setPhase("busy");
    onRevert(changeId).then(
      () => setPhase("done"),
      (err: unknown) => setPhase(err instanceof ApiError && err.status === 409 ? "conflict" : "error"),
    );
  };
  return (
    <>
      {phase === "conflict" && <span className="text-danger">只能撤销最近一次</span>}
      {phase === "error" && <span className="text-danger">撤销失败</span>}
      <button
        type="button"
        className="cursor-pointer font-medium text-primary underline underline-offset-2 disabled:cursor-default disabled:no-underline disabled:opacity-60"
        disabled={phase === "busy"}
        onClick={revert}
      >
        {phase === "busy" ? "撤销中" : "撤销"}
      </button>
    </>
  );
}

/** 系统消息：居中的一条，去掉发给 agent 时加的【系统】，不显示投递状态。 */
function SystemNotice({ message, actions }: { message: Message; actions: MessageActions }) {
  const event = systemEventOf(message);
  return (
    <div className="mt-5 flex justify-center" data-side="center">
      <div className="flex max-w-[85%] flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 rounded-2xl bg-muted px-3.5 py-1.5 text-center text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">
        <span>{systemNoticeText(message)}</span>
        {event?.event === "persona.changed" && <RevertButton changeId={event.personaChangeId} onRevert={actions.onRevertPersona} />}
      </div>
    </div>
  );
}

const WORKER_LINE_ICON_CLASS = "size-4 shrink-0";

/** 那一行前面的图标：派出、做完了、有问题、出错或放弃、没按格式、收工、你直接对它说的话。 */
function WorkerLineIcon({ line }: { line: WorkerMessageMeta }) {
  switch (line.event) {
    case "started":
      return <CirclePlay className={cn(WORKER_LINE_ICON_CLASS, "text-primary")} aria-hidden="true" />;
    case "ended":
      return <Archive className={WORKER_LINE_ICON_CLASS} aria-hidden="true" />;
    case "user_message":
      return <MessageSquare className={cn(WORKER_LINE_ICON_CLASS, "text-muted-foreground")} aria-hidden="true" />;
    case "turn_failed":
    case "worktree_failed":
      return <CircleX className={cn(WORKER_LINE_ICON_CLASS, "text-danger")} aria-hidden="true" />;
    case "report":
      switch (line.status) {
        case "done":
          return <CircleCheck className={cn(WORKER_LINE_ICON_CLASS, "text-success")} aria-hidden="true" />;
        case "problem":
          return <TriangleAlert className={cn(WORKER_LINE_ICON_CLASS, "text-warn-foreground")} aria-hidden="true" />;
        case "gave_up":
          return <CircleX className={cn(WORKER_LINE_ICON_CLASS, "text-danger")} aria-hidden="true" />;
        default:
          return <CircleHelp className={WORKER_LINE_ICON_CLASS} aria-hidden="true" />;
      }
  }
}

/** 项目经理会话里的 Worker 汇报：居中的一行，点开看这个 Worker 干了什么。给项目经理的汇报原文不显示。 */
function WorkerLine({ line, onOpen }: { line: WorkerMessageMeta; onOpen: (workerConversationId: ConversationId) => void }) {
  return (
    <div className="mt-5 flex justify-center px-6" data-side="center">
      <button
        type="button"
        className="group flex max-w-[85%] cursor-pointer items-center gap-2 rounded-2xl bg-muted px-3.5 py-2 text-left text-[13.5px] transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onOpen(line.workerConversationId)}
      >
        <WorkerLineIcon line={line} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{workerLineText(line)}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}

export function MessageBubble({
  message,
  identity,
  head,
  actions,
}: {
  message: Message;
  identity: AgentIdentity;
  head: boolean;
  actions: MessageActions;
}) {
  const time = formatTime(message.createdAt);
  // agent 发来的文件：meta 没变就是同一个数组，Markdown 不用重建插件
  const files = useMemo(() => sentFilesOf(message), [message.meta]);
  const workerLine = workerEventOf(message);
  if (workerLine) return <WorkerLine line={workerLine} onOpen={actions.onOpenWorker} />;
  if (message.sender === "system") return <SystemNotice message={message} actions={actions} />;
  if (message.sender === "user") {
    const attachments = attachmentsOf(message);
    return (
      <article className="mt-5 flex flex-col items-end" data-side="right" data-status={message.status ?? undefined} title={time}>
        {/* 只发文件没写字的消息没有文字气泡 */}
        {(message.text !== "" || attachments.length === 0) && (
          <div data-bubble className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
            {message.text}
          </div>
        )}
        <AttachmentList attachments={attachments} />
        {message.status && (
          <DeliveryStatus
            status={message.status}
            reason={message.failureReason}
            retry={message.status === "failed" ? { phase: actions.retry[message.id], onRetry: () => actions.onRetryMessage(message.id) } : undefined}
          />
        )}
      </article>
    );
  }
  return (
    <AgentRow identity={identity} head={head} as="article" title={time}>
      <div className="w-full min-w-0 text-[15px] leading-relaxed">
        <Markdown text={message.text} files={files} />
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

function DeliveryStatus({
  status,
  reason,
  retry,
}: {
  status: NonNullable<Message["status"]>;
  reason: string | null;
  /** 服务端标了失败的用户消息才有“重试”。 */
  retry?: { phase: RetryPhase | undefined; onRetry: () => void };
}) {
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
      {retry && (
        <>
          {retry.phase === "error" && <span className="ml-1">重试失败</span>}
          <button
            type="button"
            className="ml-1 cursor-pointer font-medium text-primary underline underline-offset-2 disabled:cursor-default disabled:no-underline disabled:opacity-60"
            disabled={retry.phase === "retrying"}
            onClick={retry.onRetry}
          >
            {retry.phase === "retrying" ? "重试中" : "重试"}
          </button>
        </>
      )}
    </div>
  );
}

/** 网页先显示出来、服务端还没确认的用户消息。 */
export function PendingBubble({ pending, onRetry }: { pending: PendingMessage; onRetry: (clientId: string) => void }) {
  const failed = pending.phase === "failed";
  const filesGone = failed && pending.failure === "attachments_missing";
  return (
    <article className="mt-5 flex flex-col items-end" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      {(pending.text !== "" || pending.attachments.length === 0) && (
        <div data-bubble className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
          {pending.text}
        </div>
      )}
      <AttachmentList attachments={pending.attachments} />
      <div
        className={cn("mt-1 flex items-center gap-1.5 pr-1 text-xs", failed ? "text-danger" : "text-muted-foreground")}
        data-status={failed ? "failed" : "queued"}
      >
        {failed ? <X className="size-3.5 shrink-0" aria-hidden="true" /> : <Clock className="size-3.5 shrink-0" aria-hidden="true" />}
        <span>{filesGone ? "文件已不在，请重新添加" : failed ? "发送失败" : STATUS_LABELS.queued}</span>
        {failed && !filesGone && (
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
