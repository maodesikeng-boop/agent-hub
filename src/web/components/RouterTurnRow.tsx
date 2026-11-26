import { memo, type ReactNode } from "react";
import type { ConversationId, RouterCommandId } from "../../shared/index.ts";
import { defaultLookOf } from "../../shared/slimes.ts";
import { ApiError, type HubClient } from "../client.ts";
import { useFleetLookOf } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, formatTime, type ErrorLike } from "../format.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { cn } from "../lib/utils.ts";
import { canRetryCommand, type RouterTurnDestination, type RouterTurnEntry } from "../router-stream.ts";
import { ChevronRight, CircleAlert } from "../ui/icons.ts";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { ForwardReply } from "./ForwardReply.tsx";
import { Markdown } from "./Markdown.tsx";
import { AgentHead, BUBBLE, CopyButton, SentBody, TEXT_BUTTON, UnsentMark } from "./Messages.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { StatusShimmer } from "./StatusShimmer.tsx";

const ROUTER_IDENTITY = { name: "Router", look: defaultLookOf(0) } as const;

export interface RouterTurnRowProps {
  entry: RouterTurnEntry;
  multiDevice: boolean;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  retryPending: boolean;
  retryError: ErrorLike | undefined;
  onRetryCommand: (commandId: RouterCommandId, version: number | undefined) => void;
  onRetryUnsent: (clientId: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}

function DestinationRow({
  dest,
  multiDevice,
  onOpenConversation,
  onOpenWorker,
}: {
  dest: RouterTurnDestination;
  multiDevice: boolean;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const showProject = dest.projectName !== null && dest.projectName !== dest.name;
  const showDevice = (multiDevice || !dest.self) && dest.deviceName !== "";
  const look = useFleetLookOf()(dest.deviceKey, dest.pmId);
  return (
    <button
      type="button"
      data-destination
      className="flex w-full pointer-coarse:min-h-11 cursor-pointer items-center gap-3 px-2.5 py-2 text-left transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]"
      onClick={() =>
        dest.worker ? onOpenWorker(dest.deviceKey, dest.conversationId) : onOpenConversation(dest.deviceKey, dest.conversationId)
      }
    >
      <Avatar look={look} size={20} neutral={dest.worker} />
      <span className="min-w-0 truncate text-body font-medium text-foreground">{dest.name}</span>
      {showProject && <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{dest.projectName}</span>}
      {showDevice && <span className="shrink-0 text-xs text-muted-foreground">{dest.deviceName}</span>}
      {dest.opLabel !== null && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{dest.opLabel}</span>}
      <ChevronRight className={cn("size-pixel-sm shrink-0 text-muted-foreground", dest.opLabel === null && "ml-auto")} aria-hidden="true" />
    </button>
  );
}

function unsentMarkOf(entry: RouterTurnEntry, onRetryUnsent: (clientId: string) => void): ReactNode {
  const err = entry.unsentError;
  const rejected = err instanceof ApiError && err.status === 400;
  const info = err !== undefined ? errorText(err) : undefined;
  return (
    <UnsentMark
      reason={info !== undefined ? errorLine(info) : undefined}
      raw={info !== undefined ? errorTitle(info) : undefined}
      {...(rejected ? {} : { onRetry: () => onRetryUnsent(entry.clientId) })}
    />
  );
}

/**
 * Precondition: rendered inside FleetDeviceScopes and FleetLooks providers.
 * Postcondition: renders the user bubble, Router status or Markdown reply, clickable PM/Worker destinations, retry controls, and inline ForwardReply blocks for one Router turn.
 */
export const RouterTurnRow = memo(function RouterTurnRow({
  entry,
  multiDevice,
  clientForDevice,
  storeForDevice,
  retryPending,
  retryError,
  onRetryCommand,
  onRetryUnsent,
  onOpenConversation,
  onOpenWorker,
}: RouterTurnRowProps) {
  const effectiveStatus = retryPending ? "planning" : entry.status;
  const isSending = effectiveStatus === "sending";
  const isSendFailed = effectiveStatus === "send_failed";
  const command = entry.command;
  const plan = command?.plan ?? null;
  const rawReply = plan?.reply ?? "";
  const showReply = rawReply.trim() !== "" && !(plan?.track === "A" && effectiveStatus === "dispatched");
  const isRunning = effectiveStatus === "planning";
  const isFailed = effectiveStatus === "failed";
  const canRetry = isFailed && entry.live && command !== null && canRetryCommand(command);

  const failReason = retryError !== undefined ? errorLine(retryError) : (command?.error ?? "Router couldn't finish this. Try again");
  const failRaw =
    retryError !== undefined ? errorTitle(retryError) : plan?.errorRaw !== undefined && plan.errorRaw !== failReason ? plan.errorRaw : undefined;

  return (
    <div data-stream-entry className="w-full">
      <div data-router-turn data-status={effectiveStatus} className="mt-6 flex flex-col first:mt-2">
        <article className="flex flex-col items-end" data-side="right" title={formatTime(entry.createdAt)}>
          <SentBody unsent={isSendFailed ? unsentMarkOf(entry, onRetryUnsent) : null}>
            {(entry.inputText !== "" || entry.attachments.length === 0) && (
              <div
                data-bubble
                className={cn(BUBBLE, "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]")}
              >
                {entry.inputText}
              </div>
            )}
            <AttachmentList attachments={entry.attachments} />
          </SentBody>
        </article>

        {!isSending && !isSendFailed && (
          <div className="mt-4 flex flex-col" data-side="left">
            <AgentHead identity={ROUTER_IDENTITY} avatar={<RouterAvatar size={26} working={isRunning} />} />
            <div className="flex flex-col gap-2.5">
              {entry.destinations.length > 0 && (
                <div className="-mx-2.5 flex flex-col gap-0.5">
                  {entry.destinations.map((dest) => (
                    <DestinationRow
                      key={dest.key}
                      dest={dest}
                      multiDevice={multiDevice}
                      onOpenConversation={onOpenConversation}
                      onOpenWorker={onOpenWorker}
                    />
                  ))}
                </div>
              )}

              {showReply && (
                <div className="w-full min-w-0 text-body leading-relaxed">
                  <Markdown text={rawReply} />
                </div>
              )}

              {plan?.replyTruncated === true && <p className="text-xs text-muted-foreground">Reply truncated</p>}

              {isRunning && (
                <div className="text-minor text-muted-foreground">
                  <StatusShimmer text="Working…" />
                </div>
              )}

              {isFailed && (
                <div className="flex items-start gap-2 text-minor leading-5">
                  <CircleAlert className="mt-0.75 size-pixel-sm shrink-0 text-danger" aria-hidden="true" />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
                    <span className="text-minor text-muted-foreground" title={failRaw}>
                      {failReason}
                    </span>
                    {canRetry && command !== null && (
                      <button
                        type="button"
                        className={cn(TEXT_BUTTON, "px-1 text-minor font-medium text-muted-foreground")}
                        onClick={() => onRetryCommand(command.id, entry.version)}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )}

              {!isRunning && !isFailed && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                  {showReply && <CopyButton text={rawReply} />}
                  <span>{formatTime(entry.createdAt)}</span>
                </div>
              )}
            </div>
            {entry.destinations.map(
              (dest) =>
                dest.forwardMessageId !== null && (
                  <ForwardReply
                    key={dest.key}
                    dest={dest}
                    stores={storeForDevice}
                    client={clientForDevice(dest.deviceKey)}
                    onOpenConversation={onOpenConversation}
                  />
                ),
            )}
          </div>
        )}
      </div>
    </div>
  );
});
