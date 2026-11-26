import { z } from "zod";
import { clipChecklistTitle, type ChecklistItem, type ChecklistItemPatch, type ChecklistUpdate } from "./checklist.ts";
import { CHECKLIST_MAX_ITEMS, CHECKLIST_TITLE_MAX_CHARS } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";

const positionKinds = z.enum(["start", "done", "cancel"]);
export const hubChecklistRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("set"),
    // JavaScript strings use two code units for characters outside the BMP.
    titles: z.array(z.string().trim().min(1).max(2 * CHECKLIST_TITLE_MAX_CHARS)).min(1).max(CHECKLIST_MAX_ITEMS),
  }),
  z.strictObject({ kind: positionKinds, position: z.int().positive() }),
]);

export type HubChecklistRequest = z.infer<typeof hubChecklistRequestSchema>;

type ChecklistError = { ok: false; reason: string; error: string };
export type HubChecklistParse = { ok: true; request: HubChecklistRequest } | ChecklistError;

export const HUB_CHECKLIST_COMMAND = `${HUB_COMMAND} checklist`;
export const HUB_CHECKLIST_USAGE = [
  `  ${HUB_CHECKLIST_COMMAND} set "<步骤>" ["<步骤>" …]               列出本轮的全部步骤，第一项标为进行中`,
  `  ${HUB_CHECKLIST_COMMAND} start <编号>                             开始指定步骤（从 1 编号）`,
  `  ${HUB_CHECKLIST_COMMAND} done <编号>                              完成指定步骤。如果紧接着的一项待开始，就开始那一项`,
  `  ${HUB_CHECKLIST_COMMAND} cancel <编号>                            取消指定步骤`,
].join("\n");

function invalid(reason: string): ChecklistError {
  return { ok: false, reason, error: `${reason}\n用法：\n${HUB_CHECKLIST_USAGE}` };
}

export function parseHubChecklistArgs(argv: readonly string[]): HubChecklistParse {
  const [kind, ...args] = argv;
  if (kind === "set") {
    if (args.length > CHECKLIST_MAX_ITEMS) return invalid(`进度清单最多有 ${CHECKLIST_MAX_ITEMS} 项`);
    const titles = args.map(clipChecklistTitle).filter(Boolean);
    if (titles.length === 0) return invalid("至少写一项进度");
    return { ok: true, request: { kind, titles } };
  }
  const action = positionKinds.safeParse(kind);
  if (!action.success) return invalid("请选择进度清单子命令：set、start、done 或 cancel");
  const [raw] = args;
  const position = Number(raw);
  if (args.length !== 1 || raw === undefined || !/^\d+$/u.test(raw) || !Number.isSafeInteger(position) || position < 1) {
    return invalid("只填一个从 1 开始的整数编号");
  }
  return { ok: true, request: { kind: action.data, position } };
}

export function hubChecklistUpdate(
  request: HubChecklistRequest,
  current: readonly ChecklistItem[],
): { ok: true; update: ChecklistUpdate } | ChecklistError {
  if (request.kind === "set") {
    return {
      ok: true,
      update: {
        kind: "replace",
        items: request.titles.map((title, i) => ({ id: null, title, status: i === 0 ? "in_progress" : "pending" })),
      },
    };
  }
  const item = current[request.position - 1];
  if (item === undefined) return invalid(`编号 ${request.position} 不在清单里（当前有 ${current.length} 项）`);
  const items: ChecklistItemPatch[] = [];
  switch (request.kind) {
    case "start":
      for (const other of current) {
        if (other.id !== item.id && other.status === "in_progress") items.push({ id: other.id, status: "pending" });
      }
      items.push({ id: item.id, status: "in_progress" });
      break;
    case "done": {
      items.push({ id: item.id, status: "completed" });
      const next = current[request.position];
      if (next?.status === "pending") items.push({ id: next.id, status: "in_progress" });
      break;
    }
    case "cancel":
      items.push({ id: item.id, status: "cancelled" });
      break;
  }
  return { ok: true, update: { kind: "merge", items } };
}
