import { Archive, CalendarClock, Check, ChevronRight, CircleAlert, CirclePlay, CircleX, Clock, Copy, FolderMinus, FolderPlus, Info, MessageSquare, RefreshCw, UserPen, type Icon } from "../ui/icons.ts";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  askOf,
  attachmentsOf,
  extractAskCard,
  isRewoundMessage,
  REPORT_END,
  REPORT_START,
  sentFilesOf,
  sentFilesOfDeliverables,
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  workerPickOf,
  type AgentVendor,
  type ConversationId,
  type Deliverable,
  type Message,
  type MessageId,
  type PersonaChangeId,
  type WorkerMessageMeta,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { describeFailure } from "../../shared/errors.ts";
import { errorLine, errorTitle, formatTime, pieceLineParts } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { RenderItem } from "../selectors.ts";
import type { PendingMessage, RetryPhase } from "../state.ts";
import { workedFor } from "../step-labels.ts";
import { describeSystemEvent, type EventFamily, type EventIconName } from "../system-events.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { AskCard } from "./AskCard.tsx";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import type { SlimeLook } from "../../shared/slimes.ts";
import { DeliverableFiles } from "./Deliverables.tsx";
import { ThreadCard } from "./ThreadCard.tsx";
import { WorkerPickTag } from "./WorkerPickTag.tsx";
import { COPIED_RESET_MS } from "./CodeBlock.tsx";
import { Markdown } from "./Markdown.tsx";
import { UserBlockerCard } from "./UserBlockerCard.tsx";

export interface AgentIdentity {
  name: string;
  look: SlimeLook;
  neutral?: boolean;
}

export interface MessageActions {
  onOpenWorker: (workerConversationId: ConversationId) => void;
  openWorkerId?: ConversationId | null;
  retry: Record<MessageId, RetryPhase | undefined>;
  onRetryMessage: (messageId: MessageId) => void;
  onRevertPersona: (changeId: PersonaChangeId) => Promise<void>;
  vendorOf?: (conversationId: ConversationId) => AgentVendor | undefined;
  onAnswerAsk?: (messageId: MessageId, body: { clientId: string; choice: string | null; note?: string }) => Promise<void>;
}

export const BUBBLE = "w-fit max-w-full px-4 py-2.5 text-body leading-relaxed";
export const SECONDARY = "text-minor text-muted-foreground";
export const TEXT_BUTTON = "touch-target cursor-pointer transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus";

export function AgentHead({
  identity,
  avatar,
  onClick,
  trailing,
  working = false,
}: {
  identity: AgentIdentity;
  avatar?: React.ReactNode;
  onClick?: () => void;
  trailing?: React.ReactNode;
  working?: boolean;
}) {
  const icon = <span className="relative flex shrink-0">{avatar ?? <Avatar look={identity.look} size={26} neutral={identity.neutral} working={working} />}</span>;
  const name = <div className={cn("min-w-0 truncate font-medium", SECONDARY)}>{identity.name}</div>;
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2" data-slot="agent-head">
      {onClick ? (
        <button type="button" className={cn("inline-flex min-w-0 items-center gap-2", TEXT_BUTTON)} onClick={onClick}>
          {icon}
          {name}
        </button>
      ) : (
        <>
          {icon}
          {name}
        </>
      )}
      {trailing}
    </div>
  );
}

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

const NO_DELIVERABLES: readonly Deliverable[] = [];

export const AgentText = memo(function AgentText({
  message,
  highlighted,
  onAnswerAsk,
}: {
  message: Message;
  highlighted: boolean;
  onAnswerAsk?: MessageActions["onAnswerAsk"];
}) {
  const deliverables = useMemo(() => askOf(message)?.deliverables ?? NO_DELIVERABLES, [message.sender, message.meta]);
  const files = useMemo(() => {
    const own = sentFilesOf(message);
    if (deliverables.length === 0) return own;
    const hrefs = new Set(own.map((f) => f.href));
    const extra = sentFilesOfDeliverables(deliverables).filter((f) => !hrefs.has(f.href));
    return extra.length === 0 ? own : [...own, ...extra];
  }, [message.meta, deliverables]);
  const askCard = useMemo(() => extractAskCard(message), [message.sender, message.meta, message.text]);
  const blocker = askCard === null ? askOf(message) : null;
  return (
    <article
      className={cn("flex w-full min-w-0 flex-col items-start gap-1.5", highlighted && "outline-2 outline-offset-4 outline-border-focus")}
      data-side="left"
      data-message-id={message.id}
      data-highlighted={highlighted ? "true" : undefined}
    >
      {blocker?.blockerRef !== undefined ? (
        <UserBlockerCard
          blockerId={blocker.blockerRef.blockerId}
          text={message.text}
          answered={blocker.answered === true}
          className="w-full max-w-[min(100%,36rem)]"
        />
      ) : askCard ? (
        <AskCard card={askCard} files={files} deliverables={deliverables} messageId={message.id} onAnswerAsk={onAnswerAsk} />
      ) : (
        <div className="w-full min-w-0 text-body leading-relaxed">
          <Markdown text={displayText(message.text)} files={files} messageId={message.id} />
          <DeliverableFiles deliverables={deliverables} className="mt-2" />
        </div>
      )}
    </article>
  );
});

