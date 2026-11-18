// 总助时间流里转交问题下面的项目经理回复（docs/router-forward-reply-design.md，docs/ui-standard.md 第 21 条“转交回复”）。
// 回复正文用项目经理对话里同一个 MessageBubble 画，包在目标设备的 DeviceScopeOf 里，文件链接、预览按那台设备的。
import { CircleAlert } from "lucide-react";
import { memo } from "react";
import type { ConversationId } from "../../shared/domain.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { HubClient } from "../client.ts";
import { DeviceScopeOf } from "../device-scope.tsx";
import { useForwardReply } from "../forward-reply.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { formatTime } from "../format.ts";
import type { RouterTurnDestination } from "../router-stream.ts";
import { AgentHead, CopyButton, MessageBubble, SECONDARY } from "./Messages.tsx";
import type { MessageActions } from "./Messages.tsx";

// 总助里的回复只读：重试、撤销、点开 Worker 都在项目经理自己的对话里做
const READ_ONLY_ACTIONS: MessageActions = {
  onOpenWorker: () => {},
  retry: {},
  onRetryMessage: () => {},
  onRevertPersona: () => Promise.resolve(),
};

/**
 * 前置：dest.forwardMessageId 不是 null。
 * 后置：按 useForwardReply 的状态画：
 * waiting：项目经理头像和名字，下面一行 Working…；
 * replied：头像和名字，下面是回复正文和交付文件，结尾一行复制键和回复的时间；
 * ended：头像和名字，下面一行 Stopped，失败时是红色感叹号和原因；
 * silent、unknown：什么都不画。
 * 头像和名字整块可点，打开这个项目经理的对话。
 */
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
  if (state.kind === "silent" || state.kind === "unknown") return null;
  const failure = state.kind === "ended" && state.status === "failed" ? describeFailure(state.reason ?? "") : null;
  const identity = { name: dest.name, avatarKey: dest.avatarKey };
  return (
    <div data-forward-reply data-state={state.kind} data-side="left" className="mt-4 flex min-w-0 flex-col">
      <AgentHead identity={identity} onClick={() => onOpenConversation(dest.deviceKey, dest.conversationId)} />
      {state.kind === "waiting" && (
        <div className={SECONDARY}>
          <span className="status-shimmer">Working…</span>
        </div>
      )}
      {state.kind === "replied" && (
        <DeviceScopeOf deviceKey={dest.deviceKey}>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="*:mt-0!">
              <MessageBubble message={state.reply} identity={identity} head={false} actions={READ_ONLY_ACTIONS} />
            </div>
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
            <CircleAlert className="mt-0.75 size-3.5 shrink-0 text-danger" aria-hidden="true" />
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
