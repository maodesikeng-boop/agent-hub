import type { ChecklistStatus, Message } from "../../src/shared/index.ts";

type Scenario = "two-turns" | "unfinished" | "waiting" | "idle";
export const WAKEUP_BODY = "步骤「整理检查结果」已完成。下一步是复核交付记录。";

function task(id: string, title: string, status: ChecklistStatus) {
  return { id, title, activeTitle: null, status };
}

export function progressScenarioMessages({
  scenario, baseId, conversationId, sessionId, now,
}: {
  scenario: Scenario;
  baseId: number;
  conversationId: number;
  sessionId: number;
  now: number;
}): Message[] {
  const startedAt = now - (scenario === "waiting" ? 35_000 : 220_000);
  const row = (offset: number, elapsed: number, fields: Partial<Message>): Message => ({
    id: baseId + offset, conversationId, sessionId, workerId: null, sender: "agent", kind: "text", text: "",
    meta: null, collapsed: false, dedupeKey: `progress-scenario:${baseId + offset}`, status: null, failureReason: null,
    createdAt: startedAt + elapsed, updatedAt: startedAt + elapsed, ...fields,
  });
  const list = (offset: number, elapsed: number, checklist: ReturnType<typeof task>[]) =>
    row(offset, elapsed, { kind: "checklist", collapsed: true, meta: { checklist } });
  const wake = (offset: number, elapsed: number, status: Message["status"]) =>
    row(offset, elapsed, {
      sender: "system", status, text: `【任务图 #42「复核交付」】\n${WAKEUP_BODY}`,
      meta: { event: "pm.wakeup", source: "task_graph", ref: "step-ready" },
    });
  const first = [
    task("a", "核对 Worker 进度", "completed"),
    task("b", "检查交付记录", "completed"),
    task("c", "整理检查结果", scenario === "two-turns" || scenario === "idle" ? "completed" : "pending"),
  ];
  const start = row(1, 0, { sender: "user", text: "看看 Worker 都做到哪了", status: scenario === "waiting" ? "processing" : "replied" });
  if (scenario === "waiting") {
    return [
      start,
      list(2, 2_000, [first[0]!, { ...first[1]!, status: "in_progress" }, first[2]!]),
      row(3, 8_000, { kind: "tool", collapsed: true, text: "Read: delivery.md" }),
      wake(4, 27_000, "queued"),
      list(5, 29_000, [first[0]!, first[1]!, { ...first[2]!, status: "in_progress" }]),
    ];
  }
  if (scenario === "idle") {
    return [
      wake(1, 0, "replied"),
      row(2, 4_000, { kind: "tool", collapsed: true, text: "Read: delivery.md" }),
      row(3, 8_000, { text: "已开始复核交付记录。" }),
    ];
  }
  const carried = scenario === "unfinished" ? [{ ...first[2]!, status: "completed" as const }] : [];
  return [
    start,
    list(2, 4_000, first),
    row(3, 25_000, { text: scenario === "unfinished" ? "前两项做完了，检查结果下一轮整理。" : "Worker 进度和交付记录已核对。" }),
    row(4, 90_000, { sender: "user", text: "再查一下检查为什么失败", status: "replied" }),
    list(5, 110_000, [...carried, task("d", "查看失败日志", "completed"), task("e", "定位失败用例", "completed")]),
    row(6, 112_000, { text: "找到了一个超时用例。" }),
  ];
}
