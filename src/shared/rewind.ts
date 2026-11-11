// 二次 Esc 回退最后一条用户消息的判定规则（前后端共用一份，保证乐观回退与账本落库完全一致）。
import {
  isHandoverTraffic,
  isSilentTriggerMessage,
  systemEventOf,
  workerEventOf,
  type Message,
  type WorkerEvent,
} from "./domain.ts";
import { workerPickOf } from "./worker.ts";

/** 这些系统事件或 Worker 事件代表在用户消息之后开始了新一轮输入或结束了会话/Worker，不能越过它们去掏更早的用户消息。 */
const TURN_BOUNDARY_WORKER_EVENTS: ReadonlySet<WorkerEvent> = new Set(["report", "turn_failed", "worktree_failed", "ended"]);

/** 这条用户消息已经按二次 Esc 回退进过输入框了（meta.rewound 为 true）。 */
export function isRewoundMessage(message: Pick<Message, "sender" | "meta">): boolean {
  return message.sender === "user" && message.meta?.rewound === true;
}

/** 有可回退进输入框的内容（文字或 /hub:worker 选择；只传了附件没写字的消息不回退，避免吞掉附件气泡）。 */
export function canRewindContent(message: Pick<Message, "text" | "meta">): boolean {
  return message.text !== "" || workerPickOf(message) !== null;
}

/**
 * 从对话消息列表（按 id 从小到大排列）末尾找出当前可被二次 Esc 回退的那一条用户消息；找不到回 null。
 * - 只看对话最后一轮输入：遇到更新的项目经理指令、换代分隔线、定时任务触发或 Worker 汇报/收工，立即停止，绝不越界翻旧账；
 * - 遇到最新一条用户消息即拍板（不会继续往前找更早的用户消息）：已回退过的、无文字且无 workerPick 的、已正常回复或发送失败的一律回 null；
 * - 状态为 stopped / cancelled，或当前正处于 stopping 且状态为 queued / delivered / processing 时允许回退。
 */
export function findRewindableMessage(messages: readonly Message[], options?: { stopping?: boolean }): Message | null {
  const stopping = options?.stopping === true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isHandoverTraffic(m) || isSilentTriggerMessage(m)) continue;
    if (m.sender === "pm") return null;
    const sys = systemEventOf(m)?.event;
    if (sys === "session.renewed" || sys === "schedule.run") return null;
    const wk = workerEventOf(m);
    if (wk !== null && TURN_BOUNDARY_WORKER_EVENTS.has(wk.event)) return null;
    if (m.sender === "user") {
      if (isRewoundMessage(m) || !canRewindContent(m)) return null;
      if (m.status === "stopped" || m.status === "cancelled") return m;
      if (stopping && (m.status === "queued" || m.status === "delivered" || m.status === "processing")) return m;
      return null;
    }
  }
  return null;
}
