// 消息流里的每一种东西（docs/ui-standard.md 第 17 条）：一轮回复（一个头像、操作合成一行 Worked for、文字、复制和时间）、
// 用户的气泡、Worker 的发言、很淡的系统行、到点的定时任务、消息状态、空对话。怎么分组见 selectors.ts 的 groupMessages。
import {
  Archive,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  CircleX,
  Clock,
  Copy,
  FolderMinus,
  FolderPlus,
  Info,
  MessageSquare,
  RefreshCw,
  Square,
  TriangleAlert,
  UserPen,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  attachmentsOf,
  REPORT_END,
  REPORT_START,
  sentFilesOf,
  systemEventOf,
  systemNoticeText,
  WORKER_REPORT_STATUS_LABELS,
  workerEventOf,
  workerLineText,
  type ConversationId,
  type Message,
  type MessageId,
  type PersonaChangeId,
  type SystemMessageMeta,
  type WorkerMessageMeta,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { describeFailure } from "../errors.ts";
import { formatTime, STATUS_LABELS } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { RenderItem } from "../selectors.ts";
import type { PendingMessage, RetryPhase } from "../state.ts";
import { workedFor } from "../step-labels.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";

export interface AgentIdentity {
  name: string;
  avatarKey: number;
  /** Worker：中性灰的头像（不按编号配色）。 */
  neutral?: boolean;
}

/** 消息上能点的操作：重试服务端标了失败的用户消息、撤销项目经理对自己性格设定的修改、点开 Worker。 */
export interface MessageActions {
  /** 点项目经理会话里 Worker 的发言、派出 / 收工那一行：打开这个 Worker 自己的对话。 */
  onOpenWorker: (workerConversationId: ConversationId) => void;
  /** 点过“重试”的消息的状态。 */
  retry: Record<MessageId, RetryPhase | undefined>;
  onRetryMessage: (messageId: MessageId) => void;
  /** 撤销失败就 reject（ApiError，409 是“不是最近一次”）。 */
  onRevertPersona: (changeId: PersonaChangeId) => Promise<void>;
}

const BUBBLE = "w-fit max-w-full rounded-[22px] px-4 py-2.5 text-[15px] leading-relaxed";
/** 名字、Worked for、可点开的系统行：13.5px 灰。 */
const SECONDARY = "text-[13.5px] text-muted-foreground";
/** 文字按钮：没有底色和胶囊，悬停变前景色，键盘聚焦有中性的圈。 */
const TEXT_BUTTON = "cursor-pointer rounded-full transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/** 头像（24px）+ 名字；Worker 的发言在名字后面跟状态小标注。头像旁不放 agent 的状态。 */
function AgentHead({ identity, children }: { identity: AgentIdentity; children?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2" data-slot="agent-head">
      <Avatar colorKey={identity.avatarKey} size={24} neutral={identity.neutral} />
      <div className={cn("min-w-0 truncate font-medium", SECONDARY)}>{identity.name}</div>
      {children}
    </div>
  );
}

/**
 * Worker 回复末尾给项目经理的汇报块（=== 汇报 === … === 汇报结束 ===）：去掉两行标记，每一项一行（Markdown 会把相邻的行并成一段）。
 * 只改显示，复制拿的还是原文。
 */
export function displayText(text: string): string {
  const end = text.lastIndexOf(REPORT_END);
  const start = end === -1 ? -1 : text.lastIndexOf(REPORT_START, end);
  if (start === -1) return text;
  const items = text
    .slice(start + REPORT_START.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `- ${line}`);
  return `${text.slice(0, start).trimEnd()}\n\n---\n\n${items.join("\n")}\n\n${text.slice(end + REPORT_END.length).trim()}`.trim();
}

/** agent 说的一段文字（Markdown）。hub ask 问你的不另挂“等你确定”标签：右栏已经列着，点过去会高亮这一条。 */
function AgentText({ message, highlighted }: { message: Message; highlighted: boolean }) {
  // agent 发来的文件：meta 没变就是同一个数组，Markdown 不用重建插件
  const files = useMemo(() => sentFilesOf(message), [message.meta]);
  return (
    <article
      className={cn("flex w-full min-w-0 flex-col items-start gap-1.5", highlighted && "rounded-2xl outline-2 outline-offset-4 outline-ring/60")}
      data-side="left"
      data-message-id={message.id}
      data-highlighted={highlighted ? "true" : undefined}
    >
      <div className="w-full min-w-0 text-[15px] leading-relaxed">
        <Markdown text={displayText(message.text)} files={files} messageId={message.id} />
      </div>
    </article>
  );
}

/** Worked for 里的一步：工具原样（等宽）、派出 / 收工的 Worker（点开它的对话）、建删的定时任务。 */
function WorkStep({ message, onOpenWorker }: { message: Message; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const line = workerEventOf(message);
  if (line) {
    return (
      <li>
        <button type="button" className={cn(TEXT_BUTTON, "text-left [overflow-wrap:anywhere]")} onClick={() => onOpenWorker(line.workerConversationId)}>
          {workerLineText(line)}
        </button>
      </li>
    );
  }
  if (message.sender === "system") return <li className="[overflow-wrap:anywhere]">{systemNoticeText(message)}</li>;
  return <li className="font-mono [overflow-wrap:anywhere]">{message.text}</li>;
}

/**
 * 一轮的操作合成的那一行：跑完是“Worked for 23s ›”，正在跑是状态（AgentStatus）。有操作才能点开看每一步。
 */
function WorkLine({ label, work, onOpenWorker }: { label: React.ReactNode; work: Message[]; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const [open, setOpen] = useState(false);
  if (work.length === 0) {
    return (
      <div className={SECONDARY} data-work-line>
        {label}
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-work-line>
      <CollapsibleTrigger className={cn("group inline-flex items-center gap-1", TEXT_BUTTON, SECONDARY)}>
        {label}
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 mb-1 space-y-1 border-l border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {work.map((m) => (
            <WorkStep key={m.id} message={m} onOpenWorker={onOpenWorker} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 复制按钮：点了换成勾，过一会儿变回来。 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <Button variant="ghost" size="icon-sm" className="-ml-2 size-7" aria-label={copied ? "已复制" : "复制"} title={copied ? "已复制" : "复制"} onClick={copy}>
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </Button>
  );
}

type Turn = Extract<RenderItem, { kind: "turn" }>;

/**
 * agent 的一轮回复：开头一次头像 + 名字；操作合成一行；文字和夹在中间的系统行按顺序排；跑完最下面是复制和时间。
 * status：这一轮还在跑时的状态（AgentStatus），那一行挪到最下面；没在跑是 undefined。
 */
export function TurnView({
  turn,
  identity,
  status,
  actions,
  highlightId,
}: {
  turn: Pick<Turn, "work" | "parts" | "startedAt" | "endedAt">;
  identity: AgentIdentity;
  status?: React.ReactNode;
  actions: MessageActions;
  highlightId?: MessageId | null;
}) {
  const running = status != null;
  const texts = turn.parts.filter((m) => m.sender === "agent");
  const lastText = texts.at(-1);
  return (
    <div className="mt-6 flex flex-col first:mt-2" data-turn data-side="left" data-running={running ? "true" : undefined}>
      <AgentHead identity={identity} />
      <div className="flex flex-col gap-2.5">
        {!running && turn.work.length > 0 && <WorkLine label={workedFor(turn.endedAt - turn.startedAt)} work={turn.work} onOpenWorker={actions.onOpenWorker} />}
        {turn.parts.map((m) =>
          m.sender === "agent" ? <AgentText key={m.id} message={m} highlighted={m.id === highlightId} /> : <SystemNotice key={m.id} message={m} actions={actions} inTurn />,
        )}
        {running && <WorkLine label={status} work={turn.work} onOpenWorker={actions.onOpenWorker} />}
        {!running && lastText && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <CopyButton text={texts.map((m) => m.text).join("\n\n")} />
            <span>{formatTime(lastText.createdAt)}</span>
          </div>
        )}
      </div>
    </div>
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
        className="cursor-pointer font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:no-underline disabled:opacity-60"
        disabled={phase === "busy"}
        onClick={revert}
      >
        {phase === "busy" ? "撤销中" : "撤销"}
      </button>
    </>
  );
}

/** 到点的定时任务：一行系统样子的标题（时钟 + “定时任务：名字（原定 09:00）”），点开看任务说明。 */
function ScheduleRun({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const match = /^【([^】]*)】\s*([\s\S]*)$/.exec(text);
  const title = match?.[1] ?? "定时任务";
  const body = (match?.[2] ?? text).trim();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-6 flex flex-col items-start" data-side="left" data-event="schedule.run">
      <CollapsibleTrigger className={cn("group inline-flex items-center gap-1.5", TEXT_BUTTON, SECONDARY)} disabled={body === ""}>
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="[overflow-wrap:anywhere]">{title}</span>
        {body !== "" && <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <p className={cn("mt-1.5 border-l border-border pl-3 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", SECONDARY)}>{body}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

const NOTICE_ICONS: Partial<Record<SystemMessageMeta["event"], LucideIcon>> = {
  "project.created": FolderPlus,
  "folder.attached": FolderPlus,
  "folder.detached": FolderMinus,
  "persona.changed": UserPen,
  "schedule.created": CalendarClock,
  "schedule.removed": CalendarClock,
  "handover.requested": RefreshCw,
  "session.renewed": RefreshCw,
};

const WORKER_NOTICE_ICONS: Partial<Record<WorkerMessageMeta["event"], LucideIcon>> = {
  started: CirclePlay,
  ended: Archive,
  user_message: MessageSquare,
};

/** 很淡的一行：靠左、12px 灰、前面一个小图标，没有底色、不居中。出错的图标是红的。 */
function NoticeLine({
  icon: Icon,
  danger = false,
  title,
  inTurn = false,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  title?: string;
  inTurn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-1.5 text-xs leading-5 text-muted-foreground", !inTurn && "mt-4")} data-side="left" data-notice title={title}>
      <Icon className={cn("mt-[3px] size-3.5 shrink-0", danger && "text-danger")} aria-hidden="true" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** 系统消息：到点的定时任务是可点开的一行，别的都是很淡的一行（去掉发给 agent 时加的【系统】，不显示投递状态）。 */
function SystemNotice({ message, actions, inTurn = false }: { message: Message; actions: MessageActions; inTurn?: boolean }) {
  const event = systemEventOf(message);
  const text = systemNoticeText(message);
  switch (event?.event) {
    case "schedule.run":
      return <ScheduleRun text={text} />;
    case "schedule.failed": {
      // “定时任务没跑成：名字：原因”：原因写成人话，原文放 title
      const prefix = `定时任务没跑成：${event.name}：`;
      const reason = text.startsWith(prefix) ? describeFailure(text.slice(prefix.length), { unknown: "raw" }).text : null;
      return (
        <NoticeLine icon={CircleX} danger title={text} inTurn={inTurn}>
          <span>{reason === null ? text : `定时任务「${event.name}」没跑成：${reason}`}</span>
        </NoticeLine>
      );
    }
    case "handover.failed":
      return (
        <NoticeLine icon={CircleX} danger inTurn={inTurn}>
          <span>{text}</span>
        </NoticeLine>
      );
    case "persona.changed":
      return (
        <NoticeLine icon={UserPen} inTurn={inTurn}>
          <span>{text}</span>
          <RevertButton changeId={event.personaChangeId} onRevert={actions.onRevertPersona} />
        </NoticeLine>
      );
    default:
      return (
        <NoticeLine icon={(event && NOTICE_ICONS[event.event]) ?? Info} inTurn={inTurn}>
          <span>{text}</span>
        </NoticeLine>
      );
  }
}

/** Worker 的状态小标注：图标带颜色、字是灰的。没按格式的不标。 */
function workerTag(line: WorkerMessageMeta): { icon: LucideIcon; className: string; label: string } | null {
  if (line.event === "turn_failed" || line.event === "worktree_failed") return { icon: CircleX, className: "text-danger", label: "出错" };
  switch (line.status) {
    case "done":
      return { icon: CircleCheck, className: "text-success", label: WORKER_REPORT_STATUS_LABELS.done };
    case "problem":
      return { icon: TriangleAlert, className: "text-warn-foreground", label: WORKER_REPORT_STATUS_LABELS.problem };
    case "gave_up":
      return { icon: CircleX, className: "text-danger", label: WORKER_REPORT_STATUS_LABELS.gave_up };
    default:
      return null;
  }
}

/**
 * Worker 的发言（项目经理对话里的汇报、这一轮没做完、建 worktree 失败）：中性头像 + 标题 + 状态小标注，正文是摘要。
 * 整条可点，打开 Worker 的完整对话。给项目经理的汇报原文不显示。
 */
function WorkerSpeech({ line, onOpen }: { line: WorkerMessageMeta; onOpen: MessageActions["onOpenWorker"] }) {
  const tag = workerTag(line);
  const failed = line.event !== "report";
  const summary = line.summary?.trim() ?? "";
  const body = failed && summary !== "" ? describeFailure(summary, { unknown: "raw" }) : null;
  return (
    <article className="mt-4 flex flex-col" data-side="left" data-worker-report>
      <button
        type="button"
        className="-mx-3 flex cursor-pointer flex-col items-start rounded-2xl px-3 py-2 text-left transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onOpen(line.workerConversationId)}
      >
        <AgentHead identity={{ name: line.title, avatarKey: line.workerId, neutral: true }}>
          {tag && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" data-tag>
              <tag.icon className={cn("size-3.5", tag.className)} aria-hidden="true" />
              {tag.label}
            </span>
          )}
        </AgentHead>
        {summary !== "" && (
          <p className="w-full min-w-0 text-[15px] leading-relaxed [overflow-wrap:anywhere]" title={body ? body.raw : undefined}>
            {body ? body.text : summary}
          </p>
        )}
      </button>
    </article>
  );
}

/** 项目经理对话里 Worker 的那些行：汇报是 Worker 的发言，派出、收工、你对它说的是很淡的一行（点开 Worker）。 */
function WorkerItem({ line, onOpen }: { line: WorkerMessageMeta; onOpen: MessageActions["onOpenWorker"] }) {
  if (line.event === "report" || line.event === "turn_failed" || line.event === "worktree_failed") return <WorkerSpeech line={line} onOpen={onOpen} />;
  return (
    <NoticeLine icon={WORKER_NOTICE_ICONS[line.event] ?? Info}>
      <button type="button" className={cn(TEXT_BUTTON, "text-left")} onClick={() => onOpen(line.workerConversationId)}>
        {workerLineText(line)}
      </button>
    </NoticeLine>
  );
}

/**
 * 单独显示的一条（不在一轮回复里的）：用户的气泡、Worker 对话里项目经理的话、Worker 的发言、系统行。
 * head：项目经理的话要不要带头像（上一条也是它说的就不带）。
 */
export function MessageBubble({
  message,
  identity,
  head,
  actions,
  highlighted = false,
}: {
  message: Message;
  identity: AgentIdentity;
  head: boolean;
  actions: MessageActions;
  highlighted?: boolean;
}) {
  const workerLine = workerEventOf(message);
  if (workerLine) return <WorkerItem line={workerLine} onOpen={actions.onOpenWorker} />;
  if (message.sender === "system") return <SystemNotice message={message} actions={actions} />;
  if (message.sender === "user") return <UserBubble message={message} actions={actions} />;
  // Worker 对话里项目经理的话（任务、打回）：头像 + 名字 + 正文，和项目经理对话里它自己说话一个样子
  return (
    <div className={cn("flex flex-col", head ? "mt-6 first:mt-2" : "mt-2.5")} data-side="left" data-head={head}>
      {head && <AgentHead identity={identity} />}
      <AgentText message={message} highlighted={highlighted} />
    </div>
  );
}

function UserBubble({ message, actions }: { message: Message; actions: MessageActions }) {
  const attachments = attachmentsOf(message);
  return (
    <article className="mt-6 flex flex-col items-end first:mt-2" data-side="right" data-status={message.status ?? undefined} title={formatTime(message.createdAt)}>
      {/* 只发文件没写字的消息没有文字气泡 */}
      {(message.text !== "" || attachments.length === 0) && (
        <div data-bubble className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
          {message.text}
        </div>
      )}
      <AttachmentList attachments={attachments} />
      <DeliveryStatus
        status={message.status}
        reason={message.failureReason}
        retry={message.status === "failed" ? { phase: actions.retry[message.id], onRetry: () => actions.onRetryMessage(message.id) } : undefined}
      />
    </article>
  );
}

/** 用户消息下面只在这几种状态显示一行；已送达、处理中、已回复不显示。 */
const SHOWN_STATUSES = new Set<Message["status"]>(["queued", "failed", "stopped"]);

const DELIVERY_ROW = "mt-1 flex items-center gap-1.5 pr-1 text-xs";
const RETRY_BUTTON = "cursor-pointer font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:no-underline disabled:opacity-60";

function DeliveryStatus({
  status,
  reason,
  retry,
}: {
  status: Message["status"];
  reason: string | null;
  /** 服务端标了失败的用户消息才有“重试”。 */
  retry?: { phase: RetryPhase | undefined; onRetry: () => void };
}) {
  if (status === null || !SHOWN_STATUSES.has(status)) return null;
  const failed = status === "failed";
  const failure = failed && reason ? describeFailure(reason) : null;
  return (
    <div className={cn(DELIVERY_ROW, failed ? "text-danger" : "text-muted-foreground")} data-status={status} data-delivery>
      {status === "queued" && <Clock className="size-3.5 shrink-0" aria-hidden="true" />}
      {status === "stopped" && <Square className="size-3 shrink-0 fill-current" aria-hidden="true" />}
      {failed && <X className="size-3.5 shrink-0" aria-hidden="true" />}
      {failed ? <span title={failure?.raw}>{failure ? failure.text : "发送失败"}</span> : <span>{STATUS_LABELS[status]}</span>}
      {retry && (
        <>
          {retry.phase === "error" && <span>重试失败</span>}
          <button type="button" className={RETRY_BUTTON} disabled={retry.phase === "retrying"} onClick={retry.onRetry}>
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
  const rejected = failed && pending.failure === "rejected" && pending.reason !== undefined;
  const noRetry = filesGone || rejected;
  return (
    <article className="mt-6 flex flex-col items-end first:mt-2" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      {(pending.text !== "" || pending.attachments.length === 0) && (
        <div data-bubble className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
          {pending.text}
        </div>
      )}
      <AttachmentList attachments={pending.attachments} />
      <div className={cn(DELIVERY_ROW, failed ? "text-danger" : "text-muted-foreground")} data-status={failed ? "failed" : "queued"} data-delivery>
        {failed ? <X className="size-3.5 shrink-0" aria-hidden="true" /> : <Clock className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{filesGone ? "文件已不在，请重新添加" : rejected ? pending.reason : failed ? "发送失败" : STATUS_LABELS.queued}</span>
        {failed && !noRetry && (
          <button type="button" className={RETRY_BUTTON} onClick={() => onRetry(pending.clientId)}>
            重试
          </button>
        )}
      </div>
    </article>
  );
}

/** 空对话：中间是 agent 的头像、名字和“还没有消息”。 */
export function EmptyConversation({ identity }: { identity?: AgentIdentity }) {
  return (
    <div className="m-auto flex flex-col items-center gap-3 py-10 text-center" data-empty>
      {identity && <Avatar colorKey={identity.avatarKey} size={48} neutral={identity.neutral} />}
      <div className="flex flex-col items-center gap-0.5">
        {identity && <div className="text-[17px] font-semibold">{identity.name}</div>}
        <div className={SECONDARY}>还没有消息</div>
      </div>
    </div>
  );
}