function PieceLineButton({ line, onOpen }: { line: WorkerMessageMeta; onOpen: MessageActions["onOpenWorker"] }) {
  const { title, state, detail } = pieceLineParts(line);
  return (
    <button
      type="button"
      aria-label={[title, state, detail].filter((part) => part !== "").join(" ")}
      className={cn(TEXT_BUTTON, "inline-flex flex-wrap gap-x-2 text-left [overflow-wrap:anywhere]")}
      onClick={() => onOpen(line.workerConversationId)}
    >
      <span className="text-foreground">{title}</span>
      <span>{state}</span>
      {detail !== "" && <span>{detail}</span>}
    </button>
  );
}

function WorkStep({ message, onOpenWorker }: { message: Message; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const line = workerEventOf(message);
  if (line) {
    return (
      <li>
        <PieceLineButton line={line} onOpen={onOpenWorker} />
      </li>
    );
  }
  if (message.sender === "system") return <li className="[overflow-wrap:anywhere]">{systemNoticeText(message)}</li>;
  return <li className="font-mono [overflow-wrap:anywhere]">{message.text}</li>;
}

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
        <ChevronRight className="size-pixel-sm transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
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

export function CopyButton({ text }: { text: string }) {
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
      {copied ? <Check className="size-pixel-sm" aria-hidden="true" /> : <Copy className="size-pixel-sm" aria-hidden="true" />}
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
  return a === b || (a.name === b.name && a.look === b.look && a.neutral === b.neutral);
}

let lastReverted: ReadonlySet<PersonaChangeId> = EMPTY_REVERTED;

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

export const TurnView = memo(
  function TurnView({
    turn,
    identity,
    status,
    streamingText,
    actions,
    highlightId,
    revertedChanges,
  }: {
    turn: Pick<Turn, "work" | "parts" | "startedAt" | "endedAt">;
    identity: AgentIdentity;
    status?: React.ReactNode;
    streamingText?: string | null;
    actions: MessageActions;
    highlightId?: MessageId | null;
    revertedChanges?: ReadonlySet<PersonaChangeId>;
  }) {
    const liveText = streamingText ? displayText(streamingText) : "";
    const running = status != null || liveText !== "";
    const texts = turn.parts.filter((m) => m.sender === "agent");
    const lastText = texts.at(-1);
    const reverted = revertedChanges ?? revertedChangeIds(turn.parts);
    return (
      <div className="mt-6 flex flex-col [[data-list-head]>&]:mt-2" data-turn data-side="left" data-running={running ? "true" : undefined}>
        <AgentHead identity={identity} working={running} />
        <div className="flex flex-col gap-2.5">
          {!running && turn.work.length > 0 && <WorkLine label={workedFor(turn.endedAt - turn.startedAt)} work={turn.work} onOpenWorker={actions.onOpenWorker} />}
          {turn.parts.map((m) =>
            m.sender === "agent" ? (
              <AgentText key={m.id} message={m} highlighted={m.id === highlightId} onAnswerAsk={actions.onAnswerAsk} />
            ) : (
              <SystemNotice key={m.id} message={m} actions={actions} revertedChanges={reverted} inTurn />
            ),
          )}
          {liveText !== "" && (
            <article className="flex w-full min-w-0 flex-col items-start gap-1.5" data-side="left" data-streaming="true">
              <div className="w-full min-w-0 text-body leading-relaxed">
                <Markdown text={liveText} />
              </div>
            </article>
          )}
          {running && status != null && <WorkLine label={status} work={turn.work} onOpenWorker={actions.onOpenWorker} />}
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
    prev.streamingText === next.streamingText &&
    prev.actions === next.actions &&
    prev.highlightId === next.highlightId &&
    prev.revertedChanges === next.revertedChanges,
);

type RevertPhase = "idle" | "busy" | "done" | "conflict" | "error";

// Events are quiet lines, not boxes: a bare icon on the first line, then the label, the muted detail, and any action in
// one wrapping run, so a Worker starting or a folder attaching never outweighs the messages around it.
const EVENT_ROW = "flex w-full min-w-0 items-start gap-2 py-0.5 text-left text-minor leading-5 text-muted-foreground";
const EVENT_TEXT = "min-w-0 [overflow-wrap:anywhere]";
const EVENT_LINK =
  "touch-target group/event inline-flex max-w-full cursor-pointer items-start gap-2 rounded-xs py-0.5 text-left text-minor leading-5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus disabled:cursor-default disabled:hover:text-muted-foreground motion-reduce:transition-none";
const EVENT_ACTION =
  "touch-target ml-3 cursor-pointer font-medium text-rail-ink outline-none hover:underline focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default disabled:no-underline disabled:opacity-60";

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
  if (reverted || phase === "done") {
    return <span className="ml-3 text-muted-foreground">Undone</span>;
  }
  const revert = () => {
    setPhase("busy");
    onRevert(changeId).then(
      () => setPhase("done"),
      (err: unknown) => setPhase(err instanceof ApiError && err.status === 409 ? "conflict" : "error"),
    );
  };
  return (
    <>
      <button type="button" className={EVENT_ACTION} disabled={phase === "busy"} onClick={revert}>
        {phase === "busy" ? "Undoing…" : "Undo"}
      </button>
      {phase === "conflict" && <span className="ml-3 text-danger">Only the latest change can be undone</span>}
      {phase === "error" && <span className="ml-3 text-danger">Couldn't undo</span>}
    </>
  );
}

const EVENT_ICONS: Readonly<Record<EventIconName, Icon>> = {
  "folder-plus": FolderPlus,
  "folder-minus": FolderMinus,
  "user-pen": UserPen,
  calendar: CalendarClock,
  clock: Clock,
  refresh: RefreshCw,
  error: CircleX,
  info: Info,
  "worker-start": CirclePlay,
  "worker-end": Archive,
  "worker-message": MessageSquare,
};

const WORKER_NOTICE_ICONS: Partial<Record<WorkerMessageMeta["event"], Icon>> = {
  started: CirclePlay,
  ended: Archive,
  user_message: MessageSquare,
};

function EventIcon({ icon: Icon, danger = false }: { icon: Icon; danger?: boolean }) {
  return <Icon className={cn("mt-0.75 size-3.5 shrink-0", danger && "text-danger")} aria-hidden="true" />;
}

function EventLabel({ label, danger = false }: { label: string; danger?: boolean }) {
  return <span className={cn("mr-2 font-medium", danger && "text-danger")}>{label}</span>;
}

function EventChevron({ turns = false }: { turns?: boolean }) {
  return (
    <ChevronRight
      className={cn("ml-1 inline size-pixel-sm align-[-0.0625rem]", turns && "transition-transform group-data-[state=open]/event:rotate-90 motion-reduce:transition-none")}
      aria-hidden="true"
    />
  );
}

function EventStripShell({
  danger = false,
  inTurn = false,
  grouped = false,
  children,
}: {
  danger?: boolean;
  inTurn?: boolean;
  grouped?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-event-group={grouped ? "true" : undefined}
      data-tone={danger ? "danger" : undefined}
      className={cn("flex w-full min-w-0 flex-col items-start", inTurn ? "mt-0.5" : "mt-4 [[data-list-head]>&]:mt-2")}
    >
      {children}
    </div>
  );
}

function EventRow({
  icon,
  tag,
  danger = false,
  title,
  action,
  children,
}: {
  icon: Icon;
  tag: string;
  danger?: boolean;
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={EVENT_ROW} data-side="left" data-notice title={title}>
      <EventIcon icon={icon} danger={danger} />
      <p className={EVENT_TEXT}>
        <EventLabel label={tag} danger={danger} />
        {children}
        {action}
      </p>
    </div>
  );
}

function CollapsibleEvent({
  icon,
  tag,
  text,
  event,
  className,
  notice = false,
  children,
}: {
  icon: Icon;
  tag: string;
  text: string;
  event: string;
  className: string;
  notice?: boolean;
  children: React.ReactNode | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("flex w-full min-w-0 flex-col items-start", className)} data-side="left" data-notice={notice || undefined} data-event={event}>
      <CollapsibleTrigger aria-label={text} className={EVENT_LINK} disabled={children === null}>
        <EventIcon icon={icon} />
        <span className={EVENT_TEXT}>
          <EventLabel label={tag} />
          {text}
          {children !== null && <EventChevron turns />}
        </span>
      </CollapsibleTrigger>
      {children !== null && <CollapsibleContent className="mt-1.5 mb-1 ml-1.5 w-full min-w-0 border-l border-border pl-4">{children}</CollapsibleContent>}
    </Collapsible>
  );
}

function ScheduleRun({ text }: { text: string }) {
  const match = /^【([^】]*)】\s*([\s\S]*)$/.exec(text);
  const title = match?.[1] ?? "Scheduled task";
  const body = (match?.[2] ?? text).trim();
  return (
    <CollapsibleEvent icon={Clock} tag="Scheduled" text={title} event="schedule.run" className="mt-6">
      {body === "" ? null : <p className={cn("leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", SECONDARY)}>{body}</p>}
    </CollapsibleEvent>
  );
}

function SessionRenewed({ text, handover }: { text: string; handover: string }) {
  const body = handover.trim();
  return (
    <CollapsibleEvent icon={RefreshCw} tag="Session" text={text} event="session.renewed" className="mt-4" notice>
      {body === "" ? null : (
        <div className={cn("leading-relaxed [overflow-wrap:anywhere]", SECONDARY)} data-handover>
          <Markdown text={body} />
        </div>
      )}
    </CollapsibleEvent>
  );
}

function SystemNoticeRow({
  message,
  actions,
  revertedChanges,
}: {
  message: Message;
  actions: MessageActions;
  revertedChanges?: ReadonlySet<PersonaChangeId>;
}) {
  const event = systemEventOf(message);
  const summary = describeSystemEvent(message, actions.vendorOf?.(message.conversationId));
  const action =
    event?.event === "persona.changed" ? (
      <RevertButton changeId={event.personaChangeId} reverted={revertedChanges?.has(event.personaChangeId)} onRevert={actions.onRevertPersona} />
    ) : undefined;
  return (
    <EventRow icon={EVENT_ICONS[summary.icon]} tag={summary.tag} danger={summary.tone === "danger"} title={summary.rawTitle} action={action}>
      {summary.text}
    </EventRow>
  );
}

function WorkerNoticeRow({ line, onOpen }: { line: WorkerMessageMeta; onOpen: MessageActions["onOpenWorker"] }) {
  const { title, state, detail } = pieceLineParts(line);
  const icon = WORKER_NOTICE_ICONS[line.event] ?? Info;
  return (
    <div data-side="left" data-notice className="max-w-full">
      <button
        type="button"
        aria-label={[title, state, detail].filter((part) => part !== "").join(" ")}
        className={EVENT_LINK}
        onClick={() => onOpen(line.workerConversationId)}
      >
        <EventIcon icon={icon} />
        <span className={EVENT_TEXT}>
          <EventLabel label={title} />
          {state}
          {detail !== "" && <span className="ml-2">{detail}</span>}
          <EventChevron />
        </span>
      </button>
    </div>
  );
}

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
  if (event?.event === "schedule.run") return <ScheduleRun text={text} />;
  if (event?.event === "session.renewed") return <SessionRenewed text={text} handover={message.text} />;
  const danger = event?.event === "schedule.failed" || event?.event === "handover.failed";
  return (
    <EventStripShell danger={danger} inTurn={inTurn}>
      <SystemNoticeRow message={message} actions={actions} revertedChanges={revertedChanges} />
    </EventStripShell>
  );
}

export const EventGroupView = memo(
  function EventGroupView({
    family,
    messages,
    actions,
    revertedChanges,
  }: {
    family: EventFamily;
    messages: readonly Message[];
    actions: MessageActions;
    revertedChanges?: ReadonlySet<PersonaChangeId>;
  }) {
    return (
      <EventStripShell danger={family === "danger"} grouped>
        {messages.map((message) => {
          const workerLine = workerEventOf(message);
          if (workerLine !== null) return <WorkerNoticeRow key={message.id} line={workerLine} onOpen={actions.onOpenWorker} />;
          return <SystemNoticeRow key={message.id} message={message} actions={actions} revertedChanges={revertedChanges} />;
        })}
      </EventStripShell>
    );
  },
  (prev, next) =>
    prev.family === next.family &&
    sameList(prev.messages, next.messages) &&
    prev.actions === next.actions &&
    prev.revertedChanges === next.revertedChanges,
);

function WorkerItem({ line, look, createdAt, actions }: { line: WorkerMessageMeta; look: SlimeLook; createdAt: number; actions: MessageActions }) {
  const onOpen = actions.onOpenWorker;
  if (line.event === "report" || line.event === "turn_failed" || line.event === "worktree_failed") {
    return (
      <ThreadCard
        line={line}
        look={look}
        open={actions.openWorkerId === line.workerConversationId}
        createdAt={createdAt}
        vendor={actions.vendorOf?.(line.workerConversationId)}
        onOpen={onOpen}
      />
    );
  }
  return (
    <EventStripShell>
      <WorkerNoticeRow line={line} onOpen={onOpen} />
    </EventStripShell>
  );
}

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
    if (workerLine) return <WorkerItem line={workerLine} look={identity.look} createdAt={message.createdAt} actions={actions} />;
    if (message.sender === "system") return <SystemNotice message={message} actions={actions} revertedChanges={revertedChanges} />;
    if (message.sender === "user") return <UserBubble message={message} actions={actions} />;
    return (
      <div className={cn("flex flex-col", head ? "mt-6 [[data-list-head]>&]:mt-2" : "mt-2.5")} data-side="left" data-head={head}>
        {head && <AgentHead identity={identity} />}
        <LongBrief>
          <AgentText message={message} highlighted={highlighted} onAnswerAsk={actions.onAnswerAsk} />
        </LongBrief>
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

const BRIEF_SLACK_LINES = 2;
const BRIEF_FALLBACK_LINES = 8;

function LongBrief({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null || expanded) return;
    const measure = () => {
      const style = getComputedStyle(box);
      const lineHeight = Number.parseFloat(style.lineHeight) || 1.65 * (Number.parseFloat(style.fontSize) || 16);
      const lines = Number.parseInt(style.getPropertyValue("--brief-lines"), 10) || BRIEF_FALLBACK_LINES;
      setOverflowing(box.scrollHeight > (lines + BRIEF_SLACK_LINES) * lineHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild !== null) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div ref={ref} id={id} data-brief data-overflowing={overflowing && !expanded ? "" : undefined} className={cn("w-full min-w-0", overflowing && !expanded && "brief-clamp")}>
        {children}
      </div>
      {overflowing && (
        <button type="button" aria-expanded={expanded} aria-controls={id} className={cn(TEXT_BUTTON, "text-minor text-muted-foreground")} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function UserBubble({ message, actions }: { message: Message; actions: MessageActions }) {
  const attachments = attachmentsOf(message);
  const workerPick = workerPickOf(message);
  const rewound = isRewoundMessage(message);
  const failed = message.status === "failed";
  const delivered = message.meta?.deliveryConfirmed === true;
  const failure = failed && message.failureReason ? describeFailure(message.failureReason, { vendor: actions.vendorOf?.(message.conversationId) }) : null;
  const phase = actions.retry[message.id];
  return (
    <article className="mt-6 flex flex-col items-end [[data-list-head]>&]:mt-2" data-side="right" data-status={message.status ?? undefined} title={formatTime(message.createdAt)}>
      <SentBody
        unsent={
          failed && !delivered ? (
            <UnsentMark reason={failure?.text} raw={failure?.raw} retrying={phase === "retrying"} retryFailed={phase === "error"} onRetry={() => actions.onRetryMessage(message.id)} />
          ) : null
        }
      >
        {workerPick !== null && !rewound && <WorkerPickTag pick={workerPick} className={PICK_TAG} />}
        {!rewound && (message.text !== "" || attachments.length === 0) && (
          <div
            data-bubble
            className={cn(
              BUBBLE,
              "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]",
              message.status === "cancelled" && "opacity-60",
            )}
          >
            {message.text}
          </div>
        )}
        {rewound ? (
          <div className="opacity-60">
            <AttachmentList attachments={attachments} />
          </div>
        ) : (
          <AttachmentList attachments={attachments} />
        )}
      </SentBody>
      {failed && delivered && (
        <button
          type="button"
          aria-label={phase === "retrying" ? "Retrying…" : phase === "error" ? "Retry failed. Try again" : "Failed. Retry"}
          className="group/retry touch-target mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-minor text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default disabled:opacity-60"
          title={[failure?.text, failure?.raw].filter(Boolean).join("\n")}
          disabled={phase === "retrying"}
          onClick={() => actions.onRetryMessage(message.id)}
        >
          <CircleAlert className="size-pixel-sm text-danger" aria-hidden="true" />
          <span>{phase === "retrying" ? "Retrying…" : phase === "error" ? "Retry failed" : "Failed"}</span>
          {phase !== "retrying" && <span className="font-medium text-rail-ink group-hover/retry:underline">{phase === "error" ? "Try again" : "Retry"}</span>}
        </button>
      )}
    </article>
  );
}

const PICK_TAG = "mb-1.5 w-fit";

export function SentBody({ unsent, children }: { unsent: React.ReactNode; children: React.ReactNode }) {
  if (!unsent) return children;
  return (
    <div className="flex w-full items-center justify-end gap-2">
      {unsent}
      <div className="flex max-w-[80%] min-w-0 flex-col items-end [&>[data-bubble]]:max-w-full">{children}</div>
    </div>
  );
}

// The WeChat-style unsent mark is a red circle like every other status dot, never a square.
const UNSENT_DOT = "flex size-5 shrink-0 items-center justify-center rounded-full bg-danger text-xs leading-none font-semibold text-white";
const UNSENT_LABEL = "Not sent";

export function UnsentMark({
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
  const detail = [retryFailed ? "Resend failed" : null, reason].filter(Boolean).join("; ");
  const rawLine = raw && raw !== reason ? `\n${raw}` : "";
  const mark = (
    <span className={UNSENT_DOT} aria-hidden="true">
      !
    </span>
  );
  if (!onRetry) {
    const label = detail ? `${UNSENT_LABEL}: ${detail}` : UNSENT_LABEL;
    return (
      <span role="img" aria-label={label} title={label + rawLine} data-unsent className="flex shrink-0">
        {mark}
      </span>
    );
  }
  const label = `${UNSENT_LABEL}. Click to resend`;
  return (
    <button
      type="button"
      aria-label={label}
      title={(detail ? `${UNSENT_LABEL}: ${detail}. Click to resend` : label) + rawLine}
      aria-busy={retrying || undefined}
      disabled={retrying}
      data-unsent
      className="touch-target flex shrink-0 cursor-pointer rounded-full outline-none hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus disabled:cursor-default disabled:opacity-60"
      onClick={onRetry}
    >
      {mark}
    </button>
  );
}

export function PendingBubble({ pending, onRetry }: { pending: PendingMessage; onRetry: (clientId: string) => void }) {
  const failed = pending.phase === "failed";
  const filesGone = failed && pending.failure === "attachments_missing";
  const reason = failed && pending.failure === "rejected" ? pending.reason : undefined;
  const noRetry = filesGone || reason !== undefined;
  const reasonText = filesGone ? "Files are gone. Add them again" : reason !== undefined ? errorLine(reason) : undefined;
  const reasonRaw = reason !== undefined ? errorTitle(reason) : undefined;
  return (
    <article className="mt-6 flex flex-col items-end [[data-list-head]>&]:mt-2" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      <SentBody unsent={failed ? <UnsentMark reason={reasonText} raw={reasonRaw} {...(noRetry ? {} : { onRetry: () => onRetry(pending.clientId) })} /> : null}>
        {pending.workerPick && <WorkerPickTag pick={pending.workerPick} className={PICK_TAG} />}
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

export function EmptyConversation({ identity }: { identity?: AgentIdentity }) {
  return (
    <div className="m-auto flex flex-col items-center gap-3 py-10 text-center" data-empty>
      {identity && <Avatar look={identity.look} size={120} neutral={identity.neutral} />}
      <div className="flex flex-col items-center gap-0.5">
        {identity && <div className="text-title font-semibold">{identity.name}</div>}
        <div className={SECONDARY}>No messages yet</div>
      </div>
    </div>
  );
}
