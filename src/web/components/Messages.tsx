// 消息流里的每一种东西（docs/ui-standard.md 第 17 条）：一轮回复（一个头像、操作合成一行 Worked for、文字、复制和时间）、
// 用户的气泡、Worker 的发言、很淡的系统行、到点的定时任务、消息状态、空对话。怎么分组见 selectors.ts 的 groupMessages。
import {
  Archive,
  CalendarClock,
  Check,
  ChevronRight,
  CirclePlay,
  CircleX,
  Clock,
  Copy,
  FolderMinus,
  FolderPlus,
  Info,
  MessageSquare,
  RefreshCw,
  UserPen,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  attachmentsOf,
  extractAskCard,
  REPORT_END,
  REPORT_START,
  sentFilesOf,
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  workerLineText,
  type AgentVendor,
  type ConversationId,
  type Message,
  type MessageId,
  type PersonaChangeId,
  type SystemMessageMeta,
  type WorkerMessageMeta,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { describeFailure } from "../../shared/errors.ts";
import { errorLine, errorTitle, formatTime } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { RenderItem } from "../selectors.ts";
import type { PendingMessage, RetryPhase } from "../state.ts";
import { workedFor } from "../step-labels.ts";
import { workerStatusOf, type WorkerTone } from "../worker-status.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { COPIED_RESET_MS } from "./CodeBlock.tsx";
import { Markdown } from "./Markdown.tsx";

export interface AgentIdentity {
  name: string;
  avatarKey: number;
  /** Worker：所属项目经理水果切下的一瓣果肉头像。 */
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
  /** 这个对话现在用的厂商（出错时的那句话按它说哪家，不从原文猜）；不知道是 undefined。 */
  vendorOf?: (conversationId: ConversationId) => AgentVendor | undefined;
  /** 点选 `hub ask` 选项卡片里的某个选项：直接把该选项作为用户消息发出去。 */
  onAnswerAsk?: (text: string) => void;
}

const BUBBLE = "w-fit max-w-full rounded-[22px] px-4 py-2.5 text-body leading-relaxed";
/** 名字、Worked for、可点开的系统行：13.5px 灰。 */
const SECONDARY = "text-minor text-muted-foreground";
/** 文字按钮：没有底色和胶囊，悬停变前景色，键盘聚焦有中性的圈。 */
const TEXT_BUTTON = "touch-target cursor-pointer rounded-full transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/** 头像（24px）+ 名字。头像旁不放 agent 的状态；只有 Worker 汇报在头像右下角放一个状态色点。 */
function AgentHead({ identity, dot }: { identity: AgentIdentity; dot?: Exclude<WorkerTone, "neutral"> }) {
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2" data-slot="agent-head">
      <span className="relative flex shrink-0">
        <Avatar colorKey={identity.avatarKey} size={26} neutral={identity.neutral} />
        {dot && <span data-dot={dot} aria-hidden="true" className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background", TONE_DOT[dot])} />}
      </span>
      <div className={cn("min-w-0 truncate font-medium", SECONDARY)}>{identity.name}</div>
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

/** `hub ask` 带选项时的可点击 A/B/C/D 选项卡片（docs/ui-standard.md 第 17 条）。 */
function AskCard({
  card,
  files,
  messageId,
  onAnswerAsk,
}: {
  card: NonNullable<ReturnType<typeof extractAskCard>>;
  files: ReturnType<typeof sentFilesOf>;
  messageId: MessageId;
  onAnswerAsk?: MessageActions["onAnswerAsk"];
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const answered = card.answered || chosen !== null;
  const disabled = answered || !onAnswerAsk;
  return (
    <div className="w-full min-w-0 rounded-2xl border border-border bg-background p-4" data-ask-card>
      <div className="w-full min-w-0 text-body leading-relaxed font-medium">
        <Markdown text={card.question} files={files} messageId={messageId} />
      </div>
      <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label="Options">
        {card.options.map((opt, i) => {
          const isChosen = chosen === opt;
          return (
            <button
              key={i}
              type="button"
              data-ask-option
              disabled={disabled}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
                isChosen ? "bg-sidebar-active" : "hover:bg-sidebar-hover disabled:opacity-60",
              )}
              onClick={() => {
                if (disabled) return;
                setChosen(opt);
                onAnswerAsk(opt);
              }}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-xl border border-border bg-sidebar text-xs font-medium text-muted-foreground">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="min-w-0 flex-1 text-body [overflow-wrap:anywhere] [&_p]:m-0">
                <Markdown text={opt} files={files} messageId={messageId} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** agent 说的一段文字（Markdown）。hub ask 问你的不另挂“等你确定”标签：右栏已经列着，点过去会高亮这一条。 */
const AgentText = memo(function AgentText({
  message,
  highlighted,
  onAnswerAsk,
}: {
  message: Message;
  highlighted: boolean;
  onAnswerAsk?: MessageActions["onAnswerAsk"];
}) {
  // agent 发来的文件：meta 没变就是同一个数组，Markdown 不用重建插件
  const files = useMemo(() => sentFilesOf(message), [message.meta]);
  const askCard = useMemo(() => extractAskCard(message), [message.sender, message.meta, message.text]);
  return (
    <article
      className={cn("flex w-full min-w-0 flex-col items-start gap-1.5", highlighted && "rounded-2xl outline-2 outline-offset-4 outline-ring/60")}
      data-side="left"
      data-message-id={message.id}
      data-highlighted={highlighted ? "true" : undefined}
    >
      {askCard ? (
        <AskCard card={askCard} files={files} messageId={message.id} onAnswerAsk={onAnswerAsk} />
      ) : (
        <div className="w-full min-w-0 text-body leading-relaxed">
          <Markdown text={displayText(message.text)} files={files} messageId={message.id} />
        </div>
      )}
    </article>
  );
});

/** Worked for 里的一步：工具原样（等宽）、派出 / 收工的 Worker（点开它的对话）、建删的定时任务。 */
function WorkStep({ message, onOpenWorker }: { message: Message; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const line = workerEventOf(message);
  if (line) {
    return (
      <li>
        <button type="button" className={cn(TEXT_BUTTON, "text-left [overflow-wrap:anywhere]")} onClick={() => onOpenWorker(line.workerConversationId)}>
          {workerLineText(line).replace(/^Worker/, "Piece")}
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
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <Button variant="ghost" size="icon-sm" className="-ml-2 size-7" aria-label={copied ? "Copied" : "Copy"} title={copied ? "Copied" : "Copy"} onClick={copy}>
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </Button>
  );
}

type Turn = Extract<RenderItem, { kind: "turn" }>;

const EMPTY_REVERTED: ReadonlySet<PersonaChangeId> = new Set();

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a === b || (a.name === b.name && a.avatarKey === b.avatarKey && a.neutral === b.neutral);
}

/** 上一次算出的撤销清单：内容一样就还给这一份，来一条新消息不会让每一轮的 TurnView、MessageBubble（比的是引用）都重画。 */
let lastReverted: ReadonlySet<PersonaChangeId> = EMPTY_REVERTED;

/** 对话里已经被后续修改（revertOf 指向它）撤销过的性格设定修改编号。内容和上次一样时返回上次那个 Set。 */
export function revertedChangeIds(messages: readonly Message[]): ReadonlySet<PersonaChangeId> {
  let ids: Set<PersonaChangeId> | null = null;
  for (const m of messages) {
    const event = systemEventOf(m);
    if (event?.event === "persona.changed" && event.revertOf !== null) {
      ids ??= new Set<PersonaChangeId>();
      ids.add(event.revertOf);
    }
  }
  if (ids === null) return EMPTY_REVERTED;
  if (ids.size === lastReverted.size && [...ids].every((id) => lastReverted.has(id))) return lastReverted;
  lastReverted = ids;
  return ids;
}

/**
 * agent 的一轮回复：开头一次头像 + 名字；操作合成一行；文字和夹在中间的系统行按顺序排；跑完最下面是复制和时间。
 * status：这一轮还在跑时的状态（AgentStatus），那一行挪到最下面；没在跑是 undefined。
 */
export const TurnView = memo(
  function TurnView({
    turn,
    identity,
    status,
    actions,
    highlightId,
    revertedChanges,
  }: {
    turn: Pick<Turn, "work" | "parts" | "startedAt" | "endedAt">;
    identity: AgentIdentity;
    status?: React.ReactNode;
    actions: MessageActions;
    highlightId?: MessageId | null;
    revertedChanges?: ReadonlySet<PersonaChangeId>;
  }) {
    const running = status != null;
    const texts = turn.parts.filter((m) => m.sender === "agent");
    const lastText = texts.at(-1);
    const reverted = revertedChanges ?? revertedChangeIds(turn.parts);
    return (
      <div className="mt-6 flex flex-col first:mt-2" data-turn data-side="left" data-running={running ? "true" : undefined}>
        <AgentHead identity={identity} />
        <div className="flex flex-col gap-2.5">
          {!running && turn.work.length > 0 && <WorkLine label={workedFor(turn.endedAt - turn.startedAt)} work={turn.work} onOpenWorker={actions.onOpenWorker} />}
          {turn.parts.map((m) =>
            m.sender === "agent" ? (
              <AgentText key={m.id} message={m} highlighted={m.id === highlightId} onAnswerAsk={actions.onAnswerAsk} />
            ) : (
              <SystemNotice key={m.id} message={m} actions={actions} revertedChanges={reverted} inTurn />
            ),
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
  },
  (prev, next) =>
    prev.turn.startedAt === next.turn.startedAt &&
    prev.turn.endedAt === next.turn.endedAt &&
    sameList(prev.turn.work, next.turn.work) &&
    sameList(prev.turn.parts, next.turn.parts) &&
    sameIdentity(prev.identity, next.identity) &&
    prev.status === next.status &&
    prev.actions === next.actions &&
    prev.highlightId === next.highlightId &&
    prev.revertedChanges === next.revertedChanges,
);

type RevertPhase = "idle" | "busy" | "done" | "conflict" | "error";

/** 撤销按钮：只有项目经理改了性格设定的系统消息有。只有最近一次能撤销，别的服务端回 409。 */
function RevertButton({
  changeId,
  reverted = false,
  onRevert,
}: {
  changeId: PersonaChangeId;
  reverted?: boolean;
  onRevert: MessageActions["onRevertPersona"];
}) {
  const [phase, setPhase] = useState<RevertPhase>("idle");
  if (reverted || phase === "done") return <span>Undone</span>;
  const revert = () => {
    setPhase("busy");
    onRevert(changeId).then(
      () => setPhase("done"),
      (err: unknown) => setPhase(err instanceof ApiError && err.status === 409 ? "conflict" : "error"),
    );
  };
  return (
    <>
      {phase === "conflict" && <span className="text-danger">Only the latest change can be undone</span>}
      {phase === "error" && <span className="text-danger">Couldn't undo</span>}
      <button
        type="button"
        className="touch-target cursor-pointer font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:no-underline disabled:opacity-60"
        disabled={phase === "busy"}
        onClick={revert}
      >
        {phase === "busy" ? "Undoing…" : "Undo"}
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
      <Icon className={cn("mt-0.75 size-3.5 shrink-0", danger && "text-danger")} aria-hidden="true" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/**
 * 换新会话（用户点的或自动换的，ledger/handover.ts）：很淡的一行分隔线，“图标 + Handed off to a new session ›”后面一条细线，
 * 点开看交接全文（Markdown，左边一条竖线，和定时任务的说明一样）。写交接的来往本身不显示。
 */
function SessionRenewed({ text, handover }: { text: string; handover: string }) {
  const [open, setOpen] = useState(false);
  const body = handover.trim();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 flex flex-col" data-side="left" data-notice data-event="session.renewed">
      <div className="flex items-center gap-2.5">
        <CollapsibleTrigger className={cn("group inline-flex shrink-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground", TEXT_BUTTON)} disabled={body === ""}>
          <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{text}</span>
          {body !== "" && <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />}
        </CollapsibleTrigger>
        <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
      </div>
      <CollapsibleContent>
        <div className={cn("mt-1.5 border-l border-border pl-3 leading-relaxed [overflow-wrap:anywhere]", SECONDARY)} data-handover>
          <Markdown text={body} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 系统消息：到点的定时任务、换新会话是可点开的一行，别的都是很淡的一行（去掉发给 agent 时加的【系统】，不显示投递状态）。 */
function SystemNotice({
  message,
  actions,
  revertedChanges,
  inTurn = false,
}: {
  message: Message;
  actions: MessageActions;
  revertedChanges?: ReadonlySet<PersonaChangeId>;
  inTurn?: boolean;
}) {
  const event = systemEventOf(message);
  const text = systemNoticeText(message);
  switch (event?.event) {
    case "schedule.run":
      return <ScheduleRun text={text} />;
    case "session.renewed":
      return <SessionRenewed text={text} handover={message.text} />;
    case "schedule.failed": {
      // “定时任务没跑成：名字：原因”：原因写成人话，原文放 title
      const prefix = `定时任务没跑成：${event.name}：`;
      const reason = text.startsWith(prefix)
        ? describeFailure(text.slice(prefix.length), { unknown: "raw", vendor: actions.vendorOf?.(message.conversationId) }).text
        : null;
      return (
        <NoticeLine icon={CircleX} danger title={event.rawReason ?? text} inTurn={inTurn}>
          <span>{reason === null ? text : `定时任务「${event.name}」没跑成：${reason}`}</span>
        </NoticeLine>
      );
    }
    case "handover.failed":
      return (
        <NoticeLine icon={CircleX} danger title={event.rawReason} inTurn={inTurn}>
          <span>{text}</span>
        </NoticeLine>
      );
    case "persona.changed":
      return (
        <NoticeLine icon={UserPen} inTurn={inTurn}>
          <span>{text}</span>
          <RevertButton
            changeId={event.personaChangeId}
            reverted={revertedChanges?.has(event.personaChangeId)}
            onRevert={actions.onRevertPersona}
          />
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

/** 状态色点（styles.css 的变量），在头像右下角；中性的没有点。 */
const TONE_DOT: Record<Exclude<WorkerTone, "neutral">, string> = { success: "bg-success", warn: "bg-caution", danger: "bg-danger" };

/**
 * Worker 的发言（项目经理对话里的汇报、这一轮没做完、建 worktree 失败）：头像 + 标题在上面，摘要在靠左的中性浅灰气泡里。
 * 状态是头像右下角的一个小色点（workerStatusOf），字放在 title 和 aria-label。整个气泡可点，打开 Worker 的完整对话；
 * 给项目经理的汇报原文不显示。
 */
function WorkerSpeech({
  line,
  avatarKey,
  onOpen,
  vendor,
}: {
  line: WorkerMessageMeta;
  avatarKey: number;
  onOpen: MessageActions["onOpenWorker"];
  vendor?: AgentVendor;
}) {
  const { tone, label } = workerStatusOf(line);
  const failed = line.event !== "report";
  const summary = line.summary?.trim() ?? "";
  const body = failed && summary !== "" ? describeFailure(summary, { unknown: "raw", vendor }) : null;
  const text = body ? body.text : summary;
  return (
    <article className="mt-4 flex flex-col items-start" data-side="left" data-worker-report data-tone={tone}>
      <AgentHead identity={{ name: line.title, avatarKey, neutral: true }} dot={tone !== "neutral" ? tone : undefined} />
      <button
        type="button"
        data-bubble
        title={label ?? undefined}
        aria-label={label ? `${line.title}，${label}：${text}` : undefined}
        className={cn(
          BUBBLE,
          "cursor-pointer bg-bubble-agent text-left transition-colors outline-none hover:bg-[color-mix(in_srgb,var(--bubble-agent),var(--foreground)_5%)] focus-visible:ring-2 focus-visible:ring-ring/50 [overflow-wrap:anywhere]",
        )}
        onClick={() => onOpen(line.workerConversationId)}
      >
        <span title={body ? body.raw : undefined}>{text}</span>
      </button>
    </article>
  );
}

/** 项目经理对话里 Worker 的那些行：汇报是 Worker 的发言，派出、收工、你对它说的是很淡的一行（点开 Worker）。 */
function WorkerItem({ line, avatarKey, actions }: { line: WorkerMessageMeta; avatarKey: number; actions: MessageActions }) {
  const onOpen = actions.onOpenWorker;
  if (line.event === "report" || line.event === "turn_failed" || line.event === "worktree_failed") {
    // Worker 的失败原因按 Worker 自己的厂商说（可能和项目经理不是同一家）
    return <WorkerSpeech line={line} avatarKey={avatarKey} onOpen={onOpen} vendor={actions.vendorOf?.(line.workerConversationId)} />;
  }
  return (
    <NoticeLine icon={WORKER_NOTICE_ICONS[line.event] ?? Info}>
      <button type="button" className={cn(TEXT_BUTTON, "text-left")} onClick={() => onOpen(line.workerConversationId)}>
        {workerLineText(line).replace(/^Worker/, "Piece")}
      </button>
    </NoticeLine>
  );
}

/**
 * 单独显示的一条（不在一轮回复里的）：用户的气泡、Worker 对话里项目经理的话、Worker 的发言、系统行。
 * head：项目经理的话要不要带头像（上一条也是它说的就不带）。
 */
export const MessageBubble = memo(
  function MessageBubble({
    message,
    identity,
    head,
    actions,
    highlighted = false,
    revertedChanges,
  }: {
    message: Message;
    identity: AgentIdentity;
    head: boolean;
    actions: MessageActions;
    highlighted?: boolean;
    revertedChanges?: ReadonlySet<PersonaChangeId>;
  }) {
    const workerLine = workerEventOf(message);
    if (workerLine) return <WorkerItem line={workerLine} avatarKey={identity.avatarKey} actions={actions} />;
    if (message.sender === "system") return <SystemNotice message={message} actions={actions} revertedChanges={revertedChanges} />;
    if (message.sender === "user") return <UserBubble message={message} actions={actions} />;
    // Worker 对话里项目经理的话（任务、打回）：头像 + 名字 + 正文，和项目经理对话里它自己说话一个样子
    return (
      <div className={cn("flex flex-col", head ? "mt-6 first:mt-2" : "mt-2.5")} data-side="left" data-head={head}>
        {head && <AgentHead identity={identity} />}
        <AgentText message={message} highlighted={highlighted} onAnswerAsk={actions.onAnswerAsk} />
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    sameIdentity(prev.identity, next.identity) &&
    prev.head === next.head &&
    prev.actions === next.actions &&
    prev.highlighted === next.highlighted &&
    prev.revertedChanges === next.revertedChanges,
);

function UserBubble({ message, actions }: { message: Message; actions: MessageActions }) {
  const attachments = attachmentsOf(message);
  const failed = message.status === "failed";
  const failure = failed && message.failureReason ? describeFailure(message.failureReason, { vendor: actions.vendorOf?.(message.conversationId) }) : null;
  const phase = actions.retry[message.id];
  return (
    <article className="mt-6 flex flex-col items-end first:mt-2" data-side="right" data-status={message.status ?? undefined} title={formatTime(message.createdAt)}>
      <SentBody
        unsent={
          failed ? (
            <UnsentMark reason={failure?.text} raw={failure?.raw} retrying={phase === "retrying"} retryFailed={phase === "error"} onRetry={() => actions.onRetryMessage(message.id)} />
          ) : null
        }
      >
        {/* 只发文件没写字的消息没有文字气泡 */}
        {(message.text !== "" || attachments.length === 0) && (
          <div
            data-bubble
            className={cn(
              BUBBLE,
              "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]",
              // 已取消：agent 没看到过，气泡变淡一眼看得出；字照样能选中复制，用户想再发自己复制
              message.status === "cancelled" && "opacity-60",
            )}
          >
            {message.text}
          </div>
        )}
        <AttachmentList attachments={attachments} />
      </SentBody>
    </article>
  );
}

/**
 * 用户消息的气泡 + 附件；没发出去时左边一个红色感叹号（照微信），垂直居中。
 * 排队、已停止、已取消这些都不写字（docs/ui-standard.md 第 17 条），只有“没发出去”这一种标记。
 */
function SentBody({ unsent, children }: { unsent: React.ReactNode; children: React.ReactNode }) {
  if (!unsent) return children;
  return (
    <div className="flex w-full items-center justify-end gap-2">
      {unsent}
      {/* 感叹号紧挨着气泡：这一列宽度跟内容走，最宽是原来气泡的 80%，里面的气泡不再另算 80% */}
      <div className="flex max-w-[80%] min-w-0 flex-col items-end [&>[data-bubble]]:max-w-full">{children}</div>
    </div>
  );
}

const UNSENT_DOT = "flex size-5 shrink-0 items-center justify-center rounded-full bg-danger text-xs leading-none font-semibold text-white";
const UNSENT_LABEL = "没发出去";

/**
 * 没发出去的红色感叹号（照微信）：能重发的是按钮，点了重发；重发也没用的（被拦、文件没了）只是标记。
 * 原因（“网络断了，稍后重试”“文件已不在，请重新添加”）不另起一行，放在 title 和读屏名字里；原始错误放 title 第二行。
 */
function UnsentMark({
  reason,
  raw,
  onRetry,
  retrying = false,
  retryFailed = false,
}: {
  reason?: string | undefined;
  raw?: string | undefined;
  onRetry?: () => void;
  retrying?: boolean;
  retryFailed?: boolean;
}) {
  const detail = [retryFailed ? "重发失败" : null, reason].filter(Boolean).join("，");
  const rawLine = raw && raw !== reason ? `\n${raw}` : "";
  const mark = (
    <span className={UNSENT_DOT} aria-hidden="true">
      !
    </span>
  );
  if (!onRetry) {
    const label = detail ? `${UNSENT_LABEL}：${detail}` : UNSENT_LABEL;
    return (
      <span role="img" aria-label={label} title={label + rawLine} data-unsent className="flex shrink-0">
        {mark}
      </span>
    );
  }
  const label = `${UNSENT_LABEL}，点击重发`;
  return (
    <button
      type="button"
      aria-label={label}
      title={(detail ? `${UNSENT_LABEL}：${detail}，点击重发` : label) + rawLine}
      aria-busy={retrying || undefined}
      disabled={retrying}
      data-unsent
      className="touch-target flex shrink-0 cursor-pointer rounded-full outline-none hover:brightness-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
      onClick={onRetry}
    >
      {mark}
    </button>
  );
}

/** 网页先显示出来、服务端还没确认的用户消息：发送中不写字；没发出去左边红色感叹号。 */
export function PendingBubble({ pending, onRetry }: { pending: PendingMessage; onRetry: (clientId: string) => void }) {
  const failed = pending.phase === "failed";
  const filesGone = failed && pending.failure === "attachments_missing";
  const reason = failed && pending.failure === "rejected" ? pending.reason : undefined;
  const noRetry = filesGone || reason !== undefined;
  const reasonText = filesGone ? "文件已不在，请重新添加" : reason !== undefined ? errorLine(reason) : undefined;
  const reasonRaw = reason !== undefined ? errorTitle(reason) : undefined;
  return (
    <article className="mt-6 flex flex-col items-end first:mt-2" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      <SentBody unsent={failed ? <UnsentMark reason={reasonText} raw={reasonRaw} {...(noRetry ? {} : { onRetry: () => onRetry(pending.clientId) })} /> : null}>
        {(pending.text !== "" || pending.attachments.length === 0) && (
          <div data-bubble className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}>
            {pending.text}
          </div>
        )}
        <AttachmentList attachments={pending.attachments} />
      </SentBody>
    </article>
  );
}

/** 空对话：中间是 agent 的头像、名字和“还没有消息”。 */
export function EmptyConversation({ identity }: { identity?: AgentIdentity }) {
  return (
    <div className="m-auto flex flex-col items-center gap-3 py-10 text-center" data-empty>
      {identity && <Avatar colorKey={identity.avatarKey} size={48} neutral={identity.neutral} />}
      <div className="flex flex-col items-center gap-0.5">
        {identity && <div className="text-title font-semibold">{identity.name}</div>}
        <div className={SECONDARY}>No messages yet</div>
      </div>
    </div>
  );
}
