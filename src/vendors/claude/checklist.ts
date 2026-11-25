import { z } from "zod";
import { clipChecklistTitle, normalizeChecklistStatus, type ChecklistUpdate } from "../../shared/index.ts";
import { CHECKLIST_PENDING_CALLS_MAX } from "../../shared/limits.ts";
import { checklistFromTodoList } from "../_common/checklist.ts";

type PendingChecklistCall = { kind: "create"; title: string; activeTitle: string | null } | { kind: "replace" };

export interface ClaudeChecklistState {
  pending: Map<string, PendingChecklistCall>;
}

export function createClaudeChecklistState(): ClaudeChecklistState {
  return { pending: new Map() };
}

const taskInput = z.object({ taskId: z.unknown().optional(), subject: z.unknown().optional(), activeForm: z.unknown().optional(), status: z.unknown().optional() });
const taskResult = z.object({ task: z.object({ id: z.string().min(1) }).optional(), newTodos: z.unknown().optional() });

function rememberCall(state: ClaudeChecklistState, id: string, call: PendingChecklistCall): void {
  if (state.pending.size >= CHECKLIST_PENDING_CALLS_MAX && !state.pending.has(id)) {
    const oldest = state.pending.keys().next().value;
    if (oldest !== undefined) state.pending.delete(oldest);
  }
  state.pending.set(id, call);
}

export function claudeChecklistFromToolUse(state: ClaudeChecklistState, block: { toolUseId: string; name: string; input: unknown }): ChecklistUpdate | null {
  if (block.name === "TodoWrite") {
    rememberCall(state, block.toolUseId, { kind: "replace" });
    return checklistFromTodoList(block.input);
  }
  if (block.name !== "TaskCreate" && block.name !== "TaskUpdate") return null;

  const input = taskInput.safeParse(block.input).data;
  if (!input) return null;
  const activeTitle = typeof input.activeForm === "string" ? clipChecklistTitle(input.activeForm) || null : undefined;
  if (block.name === "TaskCreate") {
    if (typeof input.subject !== "string" || input.subject.trim() === "") return null;
    rememberCall(state, block.toolUseId, { kind: "create", title: clipChecklistTitle(input.subject), activeTitle: activeTitle ?? null });
    return null;
  }

  if (typeof input.taskId !== "string" || input.taskId === "") return null;
  if (input.status === "deleted") return { kind: "remove", ids: [input.taskId] };
  const status = normalizeChecklistStatus(input.status);
  return { kind: "merge", items: [{
    id: input.taskId,
    ...(typeof input.subject === "string" ? { title: input.subject } : {}),
    ...(activeTitle !== undefined ? { activeTitle } : {}),
    ...(status !== null ? { status } : {}),
  }] };
}

export function claudeChecklistFromToolResult(state: ClaudeChecklistState, toolUseId: string, toolUseResult: unknown): ChecklistUpdate | null {
  const pending = state.pending.get(toolUseId);
  state.pending.delete(toolUseId);
  if (!pending) return null;
  const result = taskResult.safeParse(toolUseResult).data;
  if (!result) return null;
  if (pending.kind === "replace") return checklistFromTodoList({ todos: result.newTodos });
  if (!result.task) return null;
  return { kind: "merge", items: [{ id: result.task.id, title: pending.title, activeTitle: pending.activeTitle, status: "pending" }] };
}
