import { CircleAlert } from "../ui/icons.ts";
import { memo } from "react";
import type { ConversationId } from "../../shared/domain.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { HubClient } from "../client.ts";
import { DeviceScopeOf, useFleetLookOf } from "../device-scope.tsx";
import { useForwardReply } from "../forward-reply.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { formatTime } from "../format.ts";
import type { RouterTurnDestination } from "../router-stream.ts";
import { AgentHead, AgentText, CopyButton, SECONDARY } from "./Messages.tsx";
import { StatusShimmer } from "./StatusShimmer.tsx";

export const ForwardReply = memo(function ForwardReply({
  dest,
  stores,
  client,
  onOpenConversation,
}: {
  dest: RouterTurnDestination;
  stores: DeviceStoreLookup;
  client: HubClient;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const state = useForwardReply(dest, stores, client);
  const lookOf = useFleetLookOf();
  if (state.kind === "silent" || state.kind === "unknown") return null;
  const failure = state.kind === "ended" && state.status === "failed" ? describeFailure(state.reason ?? "") : null;
  const identity = { name: dest.name, look: lookOf(dest.deviceKey, dest.pmId) };
  return (
    <div data-forward-reply data-state={state.kind} data-side="left" className="mt-4 flex min-w-0 flex-col">
      <AgentHead identity={identity} onClick={() => onOpenConversation(dest.deviceKey, dest.conversationId)} />
      {state.kind === "waiting" && (
        <div className={SECONDARY}>
          <StatusShimmer text="Working…" />
        </div>
      )}
      {state.kind === "replied" && (
        <DeviceScopeOf deviceKey={dest.deviceKey}>
          <div className="flex min-w-0 flex-col gap-2.5">
            <AgentText message={state.reply} highlighted={false} />
            <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <CopyButton text={state.reply.text} />
              <span>{formatTime(state.reply.createdAt)}</span>
            </div>
          </div>
        </DeviceScopeOf>
      )}
      {state.kind === "ended" &&
        (failure !== null ? (
          <div className="flex items-start gap-2 text-minor leading-5">
            <CircleAlert className="mt-0.75 size-pixel-sm shrink-0 text-danger" aria-hidden="true" />
            <span className="min-w-0 text-minor text-muted-foreground [overflow-wrap:anywhere]" title={failure.raw}>
              {failure.text}
            </span>
          </div>
        ) : (
          <div className={SECONDARY}>Stopped</div>
        ))}
    </div>
  );
});
