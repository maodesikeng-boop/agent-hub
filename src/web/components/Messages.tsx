import { useState } from "react";
import type { Message } from "../../shared/index.ts";
import { describeError, formatTime, STATUS_LABELS } from "../format.ts";
import type { PendingMessage } from "../state.ts";
import { Avatar } from "./Avatar.tsx";

interface AgentIdentity {
  name: string;
  avatarKey: number;
}

/** agent 一连串消息的第一条带头像和名字，后面的只留头像的位置。 */
function AgentRow({
  identity,
  head,
  children,
}: {
  identity: AgentIdentity;
  head: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="row" data-side="left" data-head={head}>
      <div className="row-avatar">{head && <Avatar name={identity.name} colorKey={identity.avatarKey} size="sm" />}</div>
      <div className="row-main">
        {head && <div className="row-name">{identity.name}</div>}
        {children}
      </div>
    </div>
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
      <div className="row" data-side="center">
        <div className="system-note">{message.text}</div>
      </div>
    );
  }
  if (message.sender === "user") {
    return (
      <article className="row" data-side="right" data-status={message.status ?? undefined} title={time}>
        <div className="row-main">
          <div className="bubble">{message.text}</div>
          {message.status && <DeliveryStatus status={message.status} reason={message.failureReason} />}
        </div>
      </article>
    );
  }
  return (
    <article className="row" data-side="left" data-head={head} title={time}>
      <div className="row-avatar">{head && <Avatar name={identity.name} colorKey={identity.avatarKey} size="sm" />}</div>
      <div className="row-main">
        {head && <div className="row-name">{identity.name}</div>}
        <div className="bubble">{message.text}</div>
      </div>
    </article>
  );
}

function DeliveryStatus({ status, reason }: { status: NonNullable<Message["status"]>; reason: string | null }) {
  const failure = status === "failed" && reason ? describeError(reason) : null;
  return (
    <div className="delivery" data-status={status}>
      <span>{STATUS_LABELS[status]}</span>
      {failure && (
        <span className="delivery-reason" title={reason ?? undefined}>
          {failure.label}
        </span>
      )}
    </div>
  );
}

/** 网页先显示出来、服务端还没确认的用户消息。 */
export function PendingBubble({ pending, onRetry }: { pending: PendingMessage; onRetry: (clientId: string) => void }) {
  const failed = pending.phase === "failed";
  return (
    <article className="row" data-side="right" data-status={failed ? "send_failed" : "queued"}>
      <div className="row-main">
        <div className="bubble">{pending.text}</div>
        <div className="delivery" data-status={failed ? "failed" : "queued"}>
          <span>{failed ? "发送失败" : STATUS_LABELS.queued}</span>
          {failed && (
            <button type="button" className="link-button" onClick={() => onRetry(pending.clientId)}>
              重试
            </button>
          )}
        </div>
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
      <button type="button" className="tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chevron" aria-hidden="true" />
        执行了 {messages.length} 个操作
      </button>
      {open && (
        <ul className="tool-list">
          {messages.map((m) => (
            <li key={m.id}>{m.text}</li>
          ))}
        </ul>
      )}
    </AgentRow>
  );
}
